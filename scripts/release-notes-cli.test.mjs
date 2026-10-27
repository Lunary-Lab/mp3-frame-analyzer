import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
const usage = /Usage: node scripts\/release-notes\.mjs plan\|compose/;

function invoke(args) {
  const directory = mkdtempSync(join(tmpdir(), 'release-notes-cli-'));
  try {
    // No credentials or external commands: supported commands stop at their
    // first local precondition, before any GitHub request or artifact write.
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: directory,
      env: { PATH: directory, GITHUB_SHA: 'actual-head', RELEASE_SHA: 'different-head' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(directory), [], 'Dispatch must not create release artifacts');
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const command of [
  undefined,
  '',
  'unknown',
  'PLAN',
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
]) {
  test(`rejects unsupported release-notes command ${JSON.stringify(command)}`, () => {
    const result = invoke(command === undefined ? [] : [command]);
    assert.equal(result.status, 1, 'Unsupported commands must not report success');
    assert.match(result.stderr, usage);
  });
}

for (const [command, expected] of [
  ['plan', /Prepare notes from the exact tagged source/],
  ['compose', /ENOENT.*\.release-notes-input\/plan\.json/],
]) {
  test(`dispatches ${command} to its local precondition without release operations`, () => {
    const result = invoke([command]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, usage);
    assert.match(result.stderr, expected);
  });
}
