import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/governance.yml', import.meta.url),
  'utf8',
);
function stepScript(name) {
  const block = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  assert.ok(block?.includes('        run: |\n'), `Missing shell step: ${name}`);
  const lines = block.split('        run: |\n')[1].trimEnd().split('\n');
  assert.ok(lines.length > 0 && lines.every((line) => line.startsWith('          ')));
  return lines.map((line) => line.slice(10)).join('\n');
}

const script = stepScript('Install the pinned Terraform release');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'terraform-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['bin', 'runner']) mkdirSync(join(root, name));
  const archive = join(root, 'fixture.zip');
  execFileSync('python3', [
    '-I',
    '-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("terraform", "verified fixture\\n"); z.close()',
    archive,
  ]);
  writeFileSync(
    join(root, 'bin/curl'),
    `#!/bin/bash
printf '%s\\n' "$@" > "$FIXTURE_CURL_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; cp -- "$FIXTURE_ARCHIVE" "$1"; exit; fi
  if [ "$1" = -fsSLo ]; then shift; cp -- "$FIXTURE_ARCHIVE" "$1"; exit; fi
  shift
done
exit 2
`,
    { mode: 0o700 },
  );
  return {
    root,
    archive,
    digest: createHash('sha256').update(readFileSync(archive)).digest('hex'),
  };
}

function run(value, poison = {}) {
  return spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(value.root, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: join(value.root, 'runner'),
      GITHUB_PATH: join(value.root, 'github-path'),
      TERRAFORM_VERSION: '1.16.7',
      TERRAFORM_SHA256: value.digest,
      FIXTURE_ARCHIVE: value.archive,
      FIXTURE_CURL_LOG: join(value.root, 'curl.log'),
      ...poison,
    },
  });
}

test('verified Terraform bootstrap ignores native unzip options and curl config', (t) => {
  const value = fixture(t);
  const result = run(value, { UNZIP: '-p', UNZIPOPT: '-p' });
  assert.equal(result.status, 0, result.stderr);
  const path = readFileSync(join(value.root, 'github-path'), 'utf8').trim();
  assert.equal(readFileSync(join(path, 'terraform'), 'utf8'), 'verified fixture\n');
  assert.equal(readFileSync(join(value.root, 'curl.log'), 'utf8').split('\n')[0], '-q');
});

test('occupied Terraform root cannot retain unverified bytes using native no-overwrite options', (t) => {
  const value = fixture(t);
  mkdirSync(join(value.root, 'runner/terraform'));
  writeFileSync(join(value.root, 'runner/terraform/terraform'), 'unverified fixture\n');
  const result = run(value, { UNZIP: '-n', UNZIPOPT: '-n' });
  if (result.status === 0) {
    const path = readFileSync(join(value.root, 'github-path'), 'utf8').trim();
    assert.equal(
      readFileSync(join(path, 'terraform'), 'utf8'),
      'verified fixture\n',
      'valid archive hash did not replace the existing unverified executable',
    );
  }
  assert.notEqual(result.status, 0, 'bootstrap accepted preexisting unverified executable');
  assert.equal(existsSync(join(value.root, 'github-path')), false);
  assert.equal(existsSync(join(value.root, 'curl.log')), false);
});

test('wrong Terraform archive digest fails before extraction or PATH publication', (t) => {
  const value = fixture(t);
  const result = run(value, { TERRAFORM_SHA256: '0'.repeat(64) });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(value.root, 'runner/terraform/bin/terraform')), false);
  assert.equal(existsSync(join(value.root, 'github-path')), false);
});

// Shape and message code captured from the verified Terraform 1.16.7 binary's
// provider-free init -json. Terraform itself is never invoked by these fixtures.
const info = { '@level': 'info', '@module': 'terraform.ui', '@message': 'fixture' };
const version = { ...info, type: 'version', terraform: '1.16.7', ui: '1.3' };
const success = { ...info, type: 'init_output', message_code: 'output_init_success_message' };
const jsonl = (...messages) => messages.map((message) => JSON.stringify(message)).join('\n');
const initScript = stepScript('Initialize without module downloads and reject incomplete locks');

function initializeFixture(t, output, status = 0) {
  const root = mkdtempSync(join(tmpdir(), 'terraform-init-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'output'), output);
  writeFileSync(
    join(root, 'bin/terraform'),
    '#!/bin/bash\nprintf "%s\\n" "$@" > "$TF_DATA_DIR/args"\n' +
      'cat "$TF_DATA_DIR/output"\nexit "$FIXTURE_STATUS"\n',
    { mode: 0o700 },
  );
  const result = spawnSync(
    '/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-e',
      '-o',
      'pipefail',
      '-c',
      `${initScript}\ntouch "$TF_DATA_DIR/after"`,
    ],
    {
      encoding: 'utf8',
      cwd: new URL('../governance', import.meta.url),
      env: {
        PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
        TF_DATA_DIR: root,
        TERRAFORM_VERSION: '1.16.7',
        FIXTURE_STATUS: String(status),
      },
    },
  );
  assert.equal(result.error, undefined);
  return { result, root };
}

test('native init success passes the actual jq gate and keeps readonly/no-download arguments', (t) => {
  const { result, root } = initializeFixture(t, jsonl(version, success));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'after')), true);
  assert.deepEqual(readFileSync(join(root, 'args'), 'utf8').trim().split('\n'), [
    'init',
    '-backend=false',
    '-input=false',
    '-lockfile=readonly',
    '-get=false',
    '-json',
  ]);
});

test('native diagnostics, unsuccessful init, and malformed/incomplete output stop subsequent work', (t) => {
  const diagnostic = (severity) => ({
    ...info,
    '@level': severity === 'warning' ? 'warn' : severity,
    type: 'diagnostic',
    diagnostic: { severity, summary: 'Provider lock file not updated' },
  });
  for (const [name, output, status = 0] of [
    ['hashless-lock warning', jsonl(version, diagnostic('warning'), success)],
    ['error', jsonl(version, diagnostic('error'), success)],
    [
      'mislabelled diagnostic',
      jsonl(version, { ...diagnostic('warning'), '@level': 'info' }, success),
    ],
    ['nonzero native exit', jsonl(version, success), 1],
    ['empty', ''],
    ['whitespace', '  \n'],
    ['invalid JSON', '{'],
    ['non-object record', jsonl(version, null, success)],
    ['array record', jsonl([version, success])],
    ['missing version', jsonl(success, success)],
    ['wrong version', jsonl({ ...version, terraform: '0.0.0' }, success)],
    ['missing success', jsonl(version)],
    ['wrong success shape', jsonl(version, { ...success, message_code: null })],
    ['wrong message shape', jsonl(version, { ...success, '@message': null })],
    ['empty event type', jsonl(version, { ...info, type: '' }, success)],
    ['missing event type', jsonl(version, info, success)],
    ['wrong module', jsonl(version, { ...success, '@module': 'unrelated' })],
  ]) {
    const { result, root } = initializeFixture(t, output, status);
    assert.notEqual(result.status, 0, name);
    assert.equal(existsSync(join(root, 'after')), false, name);
  }
});

test('Terraform context is exclusive and exported before init, with ambient overrides cleared', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'terraform-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const context = stepScript('Isolate Terraform configuration and data');
  const options = {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', RUNNER_TEMP: root, GITHUB_ENV: join(root, 'environment') },
  };
  assert.equal(spawnSync('/bin/bash', ['-e', '-c', context], options).status, 0);
  const exported = readFileSync(join(root, 'environment'), 'utf8');
  assert.equal(
    exported,
    `TF_DATA_DIR=${root}/terraform-context/data\n` +
      `TF_CLI_CONFIG_FILE=${root}/terraform-context/terraform.rc\n`,
  );
  assert.equal(readFileSync(join(root, 'terraform-context/terraform.rc'), 'utf8'), '\n');
  assert.notEqual(spawnSync('/bin/bash', ['-e', '-c', context], options).status, 0);
  assert.equal(readFileSync(join(root, 'environment'), 'utf8'), exported);
  for (const variable of [
    'TF_CLI_ARGS',
    'TF_CLI_ARGS_init',
    'TF_CLI_ARGS_validate',
    'TF_CLI_ARGS_test',
    'TF_CLI_ARGS_fmt',
    'TF_PLUGIN_CACHE_DIR',
    'TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE',
    'TF_REATTACH_PROVIDERS',
  ])
    assert.ok(workflow.includes(`      ${variable}: ''\n`), variable);
  assert.ok(workflow.includes('      TF_WORKSPACE: default\n'));
  assert.ok(workflow.includes('        shell: bash\n'));
  const nativeCheck =
    'python3 -I ../scripts/check-terraform-init.py "$(command -v terraform)" init-integrity.jq';
  assert.ok(workflow.includes(nativeCheck));
  assert.ok(
    workflow.indexOf(nativeCheck) > workflow.indexOf('Install the pinned Terraform release'),
  );
  assert.ok(workflow.indexOf(nativeCheck) < workflow.indexOf(initScript.split('\n')[0]));
  assert.ok(initScript.includes('jq -e -s -f init-integrity.jq'));
  assert.ok(
    workflow.indexOf(initScript.split('\n')[0]) < workflow.indexOf('- run: terraform validate'),
  );
  assert.equal(workflow.includes('continue-on-error:'), false);
});
