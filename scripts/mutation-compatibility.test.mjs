import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCache, fingerprint, validateCache } from './mutation-cache.mjs';
import { planReuse } from './mutation-impact.mjs';
import { fixtureInputs } from './mutation-cache-fixture.mjs';
import { sha256 } from './mutation-policy.mjs';

const location = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
function fixture(extraFiles = []) {
  const files = new Map([
    ['src/mp3/a.ts', 'export const a = 1;'],
    ['src/mp3/b.ts', 'export const b = 2;'],
    ['tests/helper.ts', "export { a } from '../src/mp3/a.js';"],
    ['tests/a.test.ts', "import { a } from './helper.js';"],
    ['tests/b.test.ts', "import { b } from '../src/mp3/b.js';"],
    ['docs/guide.md', 'passive prose'],
    ...extraFiles,
  ]);
  const report = {
    files: Object.fromEntries(
      ['a', 'b'].map((name) => [
        `src/mp3/${name}.ts`,
        {
          source: files.get(`src/mp3/${name}.ts`),
          mutants: [
            {
              id: name,
              status: 'Killed',
              duration: 1,
              testsCompleted: 1,
              killedBy: [name],
              replacement: '0',
              mutatorName: 'NumberLiteral',
              location,
            },
          ],
        },
      ]),
    ),
    testFiles: Object.fromEntries(
      ['a', 'b'].map((name) => [
        `tests/${name}.test.ts`,
        {
          source: files.get(`tests/${name}.test.ts`),
          tests: [{ id: name, name, location }],
        },
      ]),
    ),
  };
  const inputs = (current = files) => fixtureInputs(current, Object.keys(report.testFiles));
  const old = inputs();
  const cache = createCache(report, old, { total: 2 });
  function plan(current = files, snapshot = inputs(current)) {
    const validated = validateCache(cache.manifest, cache.reportText, snapshot, () => ({
      total: 2,
    }));
    return planReuse(validated, new Map(Object.entries(snapshot.sources)), {
      baselineFiles: new Map(Object.entries(old.sources)),
      testFiles: Object.keys(report.testFiles),
    });
  }
  return { files, report, inputs, old, cache, plan };
}

test('unchanged inputs preserve independently witnessed kills', () => {
  assert.equal(fixture().plan().eligible, 2);
});

test('unrelated docs content and path additions retain kills but change full inventory', () => {
  const f = fixture();
  f.files.set('docs/guide.md', 'edited passive prose');
  f.files.set('docs/new.md', 'new passive prose');
  f.files.set('README.md', 'new readme');
  assert.notEqual(fingerprint(f.inputs()), fingerprint(f.old));
  assert.equal(f.plan().eligible, 2);
});

test('unrelated nonparser code and unselected tests may change, be added, or renamed', () => {
  const f = fixture();
  f.files.set('src/service.ts', "import fastify from 'fastify'; export const app = fastify();");
  f.files.set('tests/service.test.ts', "import '../src/service.js';");
  assert.equal(f.plan().eligible, 2);
  f.files.delete('src/service.ts');
  f.files.set('src/renamed.ts', "import fastify from 'fastify'; export const app = fastify();");
  f.files.set('tests/service.test.ts', "import '../src/renamed.js';");
  assert.equal(f.plan().eligible, 2);
});

for (const [path, source] of [
  ['src/mp3/a.ts', 'export const a = 3;'],
  ['tests/a.test.ts', "import { a } from './helper.js'; // changed test"],
  ['tests/helper.ts', 'export const a = 1;'],
]) {
  test(`only impacted witnesses rerun after ${path} changes`, () => {
    const f = fixture();
    f.files.set(path, source);
    const plan = f.plan();
    assert.equal(plan.eligible, 1);
    assert.deepEqual(plan.affectedTests, ['tests/a.test.ts']);
  });
}

test('an unchanged transitive resource reader never witnesses reuse after docs changes', () => {
  const f = fixture();
  const reader =
    "import { readFileSync } from 'node:fs'; export const a = readFileSync('docs/guide.md');";
  f.old.sources['tests/helper.ts'] = reader;
  f.old.files.find(([path]) => path === 'tests/helper.ts')[2] = sha256(reader);
  f.cache.manifest.inputsHash = fingerprint(f.old);
  f.files.set('tests/helper.ts', reader);
  f.files.set('docs/guide.md', 'changed assertion data');
  assert.equal(f.plan().eligible, 1);
});

for (const source of [
  "const path = './helper.js'; await import(path);",
  "import { writeFileSync } from 'node:fs';",
  "import { execSync } from 'node:child_process';",
  "export * from './missing.js';",
]) {
  test(`new opaque selected dependency fails closed: ${source}`, () => {
    const f = fixture();
    f.files.set('tests/helper.ts', source);
    assert.equal(f.plan().report, null);
  });
}

for (const path of [
  'package-lock.json',
  'tests/fixture.json',
  'scripts/runner.mjs',
  '.github/workflows/ci.yml',
  '.github/unreviewed-instructions.md',
  'docs/mutation-review.md',
  'tests/types.d.ts',
]) {
  test(`global boundary retains ${path}`, () => {
    const f = fixture();
    f.files.set(path, 'changed');
    assert.throws(() => f.plan(), /Global mutation inputs changed/);
  });
}

test('existing modes and parser inventory changes remain full misses', () => {
  const f = fixture();
  const changed = f.inputs();
  changed.files.find(([path]) => path === 'docs/guide.md')[1] = 0o755;
  assert.throws(() => f.plan(f.files, changed), /mode changed/);
  f.files.set('src/mp3/added.ts', 'export const value = 1;');
  assert.throws(() => f.plan(), /Global mutation inputs changed/);
});

for (const field of [
  'dependenciesSha256',
  'environmentSha256',
  'externalSampleSha256',
  'runtime',
]) {
  test(`actual ${field} provenance still binds reuse`, () => {
    const f = fixture();
    const changed = f.inputs();
    changed[field] = 'changed';
    assert.throws(() => f.plan(f.files, changed), /Global mutation inputs changed/);
  });
}

test('missing or corrupt old dependency source cannot be supplied from current bytes', () => {
  for (const corrupt of [false, true]) {
    const f = fixture();
    if (corrupt) f.old.sources['tests/helper.ts'] = 'unauthenticated prior source';
    else delete f.old.sources['tests/helper.ts'];
    f.cache.manifest.inputsHash = fingerprint(f.old);
    assert.throws(() => f.plan(), /authenticated dependency sources|source\/input mismatch/);
  }
});

test('old manifests without the new source/isolation obligation fail closed', () => {
  const f = fixture();
  f.cache.manifest.schemaVersion = 2;
  assert.throws(() => f.plan(), /Invalid or incomplete/);
});

test('reviewed unrelated release-smoke scripts are compatible, not mutation execution roots', () => {
  const f = fixture();
  f.files.set('scripts/release-smoke-process.mjs', "import { spawn } from 'node:child_process';");
  f.files.set('scripts/release-smoke-process.test.mjs', "import './release-smoke-process.mjs';");
  assert.equal(f.plan().eligible, 2);
});

test('every transitive runtime dependency stays global even at a normally mutable path', () => {
  const f = fixture();
  for (const [path, source] of [
    ['scripts/run-mutations.mjs', "import './runtime-helper.mjs';"],
    ['scripts/runtime-helper.mjs', "import './release-smoke-process.mjs';"],
    ['scripts/release-smoke-process.mjs', 'export const version = 1;'],
  ]) {
    f.old.files.push([path, 0o644, sha256(source)]);
    f.old.sources[path] = source;
    f.files.set(path, source);
  }
  f.cache.manifest.inputsHash = fingerprint(f.old);
  f.files.set('scripts/release-smoke-process.mjs', 'export const version = 2;');
  assert.throws(() => f.plan(), /Global mutation inputs changed/);
});

test('a new selected reader, writer or unresolved dynamic dependency cannot inherit old kills', () => {
  for (const source of [
    "import { readFileSync } from 'node:fs';",
    "import { writeFileSync } from 'node:fs';",
    "const path = './helper.js'; await import(path);",
    "const load = process.getBuiltinModule; load('fs');",
  ]) {
    const f = fixture();
    const current = new Map(f.files).set('tests/new.test.ts', source);
    const plan = planReuse(f.report, current, {
      baselineFiles: f.files,
      testFiles: [...Object.keys(f.report.testFiles), 'tests/new.test.ts'],
    });
    assert.equal(plan.report, null, source);
  }
});

test('a removed old selected but unreported root must not disappear from impact analysis', () => {
  const f = fixture();
  const old = new Map(f.files).set('tests/skipped.test.ts', 'process.getBuiltinModule(name);');
  const plan = planReuse(f.report, f.files, {
    baselineFiles: old,
    baselineTestFiles: [...Object.keys(f.report.testFiles), 'tests/skipped.test.ts'],
    testFiles: Object.keys(f.report.testFiles),
  });
  assert.equal(plan.report, null);
});

test('duplicate inventory paths cannot authenticate a substituted source key', () => {
  const f = fixture();
  f.old.files.push([...f.old.files.find(([path]) => path === 'tests/helper.ts')]);
  f.old.sources['tests/unauthenticated.ts'] = 'export const trust = true;';
  f.cache.manifest.inputsHash = fingerprint(f.old);
  assert.throws(() => f.plan(), /duplicate mutation input paths/);
});

for (const path of ['CLAUDE.md', 'TODO.md', '.github/copilot-instructions.md']) {
  test(`passive instruction prose retains kills but not the full fingerprint: ${path}`, () => {
    const f = fixture([[path, 'strict']]);
    f.files.set(path, 'loose');
    assert.notEqual(fingerprint(f.inputs()), fingerprint(f.old));
    assert.equal(f.plan().eligible, 2);
  });
  test(`transitive readers of instruction prose never witness reuse: ${path}`, () => {
    const f = fixture([[path, 'strict']]);
    const reader = `import { readFileSync } from 'node:fs'; export const a = readFileSync('${path}');`;
    f.old.sources['tests/helper.ts'] = reader;
    f.old.files.find(([name]) => name === 'tests/helper.ts')[2] = sha256(reader);
    f.cache.manifest.inputsHash = fingerprint(f.old);
    f.files.set('tests/helper.ts', reader);
    f.files.set(path, 'loose');
    const result = f.plan();
    assert.equal(result.eligible, 1);
    assert.deepEqual(result.affectedTests, ['tests/a.test.ts']);
  });
}
