import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCache,
  executionSummary,
  fingerprint,
  mutationEnvironment,
  mutationInputs,
  validateCache,
} from './mutation-cache.mjs';
import { sha256 } from './mutation-policy.mjs';
import { fixtureInputs } from './mutation-cache-fixture.mjs';

const sourceFile = 'src/mp3/value.ts';
const testFile = 'tests/value.test.ts';
function fixture() {
  const mutant = {
    id: 'mutant',
    status: 'Killed',
    testsCompleted: 1,
    killedBy: ['old-test-id'],
    duration: 1,
    mutatorName: 'NumberLiteral',
    replacement: '0',
    location: { start: { line: 1, column: 22 }, end: { line: 1, column: 23 } },
  };
  const report = {
    files: { [sourceFile]: { source: 'export const value = 1;', mutants: [mutant] } },
    testFiles: {
      [testFile]: {
        source: "import '../src/mp3/value.js';",
        tests: [{ id: 'old-test-id', name: 'value', location: { start: { line: 2, column: 1 } } }],
      },
    },
  };
  const inputs = fixtureInputs(
    Object.entries({ ...report.files, ...report.testFiles }).map(([file, record]) => [
      file,
      record.source,
    ]),
  );
  const policy = { contextSha256: 'context', equivalents: [] };
  const summary = { status: 'passed', total: 1 };
  const cache = createCache(report, inputs, summary, policy);
  return { report, mutant, inputs, policy, summary, ...cache };
}

const invalidDuration = 'No fresh execution: invalid duration for mutant mutant';
const invalidReuse = 'No fresh execution or validated killing-test witness for mutant mutant';
for (const status of ['Killed', 'Survived', 'Timeout', 'NoCoverage']) {
  for (const duration of [0, 1, -1, null, undefined, NaN, Infinity, '1']) {
    test(`fresh accounting preserves ${status} duration ${String(duration)}`, () => {
      const f = fixture();
      Object.assign(f.mutant, { status, duration });
      const valid =
        Number.isFinite(duration) && (status === 'Timeout' ? duration > 0 : duration >= 0);
      if (valid) assert.deepEqual(executionSummary(f.report), { executed: 1, reused: 0, total: 1 });
      else assert.throws(() => executionSummary(f.report, f.report), { message: invalidDuration });
    });
  }
}

const reuseEdits = [
  ['missing baseline mutant', (old) => old.files[sourceFile].mutants.splice(0), false],
  ['static true', (old) => (old.files[sourceFile].mutants[0].static = true), false],
  ['static truthy', (old) => (old.files[sourceFile].mutants[0].static = 'yes'), false],
  ['static false', (old) => (old.files[sourceFile].mutants[0].static = false), true],
  ['prior timeout', (old) => (old.files[sourceFile].mutants[0].status = 'Timeout'), false],
  ['current survivor', (_, now) => (now.files[sourceFile].mutants[0].status = 'Survived'), false],
  [
    'changed completed count',
    (_, now) => (now.files[sourceFile].mutants[0].testsCompleted = 2),
    false,
  ],
  ['missing prior killer', (old) => delete old.files[sourceFile].mutants[0].killedBy, false],
  ['missing current killer', (_, now) => delete now.files[sourceFile].mutants[0].killedBy, false],
  [
    'unknown prior killer',
    (old) => (old.files[sourceFile].mutants[0].killedBy = ['unknown']),
    false,
  ],
  [
    'unknown current killer',
    (_, now) => (now.files[sourceFile].mutants[0].killedBy = ['unknown']),
    false,
  ],
  ['changed test name', (_, now) => (now.testFiles[testFile].tests[0].name = 'other'), false],
  ['changed test source', (_, now) => (now.testFiles[testFile].source += '\n'), false],
  [
    'changed location',
    (_, now) => (now.testFiles[testFile].tests[0].location.start.line = 3),
    false,
  ],
  ['changed source', (_, now) => (now.files[sourceFile].source += '\n'), false],
  ['changed replacement', (_, now) => (now.files[sourceFile].mutants[0].replacement = '2'), false],
  [
    'renumbered test and mutant',
    (_, now) => {
      now.testFiles[testFile].tests[0].id = 'new-test-id';
      Object.assign(now.files[sourceFile].mutants[0], {
        id: 'new-mutant-id',
        killedBy: ['new-test-id'],
      });
    },
    true,
  ],
];
for (const [name, edit, valid] of reuseEdits) {
  test(`reuse accounting preserves ${name}`, () => {
    const old = fixture().report;
    const now = structuredClone(old);
    delete now.files[sourceFile].mutants[0].duration;
    edit(old, now);
    const before = structuredClone({ old, now });
    if (valid) assert.deepEqual(executionSummary(now, old), { executed: 0, reused: 1, total: 1 });
    else assert.throws(() => executionSummary(now, old), { message: invalidReuse });
    assert.deepEqual({ old, now }, before);
  });
}

test('inventory identity gate runs before duration or witness checks', () => {
  const baseline = fixture().report;
  const now = structuredClone(baseline);
  now.files[sourceFile].mutants[0].duration = -1;
  now.files[sourceFile].mutants.push({ ...now.files[sourceFile].mutants[0], replacement: '2' });
  assert.throws(() => executionSummary(now, baseline, baseline), {
    message: 'Full mutant inventory changed despite identical parser sources',
  });
  now.files[sourceFile].source += '\n';
  assert.throws(() => executionSummary(now, baseline, baseline), { message: invalidDuration });
});

const invalidCaches = [
  [
    'schema before digest',
    (f) => {
      f.manifest.schemaVersion = 0;
      f.manifest.inputsHash = '';
    },
    'Invalid or incomplete cache manifest',
  ],
  [
    'completion before digest',
    (f) => {
      f.manifest.completed = false;
      f.manifest.inputsHash = '';
    },
    'Invalid or incomplete cache manifest',
  ],
  [
    'input digest before global inputs',
    (f) => {
      f.manifest.inputsHash = '';
      f.inputs.files[0][1]++;
    },
    'Corrupt cached input manifest',
  ],
  [
    'global inputs before policy',
    (f) => {
      f.inputs.files[0][1]++;
      f.policy.equivalents.push({});
    },
    'Global mutation inputs changed',
  ],
  [
    'policy before report digest',
    (f) => {
      f.policy.equivalents.push({});
      f.manifest.reportSha256 = '';
    },
    'Equivalence policy changed beyond parser context',
  ],
  [
    'report digest before parse',
    (f) => {
      f.reportText = '{';
    },
    'Corrupt cached report',
  ],
  [
    'inventory after successful audit',
    (f) => {
      f.manifest.inventorySha256 = '';
    },
    'Cached inventory or audit mismatch',
  ],
  [
    'total after successful audit',
    (f) => {
      f.manifest.total = 2;
    },
    'Cached inventory or audit mismatch',
  ],
  [
    'audit object after successful audit',
    (f) => {
      f.manifest.audit = { total: 1, status: 'passed' };
    },
    'Cached inventory or audit mismatch',
  ],
];
for (const [name, edit, message] of invalidCaches) {
  test(`cache rejection order preserves ${name}`, () => {
    const f = structuredClone(fixture());
    // Cache creation retains caller objects; split them as serialized transport does.
    f.manifest = JSON.parse(JSON.stringify(f.manifest));
    edit(f);
    let audited = 0;
    assert.throws(
      () =>
        validateCache(
          f.manifest,
          f.reportText,
          f.inputs,
          () => {
            audited++;
            return f.summary;
          },
          f.policy,
        ),
      { message },
    );
    assert.equal(audited, name.endsWith('successful audit') ? 1 : 0);
  });
}

test('authentication rejects mismatched test source before calling the audit', () => {
  const f = fixture();
  f.report.testFiles[testFile].source += '\n';
  f.reportText = JSON.stringify(f.report);
  f.manifest.reportSha256 = sha256(f.reportText);
  assert.throws(
    () =>
      validateCache(
        f.manifest,
        f.reportText,
        f.inputs,
        () => {
          assert.fail('audit must not run before source authentication');
        },
        f.policy,
      ),
    { message: 'Cached report/input source mismatch' },
  );
});

test('changed unauthenticated inputs are rejected before stale report sources', () => {
  const f = fixture();
  f.inputs.files.push(['tests/unreported.test.ts', 420, 'before']);
  f.manifest.inputsHash = fingerprint(f.manifest.inputs);
  const current = structuredClone(f.inputs);
  current.files.at(-1)[2] = 'after';
  f.report.testFiles[testFile].source += '\n';
  f.reportText = JSON.stringify(f.report);
  f.manifest.reportSha256 = sha256(f.reportText);
  assert.throws(() => validateCache(f.manifest, f.reportText, current, () => f.summary, f.policy), {
    message: 'Incomplete authenticated dependency sources',
  });
});

test('successful cache authentication passes exact old sources and policy to the audit', () => {
  const f = fixture();
  const current = structuredClone(f.inputs);
  current.files[0][2] = sha256('changed source');
  current.sources[sourceFile] = 'changed source';
  const policy = { ...f.policy, contextSha256: 'reviewed new context' };
  let calls = 0;
  const validated = validateCache(
    f.manifest,
    f.reportText,
    current,
    (report, oldPolicy, sources) => {
      calls++;
      assert.deepEqual(report, f.report);
      assert.equal(oldPolicy, f.manifest.policy);
      assert.deepEqual(sources, new Map([[sourceFile, f.report.files[sourceFile].source]]));
      return f.summary;
    },
    policy,
  );
  assert.deepEqual(validated, f.report);
  assert.equal(calls, 1);
});

async function encoderFixture(body) {
  const root = await mkdtemp(join(tmpdir(), 'mutation-encoder-characterization-'));
  for (const directory of ['node_modules', 'tools']) await mkdir(join(root, directory));
  await writeFile(join(root, 'tools/npm'), '#!/bin/sh\nprintf "11.test\\n"\n', { mode: 0o700 });
  if (body !== null) await writeFile(join(root, 'tools/lame'), body, { mode: 0o700 });
  return { root, env: mutationEnvironment({ PATH: join(root, 'tools') }) };
}

test(
  'encoder absence remains distinct from an executable that fails',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await encoderFixture(null);
    try {
      assert.deepEqual((await mutationInputs(f.root, f.env)).runtime.encoder, { available: false });
      await writeFile(join(f.root, 'tools/lame'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
      await assert.rejects(mutationInputs(f.root, f.env), {
        message: 'Cannot establish LAME tool identity',
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  'encoder identity fingerprints a symlink target and stdout plus stderr',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await encoderFixture(null);
    const executable = '#!/bin/sh\nprintf "version\\n"\nprintf "warning\\n" >&2\n';
    try {
      await writeFile(join(f.root, 'tools/encoder'), executable, { mode: 0o700 });
      await symlink('encoder', join(f.root, 'tools/lame'));
      // A project input symlink is forbidden, so keep this PATH outside the project inventory.
      const project = join(f.root, 'project');
      await mkdir(join(project, 'node_modules'), { recursive: true });
      assert.deepEqual((await mutationInputs(project, f.env)).runtime.encoder, {
        available: true,
        sha256: sha256(executable),
        version: 'version\nwarning\n',
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  'encoder resolution changes during fingerprinting are rejected',
  { skip: process.platform === 'win32' },
  async () => {
    const f = await encoderFixture(null);
    try {
      const marker = join(f.root, 'marker');
      const executable =
        '#!/bin/sh\n' +
        `if [ -f '${marker}' ]; then printf 'second'; else printf 'first'; : > '${marker}'; fi\n`;
      await writeFile(join(f.root, 'tools/lame'), executable, { mode: 0o700 });
      await assert.rejects(mutationInputs(f.root, f.env), {
        message: 'LAME resolution changed during fingerprinting',
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test('global cache rejection exposes stable field and path diagnostics without values', () => {
  const f = fixture();
  const changed = structuredClone(f.inputs);
  changed.environmentSha256 = 'private-value-must-not-appear';
  changed.files.push(['tests/fixture.json', 0o644, sha256('private fixture data')]);
  assert.throws(
    () => validateCache(f.manifest, f.reportText, changed, () => f.summary, f.policy),
    (error) => {
      assert.equal(error.code, 'global-inputs-changed');
      assert.deepEqual(error.details, {
        changedFields: ['environmentSha256'],
        changedFiles: ['tests/fixture.json'],
      });
      assert.doesNotMatch(JSON.stringify(error.details), /private/);
      return true;
    },
  );
});
