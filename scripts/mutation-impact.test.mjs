import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planReuse, testClosures } from './mutation-impact.mjs';
import {
  createCache,
  globalFingerprint,
  validateCache,
  executionSummary,
} from './mutation-cache.mjs';
import { sha256 } from './mutation-policy.mjs';
const location = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
function fixture() {
  const files = new Map([
    ['src/mp3/a.ts', 'export const a = 1;'],
    ['src/mp3/b.ts', 'export const b = 2;'],
    ['src/mp3/caller.ts', "export { a } from './a.js';"],
    ['tests/a.test.ts', "import { a } from '../src/mp3/caller.js';"],
    ['tests/b.test.ts', "import { b } from '../src/mp3/b.js';"],
  ]);
  const mutant = (id) => ({
    id,
    status: 'Killed',
    testsCompleted: 1,
    killedBy: [id],
    duration: 1,
    replacement: '0',
    mutatorName: 'NumberLiteral',
    location,
  });
  const report = {
    files: Object.fromEntries(
      ['a', 'b', 'caller'].map((name, index) => [
        `src/mp3/${name}.ts`,
        { source: files.get(`src/mp3/${name}.ts`), mutants: [mutant(String(index % 2))] },
      ]),
    ),
    testFiles: Object.fromEntries(
      ['a', 'b'].map((name, index) => [
        `tests/${name}.test.ts`,
        {
          source: files.get(`tests/${name}.test.ts`),
          tests: [{ id: String(index), name, location }],
        },
      ]),
    ),
  };
  return { files, report };
}
test('changed caller invalidates callee killers; independent test witnesses are retained', () => {
  const f = fixture();
  f.files.set('src/mp3/caller.ts', 'export const a = 1;');
  const plan = planReuse(f.report, f.files);
  assert.deepEqual(plan.affectedTests, ['tests/a.test.ts']);
  assert.equal(plan.eligible, 1);
  assert.equal(plan.report.files['src/mp3/b.ts'].mutants.length, 1);
  assert.equal(plan.report.files['src/mp3/a.ts'].mutants.length, 0);
});
test('changed test invalidates its old kills while numeric IDs are not witness identities', () => {
  const f = fixture();
  f.files.set('tests/a.test.ts', f.files.get('tests/a.test.ts') + '\n// changed');
  const plan = planReuse(f.report, f.files);
  assert.equal(plan.eligible, 1);
  const warm = structuredClone(plan.report);
  delete warm.files['src/mp3/b.ts'].mutants[0].duration;
  warm.testFiles['tests/b.test.ts'].tests[0].id = 'renumbered';
  warm.files['src/mp3/b.ts'].mutants[0].killedBy = ['renumbered'];
  assert.equal(executionSummary(warm, plan.report).reused, 1);
  warm.testFiles['tests/b.test.ts'].tests[0].name = 'different';
  assert.throws(() => executionSummary(warm, plan.report), /No fresh execution/);
});
test('follows re-exports, cycles and literal imports', () => {
  const files = new Map([
    ['tests/x.test.ts', "import '../src/a.js'; import('../src/c.js');"],
    ['src/a.ts', "export * from './b.js';"],
    ['src/b.ts', "export * from './a.js';"],
    ['src/c.ts', 'export const c=1;'],
  ]);
  const closure = testClosures(files, ['tests/x.test.ts']).get('tests/x.test.ts');
  assert.equal(closure.uncertain, false);
  assert.equal(closure.files.size, 4);
});
test('dynamic, deleted, ambiguous, unknown package and stateful imports fall back full', () => {
  for (const source of [
    'import(name);',
    "import './missing.js';",
    "import 'unknown-package';",
    "import { writeFile } from 'node:fs/promises';",
    "import { execSync } from 'node:child_process';",
    'eval(code);',
    'process.getBuiltinModule(name);',
  ]) {
    const f = fixture();
    f.files.set('tests/a.test.ts', source);
    assert.equal(planReuse(f.report, f.files).report, null, source);
  }
  const f = fixture();
  f.files.delete('src/mp3/a.ts');
  assert.equal(planReuse(f.report, f.files).report, null);
  const g = fixture();
  g.files.set('src/mp3/a.js', 'export const a=2;');
  assert.equal(planReuse(g.report, g.files).report, null);
});
test('readonly-filesystem killers are never reusable even with identical project inputs', () => {
  const f = fixture();
  const source = "import { readFileSync } from 'node:fs';";
  f.files.set('tests/b.test.ts', source);
  f.report.testFiles['tests/b.test.ts'].source = source;
  assert.deepEqual(planReuse(f.report, f.files).affectedTests, ['tests/b.test.ts']);
  f.files.set('src/mp3/a.ts', 'export const a=2;');
  const plan = planReuse(f.report, f.files);
  assert.deepEqual(plan.affectedTests, ['tests/a.test.ts', 'tests/b.test.ts']);
  assert.equal(plan.eligible, 0);
});
test('equivalents, static and timeout outcomes never seed selective reuse', () => {
  const f = fixture();
  const mutants = f.report.files['src/mp3/b.ts'].mutants;
  for (const patch of [{ status: 'Survived' }, { status: 'Timeout' }, { static: true }])
    mutants.push({ ...mutants[0], ...patch });
  const plan = planReuse(f.report, f.files);
  assert.equal(plan.eligible, 3);
  assert.equal(plan.rerun, 3);
});
test('global invalidation retains path/mode identity and all non-parser/test inputs', () => {
  const input = {
    files: [
      ['src/mp3/a.ts', 420, 'a'],
      ['tests/a.test.ts', 420, 'a'],
      ['mutation-equivalents.json', 420, 'a'],
      ['tests/helper.ts', 420, 'a'],
    ],
  };
  for (const index of [0, 1, 2]) {
    const changed = structuredClone(input);
    changed.files[index][2] = 'b';
    assert.equal(globalFingerprint(changed), globalFingerprint(input));
  }
  for (const edit of [
    (x) => x.files[0][1]++,
    (x) => (x.files[0][0] = 'src/mp3/renamed.ts'),
    (x) => x.files.pop(),
    (x) => x.files.push(['tests/new.test.ts', 420, 'a']),
    (x) => (x.files[3][2] = 'b'),
  ]) {
    const changed = structuredClone(input);
    edit(changed);
    assert.notEqual(globalFingerprint(changed), globalFingerprint(input));
  }
});
test('changed unreported tests and any equivalence proof changes invalidate baseline', () => {
  const f = fixture();
  const inputs = { files: [...f.files].map(([name, source]) => [name, 420, sha256(source)]) };
  inputs.files.push(['tests/unreported.test.ts', 420, sha256('before')]);
  const policy = { contextSha256: 'before', equivalents: [{ proof: 'same' }] };
  const summary = { total: 3 };
  const cache = createCache(f.report, inputs, summary, policy);
  const current = structuredClone(inputs);
  current.files.at(-1)[2] = sha256('after');
  assert.throws(
    () => validateCache(cache.manifest, cache.reportText, current, () => summary, policy),
    /lacks authenticated prior source/,
  );
  assert.doesNotThrow(() =>
    validateCache(cache.manifest, cache.reportText, inputs, () => summary, {
      ...policy,
      contextSha256: 'after',
    }),
  );
  assert.throws(
    () =>
      validateCache(cache.manifest, cache.reportText, inputs, () => summary, {
        ...policy,
        equivalents: [],
      }),
    /policy changed/,
  );
});
