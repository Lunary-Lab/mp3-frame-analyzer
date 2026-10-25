import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  auditMutations,
  originalAt,
  sha256,
  sourceContext,
  PARSER_GLOB,
  VITEST_CONFIG,
} from './mutation-policy.mjs';

function fixture() {
  const source = 'if (short) return null;\nreturn true;\n';
  const location = { start: { line: 1, column: 5 }, end: { line: 1, column: 10 } };
  const killed = {
    id: '0',
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status: 'Killed',
    testsCompleted: 1,
    killedBy: ['all'],
    location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
  };
  const survived = {
    id: '1',
    mutatorName: 'ConditionalExpression',
    replacement: 'false',
    status: 'Survived',
    testsCompleted: 1,
    location,
  };
  const entry = {
    id: 'EQ-example',
    file: 'src/mp3/example.ts',
    sourceSha256: sha256(source),
    original: 'short',
    replacement: 'false',
    mutatorName: 'ConditionalExpression',
    location,
    assumptions: 'Example fixture used only to exercise the gate logic.',
    proof:
      'Unit-test fixture: a real policy entry requires a source-specific logical equivalence proof.',
  };
  const policy = { schemaVersion: 1, strykerVersion: '10.1.1', target: 100, equivalents: [entry] };
  const report = {
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '10.1.1' },
    config: {
      mutate: [PARSER_GLOB],
      testRunner: 'vitest',
      vitest: { configFile: VITEST_CONFIG, related: false, pool: 'forks' },
      coverageAnalysis: 'perTest',
      incremental: true,
      incrementalFile: '.cache/mutation/working.json',
    },
    testFiles: {
      'tests/example.test.ts': {
        source: 'test',
        tests: [{ id: 'all', name: 'example', location: { start: { line: 1, column: 1 } } }],
      },
    },
    files: { 'src/mp3/example.ts': { source, mutants: [killed, survived] } },
  };
  const sources = new Map([['src/mp3/example.ts', source]]);
  policy.contextSha256 = sourceContext(sources);
  return {
    policy,
    report,
    sources,
    entry,
    killed,
    survived,
  };
}

const run = ({ report, policy, sources }) => auditMutations(report, policy, sources);

test('keeps the raw score separate and never rewrites the raw report', () => {
  const f = fixture();
  const before = structuredClone(f.report);
  const result = run(f);
  assert.equal(result.rawScore, 50);
  assert.equal(result.adjustedScore, 100);
  assert.equal(result.adjustedDetected, 1);
  assert.equal(result.adjustedTotal, 1);
  assert.equal(result.equivalent, 1);
  assert.deepEqual(result.timedOutEquivalents, []);
  assert.deepEqual(f.report, before);
});

test('keeps reviewed-equivalent timeouts visible without crediting adjusted detection', () => {
  const f = fixture();
  f.survived.status = 'Timeout';
  f.survived.duration = 7759;
  delete f.survived.testsCompleted;
  const before = structuredClone(f.report);
  const result = run(f);
  assert.equal(result.rawScore, 100);
  assert.equal(result.adjustedScore, 100);
  assert.equal(result.adjustedDetected, 1);
  assert.equal(result.adjustedTotal, 1);
  assert.equal(result.killed, 1);
  assert.equal(result.timedOut, 1);
  assert.equal(result.equivalent, 0);
  assert.equal(result.total, 2);
  assert.deepEqual(result.equivalents, ['EQ-example']);
  assert.deepEqual(result.timedOutEquivalents, ['EQ-example']);
  assert.deepEqual(result.perFile['src/mp3/example.ts'], {
    killed: 1,
    timedOut: 1,
    equivalent: 0,
    total: 2,
  });
  assert.deepEqual(f.report, before);

  // A reviewed timeout cannot cover a separate, meaningful survivor.
  f.killed.status = 'Survived';
  assert.throws(() => run(f), /Unreviewed Survived/);
});

test('reviewed-equivalent timeouts require positive finite execution evidence', () => {
  for (const duration of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '7759']) {
    const f = fixture();
    f.survived.status = 'Timeout';
    f.survived.duration = duration;
    assert.throws(() => run(f), /Invalid timeout evidence/);
  }
});

test('a failing test contradicting an equivalence proof requires re-review', () => {
  const f = fixture();
  f.survived.status = 'Killed';
  f.survived.testsCompleted = 1;
  f.survived.killedBy = ['all'];
  assert.throws(() => run(f), /unexpected status Killed; re-review/);
});

test('reviewed equivalence never accepts an incomplete or invalid outcome', () => {
  for (const status of [
    'NoCoverage',
    'Ignored',
    'Pending',
    'CompileError',
    'RuntimeError',
    'Unexpected',
  ]) {
    const f = fixture();
    f.survived.status = status;
    assert.throws(() => run(f), /unexpected status .*; re-review/);
  }
});

test('new meaningful survivor is never covered by a neighboring exclusion', () => {
  const f = fixture();
  f.killed.status = 'Survived';
  assert.throws(() => run(f), /Unreviewed Survived/);
  const other = fixture();
  other.survived.replacement = 'true';
  assert.throws(() => run(other), /Unreviewed Survived/);
});

test('fails closed on incomplete, disabled or invalid mutation outcomes', () => {
  for (const status of [
    'NoCoverage',
    'Ignored',
    'Pending',
    'CompileError',
    'RuntimeError',
    'Unexpected',
  ]) {
    const f = fixture();
    f.killed.status = status;
    assert.throws(() => run(f), /Unreviewed/);
  }
  const f = fixture();
  f.survived.testsCompleted = 0;
  assert.throws(() => run(f), /was not tested/);
});

test('retains timeout counts separately and rejects absent execution evidence', () => {
  const f = fixture();
  f.killed.status = 'Timeout';
  f.killed.duration = 1234;
  assert.equal(run(f).timedOut, 1);
  assert.equal(run(f).killed, 0);
  f.killed.duration = 0;
  assert.throws(() => run(f), /timeout evidence/);
  const g = fixture();
  g.killed.killedBy = [];
  assert.throws(() => run(g), /failing-test evidence/);
});

test('new source files and an accidentally narrowed scope fail', () => {
  const f = fixture();
  f.sources.set('src/mp3/new-reader.ts', 'export const value = 1;');
  assert.throws(() => run(f), /every current parser source/);
  const g = fixture();
  g.report.config.mutate = ['src/mp3/example.ts'];
  assert.throws(() => run(g), /entire parser/);
  const h = fixture();
  h.report.files['src/mp3/example.ts'].mutants = [];
  assert.throws(() => run(h), /No mutants/);
});

test('stale exceptions cannot survive source, location or toolchain changes', () => {
  const f = fixture();
  f.entry.sourceSha256 = 'f'.repeat(64);
  assert.throws(() => run(f), /Stale source context/);
  const g = fixture();
  g.entry.original = 'something else';
  assert.throws(() => run(g), /Original expression changed/);
  const h = fixture();
  h.report.framework.version = '11.0.0';
  assert.throws(() => run(h), /Stryker version changed/);
  const j = fixture();
  j.report.files['src/mp3/example.ts'].mutants.pop();
  assert.throws(() => run(j), /not generated/);
});

test('rejects duplicate and explanation-free equivalence entries', () => {
  const f = fixture();
  f.policy.equivalents.push(structuredClone(f.entry));
  assert.throws(() => run(f), /Duplicate/);
  const g = fixture();
  g.entry.proof = 'because';
  assert.throws(() => run(g), /Missing equivalence proof/);
});

test('does not accept weakened gate settings or broad exclusions', () => {
  const f = fixture();
  f.policy.target = 95;
  assert.throws(() => run(f), /must remain 100/);
  const g = fixture();
  g.report.config.mutator = { excludedMutations: ['ConditionalExpression'] };
  assert.throws(() => run(g), /Broad mutation exclusions/);
  const h = fixture();
  h.report.config.incremental = false;
  assert.throws(() => run(h), /execution configuration/);
});

test('rejects stale reports, duplicate mutants, empty inventories and bad coordinates', () => {
  const f = fixture();
  f.report.files['src/mp3/example.ts'].source += '\n';
  assert.throws(() => run(f), /Report source is stale/);
  const g = fixture();
  g.survived.id = g.killed.id;
  assert.throws(() => run(g), /Duplicate or invalid mutant/);
  const h = fixture();
  h.sources.clear();
  assert.throws(() => run(h), /Empty parser source/);
  assert.throws(
    () => originalAt('abc', { start: { line: 0, column: 1 }, end: { line: 1, column: 2 } }),
    /coordinates/,
  );
  assert.equal(
    originalAt('abc\ndef', { start: { line: 1, column: 2 }, end: { line: 2, column: 2 } }),
    'bc\nd',
  );
});

test('changing an imported parser module invalidates a dependent equivalence proof', () => {
  const f = fixture();
  f.sources.set(
    'src/mp3/example.ts',
    f.sources.get('src/mp3/example.ts') + '// changed invariant\n',
  );
  assert.throws(() => run(f), /Parser context changed/);
});

test('forbids source-level ignore comments even if the policy context is rehashed', () => {
  const f = fixture();
  const source = f.sources.get('src/mp3/example.ts') + '// Stryker disable all\n';
  f.sources.set('src/mp3/example.ts', source);
  f.entry.sourceSha256 = sha256(source);
  f.policy.contextSha256 = sourceContext(f.sources);
  f.report.files['src/mp3/example.ts'].source = source;
  assert.throws(() => run(f), /Source-level mutation suppression/);
});

test('never declares vacuous 100% when every mutant is excepted', () => {
  for (const status of ['Survived', 'Timeout']) {
    const f = fixture();
    f.report.files['src/mp3/example.ts'].mutants.shift();
    f.survived.status = status;
    f.survived.duration = 7759;
    assert.throws(() => run(f), /not exactly 100%/);
  }
});

test('native test locations and killing-test references are mandatory', () => {
  const f = fixture();
  delete f.report.testFiles;
  assert.throws(() => run(f), /test-file reporting/);
  const g = fixture();
  delete g.report.testFiles['tests/example.test.ts'].tests[0].location;
  assert.throws(() => run(g), /test locations/);
  const h = fixture();
  h.killed.killedBy = ['invented-test'];
  assert.throws(() => run(h), /failing-test evidence/);
});
