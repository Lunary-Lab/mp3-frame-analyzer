import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import {
  BASELINE,
  PR_BASELINE,
  pullRequestIdentity,
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
    'docs/mutation-review.md',
    'scripts/runtime-architecture.mjs',
    'scripts/runtime-architecture-rule.mjs',
    'scripts/runtime-architecture.test.mjs',
    'scripts/runtime-architecture-native.test.mjs',
    'tests/runtime-architecture/example.fixture',
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
    'mutation-equivalents.json',
    '.github/actions/test-mutations/action.yml',
    'scripts/runtime-architecture-extra.mjs',
    '.semgrep.yml',
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

test('editorial review edits preserve admission while current audit and proof inputs still bind', async (t) => {
  const { root, put } = await fixture(t);
  await put('.gitignore', '.cache/\n');
  await put('docs/mutation-review.md', 'Editorial review notes');
  await put('mutation-equivalents.json', '{"approvals":[]}');
  const capture = () => mutationInputs(root, {}, {}).then(fingerprint);
  const before = await capture();
  const report = { files: {} };
  await promoteCache(root, report, before, commit);
  await put('docs/mutation-review.md', 'Updated editorial review notes');
  const after = await capture();
  assert.equal(after, before);
  let audits = 0;
  const audit = (value, options) => {
    audits++;
    assert.deepEqual(value, report);
    assert.deepEqual(options, { nativeReuse: true });
    if (audits > 1) throw new Error('Current policy rejected the report');
  };
  assert.deepEqual(await readCache(root, after, commit, audit), {
    report,
    reason: 'native-same-input-reuse',
  });
  assert.equal(audits, 1);
  assert.deepEqual(await readCache(root, after, commit, audit), {
    report: null,
    reason: 'native-baseline-corrupt-or-unauditable',
  });
  assert.equal(audits, 2);
  await put('mutation-equivalents.json', '{"approvals":[{"changed":true}]}');
  const changedProof = await capture();
  assert.notEqual(changedProof, before);
  assert.deepEqual(await readCache(root, changedProof, commit, audit), {
    report: null,
    reason: 'native-baseline-incompatible',
  });
  assert.equal(audits, 2);
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
  assert.deepEqual(await readCache(root, key, commit, audit), {
    report: null,
    reason: 'native-baseline-missing',
  });
  await put(BASELINE, '{');
  assert.deepEqual(await readCache(root, key, commit, audit), {
    report: null,
    reason: 'native-baseline-corrupt-or-unauditable',
  });
  await promoteCache(root, report, key, commit);
  const baseline = JSON.parse(await readFile(join(root, BASELINE), 'utf8'));
  for (const [delta, reason] of [
    [{ completed: false }, 'native-baseline-incompatible'],
    [{ key: 'c'.repeat(64) }, 'native-baseline-incompatible'],
    [{ sourceCommit: 'd'.repeat(40) }, 'native-baseline-incompatible'],
    [{ schemaVersion: 0 }, 'native-baseline-incompatible'],
    [{ report: { survived: true } }, 'native-baseline-corrupt-or-unauditable'],
  ]) {
    await put(BASELINE, JSON.stringify({ ...baseline, ...delta }));
    assert.deepEqual(await readCache(root, key, commit, audit), { report: null, reason });
  }
  assert.throws(() => validateCache(baseline, key, null, audit));
  assert.throws(() => validateCache(baseline, key, 'local', audit));
  await assert.rejects(promoteCache(root, report, 'short', commit));
  await promoteCache(root, report, key, 'local');
  assert.deepEqual((await readCache(root, key, 'local', audit)).report, report);
  assert.equal((await readCache(root, key, commit, audit)).report, null);
  await rm(join(root, BASELINE));
  await mkdir(join(root, BASELINE));
  assert.deepEqual(await readCache(root, key, commit, audit), {
    report: null,
    reason: 'native-baseline-unreadable',
  });
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

test('the actual runner promotes only completed scope-correct results with the correct identity', async () => {
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
    [
      {
        GITHUB_ACTIONS: 'true',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/7/merge',
        GITHUB_REPOSITORY_ID: '42',
      },
      key,
      undefined,
      'pr:42:7',
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
        prIdentity: inputsHash && !nodeOptions ? pullRequestIdentity(env) : null,
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

test('own-PR identity survives a SHA change but cannot cross PR, input or main scopes', async (t) => {
  const { root, put } = await fixture(t);
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_REPOSITORY_ID: '42',
    GITHUB_SHA: commit,
  };
  const identity = pullRequestIdentity(env);
  assert.equal(identity, 'pr:42:7');
  assert.equal(pullRequestIdentity({ ...env, GITHUB_SHA: 'c'.repeat(40) }), identity);
  for (const delta of [
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_ACTIONS: '' },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REF: 'refs/pull/7/head' },
    { GITHUB_REPOSITORY_ID: '' },
  ])
    assert.equal(pullRequestIdentity({ ...env, ...delta }), null);
  const report = { files: {} };
  await promoteCache(root, report, key, identity);
  const envelope = JSON.parse(await readFile(join(root, PR_BASELINE), 'utf8'));
  assert.equal(envelope.prIdentity, identity);
  assert.equal(Object.hasOwn(envelope, 'sourceCommit'), false);
  assert.deepEqual((await readCache(root, key, identity, () => {})).report, report);
  for (const [otherKey, otherIdentity] of [
    [key, 'pr:42:8'],
    [key, 'pr:43:7'],
    [key, commit],
    ['c'.repeat(64), identity],
  ])
    assert.equal((await readCache(root, otherKey, otherIdentity, () => {})).report, null);
  await put(PR_BASELINE, '{partial');
  assert.equal((await readCache(root, key, identity, () => {})).report, null);
});

test('actual runner admission isolates full mode and PR-cache hits from main artifact identity', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('./run-mutations.mjs', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('    const force ='),
    source.indexOf('    await mkdir(dirname(join(root, WORKING_REPORT))'),
  );
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_REPOSITORY_ID: '42',
    MUTATION_BASELINE_SHA: commit,
    MUTATION_PR_CACHE_RESTORED: 'true',
  };
  for (const [delta, args, expected] of [
    [{}, [], 'pr:42:7'],
    [{ MUTATION_PR_CACHE_RESTORED: 'false' }, [], commit],
    [{ MUTATION_PR_CACHE_RESTORED: '' }, [], commit],
    [{ GITHUB_EVENT_NAME: 'push' }, [], commit],
    [{ GITHUB_EVENT_NAME: 'pull_request_target' }, [], commit],
    [{ GITHUB_REF: 'refs/heads/release' }, [], commit],
    [{}, ['--full'], null],
  ]) {
    const calls = [];
    await runInNewContext(
      `(async () => {${block}})()`,
      {
        args,
        env: {},
        inputsHash: key,
        process: { env: { ...env, ...delta } },
        pullRequestIdentity,
        root: '/project',
        audit: () => {},
        readCache: async (...values) => {
          calls.push(values);
          return { report: null };
        },
      },
      { timeout: 1000 },
    );
    assert.deepEqual(
      calls.map((values) => values[2]),
      expected ? [expected] : [],
    );
  }
});

test('official PR cache requires exact successful hits and saves only after encoder verification', async () => {
  const { parse } = await import('yaml');
  const { runInNewContext } = await import('node:vm');
  const action = parse(
    await readFile(
      new URL('../.github/actions/test-mutations/action.yml', import.meta.url),
      'utf8',
    ),
  );
  const steps = action.runs.steps;
  const keyStep = steps.find((step) => step.id === 'pr-key');
  const restore = steps.find((step) => step.id === 'pr-cache');
  const save = steps.find((step) => step.uses?.startsWith('actions/cache/save@'));
  assert.deepEqual(Object.keys(restore.with).sort(), ['key', 'path']);
  assert.equal(save.with.key, restore.with.key);
  assert.equal(save.with.path, PR_BASELINE);
  assert.doesNotMatch(save.with.key, /sha|restore-keys/);
  assert.equal(restore['continue-on-error'], true);
  assert.equal(save['continue-on-error'], true);
  assert.ok(
    steps.indexOf(save) >
      steps.findIndex((step) => step.run?.startsWith('node scripts/verify-encoder-discovery')),
  );
  const expression = steps
    .find((step) => step.run?.includes('run-mutations.mjs --full'))
    .env.MUTATION_PR_CACHE_RESTORED.slice(3, -2)
    .replaceAll('steps.pr-cache', "steps['pr-cache']")
    .replaceAll('.cache-hit', "['cache-hit']");
  for (const outcome of ['success', 'failure', 'skipped'])
    for (const hit of ['true', 'false', ''])
      assert.equal(
        runInNewContext(expression, {
          steps: { 'pr-cache': { outcome, outputs: { 'cache-hit': hit } } },
        }),
        outcome === 'success' && hit === 'true',
      );
  for (const [event, ref, full, expected] of [
    ['pull_request', 'refs/pull/7/merge', 'false', true],
    ['pull_request_target', 'refs/pull/7/merge', 'false', false],
    ['workflow_dispatch', 'refs/pull/7/merge', 'false', false],
    ['pull_request', 'refs/pull/7/head', 'false', false],
    ['pull_request', 'refs/pull/7/merge', 'true', false],
  ])
    assert.equal(
      runInNewContext(keyStep.if, {
        inputs: { full },
        github: { event_name: event, ref, event: { pull_request: { number: 7 } } },
        format: (pattern, number) => pattern.replace('{0}', number),
      }),
      expected,
    );
});

test('restored CI envelopes cannot be mistaken for this invocation completing promotion', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('./run-mutations.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('    // CI transport files');
  const block = source.slice(start, source.indexOf('    console.log(`Mutation cache:', start));
  assert.ok(start > source.indexOf('if (cache.report) await writeFile'));
  assert.ok(start < source.indexOf('await promoteCache'));
  for (const ci of ['true', '']) {
    const removed = [];
    await runInNewContext(
      `(async () => {${block}})()`,
      {
        process: { env: { GITHUB_ACTIONS: ci } },
        BASELINE,
        PR_BASELINE,
        root: '/project',
        join,
        rm: async (path) => {
          removed.push(path);
        },
      },
      { timeout: 1000 },
    );
    assert.deepEqual(
      removed,
      ci ? [join('/project', BASELINE), join('/project', PR_BASELINE)] : [],
    );
  }
});
