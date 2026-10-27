import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDocument } from 'yaml';
import {
  collectWorkflowInputs,
  requirePinnedFindings,
  requireSourceBoundLocals,
  requireSupportedWorkflow,
} from './workflow-pins.mjs';

test('local references including aliases require unambiguous discovered source targets', () => {
  const source = 'x: &steps [{uses: "./local"}]\nruns: {using: composite, steps: *steps}';
  const locals = requireSupportedWorkflow(source, 'action.yml');
  assert.deepEqual(locals, [{ target: './local', action: true }]);
  requireSourceBoundLocals(locals, ['local/action.yml']);
  for (const files of [[], ['ignored/action.yml'], ['local/action.yml', 'local/action.yaml']])
    assert.throws(() => requireSourceBoundLocals(locals, files));
  for (const target of ['./..', './../outside', './local/../other', './node_modules/generated'])
    assert.throws(() => requireSourceBoundLocals([{ target, action: true }], ['local/action.yml']));
  requireSourceBoundLocals([{ target: './', action: true }], ['action.yml']);
  assert.throws(() =>
    requireSourceBoundLocals(
      [{ target: './..\\outside', action: true }],
      ['..\\outside/action.yml'],
    ),
  );
  const reusable = requireSupportedWorkflow(
    'jobs: {x: {uses: "./.github/workflows/reuse.yml"}}',
    'ci.yml',
  );
  requireSourceBoundLocals(reusable, ['.github/workflows/reuse.yml']);
  assert.throws(() => requireSourceBoundLocals(reusable, []));
  assert.throws(() =>
    requireSourceBoundLocals([{ target: './action.yml', action: false }], ['action.yml']),
  );
});

test('unsupported executable containers fail closed through aliases and flow mappings', () => {
  for (const source of [
    'jobs: {x: {container: alpine:3}}',
    'jobs: {x: {container: {image: alpine@sha256:abc}}}',
    'jobs: {x: {services: {db: {image: redis:7}}}}',
    'runs: {using: docker, image: Dockerfile}',
    'runs: {using: composite, steps: [{uses: "docker://alpine:3"}]}',
    'runs: {using: composite, steps: [{parallel: [{uses: "docker://alpine:3"}]}]}',
    'jobs:\n  a: &job\n    container: alpine:3\n  b: *job',
    'x: &job {container: alpine:3}\njobs: {a: {<<: *job}}',
    'x: &steps [{uses: "docker://alpine:3"}]\nruns: {using: composite, steps: *steps}',
  ])
    assert.throws(() => requireSupportedWorkflow(source, 'fixture.yml'), /integrity/);
  requireSupportedWorkflow('runs: {using: composite, steps: [{uses: "./local"}]}', 'fixture.yml');
  for (const source of [
    'jobs: [',
    'null',
    'jobs: {}\njobs: {}',
    'jobs: !unknown {}',
    '---\njobs: {}\n---\njobs: {}',
  ])
    assert.throws(() => requireSupportedWorkflow(source, 'fixture.yml'));
});

test('scanner archive mismatch prevents extraction with the real sha256 verifier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-zizmor-bootstrap-'));
  try {
    const source = await readFile(
      new URL('../.github/actions/setup-zizmor/action.yml', import.meta.url),
      'utf8',
    );
    const action = parseDocument(source).toJS();
    const script = action.runs.steps[0].run;
    assert.match(script, /d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99/);
    assert.match(script, /v1\.31\.1\/zizmor-x86_64-unknown-linux-gnu\.tar\.gz/);
    assert.ok(script.indexOf('sha256sum --check --strict') >= 0);
    assert.ok(script.indexOf('sha256sum --check --strict') < script.indexOf('tar -xzf'));
    await writeFile(
      join(directory, 'curl'),
      '#!/bin/bash\nwhile [[ "$1" != --output ]]; do shift; done\nprintf tampered > "$2"\n',
      { mode: 0o700 },
    );
    const marker = join(directory, 'extracted');
    await writeFile(join(directory, 'tar'), `#!/bin/bash\ntouch '${marker}'\n`, { mode: 0o700 });
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script],
      {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /FAILED/);
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pinning gate rejects scanner failures and missing, malformed or ignored evidence', () => {
  const finding = { ident: 'unpinned-uses', ignored: false };
  assert.throws(() => requirePinnedFindings(14, JSON.stringify([finding])), /unpinned-uses/);
  assert.throws(() =>
    requirePinnedFindings(14, JSON.stringify([{ ...finding, ident: 'unpinned-images' }])),
  );
  assert.equal(requirePinnedFindings(0, '[]'), 0);
  assert.equal(
    requirePinnedFindings(12, JSON.stringify([{ ident: 'self-repository', ignored: false }])),
    1,
  );
  for (const status of [null, 1, 2, 3, 10, 15, -1])
    assert.throws(() => requirePinnedFindings(status, '[]'), /Scanner did not complete/);
  for (const output of [
    '',
    'null',
    '{}',
    '[null]',
    '[{}]',
    '[{"ident":"unpinned-uses","ignored":true}]',
  ])
    assert.throws(() => requirePinnedFindings(14, output));
  assert.throws(() => requirePinnedFindings(0, JSON.stringify([finding])));
  assert.throws(() => requirePinnedFindings(14, '[]'));
});

test('discovery includes new workflows and all action metadata, including tracked ignored files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-workflow-discovery-'));
  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const files = [
      '.github/workflows/ci.yml',
      '.github/workflows/new.yaml',
      'custom action/action.yml',
      'ignored/action.yaml',
    ];
    for (const file of [...files, 'ignored/untracked/action.yml', 'docs/example.yml']) {
      await mkdir(join(directory, file, '..'), { recursive: true });
      await writeFile(join(directory, file), 'name: fixture\n');
    }
    await writeFile(join(directory, '.gitignore'), 'ignored/\n');
    execFileSync('git', ['-C', directory, 'add', '-f', 'ignored/action.yaml']);
    assert.deepEqual(await collectWorkflowInputs(directory), files.sort());
    await symlink('ci.yml', join(directory, '.github/workflows/link.yml'));
    await assert.rejects(collectWorkflowInputs(directory), /regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery never silently succeeds outside a repository or without inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-empty-workflows-'));
  try {
    await assert.rejects(collectWorkflowInputs(directory));
    execFileSync('git', ['init', '--quiet', directory]);
    await assert.rejects(collectWorkflowInputs(directory), /No workflow or action inputs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
