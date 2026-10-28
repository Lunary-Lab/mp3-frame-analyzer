import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { glob, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMutationShards, PARSER_GLOB, sha256 } from './mutation-policy.mjs';
import { mutationEnvironment, mutationInputs, fingerprint } from './mutation-cache-inputs.mjs';
import { runnableParserTestFiles, verifyParserTestDiscovery } from './parser-test-discovery.mjs';
import { assertEncoderShardDiscovery } from './verify-encoder-discovery.mjs';
import { runMutationProcess } from './mutation-process.mjs';
import { mutationPartitions } from './mutation-partitions.mjs';
import { isMain, readJson, repositoryRoot } from './release-utils.mjs';

// Reserve the twelfth mutation runner for the independent pure-runtime campaign.
export const MAX_PARSER_SHARDS = 11;

export async function currentSources(root) {
  const paths = (await Array.fromAsync(glob(PARSER_GLOB, { cwd: root })))
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => !path.endsWith('.d.ts'))
    .sort();
  return new Map(
    await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path), 'utf8')])),
  );
}

function invocation(root, env = process.env) {
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    run: env.GITHUB_RUN_ID ?? null,
    attempt: env.GITHUB_RUN_ATTEMPT ?? 'local',
  };
}

const artifactName = (attempt, shard) => `full-parser-shard-${attempt}-${shard}`;
const cli = (packageName, executable) =>
  join(dirname(fileURLToPath(import.meta.resolve(`${packageName}/package.json`))), executable);

async function runFreshShardCampaign(root, scope, env, log) {
  const discovery = await verifyParserTestDiscovery(root, env);
  await writeFile(
    join(root, 'reports/mutation/discovery.json'),
    JSON.stringify(discovery, null, 2),
  );
  await runMutationProcess(
    cli('vitest', 'vitest.mjs'),
    ['run', '--no-fsModuleCache'],
    env,
    log,
    root,
  );
  await runMutationProcess(
    cli('@stryker-mutator/core', 'bin/stryker.js'),
    ['run', '--force', '--mutate', scope.join(',')],
    env,
    log,
    root,
  );
}

export async function runShard(root, shard) {
  const sources = await currentSources(root);
  const { scopes } = await mutationPartitions(sources, MAX_PARSER_SHARDS);
  assert.ok(Number.isInteger(shard) && scopes[shard], 'Invalid parser shard');
  const output = join(root, 'reports/mutation');
  const lock = join(root, '.cache/mutation/run.lock');
  await mkdir(dirname(lock), { recursive: true });
  await mkdir(lock);
  let log;
  try {
    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    // --force alone retains out-of-scope prior results. Never admit any prior state.
    await rm(join(root, '.cache/mutation/working.json'), { force: true });
    const env = mutationEnvironment();
    const before = await mutationInputs(root, env);
    log = createWriteStream(join(output, 'execution.log'));
    await runFreshShardCampaign(root, scopes[shard], env, log);
    const after = await mutationInputs(root, env);
    assert.equal(
      fingerprint(after),
      fingerprint(before),
      'Mutation inputs changed during execution',
    );
    const bytes = await readFile(join(output, 'mutation.json'));
    const manifest = {
      ...invocation(root),
      shard,
      scope: scopes[shard],
      inputs: before,
      reportSha256: sha256(bytes),
      completed: true,
    };
    // A completion manifest is written only after both native processes exit cleanly.
    await writeFile(join(output, 'complete.json'), JSON.stringify(manifest, null, 2) + '\n');
  } finally {
    log?.end();
    await rm(lock, { recursive: true, force: true });
  }
}

function freshComparableInputs({ runtime, ...inputs }) {
  const { runnerImage, ...host } = runtime;
  assert.ok(
    Array.isArray(runnerImage) &&
      runnerImage.length === 2 &&
      (runnerImage.every((part) => part === null) ||
        runnerImage.every((part) => typeof part === 'string' && part.length > 0)),
    'Missing runner image provenance',
  );
  // Hosted image revisions vary within one fresh matrix. Keep the family and
  // every other input equal; raw manifests retain each exact image revision.
  return { ...inputs, runtime: { ...host, runnerImage: runnerImage[0] } };
}

export function validateShardEvidence(entries, scopes, expected, inputs) {
  assert.equal(entries.length, scopes.length, 'Missing or extra parser shard');
  const reports = [];
  for (const [index, scope] of scopes.entries()) {
    const entry = entries.find(({ manifest }) => manifest.shard === index);
    assert.ok(entry, `Missing or duplicate parser shard ${index}`);
    const { manifest, bytes } = entry;
    for (const key of ['commit', 'run', 'attempt'])
      assert.equal(manifest[key], expected[key], `Inconsistent shard ${key}`);
    assert.equal(manifest.completed, true, 'Incomplete parser shard');
    assert.deepEqual(manifest.scope, scope, 'Inconsistent shard scope');
    assert.deepEqual(
      freshComparableInputs(manifest.inputs),
      freshComparableInputs(inputs),
      'Inconsistent shard inputs',
    );
    assert.equal(manifest.reportSha256, sha256(bytes), 'Shard report digest mismatch');
    reports.push(JSON.parse(bytes));
  }
  return reports;
}

export function assertShardTestInventory(reports, expected) {
  const inventory = (report) =>
    expected
      .toSorted()
      .map((file) =>
        report.testFiles[file].tests
          .map(({ name, location }) => JSON.stringify([name, location]))
          .sort(),
      );
  for (const report of reports) {
    assert.deepEqual(
      Object.keys(report.testFiles).sort(),
      expected.toSorted(),
      'Incomplete shard test files',
    );
    assert.deepEqual(inventory(report), inventory(reports[0]), 'Inconsistent shard test inventory');
  }
}

async function assertCurrentShardTests(root, reports) {
  const env = mutationEnvironment();
  await verifyParserTestDiscovery(root, env);
  const expected = await runnableParserTestFiles(root, env);
  assertShardTestInventory(reports, expected);
  for (const report of reports)
    for (const [file, record] of Object.entries(report.testFiles))
      assert.equal(
        record.source,
        await readFile(join(root, file), 'utf8'),
        `Stale test source: ${file}`,
      );
}

export async function collectShards(root, directory) {
  const output = join(root, 'reports/mutation');
  await rm(output, { recursive: true, force: true });
  const sources = await currentSources(root);
  const { scopes, inventories } = await mutationPartitions(sources, MAX_PARSER_SHARDS);
  const expected = invocation(root);
  const names = scopes.map((_, index) => artifactName(expected.attempt, index));
  assert.deepEqual(
    (await readdir(directory)).sort(),
    names.toSorted(),
    'Incomplete shard artifacts',
  );
  const entries = await Promise.all(
    names.map(async (name) => ({
      manifest: await readJson(join(directory, name, 'complete.json')),
      bytes: await readFile(join(directory, name, 'mutation.json'), 'utf8'),
    })),
  );
  const inputs = await mutationInputs(root, mutationEnvironment());
  const reports = validateShardEvidence(entries, scopes, expected, inputs);
  const policy = await readJson(join(root, 'mutation-equivalents.json'));
  const summary = auditMutationShards(reports, policy, sources, scopes, inventories);
  await assertCurrentShardTests(root, reports);
  assertEncoderShardDiscovery(reports);
  assert.equal(fingerprint(await mutationInputs(root, mutationEnvironment())), fingerprint(inputs));
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, 'audit.json'),
    JSON.stringify(
      {
        ...summary,
        execution: { mode: 'full-sharded', shards: scopes.length, reused: 0, ...expected },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Full parser audit passed: ${summary.total} mutants, ${summary.adjustedScore}% adjusted.`,
  );
}

if (isMain(import.meta.url)) {
  const [command, argument, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Unexpected arguments');
  if (command === 'plan' && argument === undefined) {
    const { scopes } = await mutationPartitions(
      await currentSources(repositoryRoot),
      MAX_PARSER_SHARDS,
    );
    console.log(JSON.stringify({ include: scopes.map((_, shard) => ({ shard })) }));
  } else if (command === 'run' && /^(0|[1-9]\d*)$/.test(argument ?? '')) {
    await runShard(repositoryRoot, Number(argument));
  } else if (command === 'collect' && argument) {
    await collectShards(repositoryRoot, argument);
  } else throw new Error('Expected plan, run <shard>, or collect <artifact-directory>');
}
