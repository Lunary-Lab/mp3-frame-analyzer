import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { executionSummary, inventory } from './mutation-cache.mjs';

const outcomes = (report) =>
  Object.fromEntries(
    Object.entries(report.files).map(([file, record]) => [
      file,
      record.mutants.map(({ location, replacement, status }) => [location, replacement, status]),
    ]),
  );

function impactContext(campaign) {
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
  return { ...campaign, modules, pairTest, doubleTest };
}

async function restoreImpact(context) {
  const { root, modules, put, pairTest, doubleTest, policy, impactCache } = context;
  await rm(join(root, '.cache'), { recursive: true, force: true });
  for (const [file, source] of modules) await put(file, source);
  await put('tests/pair.test.ts', pairTest);
  await put('tests/double.test.ts', doubleTest);
  await policy(modules);
  if (impactCache)
    await cp(impactCache, join(root, '.cache/mutation/validated'), { recursive: true });
}

async function verifyImpactBaseline(context) {
  const { resetImpact, run, evidence, root } = context;
  await resetImpact();
  const impactCold = await run('impact-cold');
  const impactCache = join(evidence, 'impact-baseline-cache');
  context.impactCache = impactCache;
  await cp(join(root, '.cache/mutation/validated'), impactCache, { recursive: true });
  const impactWarm = await run('impact-identical-warm');
  assert.equal(impactWarm.execution.reused, impactCold.total);
}

async function verifyChangedTestImpact(context) {
  const { resetImpact, put, pairTest, run, root } = context;
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
  assert.deepEqual(outcomes(incremental), outcomes(full));
}

async function verifyChangedSourceImpact(context) {
  const { resetImpact, modules, put, policy, run } = context;
  await resetImpact();
  const changedDouble = modules.get('src/mp3/double.ts').replace('value * 2', '2 * value');
  context.changedDouble = changedDouble;
  await put('src/mp3/double.ts', changedDouble);
  await policy(new Map([...modules, ['src/mp3/double.ts', changedDouble]]));
  const changedSource = await run('impact-changed-source-partial');
  assert.ok(changedSource.execution.reused > 0 && changedSource.execution.executed > 0);
}

async function verifyTestAndModuleRenames(context) {
  const { resetImpact, put, pairTest, run, root, modules, doubleTest, policy } = context;
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
}

async function verifyDynamicImports(context) {
  const { resetImpact, put, pairTest, run } = context;
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
}

async function verifyCallerImpact(context) {
  const { resetImpact, modules, put, policy, run, root } = context;
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
}

async function verifyReexportCycle(context) {
  const { resetImpact, put, doubleTest, run, changedDouble, policy, modules, root } = context;
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
}

async function verifyDeletionAndIsolation(context) {
  const { resetImpact, root, modules, policy, run, put, pairTest, doubleTest } = context;
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
}

// Independent modules demonstrate genuine partial reuse, not an identical-
// input-only cache. The changed caller case exposes an unchanged callee mutant.
export async function runImpactScenarios(campaign) {
  const { root } = campaign;
  for (const directory of ['src', 'tests', 'docs', '.cache'])
    await rm(join(root, directory), { recursive: true, force: true });
  for (const directory of ['src/mp3', 'tests'])
    await mkdir(join(root, directory), { recursive: true });
  const context = impactContext(campaign);
  context.resetImpact = () => restoreImpact(context);
  await verifyImpactBaseline(context);
  await verifyChangedTestImpact(context);
  await verifyChangedSourceImpact(context);
  await verifyTestAndModuleRenames(context);
  await verifyDynamicImports(context);
  await verifyCallerImpact(context);
  await verifyReexportCycle(context);
  await verifyDeletionAndIsolation(context);
}
