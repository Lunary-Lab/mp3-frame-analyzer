import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const action = readFileSync(
  new URL('../.github/actions/setup-trivy/action.yml', import.meta.url),
  'utf8',
);
const steps = parse(action).runs.steps.filter(
  (step) => step.name === 'Download and verify the pinned Trivy release',
);
assert.equal(steps.length, 1, 'Expected one Trivy bootstrap step');
const script = steps[0].run;
assert.equal(typeof script, 'string', 'Missing Trivy bootstrap shell script');
const pin = 'c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'trivy-native-options-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['bin', 'source', 'runner']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'source', 'trivy'), 'verified harmless scanner fixture\n');
  const archive = join(root, 'fixture.tgz');
  execFileSync('tar', ['-czf', archive, '-C', join(root, 'source'), 'trivy'], {
    env: { PATH: process.env.PATH },
  });
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
  assert.equal(script.split(pin).length, 2);
  return { root, archive, script: script.replace(pin, digest) };
}

function run(value, overrides = {}) {
  return spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', value.script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(value.root, 'bin')}:${process.env.PATH}`,
      RUNNER_TEMP: join(value.root, 'runner'),
      FIXTURE_ARCHIVE: value.archive,
      FIXTURE_CURL_LOG: join(value.root, 'curl.log'),
      ...overrides,
    },
  });
}

for (const hook of ['tar', 'gzip']) {
  test(`Trivy extraction ignores inherited ${hook} options after verification`, (t) => {
    const value = fixture(t);
    const marker = join(value.root, 'executed');
    const command = join(value.root, 'hook');
    writeFileSync(command, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
    const result = run(value, {
      TAR_OPTIONS: hook === 'tar' ? `--checkpoint=1 --checkpoint-action=exec=${command}` : '',
      GZIP: hook === 'gzip' ? '--invalid-inherited-option' : '',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(
      readFileSync(join(value.root, 'runner/trivy-tool/trivy'), 'utf8'),
      'verified harmless scanner fixture\n',
    );
    assert.equal(readFileSync(join(value.root, 'curl.log'), 'utf8').split('\n')[0], '--disable');
  });
}

test('native curl ignores ambient configuration only with the first disable argument', (t) => {
  const value = fixture(t);
  writeFileSync(join(value.root, '.curlrc'), 'unreviewed-invalid-option\n');
  const env = { PATH: process.env.PATH, HOME: value.root, CURL_HOME: value.root };
  const original = spawnSync('curl', ['--version'], { env, encoding: 'utf8' });
  assert.match(original.stderr, /unreviewed-invalid-option/);
  const controlled = spawnSync('curl', ['--disable', '--version'], { env, encoding: 'utf8' });
  assert.equal(controlled.status, 0, controlled.stderr);
  assert.doesNotMatch(controlled.stderr, /unreviewed-invalid-option/);
});

test('a substituted Trivy archive never reaches extraction', (t) => {
  const value = fixture(t);
  writeFileSync(value.archive, 'substituted bytes');
  const result = run(value);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(value.root, 'runner/trivy-tool/trivy')), false);
});

for (const kind of ['directory', 'file', 'symlink']) {
  test(`Trivy refuses an occupied ${kind} without download or cleanup`, (t) => {
    const value = fixture(t);
    const destination = join(value.root, 'runner/trivy-tool');
    const sentinel = join(value.root, 'sentinel');
    writeFileSync(sentinel, 'keep');
    if (kind === 'directory') mkdirSync(destination);
    else if (kind === 'file') writeFileSync(destination, 'keep');
    else {
      const outside = join(value.root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, destination);
    }
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(destination), true);
    assert.equal(readFileSync(sentinel, 'utf8'), 'keep');
    assert.equal(existsSync(join(value.root, 'curl.log')), false);
  });
}
