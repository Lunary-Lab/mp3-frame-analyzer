import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  executionSummary,
  fingerprint,
  mutationInputs,
  promoteCache,
  readCache,
} from './mutation-cache.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const evidence = join(repo, 'reports/mutation-cache-validation');
const cli = join(
  dirname(fileURLToPath(import.meta.resolve('@stryker-mutator/core/package.json'))),
  'bin/stryker.js',
);
const files = {
  '.gitignore': 'node_modules/\n.cache/\nreports/\n.stryker-tmp/\n',
  'package.json': '{"type":"module"}',
  'package-lock.json': '{"lockfileVersion":3}',
  'docs/mutation-review.md': 'Editorial review notes\n',
  'mutation-equivalents.json': '{"approvals":[]}',
  'source.js': 'export const positive = value => value > 0;\n',
  'helper.js': 'export const select = values => values;\n',
  'values.json': '[[-1,false],[0,false],[1,true]]',
  'source.test.js': `import { test, expect } from 'vitest';
import { positive } from './source.js';
import { select } from './helper.js';
import { readFileSync } from 'node:fs';
test('boundaries', () => {
  for (const [input, expected] of select(JSON.parse(readFileSync('values.json', 'utf8'))))
    expect(positive(input)).toBe(expected);
});`,
  'vitest.config.js': `export default { test: { include: ['source.test.js'], maxWorkers: 1 } };`,
  'stryker.config.json': JSON.stringify({
    testRunner: 'vitest',
    plugins: ['@stryker-mutator/vitest-runner'],
    mutate: ['source.js'],
    coverageAnalysis: 'perTest',
    concurrency: 1,
    reporters: ['json'],
    jsonReporter: { fileName: 'reports/mutation.json' },
    incremental: true,
    incrementalFile: '.cache/mutation/working.json',
    vitest: { configFile: 'vitest.config.js', related: false, pool: 'forks' },
    ignorePatterns: ['.git/**', '.cache/**', 'reports/**'],
    thresholds: { break: 0 },
  }),
};

async function campaign(root, name, baseline, change = {}, force = false) {
  for (const [path, value] of Object.entries({ ...files, ...change }))
    await writeFile(join(root, path), value);
  const key = fingerprint(await mutationInputs(root, {}, {}));
  if (baseline) await promoteCache(root, baseline.report, baseline.key, 'local');
  const cached = force ? { report: null } : await readCache(root, key, 'local', () => {});
  await rm(join(root, '.cache/mutation/working.json'), { force: true });
  if (cached.report)
    await writeFile(join(root, '.cache/mutation/working.json'), JSON.stringify(cached.report));
  const started = performance.now();
  const log = execFileSync(process.execPath, [cli, 'run', ...(!cached.report ? ['--force'] : [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const report = JSON.parse(await readFile(join(root, 'reports/mutation.json'), 'utf8'));
  const execution = executionSummary(report, Boolean(cached.report));
  const result = { key, execution, elapsedMs: Math.round(performance.now() - started), report };
  await writeFile(join(evidence, `${name}.log`), log);
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(result, null, 2));
  return result;
}

const outcomes = (report) =>
  Object.values(report.files)
    .flatMap((file) => file.mutants)
    .map(({ mutatorName, location, replacement, status }) => ({
      mutatorName,
      location,
      replacement,
      status,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test(
  'native full-scope reuse and broad-input fallback work with real Stryker/Vitest',
  { timeout: 180000 },
  async (t) => {
    await mkdir(evidence, { recursive: true });
    await mkdir(join(repo, '.cache'), { recursive: true });
    const root = await mkdtemp(join(repo, '.cache/native-toy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', root]);
    await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
    await mkdir(join(root, '.cache/mutation'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    const cold = await campaign(root, 'cold');
    assert.ok(cold.execution.executed > 0);
    assert.equal(cold.execution.reused, 0);
    for (const [name, change] of [
      ['unchanged', {}],
      ['review', { 'docs/mutation-review.md': 'Updated editorial review notes\n' }],
    ]) {
      const warm = await campaign(root, name, cold, change);
      assert.equal(warm.key, cold.key);
      assert.equal(warm.execution.executed, 0);
      assert.equal(warm.execution.reused, cold.execution.total);
      assert.deepEqual(outcomes(warm.report), outcomes(cold.report));
    }
    const forced = await campaign(root, 'forced', cold, {}, true);
    assert.equal(forced.execution.reused, 0);
    assert.deepEqual(outcomes(forced.report), outcomes(cold.report));
    const changes = {
      proof: { 'mutation-equivalents.json': '{"approvals":[{"changed":true}]}' },
      source: { 'source.js': files['source.js'] + '// source changed\n' },
      helper: { 'helper.js': 'export const select = values => values.filter(([n]) => n !== 0);' },
      fixture: { 'values.json': '[[-1,false],[1,true]]' },
      config: { 'vitest.config.js': files['vitest.config.js'] + '\n// config changed' },
      dependency: { 'package-lock.json': '{"lockfileVersion":3,"changed":true}' },
    };
    for (const [name, change] of Object.entries(changes)) {
      const result = await campaign(root, name, cold, change);
      assert.notEqual(result.key, cold.key);
      assert.equal(result.execution.reused, 0);
      assert.ok(result.execution.executed > 0);
      if (name === 'helper' || name === 'fixture')
        assert.ok(outcomes(result.report).some((mutant) => mutant.status === 'Survived'));
    }
  },
);
