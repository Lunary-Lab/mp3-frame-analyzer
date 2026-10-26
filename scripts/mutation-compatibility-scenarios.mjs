// Tiny actual Stryker runs: positive reuse and new-survivor controls share the
// same unmutated passing behavior. Never substitute planner-only simulations.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inventory } from './mutation-cache.mjs';

const doubleSource = 'export function double(value: number) { return value * 2; }\n';
const doubleTest =
  "import { expect, it } from 'vitest'; import { double } from '../src/mp3/double.js'; it('double', () => expect(double(3)).toBe(6));\n";
const selectedConfig =
  "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/add.test.ts', 'tests/double.test.ts'], isolate: true, fsModuleCache: false, maxWorkers: 1 } });\n";
const readerHelper =
  "import { expect } from 'vitest'; import { readFileSync } from 'node:fs'; export function check(value: number) { const mode = readFileSync('docs/mode.md', 'utf8'); if (mode === 'strict') expect(value).toBe(5); else expect(value).toBeDefined(); }\n";

async function report(root) {
  return JSON.parse(await readFile(join(root, 'reports/mutation/mutation.json'), 'utf8'));
}

function outcomes(value) {
  return Object.entries(value.files)
    .flatMap(([path, record]) =>
      record.mutants.map((mutant) =>
        JSON.stringify([
          path,
          record.source,
          mutant.location,
          mutant.mutatorName,
          mutant.replacement,
          mutant.status,
        ]),
      ),
    )
    .sort();
}

async function compareFull(context, name, incremental, fails = false) {
  await context.run(name + '-full', { full: true, fails });
  const full = await report(context.root);
  assert.deepEqual(inventory(incremental), inventory(full));
  assert.deepEqual(outcomes(incremental), outcomes(full));
}

async function prepare(context, suffix = '') {
  const { root, put, policy, source, strongTest, strongHelper, run, evidence } = context;
  for (const path of ['src', 'tests', 'docs', '.cache'])
    await rm(join(root, path), { recursive: true, force: true });
  for (const path of ['src/mp3', 'tests/helpers', 'docs'])
    await mkdir(join(root, path), { recursive: true });
  await put('src/mp3/add.ts', source);
  await put('src/mp3/double.ts', doubleSource);
  await put('tests/add.test.ts', strongTest);
  await put('tests/double.test.ts', doubleTest);
  await put('tests/helpers/check.ts', strongHelper);
  await put('docs/mode.md', 'strict');
  await put('vitest.mutation.config.ts', selectedConfig);
  await policy(
    new Map([
      ['src/mp3/add.ts', source],
      ['src/mp3/double.ts', doubleSource],
    ]),
  );
  const baseline = await run(`bounded${suffix}-cold`);
  const cache = join(evidence, `bounded${suffix}-baseline-cache`);
  await cp(join(root, '.cache/mutation/validated'), cache, { recursive: true });
  context.restore = async () => {
    await rm(join(root, '.cache'), { recursive: true, force: true });
    await cp(cache, join(root, '.cache/mutation/validated'), { recursive: true });
    await put('tests/helpers/check.ts', strongHelper);
    await put('docs/mode.md', 'strict');
  };
  return baseline;
}

async function passiveAndNonparser(context, baseline) {
  const { put, run, root, restore } = context;
  await restore();
  await put('docs/mode.md', 'edited unrelated prose');
  await put('src/unrelated.ts', 'export const unrelated = 42;\n');
  await put(
    'tests/unrelated.test.ts',
    "import { expect, it } from 'vitest'; import { unrelated } from '../src/unrelated.js'; it('normal suite still executes additions', () => expect(unrelated).toBe(42));\n",
  );
  const warm = await run('bounded-docs-and-nonparser-additions');
  assert.equal(warm.execution.reused, baseline.total);
  assert.equal(warm.execution.executed, 0);
  await compareFull(context, 'bounded-docs-and-nonparser-additions', await report(root));
  await rm(join(root, 'src/unrelated.ts'));
  await rm(join(root, 'tests/unrelated.test.ts'));
}

async function helperSurvivor(context) {
  const { restore, put, strongHelper, run, root } = context;
  await restore();
  await put('tests/helpers/check.ts', strongHelper.replace('.toBe(5)', '.toBeDefined()'));
  await run('bounded-helper-new-survivor', { fails: true, reason: /Unreviewed Survived/ });
  const incremental = await report(root);
  assert.ok(
    incremental.files['src/mp3/double.ts'].mutants.every((m) => !Object.hasOwn(m, 'duration')),
  );
  assert.ok(incremental.files['src/mp3/add.ts'].mutants.some((m) => m.status === 'Survived'));
  await compareFull(context, 'bounded-helper-new-survivor', incremental, true);
}

async function resourceSurvivor(context) {
  const { restore, put, run, root } = context;
  await restore();
  await put('tests/helpers/check.ts', readerHelper);
  const cold = await run('bounded-reader-introduced');
  assert.ok(cold.execution.reused > 0 && cold.execution.executed > 0);
  await put('docs/mode.md', 'loose');
  await run('bounded-resource-new-survivor', { fails: true, reason: /Unreviewed Survived/ });
  const incremental = await report(root);
  assert.ok(
    incremental.files['src/mp3/double.ts'].mutants.every((m) => !Object.hasOwn(m, 'duration')),
  );
  await compareFull(context, 'bounded-resource-new-survivor', incremental, true);
}

async function midrunDocumentChange(context) {
  const { restore, put, run, root } = context;
  await restore();
  const manifest = await readFile(join(root, '.cache/mutation/validated/manifest.json'));
  await put(
    'tests/midrun.test.ts',
    "import { it } from 'vitest'; import { writeFileSync } from 'node:fs'; it('changes a document during normal tests', () => writeFileSync('docs/mode.md', 'midrun'));\n",
  );
  await run('bounded-midrun-document-change', {
    fails: true,
    reason: /Mutation inputs changed during execution/,
  });
  assert.deepEqual(await readFile(join(root, '.cache/mutation/validated/manifest.json')), manifest);
  await rm(join(root, 'tests/midrun.test.ts'));
}

async function configResourceSurvivor(context, kind) {
  const { restore, put, run, root } = context;
  await restore();
  const readMode = "process.env.CACHE_MODE = readFileSync('docs/mode.md', 'utf8');";
  let config = selectedConfig;
  if (kind === 'config')
    config = config.replace(
      'export default',
      `import { readFileSync } from 'node:fs'; ${readMode} export default`,
    );
  if (kind === 'setup') {
    await put('tests/setup.ts', `import { readFileSync } from 'node:fs'; ${readMode}\n`);
    config = config.replace('test: {', "test: { setupFiles: ['tests/setup.ts'],");
  }
  if (kind === 'plugin') {
    await put(
      'tests/plugin.ts',
      `import { readFileSync } from 'node:fs'; export default { name: 'resource-mode', configResolved() { ${readMode} } };\n`,
    );
    config = config
      .replace('export default', "import plugin from './tests/plugin.js'; export default")
      .replace('defineConfig({', 'defineConfig({ plugins: [plugin],');
  }
  await put('vitest.mutation.config.ts', config);
  await put(
    'tests/helpers/check.ts',
    "import { expect } from 'vitest'; export function check(value: number) { if (process.env.CACHE_MODE === 'loose') expect(value).toBeDefined(); else expect(value).toBe(5); }\n",
  );
  await run(`bounded-${kind}-reader-cold`);
  await put('docs/mode.md', 'loose');
  await run(`bounded-${kind}-resource-new-survivor`, {
    fails: true,
    reason: /Unsupported execution isolation[\s\S]*Unreviewed Survived/,
  });
  const full = await report(root);
  assert.ok(
    Object.values(full.files).every((record) =>
      record.mutants.every((m) => Object.hasOwn(m, 'duration')),
    ),
  );
  for (const path of ['tests/setup.ts', 'tests/plugin.ts'])
    await rm(join(root, path), { force: true });
  await put('vitest.mutation.config.ts', selectedConfig);
}

async function opaqueResourceSurvivor(context, kind) {
  const { restore, put, run, root, strongTest } = context;
  await restore();
  await put('tests/add.test.ts', strongTest);
  if (kind !== 'context') {
    const loader =
      kind === 'computed'
        ? "const key='con'+'structor'; const load=(()=>{})[key];"
        : "let load; ({ 'constructor': load } = (() => {}));";
    await put(
      'tests/helpers/check.ts',
      `import { expect } from 'vitest'; ${loader} const fs=load('return process.getBuiltinModule("fs")')(); export function check(value: number) { const mode=fs.readFileSync('docs/mode.md','utf8'); if(mode==='strict') expect(value).toBe(5); else expect(value).toBeDefined(); }\n`,
    );
  } else {
    await put(
      'tests/add.test.ts',
      `import { it } from 'vitest'; import { add } from '../src/mp3/add.js'; it('adds', async (context) => { const check=context['expect']; const mode=await check.getState().snapshotState.environment.readSnapshotFile('docs/mode.md'); const value=add(3,2); if(mode==='strict') check(value).toBe(5); else check(value).toBeDefined(); });\n`,
    );
  }
  await run(`bounded-${kind}-opaque-cold`);
  await put('docs/mode.md', 'loose');
  await run(`bounded-${kind}-opaque-new-survivor`, {
    fails: true,
    reason: /Unresolved import impact[\s\S]*Unreviewed Survived/,
  });
  const incremental = await report(root);
  assert.ok(
    Object.values(incremental.files).every((record) =>
      record.mutants.every((m) => Object.hasOwn(m, 'duration')),
    ),
  );
  await compareFull(context, `bounded-${kind}-opaque-new-survivor`, incremental, true);
  await put('tests/add.test.ts', strongTest);
}

export async function runCompatibilityScenarios(campaign) {
  const context = { ...campaign };
  const originalConfig = await readFile(join(context.root, 'vitest.mutation.config.ts'), 'utf8');
  const baseline = await prepare(context);
  await passiveAndNonparser(context, baseline);
  await helperSurvivor(context);
  await resourceSurvivor(context);
  await midrunDocumentChange(context);
  for (const kind of ['config', 'setup', 'plugin']) await configResourceSurvivor(context, kind);
  for (const kind of ['computed', 'quoted', 'context']) await opaqueResourceSurvivor(context, kind);
  await context.put('vitest.mutation.config.ts', originalConfig);
}

export async function runInstructionDocumentScenarios(campaign) {
  const context = { ...campaign };
  const { root, put, run } = context;
  const paths = ['CLAUDE.md', 'TODO.md', '.github/copilot-instructions.md'];
  await mkdir(join(root, '.github'), { recursive: true });
  for (const path of paths) await put(path, 'strict');
  const baseline = await prepare(context, '-instruction');
  for (const path of paths) await put(path, 'loose');
  const warm = await run('bounded-instruction-prose-reuse');
  assert.equal(warm.execution.reused, baseline.total);
  assert.equal(warm.execution.executed, 0);
  await compareFull(context, 'bounded-instruction-prose-reuse', await report(root));
  for (const path of paths) await put(path, 'strict');
  await put(
    'tests/helpers/check.ts',
    `import { expect } from 'vitest'; import { readFileSync } from 'node:fs'; export function check(value: number) { const strict = ${JSON.stringify(paths)}.every(path => readFileSync(path, 'utf8') === 'strict'); if(strict) expect(value).toBe(5); else expect(value).toBeDefined(); }\n`,
  );
  await run('bounded-instruction-reader-cold', { full: true });
  for (const path of paths) await put(path, 'loose');
  await run('bounded-instruction-reader-new-survivor', {
    fails: true,
    reason: /Unreviewed Survived/,
  });
  const incremental = await report(root);
  assert.ok(
    incremental.files['src/mp3/double.ts'].mutants.every((m) => !Object.hasOwn(m, 'duration')),
  );
  assert.ok(incremental.files['src/mp3/add.ts'].mutants.every((m) => Object.hasOwn(m, 'duration')));
  await compareFull(context, 'bounded-instruction-reader-new-survivor', incremental, true);
}
