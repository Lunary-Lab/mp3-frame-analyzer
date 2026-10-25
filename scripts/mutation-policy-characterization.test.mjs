import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditMutations, sha256, sourceContext } from './mutation-policy.mjs';

// Keep these intentionally malformed reports independent of Stryker: this is a
// characterization of the auditor's trust boundary, not a second report parser.
export function fixture() {
  const file = 'src/mp3/example.ts';
  const source = 'if (short) return null;\nreturn true;\n';
  const location = { start: { line: 1, column: 5 }, end: { line: 1, column: 10 } };
  const killed = {
    id: '0',
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    status: 'Killed',
    testsCompleted: 1,
    killedBy: ['test-1'],
    location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
  };
  const equivalent = {
    id: '1',
    mutatorName: 'ConditionalExpression',
    replacement: 'false',
    status: 'Survived',
    testsCompleted: 1,
    location,
  };
  const entry = {
    id: 'EQ-example',
    file,
    sourceSha256: sha256(source),
    original: 'short',
    replacement: 'false',
    mutatorName: 'ConditionalExpression',
    location: structuredClone(location),
    assumptions: 'Only a synthetic policy-gate fixture, never a parser equivalence.',
    proof:
      'Only a synthetic policy-gate fixture; real entries require a reviewed source-specific proof.',
  };
  const sources = new Map([[file, source]]);
  const policy = {
    schemaVersion: 1,
    strykerVersion: '10.1.1',
    target: 100,
    contextSha256: sourceContext(sources),
    equivalents: [entry],
  };
  const nativeTest = {
    id: 'test-1',
    name: 'example',
    location: { start: { line: 1, column: 1 } },
  };
  const record = { source, mutants: [killed, equivalent] };
  const testRecord = { source: 'test source', tests: [nativeTest] };
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
    testFiles: { 'tests/example.test.ts': testRecord },
    files: { [file]: record },
  };
  return {
    file,
    source,
    report,
    policy,
    sources,
    entry,
    killed,
    equivalent,
    nativeTest,
    record,
    testRecord,
  };
}

const audit = ({ report, policy, sources }) => auditMutations(report, policy, sources);
const baselineResult = {
  status: 'passed',
  target: 100,
  strykerVersion: '10.1.1',
  rawScore: 50,
  adjustedScore: 100,
  adjustedDetected: 1,
  adjustedTotal: 1,
  killed: 1,
  timedOut: 0,
  equivalent: 1,
  total: 2,
  perFile: { 'src/mp3/example.ts': { killed: 1, timedOut: 0, equivalent: 1, total: 2 } },
  equivalents: ['EQ-example'],
  timedOutEquivalents: [],
  scope: ['src/mp3/example.ts'],
};

function expectRejection(change, message, errorType = Error) {
  const f = fixture();
  change(f);
  const before = structuredClone({ report: f.report, policy: f.policy, sources: f.sources });
  assert.throws(() => audit(f), { name: errorType.name, message });
  assert.deepEqual({ report: f.report, policy: f.policy, sources: f.sources }, before);
}

const rejected = [
  [
    'missing policy',
    (f) => {
      f.policy = undefined;
    },
    'Unsupported equivalence-policy schema',
  ],
  [
    'wrong policy schema',
    (f) => {
      f.policy.schemaVersion = '1';
    },
    'Unsupported equivalence-policy schema',
  ],
  [
    'weakened target',
    (f) => {
      f.policy.target = 99.999;
    },
    'The adjusted mutation gate must remain 100%',
  ],
  [
    'missing report',
    (f) => {
      f.report = null;
    },
    'Unsupported Stryker report schema',
  ],
  [
    'wrong report schema',
    (f) => {
      f.report.schemaVersion = 1;
    },
    'Unsupported Stryker report schema',
  ],
  [
    'missing framework',
    (f) => {
      delete f.report.framework;
    },
    'Stryker version changed: review the mutation policy',
  ],
  [
    'wrong framework',
    (f) => {
      f.report.framework.name = 'not-StrykerJS';
    },
    'Stryker version changed: review the mutation policy',
  ],
  [
    'wrong framework version',
    (f) => {
      f.report.framework.version = '11';
    },
    'Stryker version changed: review the mutation policy',
  ],
  [
    'missing config',
    (f) => {
      delete f.report.config;
    },
    'Mutation scope must include the entire parser',
  ],
  [
    'narrow scope',
    (f) => {
      f.report.config.mutate = ['src/mp3/example.ts'];
    },
    'Mutation scope must include the entire parser',
  ],
  [
    'extra scope',
    (f) => {
      f.report.config.mutate.push('src/*.ts');
    },
    'Mutation scope must include the entire parser',
  ],
  [
    'excluded family',
    (f) => {
      f.report.config.mutator = { excludedMutations: ['BooleanLiteral'] };
    },
    'Broad mutation exclusions are forbidden',
  ],
  [
    'ignore plugin',
    (f) => {
      f.report.config.ignorers = ['plugin'];
    },
    'Broad mutation exclusions are forbidden',
  ],
  [
    'missing source map',
    (f) => {
      f.sources = null;
    },
    'Empty parser source inventory',
  ],
  [
    'empty source map',
    (f) => {
      f.sources.clear();
    },
    'Empty parser source inventory',
  ],
  [
    'missing report files',
    (f) => {
      delete f.report.files;
    },
    'Mutation report does not contain every current parser source',
  ],
  [
    'extra report file',
    (f) => {
      f.report.files['src/mp3/extra.ts'] = f.record;
    },
    'Mutation report does not contain every current parser source',
  ],
  [
    'missing report file',
    (f) => {
      delete f.report.files[f.file];
    },
    'Mutation report does not contain every current parser source',
  ],
  [
    'stale context',
    (f) => {
      f.policy.contextSha256 = 'stale';
    },
    'Parser context changed: re-review equivalence proofs before updating the context hash',
  ],
  [
    'missing equivalent list',
    (f) => {
      delete f.policy.equivalents;
    },
    'Missing reviewed equivalent-mutant list',
  ],
  [
    'non-array equivalent list',
    (f) => {
      f.policy.equivalents = {};
    },
    'Missing reviewed equivalent-mutant list',
  ],
  [
    'empty equivalent ID',
    (f) => {
      f.entry.id = '';
    },
    'Duplicate or invalid equivalence ID',
  ],
  [
    'non-string equivalent ID',
    (f) => {
      f.entry.id = 1;
    },
    'Duplicate or invalid equivalence ID',
  ],
  [
    'duplicate equivalent ID',
    (f) => {
      f.policy.equivalents.push(structuredClone(f.entry));
    },
    'Duplicate or invalid equivalence ID',
  ],
  [
    'missing equivalent source',
    (f) => {
      f.entry.file = 'src/mp3/unknown.ts';
    },
    'Stale source context for EQ-example; re-review its proof',
  ],
  [
    'stale equivalent hash',
    (f) => {
      f.entry.sourceSha256 = 'stale';
    },
    'Stale source context for EQ-example; re-review its proof',
  ],
  [
    'changed equivalent original',
    (f) => {
      f.entry.original = 'wrong';
    },
    'Original expression changed for EQ-example',
  ],
  [
    'duplicate exact equivalent',
    (f) => {
      f.policy.equivalents.push({ ...f.entry, id: 'EQ-other' });
    },
    'Duplicate mutation exception EQ-other',
  ],
  [
    'missing test inventory',
    (f) => {
      delete f.report.testFiles;
    },
    'Missing native test-file reporting',
  ],
  [
    'empty test inventory',
    (f) => {
      f.report.testFiles = {};
    },
    'Missing native test-file reporting',
  ],
  [
    'outside test directory',
    (f) => {
      f.report.testFiles = { 'other/example.ts': f.testRecord };
    },
    'Invalid test-file provenance',
  ],
  [
    'traversing test path',
    (f) => {
      f.report.testFiles = { 'tests/../example.ts': f.testRecord };
    },
    'Invalid test-file provenance',
  ],
  [
    'missing test source',
    (f) => {
      delete f.testRecord.source;
    },
    'Invalid test-file provenance',
  ],
  [
    'non-string test source',
    (f) => {
      f.testRecord.source = {};
    },
    'Invalid test-file provenance',
  ],
  [
    'missing native tests',
    (f) => {
      delete f.testRecord.tests;
    },
    'Missing native test locations',
  ],
  [
    'empty native tests',
    (f) => {
      f.testRecord.tests = [];
    },
    'Missing native test locations',
  ],
  [
    'non-array native tests',
    (f) => {
      f.testRecord.tests = {};
    },
    'Missing native test locations',
  ],
  [
    'non-string test ID',
    (f) => {
      f.nativeTest.id = 1;
    },
    'Duplicate or invalid test ID',
  ],
  [
    'duplicate test ID',
    (f) => {
      f.testRecord.tests.push(structuredClone(f.nativeTest));
    },
    'Duplicate or invalid test ID',
  ],
  [
    'empty test name',
    (f) => {
      f.nativeTest.name = '';
    },
    'Missing native test name',
  ],
  [
    'non-string test name',
    (f) => {
      f.nativeTest.name = 1;
    },
    'Missing native test name',
  ],
  [
    'missing test location',
    (f) => {
      delete f.nativeTest.location;
    },
    'Missing native test locations',
  ],
  [
    'missing test start',
    (f) => {
      f.nativeTest.location = {};
    },
    'Missing native test locations',
  ],
  [
    'stale report source',
    (f) => {
      f.record.source += '\n';
    },
    'Report source is stale: src/mp3/example.ts',
  ],
  [
    'source suppression',
    (f) => {
      const source = f.source + '// Stryker disable all\n';
      f.sources.set(f.file, source);
      f.record.source = source;
      f.entry.sourceSha256 = sha256(source);
      f.policy.contextSha256 = sourceContext(f.sources);
    },
    'Source-level mutation suppression: src/mp3/example.ts',
  ],
  [
    'empty mutant inventory',
    (f) => {
      f.record.mutants = [];
    },
    'No mutants generated for src/mp3/example.ts',
  ],
  [
    'non-array mutant inventory',
    (f) => {
      f.record.mutants = {};
    },
    'No mutants generated for src/mp3/example.ts',
  ],
  [
    'missing mutant ID',
    (f) => {
      delete f.killed.id;
    },
    'Duplicate or invalid mutant ID',
  ],
  [
    'duplicate mutant ID',
    (f) => {
      f.equivalent.id = f.killed.id;
    },
    'Duplicate or invalid mutant ID',
  ],
  [
    'missing replacement',
    (f) => {
      delete f.killed.replacement;
    },
    'Malformed mutant in src/mp3/example.ts',
  ],
  [
    'missing mutator',
    (f) => {
      delete f.killed.mutatorName;
    },
    'Malformed mutant in src/mp3/example.ts',
  ],
  [
    'duplicate exact mutant',
    (f) => {
      f.record.mutants.push({ ...f.killed, id: '2' });
    },
    'Duplicate mutation in src/mp3/example.ts',
  ],
  [
    'untested equivalent',
    (f) => {
      f.equivalent.testsCompleted = 0;
    },
    'EQ-example was not tested',
  ],
  [
    'no killing tests',
    (f) => {
      f.killed.killedBy = [];
    },
    'No failing-test evidence for killed mutant 0',
  ],
  [
    'unknown killing test',
    (f) => {
      f.killed.killedBy = ['unknown'];
    },
    'No failing-test evidence for killed mutant 0',
  ],
  [
    'partially unknown killing tests',
    (f) => {
      f.killed.killedBy.push('unknown');
    },
    'No failing-test evidence for killed mutant 0',
  ],
  [
    'untested kill',
    (f) => {
      f.killed.testsCompleted = 0;
    },
    'No failing-test evidence for killed mutant 0',
  ],
  [
    'missing generated equivalent',
    (f) => {
      f.record.mutants.pop();
    },
    'Stale exception: its exact mutant was not generated',
  ],
  [
    'only equivalent survives',
    (f) => {
      f.record.mutants.shift();
    },
    'Adjusted mutation coverage is not exactly 100%',
  ],
  [
    'only equivalent times out',
    (f) => {
      f.record.mutants.shift();
      f.equivalent.status = 'Timeout';
      f.equivalent.duration = 1;
    },
    'Adjusted mutation coverage is not exactly 100%',
  ],
];

for (const [name, change, message] of rejected) {
  test(`auditor rejection: ${name}`, () => expectRejection(change, message));
}

for (const [path, value] of [
  [['testRunner'], 'command'],
  [['vitest'], null],
  [['vitest', 'configFile'], 'vitest.config.ts'],
  [['vitest', 'related'], true],
  [['vitest', 'pool'], 'threads'],
  [['coverageAnalysis'], 'off'],
  [['incremental'], false],
  [['incrementalFile'], '.cache/other.json'],
]) {
  test(`auditor execution invariant: ${path.join('.')}`, () => {
    expectRejection((f) => {
      const parent = path.slice(0, -1).reduce((object, key) => object[key], f.report.config);
      parent[path.at(-1)] = value;
    }, 'Unexpected mutation execution configuration');
  });
}

for (const property of ['proof', 'assumptions']) {
  for (const value of [undefined, null, 5, '', ' '.repeat(80), 'short']) {
    test(`auditor rejects ${property}: ${JSON.stringify(value)}`, () => {
      expectRejection((f) => {
        f.entry[property] = value;
      }, 'Missing equivalence proof or assumptions for EQ-example');
    });
  }
}

for (const property of ['line', 'column']) {
  for (const value of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity]) {
    test(`auditor rejects test ${property}: ${String(value)}`, () => {
      expectRejection((f) => {
        f.nativeTest.location.start[property] = value;
      }, 'Missing native test locations');
    });
  }
}

for (const status of [
  'Killed',
  'NoCoverage',
  'Ignored',
  'Pending',
  'CompileError',
  'RuntimeError',
  'Unexpected',
]) {
  test(`auditor rejects equivalent outcome: ${status}`, () => {
    expectRejection((f) => {
      f.equivalent.status = status;
    }, `EQ-example has unexpected status ${status}; re-review or remove the exception`);
  });
}

for (const status of [
  'Survived',
  'NoCoverage',
  'Ignored',
  'Pending',
  'CompileError',
  'RuntimeError',
  'Unexpected',
]) {
  test(`auditor rejects unreviewed outcome: ${status}`, () => {
    expectRejection((f) => {
      f.killed.status = status;
    }, `Unreviewed ${status} mutant src/mp3/example.ts:2 BooleanLiteral -> "false"`);
  });
}

for (const member of ['killed', 'equivalent']) {
  for (const duration of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '1']) {
    test(`auditor rejects ${member} timeout duration: ${String(duration)}`, () => {
      expectRejection(
        (f) => {
          f[member].status = 'Timeout';
          f[member].duration = duration;
        },
        `Invalid timeout evidence for mutant ${member === 'killed' ? '0' : '1'}`,
      );
    });
  }
}

for (const [name, change, message] of [
  [
    'schema before target',
    (f) => {
      f.policy.schemaVersion = 0;
      f.policy.target = 0;
    },
    'Unsupported equivalence-policy schema',
  ],
  [
    'scope before exclusions',
    (f) => {
      f.report.config.mutate = [];
      f.report.config.ignorers = ['plugin'];
    },
    'Mutation scope must include the entire parser',
  ],
  [
    'context before proof',
    (f) => {
      f.policy.contextSha256 = '';
      f.entry.proof = '';
    },
    'Parser context changed: re-review equivalence proofs before updating the context hash',
  ],
  [
    'proof before provenance',
    (f) => {
      f.entry.proof = '';
      delete f.report.testFiles;
    },
    'Missing equivalence proof or assumptions for EQ-example',
  ],
  [
    'test evidence before report source',
    (f) => {
      delete f.nativeTest.location;
      f.record.source = '';
    },
    'Missing native test locations',
  ],
  [
    'mutant identity before outcome',
    (f) => {
      f.killed.id = null;
      f.killed.status = 'Ignored';
    },
    'Duplicate or invalid mutant ID',
  ],
  [
    'equivalent status before timeout evidence',
    (f) => {
      f.equivalent.status = 'Killed';
      f.equivalent.duration = -1;
    },
    'EQ-example has unexpected status Killed; re-review or remove the exception',
  ],
  [
    'stale exception before vacuous score',
    (f) => {
      f.record.mutants.pop();
      f.policy.equivalents.push({ ...f.entry, id: 'EQ-second', replacement: 'true' });
    },
    'Stale exception: its exact mutant was not generated',
  ],
]) {
  test(`auditor failure precedence: ${name}`, () => expectRejection(change, message));
}

test('auditor preserves the complete result and all input objects', () => {
  const f = fixture();
  const before = structuredClone(f);
  assert.deepEqual(audit(f), baselineResult);
  assert.deepEqual(f, before);
});

test('auditor retains finite timeout accounting for both kinds of mutant', () => {
  const f = fixture();
  f.equivalent.status = 'Timeout';
  f.equivalent.duration = 0.5;
  f.killed.status = 'Timeout';
  f.killed.duration = 1;
  delete f.killed.testsCompleted;
  delete f.equivalent.testsCompleted;
  assert.deepEqual(audit(f), {
    ...baselineResult,
    rawScore: 100,
    killed: 0,
    timedOut: 2,
    equivalent: 0,
    perFile: { [f.file]: { killed: 0, timedOut: 2, equivalent: 0, total: 2 } },
    timedOutEquivalents: ['EQ-example'],
  });
});

test('auditor preserves empty IDs and numeric completed-test coercion already accepted by the gate', () => {
  const f = fixture();
  f.nativeTest.id = '';
  f.killed.id = '';
  f.killed.killedBy = [''];
  f.killed.testsCompleted = '1';
  f.equivalent.testsCompleted = '1';
  assert.deepEqual(audit(f), baselineResult);
});

test('auditor sorts source scopes but retains reviewed-equivalence order', () => {
  const f = fixture();
  const file = 'src/mp3/a.ts';
  f.sources.set(file, f.source);
  f.policy.contextSha256 = sourceContext(f.sources);
  f.report.files[file] = {
    source: f.source,
    mutants: [
      { ...f.killed, id: '2' },
      { ...f.equivalent, id: '3' },
    ],
  };
  f.policy.equivalents.push({ ...f.entry, file, id: 'EQ-a' });
  assert.deepEqual(audit(f), {
    ...baselineResult,
    adjustedDetected: 2,
    adjustedTotal: 2,
    killed: 2,
    equivalent: 2,
    total: 4,
    perFile: { [file]: baselineResult.perFile[f.file], [f.file]: baselineResult.perFile[f.file] },
    equivalents: ['EQ-example', 'EQ-a'],
    scope: [file, f.file],
  });
  f.report.files[file].mutants[0].id = f.killed.id;
  assert.throws(() => audit(f), { name: 'Error', message: 'Duplicate or invalid mutant ID' });
});

for (const [name, change, message] of [
  [
    'null equivalence entry',
    (f) => {
      f.policy.equivalents = [null];
    },
    "Cannot read properties of null (reading 'id')",
  ],
  [
    'null test record',
    (f) => {
      f.report.testFiles['tests/example.test.ts'] = null;
    },
    "Cannot read properties of null (reading 'source')",
  ],
  [
    'null test',
    (f) => {
      f.testRecord.tests = [null];
    },
    "Cannot read properties of null (reading 'id')",
  ],
  [
    'null source record',
    (f) => {
      f.report.files[f.file] = null;
    },
    "Cannot read properties of null (reading 'source')",
  ],
  [
    'null mutant',
    (f) => {
      f.record.mutants = [null];
    },
    "Cannot read properties of null (reading 'id')",
  ],
  [
    'non-array killing references',
    (f) => {
      f.killed.killedBy = 'test-1';
    },
    'mutant.killedBy.every is not a function',
  ],
]) {
  test(`auditor malformed-shape behavior: ${name}`, () =>
    expectRejection(change, message, TypeError));
}
