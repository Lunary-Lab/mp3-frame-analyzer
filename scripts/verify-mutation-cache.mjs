// Real Stryker/Vitest regression campaign, deliberately separate from fast unit tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { sourceContext } from './mutation-policy.mjs';
import { runInvalidationScenarios } from './mutation-invalidation-scenarios.mjs';
import { runImpactScenarios } from './mutation-impact-scenarios.mjs';
import {
  runCompatibilityScenarios,
  runInstructionDocumentScenarios,
} from './mutation-compatibility-scenarios.mjs';

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
async function readScenarioAudit(name, fails) {
  let audit = null;
  if (!fails) {
    audit = JSON.parse(await readFile(join(root, 'reports/mutation/audit.json'), 'utf8'));
    await cp(join(root, 'reports/mutation'), join(evidence, name), { recursive: true });
  } else {
    await assert.rejects(readFile(join(root, 'reports/mutation/audit.json')), { code: 'ENOENT' });
    await cp(join(root, 'reports/mutation'), join(evidence, name), { recursive: true });
  }
  return audit;
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
  const audit = await readScenarioAudit(name, fails);
  results.push({
    name,
    status: result.status,
    elapsedMs: Math.round(performance.now() - started),
    execution: audit?.execution,
  });
  const description = fails
    ? 'expected rejection'
    : `${audit.execution.executed} executed / ${audit.execution.reused} reused`;
  console.log(`${name}: ${description}`);
  return audit;
}
async function prepareProject() {
  for (const path of ['scripts', 'src/mp3', 'tests/helpers'])
    await mkdir(join(root, path), { recursive: true });
  for (const name of [
    'run-mutations.mjs',
    'mutation-policy.mjs',
    'mutation-cache.mjs',
    'mutation-cache-inputs.mjs',
    'mutation-impact.mjs',
    'mutation-import-capabilities.mjs',
    'mutation-compatibility.mjs',
    'mutation-execution-guard.mjs',
    'mutation-loader-inputs.mjs',
    'mutation-runtime-inputs.mjs',
    'mutation-runtime-witness.mjs',
    'mutation-module-capabilities.mjs',
    'mutation-reviewed-data-access.mjs',
  ])
    await cp(join(project, 'scripts', name), join(root, 'scripts', name));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir');
  await put('package.json', '{"type":"module","private":true}\n');
  await put('tsconfig.json', '{}\n');
  await put('src/mp3/add.ts', source);
  await put('tests/add.test.ts', strongTest);
  await put('tests/helpers/check.ts', strongHelper);
  await policy();
  await put(
    'vitest.config.ts',
    "import { defineConfig } from 'vitest/config'; export default defineConfig({ test: { include: ['tests/**/*.test.ts'], maxWorkers: 1, fsModuleCache: false, isolate: true } });\n",
  );
  await put('vitest.mutation.config.ts', "export { default } from './vitest.config.js';\n");
  const config = JSON.parse(await readFile(join(project, 'stryker.config.json'), 'utf8'));
  config.concurrency = 1;
  await put('stryker.config.json', JSON.stringify(config));
}

try {
  await prepareProject();
  const campaign = { root, evidence, put, policy, run, source, strongTest, strongHelper };
  if (!process.argv.includes('--documents-only')) {
    if (!process.argv.includes('--impact-only')) await runInvalidationScenarios(campaign);
    await runImpactScenarios(campaign);
    await runCompatibilityScenarios(campaign);
  }
  await runInstructionDocumentScenarios(campaign);
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`Verified ${results.length} actual Stryker/Vitest scenarios. Evidence: ${evidence}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
