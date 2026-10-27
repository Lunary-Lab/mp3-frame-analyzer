import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPureReport,
  assertPureScope,
  deferredSources,
  pureSources,
  pureTests,
} from './nonparser-pure-scope.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mp3-nonparser-scope-'));
  try {
    for (const file of [...pureSources, ...Object.keys(deferredSources)]) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await writeFile(join(directory, file), '');
    }
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the native campaign is fresh and uses matching sources and mirrored test discovery', async () => {
  await assertPureScope(root);
  const { default: config } = await import('../stryker.nonparser-pure.config.mjs');
  assert.deepEqual(config.mutate, pureSources);
  assert.equal(config.incremental, false);
  assert.equal(config.concurrency, 2);
  assert.equal(config.thresholds.break, 100);
  assert.equal(config.coverageAnalysis, 'perTest');
  assert.equal(config.vitest.related, true);
  assert.equal(config.tempDirName, '.stryker-pure-tmp');
  assert.equal(config.jsonReporter.fileName, 'reports/mutation-pure/mutation.json');
  assert.deepEqual(config.plugins, ['@stryker-mutator/vitest-runner']);
  const { default: vitest } = await import('../vitest.nonparser-pure.config.mjs');
  assert.deepEqual(vitest.test.include, pureTests);
  assert.equal(vitest.test.isolate, true);
  assert.equal(vitest.test.fsModuleCache, false);
  assert.equal(vitest.test.passWithNoTests, false);
});

test('a newly extracted runtime dependency cannot escape an explicit stage assignment', async () => {
  await fixture(async (directory) => {
    await assertPureScope(directory);
    await mkdir(join(directory, 'src', 'policy'));
    await writeFile(join(directory, 'src', 'policy', 'new.ts'), 'export const limit = 1;');
    await assert.rejects(assertPureScope(directory), /Nonparser source inventory changed/);
  });
});

test('a removed runtime source cannot leave a stale active or deferred inventory entry', async () => {
  await fixture(async (directory) => {
    await rm(join(directory, 'src', 'shutdown.ts'));
    await assert.rejects(assertPureScope(directory), /Nonparser source inventory changed/);
  });
});

const killedReport = () => ({
  files: Object.fromEntries(
    pureSources.map((file, id) => [file, { mutants: [{ id, status: 'Killed' }] }]),
  ),
});

test('the report gate requires the complete nonempty source inventory and only actual kills', () => {
  assert.equal(assertPureReport(killedReport()), 3);
  for (const status of [
    'RuntimeError',
    'CompileError',
    'NoCoverage',
    'Survived',
    'Timeout',
    'Ignored',
    'Pending',
  ]) {
    const report = killedReport();
    report.files[pureSources[0]].mutants[0].status = status;
    assert.throws(() => assertPureReport(report), /was/);
  }
  for (const report of [null, [], {}, { files: null }, { files: [] }, { files: {} }])
    assert.throws(() => assertPureReport(report));
  const empty = killedReport();
  empty.files[pureSources[0]].mutants = [];
  assert.throws(() => assertPureReport(empty), /No mutants/);
  const missing = killedReport();
  delete missing.files[pureSources[0]];
  assert.throws(() => assertPureReport(missing), /Unexpected source inventory/);
  const extra = killedReport();
  extra.files['src/mp3/count-frames.ts'] = { mutants: [{ id: 99, status: 'Killed' }] };
  assert.throws(() => assertPureReport(extra), /Unexpected source inventory/);
});

test('the direct report command fails for missing or malformed JSON and accepts valid kills', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'mutation.json');
    const run = () =>
      spawnSync(process.execPath, [join(root, 'scripts/nonparser-pure-scope.mjs'), path], {
        encoding: 'utf8',
        timeout: 5000,
      });
    assert.equal(run().status, 1);
    await writeFile(path, '{not JSON');
    assert.equal(run().status, 1);
    await writeFile(path, JSON.stringify(killedReport()));
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /3 mutants killed; no exemptions/);
  });
});

test('the fresh command clears only its own report directory, never parser output', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const cleanup = pkg.scripts['mutation:pure'].split(' && ')[0].match(/^node -e "(.+)"$/)?.[1];
  assert.ok(cleanup, 'Expected native filesystem cleanup before the fresh command');
  await fixture(async (directory) => {
    const parser = join(directory, 'reports', 'mutation', 'keep.json');
    const pure = join(directory, 'reports', 'mutation-pure', 'stale.json');
    for (const path of [parser, pure]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'sentinel');
    }
    const result = spawnSync(process.execPath, ['-e', cleanup], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(parser, 'utf8'), 'sentinel');
    await assert.rejects(access(dirname(pure)), { code: 'ENOENT' });
  });
});
