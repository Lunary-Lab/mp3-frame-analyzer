import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditMutations, auditMutationShards, sha256, sourceContext } from './mutation-policy.mjs';

function fixture(count = 2) {
  const source = 'if (short) return null;\nreturn true;\n';
  const location = { start: { line: 1, column: 5 }, end: { line: 1, column: 10 } };
  const scopes = Array.from({ length: count }, (_, i) => [`src/mp3/file-${i}.ts`]);
  const sources = new Map(scopes.flat().map((file) => [file, source]));
  const policy = {
    schemaVersion: 1,
    strykerVersion: '10.1.1',
    target: 100,
    contextSha256: sourceContext(sources),
    equivalents: scopes.flat().map((file, index) => ({
      id: `EQ-${index}`,
      file,
      sourceSha256: sha256(source),
      original: 'short',
      replacement: 'false',
      mutatorName: 'ConditionalExpression',
      location,
      assumptions: 'Synthetic fixture for a source-bound equivalence gate.',
      proof:
        'Synthetic fixture only; production entries require a reviewed source-specific equivalence proof.',
    })),
  };
  const reports = scopes.map((scope) => ({
    schemaVersion: '1.0',
    framework: { name: 'StrykerJS', version: '10.1.1' },
    config: {
      mutate: scope,
      concurrency: 2,
      force: true,
      testRunner: 'vitest',
      vitest: { configFile: 'vitest.mutation.config.ts', related: false, pool: 'forks' },
      coverageAnalysis: 'perTest',
      incremental: true,
      incrementalFile: '.cache/mutation/working.json',
    },
    testFiles: {
      'tests/mp3/example.test.ts': {
        source: 'test source',
        tests: [{ id: 'test', name: 'example', location: { start: { line: 1, column: 1 } } }],
      },
    },
    files: {
      [scope[0]]: {
        source,
        mutants: [
          {
            id: '0',
            mutatorName: 'BooleanLiteral',
            replacement: 'false',
            status: 'Killed',
            testsCompleted: 1,
            killedBy: ['test'],
            duration: 0,
            location: { start: { line: 2, column: 8 }, end: { line: 2, column: 12 } },
          },
          {
            id: '1',
            mutatorName: 'ConditionalExpression',
            replacement: 'false',
            status: 'Survived',
            testsCompleted: 1,
            duration: 1,
            location,
          },
        ],
      },
    },
  }));
  return { sources, policy, scopes, reports };
}

const run = ({ reports, policy, sources, scopes, inventories }) =>
  auditMutationShards(reports, policy, sources, scopes, inventories);
const record = (f, index = 0) => f.reports[index].files[f.scopes[index][0]];
const rejected = (change, message) => {
  const f = fixture();
  change(f);
  assert.throws(() => run(f), message);
};

test('audits all files and proofs while preserving raw statuses and report-local IDs', () => {
  const f = fixture();
  const before = structuredClone(f);
  const result = run(f);
  assert.equal(result.total, 4);
  assert.equal(result.killed, 2);
  assert.equal(result.equivalent, 2);
  assert.equal(result.rawScore, 50);
  assert.equal(result.adjustedScore, 100);
  assert.equal(result.adjustedDetected, 2);
  assert.equal(result.adjustedTotal, 2);
  assert.deepEqual(result.equivalents, ['EQ-0', 'EQ-1']);
  assert.deepEqual(result.scope, [...f.sources.keys()]);
  assert.deepEqual(f, before);
  assert.throws(() => auditMutations(f.reports[0], f.policy, f.sources), /entire parser/);
});

test('supports one tiny shard and automatically expanded complete source inventories', () => {
  assert.equal(run(fixture(1)).total, 2);
  assert.equal(run(fixture(3)).total, 6);
  rejected((f) => {
    f.sources.set('src/mp3/new.ts', 'export const value = true;');
    f.policy.contextSha256 = sourceContext(f.sources);
  }, /every current parser source/);
});

test('one shard can own multiple whole files without making mutant IDs globally ambiguous', () => {
  const f = fixture();
  const second = record(f, 1);
  second.mutants.forEach((mutant) => {
    mutant.id += '-second';
  });
  f.reports[0].files[f.scopes[1][0]] = second;
  f.scopes = [f.scopes.flat()];
  f.reports[0].config.mutate = f.scopes[0];
  f.reports.pop();
  assert.equal(run(f).total, 4);
});

for (const [name, change, message] of [
  ['missing report', (f) => f.reports.pop(), /Missing or extra shard reports/],
  ['extra report', (f) => f.reports.push(f.reports[0]), /Missing or extra shard reports/],
  [
    'no scopes',
    (f) => {
      f.scopes = [];
    },
    /Missing or empty shard scopes/,
  ],
  [
    'empty scope',
    (f) => {
      f.scopes[0] = [];
    },
    /Missing or empty shard scopes/,
  ],
  [
    'duplicate scope',
    (f) => {
      f.scopes[1] = f.scopes[0];
    },
    /every current parser source/,
  ],
  [
    'omitted file',
    (f) => {
      f.reports.pop();
      f.scopes.pop();
    },
    /every current parser source/,
  ],
  [
    'missing source record',
    (f) => {
      f.reports[0].files = {};
    },
    /assigned source files/,
  ],
  [
    'cached out-of-scope file',
    (f) => {
      f.reports[0].files[f.scopes[1][0]] = record(f, 1);
    },
    /assigned source files/,
  ],
  ['wrong report ownership', (f) => f.reports.reverse(), /entire parser/],
  [
    'stale report source',
    (f) => {
      record(f).source += '// changed';
    },
    /Report source is stale/,
  ],
  [
    'changed context',
    (f) => {
      f.policy.contextSha256 = 'changed';
    },
    /Parser context changed/,
  ],
  [
    'duplicate ID within a report',
    (f) => {
      record(f).mutants[1].id = '0';
    },
    /Duplicate or invalid mutant ID/,
  ],
  [
    'no mutants in a file',
    (f) => {
      record(f).mutants = [];
    },
    /No mutants generated/,
  ],
  [
    'missing generated equivalent',
    (f) => record(f, 1).mutants.pop(),
    /exact mutant was not generated/,
  ],
  [
    'unreviewed survivor',
    (f) => {
      record(f).mutants[0].status = 'Survived';
    },
    /Unreviewed Survived/,
  ],
  [
    'unexpected killed equivalent',
    (f) => {
      record(f).mutants[1].status = 'Killed';
    },
    /unexpected status Killed/,
  ],
])
  test(`shard collection rejects ${name}`, () => rejected(change, message));

for (const [name, change, message] of [
  [
    'unforced run',
    (c) => {
      c.force = false;
    },
    /fresh execution with two workers/,
  ],
  [
    'extra workers',
    (c) => {
      c.concurrency = 4;
    },
    /fresh execution with two workers/,
  ],
  [
    'wrong Vitest config',
    (c) => {
      c.vitest.configFile = 'vitest.config.ts';
    },
    /execution configuration/,
  ],
  [
    'related test narrowing',
    (c) => {
      c.vitest.related = true;
    },
    /execution configuration/,
  ],
  [
    'disabled coverage',
    (c) => {
      c.coverageAnalysis = 'off';
    },
    /execution configuration/,
  ],
  [
    'mutator exclusion',
    (c) => {
      c.mutator = { excludedMutations: ['BooleanLiteral'] };
    },
    /exclusions/,
  ],
  [
    'whole-project glob',
    (c) => {
      c.mutate = ['src/mp3/**/*.ts'];
    },
    /entire parser/,
  ],
  [
    'range selector',
    (c) => {
      c.mutate = ['src/mp3/file-1.ts:1-2'];
    },
    /entire parser/,
  ],
  [
    'inconsistent timeout',
    (c) => {
      c.timeoutMS = 1;
    },
    /Inconsistent shard execution configurations/,
  ],
  [
    'inconsistent reporter',
    (c) => {
      c.reporters = ['clear-text'];
    },
    /Inconsistent shard execution configurations/,
  ],
])
  test(`shard collection rejects ${name}`, () =>
    rejected((f) => change(f.reports[1].config), message));

test('native test references are local to their report, even when IDs overlap', () => {
  rejected((f) => {
    f.reports[1].testFiles['tests/mp3/example.test.ts'].tests[0].id = 'other-shard-only';
    record(f, 1).mutants[0].killedBy = ['other-shard-only'];
    record(f).mutants[0].killedBy = ['other-shard-only'];
  }, /No failing-test evidence/);
  rejected((f) => {
    delete f.reports[1].testFiles;
  }, /Missing native test-file reporting/);
});

test('fresh shards reject reused results or invalid durations for every outcome', () => {
  for (const index of [0, 1]) {
    for (const duration of [undefined, null, -1, NaN, Infinity, '1'])
      rejected((f) => {
        record(f).mutants[index].duration = duration;
      }, /fresh execution evidence/);
    rejected((f) => {
      delete record(f).mutants[index].duration;
    }, /fresh execution evidence/);
  }
  rejected((f) => {
    record(f).mutants[0].status = 'Timeout';
    record(f).mutants[0].duration = 0;
  }, /Invalid timeout evidence/);
});

test('reviewed timeout accounting stays global and excludes it from adjusted detection', () => {
  const f = fixture();
  record(f, 1).mutants[1].status = 'Timeout';
  const before = structuredClone(f);
  const result = run(f);
  assert.equal(result.rawScore, 75);
  assert.equal(result.timedOut, 1);
  assert.equal(result.equivalent, 1);
  assert.equal(result.adjustedDetected, 2);
  assert.equal(result.adjustedTotal, 2);
  assert.deepEqual(result.timedOutEquivalents, ['EQ-1']);
  assert.deepEqual(f, before);
});

function rangeFixture() {
  const f = fixture(1);
  const file = [...f.sources.keys()][0];
  const original = f.reports[0];
  f.reports = original.files[file].mutants.map((mutant) => {
    const report = structuredClone(original);
    report.files[file].mutants = [structuredClone(mutant)];
    const { start, end } = mutant.location;
    report.config.mutate = [
      `${file}:${start.line}:${start.column - 1}-${end.line}:${end.column - 1}`,
    ];
    return report;
  });
  f.scopes = f.reports.map((report) => report.config.mutate);
  f.inventories = f.reports.map((report) =>
    report.files[file].mutants.map(({ location, mutatorName, replacement }) => ({
      fileName: file,
      location,
      mutatorName,
      replacement,
    })),
  );
  return f;
}

test('range reports preserve source-bound proofs and aggregate per-file counts without rewriting', () => {
  const f = rangeFixture();
  const before = structuredClone(f);
  const result = run(f);
  assert.equal(result.total, 2);
  assert.deepEqual(result.perFile['src/mp3/file-0.ts'], {
    killed: 1,
    timedOut: 0,
    equivalent: 1,
    total: 2,
  });
  assert.equal(result.adjustedScore, 100);
  assert.deepEqual(f, before);
});

test('range collection rejects missing, duplicate and misplaced native identities', () => {
  for (const change of [
    (f, file) => {
      f.reports[0].files[file].mutants.push(f.reports[1].files[file].mutants[0]);
    },
    (f, file) => {
      f.reports[0].files[file].mutants = f.reports[1].files[file].mutants;
    },
    (f, file) => {
      f.reports[0].files[file].mutants[0].replacement = 'unplanned';
    },
    (f) => {
      f.inventories[1] = f.inventories[0];
    },
    (f) => {
      f.inventories.pop();
    },
  ]) {
    const f = rangeFixture();
    change(f, [...f.sources.keys()][0]);
    assert.throws(() => run(f), /native partition/);
  }
});

for (const status of [
  'NoCoverage',
  'Ignored',
  'Pending',
  'CompileError',
  'RuntimeError',
  'Unexpected',
])
  test(`shard collection rejects incomplete ${status} outcomes`, () => {
    rejected((f) => {
      record(f).mutants[0].status = status;
    }, /Unreviewed/);
  });
