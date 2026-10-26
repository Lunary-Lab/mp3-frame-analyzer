import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fingerprint,
  globalFingerprint,
  mutationEnvironment,
  mutationInputs,
} from './mutation-cache.mjs';
import { mutationHardware, mutationWorkers } from './mutation-workers.mjs';
import { workerOutcomes } from './mutation-invalidation-scenarios.mjs';

const config = { concurrency: 2 };

test('worker parity ignores completion order, not mutant identity or outcome drift', () => {
  const mutant = {
    id: '0',
    status: 'Killed',
    mutatorName: 'ArithmeticOperator',
    replacement: 'a - b',
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
  };
  const before = {
    files: {
      'a.ts': { source: 'a + b', mutants: [mutant, { ...mutant, id: '1', replacement: 'a * b' }] },
      'b.ts': { source: 'b + c', mutants: [{ ...mutant, id: '2' }] },
    },
  };
  const reordered = structuredClone(before);
  reordered.files['a.ts'].mutants.reverse();
  reordered.files = Object.fromEntries(Object.entries(reordered.files).reverse());
  assert.deepEqual(workerOutcomes(before), workerOutcomes(reordered));
  for (const [field, value] of [
    ['id', '9'],
    ['status', 'Timeout'],
    ['mutatorName', 'BlockStatement'],
    ['replacement', '{}'],
    ['location', { ...mutant.location, end: { line: 1, column: 7 } }],
  ]) {
    const changed = structuredClone(before);
    changed.files['a.ts'].mutants[0][field] = value;
    assert.notDeepEqual(workerOutcomes(before), workerOutcomes(changed), field);
  }
  const changedSource = structuredClone(before);
  changedSource.files['a.ts'].source = 'a + c';
  assert.notDeepEqual(workerOutcomes(before), workerOutcomes(changedSource));
});

test('local default is at most two workers and explicit choices are CPU-bounded', () => {
  assert.equal(mutationWorkers(config, undefined, 8), 2);
  assert.equal(mutationWorkers(config, undefined, 1), 1);
  assert.equal(mutationWorkers({ concurrency: 1 }, undefined, 8), 1);
  for (const count of [1, 2, 4]) assert.equal(mutationWorkers(config, String(count), 4), count);
  assert.throws(() => mutationWorkers(config, '4', 2), /exceed available CPU/);
  assert.throws(() => mutationWorkers(config, '2', 1), /exceed available CPU/);
});

test('malformed requests fail without echoing their value or accepting silent defaults', () => {
  for (const requested of ['', '0', '3', '5', '-1', '2.0', ' 4', '04', '50%', 'secret-token']) {
    assert.throws(() => mutationWorkers(config, requested, 8), {
      message: 'MUTATION_WORKERS must be exactly 1, 2 or 4',
    });
  }
  for (const available of [0, -1, 1.5, NaN])
    assert.throws(() => mutationWorkers(config, '1', available), /Cannot establish/);
  for (const changed of [
    { concurrency: 4 },
    { concurrency: '50%' },
    { ...config, checkers: ['typescript'] },
  ])
    assert.throws(
      () => mutationWorkers(changed, undefined, 8),
      /safe 1\/2-worker config without checkers/,
    );
});

test('the selected worker count changes full and compatibility hashes without environment disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mutation-workers-'));
  try {
    await mkdir(join(root, 'node_modules'));
    const env = mutationEnvironment();
    const two = await mutationInputs(root, env, 2);
    const four = await mutationInputs(root, env, 4);
    assert.equal(two.runtime.strykerWorkers, 2);
    assert.equal(four.runtime.strykerWorkers, 4);
    assert.notEqual(fingerprint(two), fingerprint(four));
    assert.notEqual(globalFingerprint(two), globalFingerprint(four));
    assert.deepEqual({ ...two.runtime, strykerWorkers: 4 }, four.runtime);
    assert.equal(fingerprint(await mutationInputs(root, env, 2)), fingerprint(two));
    assert.equal(mutationEnvironment({ MUTATION_WORKERS: '4' }).MUTATION_WORKERS, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hardware diagnostics contain only explicit capacity fields and honest unmeasured metrics', () => {
  const hardware = mutationHardware(2);
  assert.deepEqual(Object.keys(hardware), [
    'strykerWorkers',
    'availableParallelism',
    'logicalCpuCount',
    'architecture',
    'platform',
    'totalMemoryBytes',
    'freeMemoryBytesAtStart',
    'availableMemoryBytesAtStart',
    'constrainedMemoryBytes',
    'workerPeakRssBytes',
    'workerCpuUtilization',
    'resourceMeasurement',
  ]);
  assert.equal(hardware.strykerWorkers, 2);
  assert.ok(hardware.availableParallelism >= 1);
  assert.ok(hardware.totalMemoryBytes > 0);
  assert.equal(hardware.workerPeakRssBytes, null);
  assert.equal(hardware.workerCpuUtilization, null);
  assert.match(hardware.resourceMeasurement, /not collected/);
});

test('CI opts into four workers only manually and preserves the existing worker and safety config', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /mutation_workers:\n[^]*?type: choice\n\s+options: \['2', '4'\]\n\s+default: '2'/,
  );
  assert.match(workflow, /MUTATION_WORKERS: \$\{\{ inputs\.mutation_workers \|\| '2' \}\}/);
  assert.match(workflow, /npm run test:mutation-cache:integration -- --workers/);
  const stryker = JSON.parse(await readFile(new URL('../stryker.config.json', import.meta.url)));
  assert.equal(stryker.concurrency, 2);
  assert.equal(stryker.timeoutMS, 2000);
  assert.deepEqual(stryker.mutate, ['src/mp3/**/*.ts']);
  assert.deepEqual(stryker.thresholds, { high: 100, low: 100, break: 0 });
  const vitest = await readFile(new URL('../vitest.mutation.config.ts', import.meta.url), 'utf8');
  assert.match(vitest, /maxWorkers: 1/);
});
