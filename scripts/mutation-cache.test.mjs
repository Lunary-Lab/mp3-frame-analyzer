import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  BASELINE,
  executionSummary,
  fingerprint,
  mutationEnvironment,
  mutationInputs,
  promoteCache,
  readCache,
  validateCache,
} from './mutation-cache.mjs';

const commit = 'a'.repeat(40);
const key = 'b'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'native-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const put = async (path, content = 'initial') => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  };
  return { root, put };
}

test('the same declared inputs are stable; rooted noninputs do not invalidate', async (t) => {
  const { root, put } = await fixture(t);
  await put('src/parser.ts');
  const capture = () => mutationInputs(root, {}, { node: 'test' }).then(fingerprint);
  const before = await capture();
  for (const path of [
    'README.md',
    'AGENTS.md',
    'docs/testing.md',
    '.semgrep.yml',
    'tests/semgrep/example.fixture',
    'governance/main.tf',
    '.github/workflows/ci.yml',
  ]) {
    await put(path, 'unrelated edit');
    assert.equal(await capture(), before, path);
  }
});

test('source, helper, selected test, every resource extension, config, lock and unknown inputs bind', async (t) => {
  const { root, put } = await fixture(t);
  const capture = () => mutationInputs(root, {}, { node: 'test' }).then(fingerprint);
  for (const path of [
    'src/parser.ts',
    'src/app.ts',
    'tests/helper.ts',
    'tests/parser.test.ts',
    'tests/fixtures/value.md',
    'tests/fixtures/value.json',
    'stryker.config.json',
    'vitest.mutation.config.ts',
    'package-lock.json',
    'docs/mutation-review.md',
    '.github/actions/test-mutations/action.yml',
    'unknown.txt',
  ]) {
    const before = await capture();
    await put(path);
    const added = await capture();
    assert.notEqual(added, before, `added ${path}`);
    await put(path, 'changed');
    assert.notEqual(await capture(), added, `changed ${path}`);
    await rm(join(root, path));
    assert.equal(await capture(), before, `deleted ${path}`);
  }
});

test('tracked deletion, rename, executable mode, runtime, environment and external resources bind', async (t) => {
  const { root, put } = await fixture(t);
  await put('source.js');
  execFileSync('git', ['add', '.'], { cwd: root });
  const capture = (env = {}, runtime = {}) => mutationInputs(root, env, runtime).then(fingerprint);
  const before = await capture();
  await chmod(join(root, 'source.js'), 0o755);
  assert.notEqual(await capture(), before);
  await rm(join(root, 'source.js'));
  const deleted = await capture();
  assert.notEqual(deleted, before);
  await put('renamed.js');
  assert.notEqual(await capture(), before);
  assert.notEqual(await capture({}, { node: 'changed' }), await capture());
  assert.notEqual(await capture({ TZ: 'different' }), await capture());
  await symlink('renamed.js', join(root, 'unsupported.js'));
  await assert.rejects(capture, /nonregular/);
  assert.deepEqual(mutationEnvironment({ SECRET: 'never inherited', PROPERTY_SEED: '7' }), {
    NODE_ENV: 'test',
    PROPERTY_SEED: '7',
    NO_COLOR: '1',
  });
});

test('missing, malformed, mismatched, incomplete and unauditable baselines are cache misses', async (t) => {
  const { root, put } = await fixture(t);
  const report = { files: {} };
  const audit = (value, options) => {
    assert.deepEqual(value, report);
    assert.deepEqual(options, { nativeReuse: true });
  };
  assert.equal((await readCache(root, key, commit, audit)).report, null);
  await put(BASELINE, '{');
  assert.equal((await readCache(root, key, commit, audit)).report, null);
  await promoteCache(root, report, key, commit);
  const baseline = JSON.parse(await readFile(join(root, BASELINE), 'utf8'));
  for (const delta of [
    { completed: false },
    { key: 'c'.repeat(64) },
    { sourceCommit: 'd'.repeat(40) },
    { schemaVersion: 0 },
    { report: { survived: true } },
  ]) {
    await put(BASELINE, JSON.stringify({ ...baseline, ...delta }));
    assert.equal((await readCache(root, key, commit, audit)).report, null);
  }
  assert.throws(() => validateCache(baseline, key, null, audit));
  assert.throws(() => validateCache(baseline, key, 'local', audit));
  await assert.rejects(promoteCache(root, report, 'short', commit));
  await promoteCache(root, report, key, 'local');
  assert.deepEqual((await readCache(root, key, 'local', audit)).report, report);
  assert.equal((await readCache(root, key, commit, audit)).report, null);
});

test('admission preserves native report bytes semantically and reports native reuse honestly', async (t) => {
  const { root } = await fixture(t);
  const report = {
    files: {
      'source.ts': {
        mutants: [{ status: 'Killed', duration: 0 }, { status: 'Timeout' }, { status: 'Survived' }],
      },
    },
  };
  await promoteCache(root, report, key, commit);
  const admitted = await readCache(root, key, commit, () => {});
  assert.deepEqual(admitted.report, report);
  assert.deepEqual(executionSummary(admitted.report, true), { total: 3, executed: 1, reused: 2 });
  assert.deepEqual(executionSummary(report, false), { total: 3, executed: 3, reused: 0 });
});

test('ignored Vite test-mode environment files are explicit inputs', async (t) => {
  const { root, put } = await fixture(t);
  await put('.gitignore', '.env*\n');
  const capture = () => mutationInputs(root, {}, {}).then(fingerprint);
  for (const name of ['.env', '.env.local', '.env.test', '.env.test.local']) {
    const before = await capture();
    await put(name, 'VITE_FLAG=first');
    const added = await capture();
    assert.notEqual(added, before);
    await put(name, 'VITE_FLAG=changed');
    assert.notEqual(await capture(), added);
    await rm(join(root, name));
    assert.equal(await capture(), before);
  }
});

test('the actual runner promotes only completed local/main results with the correct identity', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('./run-mutations.mjs', import.meta.url), 'utf8');
  const block = source.split('// Promotion is last,')[1]?.split('    console.log(')[0];
  assert.ok(block);
  const program = block.slice(block.indexOf('    if ('));
  for (const [env, inputsHash, nodeOptions, expected] of [
    [{}, key, undefined, 'local'],
    [
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: commit,
      },
      key,
      undefined,
      commit,
    ],
    [
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/1/merge',
      },
      key,
      undefined,
      null,
    ],
    [{}, null, undefined, null],
    [{}, key, '--import=unreviewed', null],
  ]) {
    const calls = [];
    const report = { current: true };
    await runInNewContext(
      `(async () => {${program}})()`,
      {
        process: { env },
        inputsHash,
        env: { NODE_OPTIONS: nodeOptions },
        inputCaptureError: null,
        root: '/project',
        report,
        promoteCache: (...args) => {
          calls.push(args);
        },
      },
      { timeout: 1000 },
    );
    assert.deepEqual(calls, expected ? [['/project', report, key, expected]] : []);
  }
});
