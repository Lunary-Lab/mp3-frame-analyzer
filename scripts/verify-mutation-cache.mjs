// Real Stryker/Vitest regression campaign, deliberately separate from fast unit tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sourceContext } from './mutation-policy.mjs';
import { executionSummary, inventory } from './mutation-cache.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const evidence = resolve(process.argv[2] ?? 'reports/mutation-cache-validation');
await mkdir(evidence, { recursive: true });
const root = await mkdtemp(join(tmpdir(), 'mutation-functional-'));
const results = [];
const source = 'export function add(a: number, b: number) { return a + b; }\n';
const strongTest =
  "import { it } from 'vitest';\nimport { add } from '../src/mp3/add.js';\nimport { check } from './helpers/check.js';\nit('adds', () => { check(add(3, 2)); });\n";
const strongHelper =
  "import { expect } from 'vitest';\nexport function check(value: number) { expect(value).toBe(5); }\n";
async function put(path, text) {
  await writeFile(join(root, path), text);
}
async function policy(text = source) {
  await put(
    'mutation-equivalents.json',
    JSON.stringify({
      schemaVersion: 1,
      strykerVersion: '10.1.1',
      target: 100,
      contextSha256: sourceContext(
        text instanceof Map ? text : new Map([['src/mp3/add.ts', text]]),
      ),
      equivalents: [],
    }),
  );
}
async function run(name, { full = false, fails = false, reason, env = {} } = {}) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ['scripts/run-mutations.mjs', ...(full ? ['--full'] : [])],
    {
      cwd: root,
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_REF: '', GITHUB_EVENT_NAME: '', ...env },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const log = result.stdout + result.stderr;
  await writeFile(join(evidence, name + '.log'), log);
  await cp(join(root, 'reports/mutation'), join(evidence, name), { recursive: true }).catch(
    () => {},
  );
  assert.equal(result.error, undefined, name);
  assert.equal(result.status, fails ? 1 : 0, `${name}\n${log}`);
  if (reason) assert.match(log, reason, name);
  let audit = null;
  if (!fails) {
    audit = JSON.parse(await readFile(join(root, 'reports/mutation/audit.json'), 'utf8'));
    await cp(join(root, 'reports/mutation'), join(evidence, name), { recursive: true });
  } else {
    await assert.rejects(readFile(join(root, 'reports/mutation/audit.json')), { code: 'ENOENT' });
    await cp(join(root, 'reports/mutation'), join(evidence, name), { recursive: true });
  }
  results.push({
    name,
    status: result.status,
    elapsedMs: Math.round(performance.now() - started),
    execution: audit?.execution,
  });
  console.log(
    `${name}: ${fails ? 'expected rejection' : `${audit.execution.executed} executed / ${audit.execution.reused} reused`}`,
  );
  return audit;
}
let baselineCache;
async function restore() {
  await rm(join(root, '.cache'), { recursive: true, force: true });
  await cp(baselineCache, join(root, '.cache/mutation/validated'), { recursive: true });
  await put('src/mp3/add.ts', source);
  await put('tests/add.test.ts', strongTest);
  await put('tests/helpers/check.ts', strongHelper);
  await policy();
}
try {
  for (const path of ['scripts', 'src/mp3', 'tests/helpers'])
    await mkdir(join(root, path), { recursive: true });
  for (const name of [
    'run-mutations.mjs',
    'mutation-policy.mjs',
    'mutation-cache.mjs',
    'mutation-impact.mjs',
  ])
    await cp(join(project, 'scripts', name), join(root, 'scripts', name));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await put('package.json', '{"type":"module","private":true}\n');
  await put('src/mp3/add.ts', source);
  await put('tests/add.test.ts', strongTest);
  await put('tests/helpers/check.ts', strongHelper);
  await policy();
  await put(
    'vitest.config.ts',
    "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/**/*.test.ts'], maxWorkers: 1, fsModuleCache: false } });\n",
  );
  await put('vitest.mutation.config.ts', "export { default } from './vitest.config.js';\n");
  const config = JSON.parse(await readFile(join(project, 'stryker.config.json'), 'utf8'));
  config.concurrency = 1;
  await put('stryker.config.json', JSON.stringify(config));
  if (!process.argv.includes('--impact-only')) {
    const cold = await run('cold', { reason: /cache missing/ });
    assert.equal(cold.execution.reused, 0);
    baselineCache = join(evidence, 'baseline-cache');
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
        (await run('changed-' + name, { reason: /Global mutation inputs changed/ })).execution
          .reused,
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
  // Independent modules demonstrate genuine partial reuse, not an identical-
  // input-only cache. The changed caller case exposes an unchanged callee mutant.
  for (const directory of ['src', 'tests', 'docs', '.cache'])
    await rm(join(root, directory), { recursive: true, force: true });
  for (const directory of ['src/mp3', 'tests'])
    await mkdir(join(root, directory), { recursive: true });
  const modules = new Map([
    ['src/mp3/positive.ts', 'export function positive(value: number) { return value > 0; }\n'],
    [
      'src/mp3/bridge.ts',
      "import { positive } from './positive.js'; export function pair() { return [positive(0), positive(1)]; }\n",
    ],
    ['src/mp3/double.ts', 'export function double(value: number) { return value * 2; }\n'],
  ]);
  const pairTest =
    "import { expect, it } from 'vitest'; import { pair } from '../src/mp3/bridge.js'; it('pair', () => { expect(pair()).toEqual([false, true]); });\n";
  const doubleTest =
    "import { expect, it } from 'vitest'; import { double } from '../src/mp3/double.js'; it('double', () => { expect(double(3)).toBe(6); });\n";
  async function resetImpact() {
    await rm(join(root, '.cache'), { recursive: true, force: true });
    for (const [file, source] of modules) await put(file, source);
    await put('tests/pair.test.ts', pairTest);
    await put('tests/double.test.ts', doubleTest);
    await policy(modules);
    if (impactCache)
      await cp(impactCache, join(root, '.cache/mutation/validated'), { recursive: true });
  }
  let impactCache;
  await resetImpact();
  const impactCold = await run('impact-cold');
  impactCache = join(evidence, 'impact-baseline-cache');
  await cp(join(root, '.cache/mutation/validated'), impactCache, { recursive: true });
  const impactWarm = await run('impact-identical-warm');
  assert.equal(impactWarm.execution.reused, impactCold.total);
  await resetImpact();
  await put('tests/pair.test.ts', pairTest + '// changed selected test file\n');
  const changedTest = await run('impact-changed-test-partial');
  assert.ok(changedTest.execution.reused > 0 && changedTest.execution.executed > 0);
  const incremental = JSON.parse(await readFile(join(root, 'reports/mutation/mutation.json')));
  const forced = await run('impact-changed-test-full', { full: true });
  assert.equal(forced.execution.executed, forced.total);
  assert.equal(forced.execution.reused, 0);
  const full = JSON.parse(await readFile(join(root, 'reports/mutation/mutation.json')));
  assert.deepEqual(inventory(incremental), inventory(full));
  const outcomes = (report) =>
    Object.fromEntries(
      Object.entries(report.files).map(([file, record]) => [
        file,
        record.mutants.map(({ location, replacement, status }) => [location, replacement, status]),
      ]),
    );
  assert.deepEqual(outcomes(incremental), outcomes(full));
  await resetImpact();
  const changedDouble = modules.get('src/mp3/double.ts').replace('value * 2', '2 * value');
  await put('src/mp3/double.ts', changedDouble);
  await policy(new Map([...modules, ['src/mp3/double.ts', changedDouble]]));
  const changedSource = await run('impact-changed-source-partial');
  assert.ok(changedSource.execution.reused > 0 && changedSource.execution.executed > 0);
  await resetImpact();
  await put(
    'tests/pair.test.ts',
    pairTest.replace('expect(pair()).toEqual([false, true])', 'expect(pair()[1]).toBe(true)'),
  );
  await run('impact-changed-test-new-survivor', { fails: true, reason: /Unreviewed Survived/ });
  await resetImpact();
  await put('tests/renamed.test.ts', pairTest);
  await rm(join(root, 'tests/pair.test.ts'));
  assert.equal(
    (await run('impact-renamed-test-full', { reason: /Global mutation inputs changed/ })).execution
      .reused,
    0,
  );
  await rm(join(root, 'tests/renamed.test.ts'));
  await resetImpact();
  await put('src/mp3/renamed.ts', modules.get('src/mp3/double.ts'));
  await rm(join(root, 'src/mp3/double.ts'));
  await put('tests/double.test.ts', doubleTest.replace('/double.js', '/renamed.js'));
  const renamedModules = new Map(modules);
  renamedModules.delete('src/mp3/double.ts');
  renamedModules.set('src/mp3/renamed.ts', modules.get('src/mp3/double.ts'));
  await policy(renamedModules);
  assert.equal(
    (await run('impact-renamed-module-full', { reason: /Global mutation inputs changed/ }))
      .execution.reused,
    0,
  );
  await rm(join(root, 'src/mp3/renamed.ts'));
  await resetImpact();
  await put(
    'tests/pair.test.ts',
    pairTest.replace(
      "import { pair } from '../src/mp3/bridge.js';",
      "const { pair } = await import('../src/mp3/bridge.js');",
    ),
  );
  const literal = await run('impact-literal-dynamic-import');
  assert.ok(literal.execution.reused > 0 && literal.execution.executed > 0);
  await resetImpact();
  await put(
    'tests/pair.test.ts',
    pairTest.replace(
      "import { pair } from '../src/mp3/bridge.js';",
      "const path = '../src/mp3/bridge.js'; const { pair } = await import(path);",
    ),
  );
  assert.equal(
    (await run('impact-unresolved-dynamic-import-full', { reason: /Unresolved import impact/ }))
      .execution.reused,
    0,
  );
  await resetImpact();
  const changedCaller = modules.get('src/mp3/bridge.ts').replace('positive(0)', 'false');
  await put('src/mp3/bridge.ts', changedCaller);
  await policy(new Map([...modules, ['src/mp3/bridge.ts', changedCaller]]));
  await run('impact-changed-caller-new-callee-survivor', {
    fails: true,
    reason: /Unreviewed Survived/,
  });
  const callerIncremental = JSON.parse(
    await readFile(join(root, 'reports/mutation/mutation.json')),
  );
  assert.ok(
    callerIncremental.files['src/mp3/positive.ts'].mutants.some(
      (m) => m.status === 'Survived' && Object.hasOwn(m, 'duration'),
    ),
  );
  assert.ok(
    callerIncremental.files['src/mp3/double.ts'].mutants.every(
      (m) => !Object.hasOwn(m, 'duration'),
    ),
  );
  await run('impact-changed-caller-full-confirmation', {
    full: true,
    fails: true,
    reason: /Unreviewed Survived/,
  });
  const callerFull = JSON.parse(await readFile(join(root, 'reports/mutation/mutation.json')));
  assert.deepEqual(inventory(callerIncremental), inventory(callerFull));
  assert.deepEqual(outcomes(callerIncremental), outcomes(callerFull));
  assert.equal(executionSummary(callerFull).executed, inventory(callerFull).length);
  await resetImpact();
  await put(
    'tests/relay.ts',
    "export { double } from '../src/mp3/double.js'; export { tag } from './cycle.js';\n",
  );
  await put('tests/cycle.ts', "import './relay.js'; export const tag = 1;\n");
  await put('tests/double.test.ts', doubleTest.replace('../src/mp3/double.js', './relay.js'));
  await run('impact-reexport-cycle-cold');
  await put('src/mp3/double.ts', changedDouble);
  await policy(new Map([...modules, ['src/mp3/double.ts', changedDouble]]));
  const cycle = await run('impact-reexport-cycle-source-change');
  assert.ok(cycle.execution.reused > 0 && cycle.execution.executed > 0);
  await rm(join(root, 'tests/relay.ts'));
  await rm(join(root, 'tests/cycle.ts'));
  await resetImpact();
  await rm(join(root, 'src/mp3/double.ts'));
  await rm(join(root, 'tests/double.test.ts'));
  const deleted = new Map(modules);
  deleted.delete('src/mp3/double.ts');
  await policy(deleted);
  assert.equal(
    (await run('impact-deleted-module-and-test-full', { reason: /Global mutation inputs changed/ }))
      .execution.reused,
    0,
  );
  await resetImpact();
  const isolationCheck =
    "expect(globalThis.__mutationIsolation).toBeUndefined(); expect(process.env.MUTATION_ISOLATION_PROBE).toBeUndefined(); globalThis.__mutationIsolation = 'set'; process.env.MUTATION_ISOLATION_PROBE = 'set';\n";
  await put('tests/pair.test.ts', pairTest + isolationCheck);
  await put('tests/double.test.ts', doubleTest + isolationCheck);
  await run('impact-isolated-file-globals-and-environment');
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Verified ${results.length} actual Stryker/Vitest scenarios. Evidence: ${evidence}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
