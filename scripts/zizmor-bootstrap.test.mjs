import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const action = parse(
  readFileSync(new URL('../.github/actions/setup-zizmor/action.yml', import.meta.url), 'utf8'),
);
const pinned = 'd185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'zizmor-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['bin', 'source', 'runner']) mkdirSync(join(root, directory));
  writeFileSync(join(root, 'source', 'zizmor'), 'harmless pinned fixture\n');
  const archive = join(root, 'fixture.tar.gz');
  execFileSync('/usr/bin/env', [
    '-i',
    'PATH=/usr/bin:/bin',
    'tar',
    '-czf',
    archive,
    '-C',
    join(root, 'source'),
    'zizmor',
  ]);
  writeFileSync(
    join(root, 'bin', 'curl'),
    `#!/bin/bash
printf '%s\\n' "$@" > "$FIXTURE_CURL_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; cp -- "$FIXTURE_ARCHIVE" "$1"; exit; fi
  shift
done
exit 2
`,
    { mode: 0o700 },
  );
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(action.runs.steps[0].run.split(pinned).length, 2);
  return { root, archive, script: action.runs.steps[0].run.replace(pinned, digest) };
}

function run(value, poison = {}) {
  return spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', value.script],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(value.root, 'bin')}:${process.env.PATH}`,
        RUNNER_TEMP: join(value.root, 'runner'),
        FIXTURE_ARCHIVE: value.archive,
        FIXTURE_CURL_LOG: join(value.root, 'curl.log'),
        ...poison,
      },
    },
  );
}

for (const hook of ['tar', 'gzip', 'curl']) {
  test(`verified zizmor archive isolates ambient ${hook} configuration`, (t) => {
    const value = fixture(t);
    const marker = join(value.root, 'ambient-command');
    const poison = { TAR_OPTIONS: '', GZIP: '' };
    if (hook === 'tar') {
      const command = join(value.root, 'hook');
      writeFileSync(command, `#!/bin/sh\ntouch -- "${marker}"\n`, { mode: 0o700 });
      poison.TAR_OPTIONS = `--checkpoint=1 --checkpoint-action=exec=${command}`;
    }
    if (hook === 'gzip') poison.GZIP = '--invalid-fixture-option';
    const result = run(value, poison);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false, 'archive extraction executed an ambient command');
    assert.equal(
      readFileSync(join(value.root, 'runner/zizmor-tool/zizmor'), 'utf8'),
      'harmless pinned fixture\n',
    );
    assert.equal(readFileSync(join(value.root, 'curl.log'), 'utf8').split('\n')[0], '-q');
  });
}

test('substituted archive cannot reach native extraction', (t) => {
  const value = fixture(t);
  writeFileSync(value.archive, 'substituted bytes');
  const result = run(value);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(value.root, 'runner/zizmor-tool/zizmor')), false);
});

test('occupied bootstrap root fails instead of reusing previously extracted tools', (t) => {
  const value = fixture(t);
  mkdirSync(join(value.root, 'runner/zizmor-tool'));
  const result = run(value);
  assert.notEqual(result.status, 0);
  assert.equal(
    existsSync(join(value.root, 'curl.log')),
    false,
    'download ran before exclusive ownership',
  );
});
