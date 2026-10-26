// Changes to global inputs and untrusted baselines must invalidate reuse.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function restoreBaseline(context) {
  const { root, baselineCache, put, source, strongTest, strongHelper, policy } = context;
  await rm(join(root, '.cache'), { recursive: true, force: true });
  await cp(baselineCache, join(root, '.cache/mutation/validated'), { recursive: true });
  await put('src/mp3/add.ts', source);
  await put('tests/add.test.ts', strongTest);
  await put('tests/helpers/check.ts', strongHelper);
  await policy();
}

async function verifyWarmBaseline(context) {
  const { run, root, evidence, put, restore } = context;
  const cold = await run('cold', { reason: /cache missing/ });
  assert.equal(cold.execution.reused, 0);
  const baselineCache = join(evidence, 'baseline-cache');
  context.baselineCache = baselineCache;
  context.cold = cold;
  await cp(join(root, '.cache/mutation/validated'), baselineCache, { recursive: true });
  const warm = await run('warm');
  assert.equal(warm.execution.reused, cold.total);
  assert.equal(warm.execution.executed, 0);
  await run('forced-full', { full: true, reason: /forced full verification/ });
  await restore();
  await put('README.md', 'Unrelated documentation\n');
  assert.equal(
    (await run('docs-only-invalidates', { reason: /Global mutation inputs changed/ })).execution
      .reused,
    0,
  );
  await rm(join(root, 'README.md'));
}

async function verifyChangedTests(context) {
  const { restore, put, strongTest, strongHelper, run, root, baselineCache } = context;
  await restore();
  await put('tests/add.test.ts', strongTest.replace('check(add(3, 2))', 'void add(3, 2)'));
  await run('changed-test-new-survivor', {
    fails: true,
    reason: /Unreviewed Survived/,
  });
  assert.deepEqual(
    await readFile(join(root, '.cache/mutation/validated/manifest.json')),
    await readFile(join(baselineCache, 'manifest.json')),
  );
  await restore();
  await put('tests/add.test.ts', strongTest + "it('adds again', () => { check(add(3, 2)); });\n");
  assert.equal(
    (await run('added-test', { reason: /unaffected killing-test witnesses/ })).execution.reused,
    0,
  );
  await restore();
  await rm(join(root, 'tests/add.test.ts'));
  await run('removed-test', { fails: true, reason: /Global mutation inputs changed/ });
  await restore();
  await put('tests/helpers/check.ts', strongHelper.replace('.toBe(5)', '.toBeDefined()'));
  await run('changed-imported-helper-new-survivor', {
    fails: true,
    reason: /Global mutation inputs changed[\s\S]*Unreviewed Survived/,
  });
}

async function prepareWorkerFixture({ put, policy, source }) {
  const scale = 'export function scale(value: number) { return value * 2; }\n';
  await put('src/mp3/scale.ts', scale);
  await put(
    'tests/scale.test.ts',
    "import { expect, it } from 'vitest'; import { scale } from '../src/mp3/scale.js'; it('scales', () => { expect(scale(3)).toBe(6); });\n",
  );
  await policy(
    new Map([
      ['src/mp3/add.ts', source],
      ['src/mp3/scale.ts', scale],
    ]),
  );
}

export function workerOutcomes(report) {
  return Object.entries(report.files)
    .flatMap(([file, record]) =>
      record.mutants.map(({ id, status, mutatorName, replacement, location }) => ({
        file,
        source: record.source,
        id,
        status,
        mutatorName,
        replacement,
        location,
      })),
    )
    .sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
}

async function verifyWorkerSelection(context) {
  const { restore, run, root } = context;
  await restore();
  await prepareWorkerFixture(context);
  const two = await run('two-workers', {
    env: { MUTATION_WORKERS: '2' },
    reason: /Global mutation inputs changed[\s\S]*Creating 2 test runner process/,
  });
  assert.equal(two.execution.strykerWorkers, 2);
  assert.equal(two.execution.reused, 0);
  assert.equal(two.total, 4);
  const manifest = await readFile(join(root, '.cache/mutation/validated/manifest.json'));
  const report = await readFile(join(root, 'reports/mutation/mutation.json'), 'utf8');
  const four = await run('four-worker-candidate', {
    env: { MUTATION_WORKERS: '4' },
    reason: /Creating 4 test runner process[\s\S]*cache promotion disabled/,
  });
  assert.equal(four.execution.strykerWorkers, 4);
  assert.equal(four.execution.workerCandidate, true);
  assert.equal(four.execution.reused, 0);
  assert.equal(four.execution.executed, two.execution.executed);
  assert.notEqual(four.execution.inputsHash, two.execution.inputsHash);
  assert.deepEqual(
    workerOutcomes(
      JSON.parse(await readFile(join(root, 'reports/mutation/mutation.json'), 'utf8')),
    ),
    workerOutcomes(JSON.parse(report)),
  );
  assert.deepEqual(await readFile(join(root, '.cache/mutation/validated/manifest.json')), manifest);
  const warm = await run('two-workers-still-warm', { env: { MUTATION_WORKERS: '2' } });
  assert.equal(warm.execution.reused, two.total);
  assert.equal(warm.execution.executed, 0);
  await rm(join(root, 'src/mp3/scale.ts'));
  await rm(join(root, 'tests/scale.test.ts'));
  await restore();
}

async function verifySourceContext(context) {
  const { restore, source, put, policy, run, strongHelper } = context;
  await restore();
  const changed = source.replace('a + b', 'a + b + 1');
  await put('src/mp3/add.ts', changed);
  await policy(changed);
  await put('tests/helpers/check.ts', strongHelper.replace('.toBe(5)', '.toBe(6)'));
  assert.equal(
    (await run('changed-mutated-source', { reason: /Global mutation inputs changed/ })).execution
      .reused,
    0,
  );
  await restore();
  await put('src/mp3/add.ts', changed);
  await run('stale-equivalence-context', { fails: true, reason: /Parser context changed/ });
}

async function verifyGlobalInputs(context) {
  const { restore, root, put, run } = context;
  for (const [name, path, content] of [
    ['fixture', 'tests/input.json', '{"value":5}'],
    ['snapshot', 'tests/add.snap', 'snapshot'],
    ['generator', 'scripts/generator.mjs', 'export const seed = 1;'],
    ['lockfile', 'package-lock.json', '{"lockfileVersion":3}'],
    [
      'test-selection',
      'vitest.mutation.config.ts',
      "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/add.test.ts'], maxWorkers: 1, fsModuleCache: false } });\n",
    ],
  ]) {
    await restore();
    const previous = await readFile(join(root, path)).catch(() => null);
    await put(path, content);
    assert.equal(
      (await run('changed-' + name, { reason: /Global mutation inputs changed/ })).execution.reused,
      0,
    );
    if (previous) await put(path, previous);
    else await rm(join(root, path));
  }
  await restore();
  await run('changed-property-seed', {
    reason: /Global mutation inputs changed/,
    env: { PROPERTY_SEED: '9' },
  });
  await restore();
  await run('changed-timezone', {
    reason: /Global mutation inputs changed/,
    env: { TZ: 'Etc/GMT+1' },
  });
}

async function verifyMalformedCache(context) {
  const { restore, root, run, put, cold } = context;
  for (const [name, edit] of [
    [
      'wrong-version',
      (m) => {
        m.schemaVersion = 99;
      },
    ],
    [
      'incomplete',
      (m) => {
        m.completed = false;
      },
    ],
  ]) {
    await restore();
    const path = join(root, '.cache/mutation/validated/manifest.json');
    const manifest = JSON.parse(await readFile(path));
    edit(manifest);
    await writeFile(path, JSON.stringify(manifest));
    assert.equal(
      (await run(name, { reason: /Invalid or incomplete cache manifest/ })).execution.reused,
      0,
    );
  }
  await restore();
  await put('.cache/mutation/validated/report.json', '{');
  assert.equal((await run('corrupt', { reason: /Corrupt cached report/ })).execution.reused, 0);
  await restore();
  await put('.cache/mutation/working.json', '{"partial":true}');
  assert.equal((await run('partial-working-report-ignored')).execution.reused, cold.total);
}

async function verifyTrustAndExternalInputs(context) {
  const { restore, run, root, put } = context;
  await restore();
  await run('untrusted-pr-context', {
    reason: /forced full verification/,
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REF: 'refs/pull/1/merge',
      GITHUB_EVENT_NAME: 'pull_request',
    },
  });
  await restore();
  await mkdir(join(root, 'docs'), { recursive: true });
  await put('docs/expectation.md', '5');
  await put(
    'tests/helpers/check.ts',
    "import { expect } from 'vitest'; import { readFileSync } from 'node:fs'; const expected = readFileSync(new URL('../../docs/expectation.md', import.meta.url), 'utf8'); export function check(value: number) { if (expected === 'defined') expect(value).toBeDefined(); else expect(value).toBe(Number(expected)); }\n",
  );
  await run('markdown-fixture-cold');
  await put('docs/expectation.md', 'defined');
  await run('markdown-fixture-new-survivor', {
    fails: true,
    reason: /Global mutation inputs changed[\s\S]*Unreviewed Survived/,
  });
}

export async function runInvalidationScenarios(campaign) {
  const context = { ...campaign };
  context.restore = () => restoreBaseline(context);
  await verifyWarmBaseline(context);
  if (campaign.workerParity) await verifyWorkerSelection(context);
  await verifyChangedTests(context);
  await verifySourceContext(context);
  await verifyGlobalInputs(context);
  await verifyMalformedCache(context);
  await verifyTrustAndExternalInputs(context);
}
