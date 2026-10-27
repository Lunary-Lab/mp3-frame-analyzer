import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineValidator } from './mutation-baseline-validation.mjs';
import { createCache } from './mutation-cache.mjs';
import { fixtureInputs } from './mutation-cache-fixture.mjs';
import { auditMutations, sourceContext } from './mutation-policy.mjs';

function fixture() {
  const source = 'export const value = 1;';
  const testSource = "import { value } from '../src/helper.js'; export const observed = value;";
  const helper = "export { value } from './mp3/example.js';";
  const inputs = fixtureInputs([
    ['src/mp3/example.ts', source],
    ['src/helper.ts', helper],
    ['tests/example.test.ts', testSource],
  ]);
  const sources = new Map([['src/mp3/example.ts', source]]);
  const policy = {
    schemaVersion: 1,
    strykerVersion: '10.1.1',
    target: 100,
    equivalents: [],
    contextSha256: sourceContext(sources),
  };
  const report = {
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '10.1.1' },
    config: {
      mutate: ['src/mp3/**/*.ts'],
      testRunner: 'vitest',
      vitest: { configFile: 'vitest.mutation.config.ts', related: false, pool: 'forks' },
      coverageAnalysis: 'perTest',
      incremental: true,
      incrementalFile: '.cache/mutation/working.json',
    },
    testFiles: {
      'tests/example.test.ts': {
        source: testSource,
        tests: [{ id: 'test', name: 'example', location: { start: { line: 1, column: 1 } } }],
      },
    },
    files: {
      'src/mp3/example.ts': {
        source,
        mutants: [
          {
            id: '0',
            mutatorName: 'NumberLiteral',
            replacement: '0',
            status: 'Killed',
            testsCompleted: 1,
            killedBy: ['test'],
            duration: 1,
            location: { start: { line: 1, column: 22 }, end: { line: 1, column: 23 } },
          },
        ],
      },
    },
  };
  const summary = auditMutations(report, policy, sources);
  const cache = createCache(report, inputs, summary, policy, 'a'.repeat(40));
  return { inputs, policy, report, summary, cache, source, testSource };
}

test('production candidate validation requires the real complete cache audit and an eligible killing witness', () => {
  const f = fixture();
  const validate = baselineValidator(f.inputs, f.policy);
  assert.equal(validate(f.cache), true);
  for (const patch of [
    { completed: false },
    { reportSha256: '0'.repeat(64) },
    { inputsHash: '0'.repeat(64) },
    { inventorySha256: '0'.repeat(64) },
    { total: f.summary.total + 1 },
    { audit: {} },
  ])
    assert.throws(() => validate({ ...f.cache, manifest: { ...f.cache.manifest, ...patch } }));
  const survivor = structuredClone(f.report);
  survivor.files['src/mp3/example.ts'].mutants[0].status = 'Survived';
  const unaudited = createCache(survivor, f.inputs, f.summary, f.policy, 'a'.repeat(40));
  assert.throws(() => validate(unaudited), /Unreviewed Survived/);
});

test('authenticated changed helper inputs cannot use the previous killing witness', () => {
  const f = fixture();
  const current = fixtureInputs([
    ['src/mp3/example.ts', f.source],
    ['src/helper.ts', 'export const value = 1;'],
    ['tests/example.test.ts', f.testSource],
  ]);
  assert.equal(baselineValidator(current, f.policy)(f.cache), false);
});

test('production candidate validation rejects incompatible runtime configuration and proof changes', () => {
  const f = fixture();
  const changedPolicy = { ...f.policy, target: 99 };
  assert.throws(() => baselineValidator(f.inputs, changedPolicy)(f.cache), /Equivalence policy/);
  const unsupported = structuredClone(f.inputs);
  delete unsupported.sources['vitest.config.ts'];
  assert.throws(() => baselineValidator(unsupported, f.policy), /Incomplete authenticated/);
  const globalChange = structuredClone(f.inputs);
  globalChange.dependenciesSha256 = 'new installed bytes';
  assert.throws(() => baselineValidator(globalChange, f.policy)(f.cache), /Global mutation inputs/);
});
