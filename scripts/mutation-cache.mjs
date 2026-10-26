import { execFileSync } from 'node:child_process';
import { readFile, lstat, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './mutation-policy.mjs';
import { testWitnesses } from './mutation-impact.mjs';
import { CACHE_SCHEMA, fingerprint, globalFingerprint } from './mutation-cache-inputs.mjs';

import { assertCompatibleModes, reuseContext } from './mutation-compatibility.mjs';

export {
  CACHE_SCHEMA,
  fingerprint,
  globalFingerprint,
  isContainedRelativePath,
  isMutationInput,
  mutationEnvironment,
  mutationInputs,
} from './mutation-cache-inputs.mjs';

export const CACHE_DIRECTORY = '.cache/mutation/validated';
export const WORKING_REPORT = '.cache/mutation/working.json';

export function inventory(report) {
  return Object.entries(report.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([file, record]) =>
      record.mutants
        .map((mutant) => [
          file,
          sha256(record.source),
          mutant.mutatorName,
          mutant.replacement,
          mutant.location,
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
}

export function samePolicyExceptContext(before, current) {
  return (
    JSON.stringify({ ...before, contextSha256: null }) ===
    JSON.stringify({ ...current, contextSha256: null })
  );
}

export function createCache(report, inputs, summary, policy = null, sourceCommit = null) {
  const reportText = JSON.stringify(report);
  return {
    reportText,
    manifest: {
      schemaVersion: CACHE_SCHEMA,
      completed: true,
      inputs,
      inputsHash: fingerprint(inputs),
      policy,
      sourceCommit,
      reportSha256: sha256(reportText),
      inventorySha256: fingerprint(inventory(report)),
      total: summary.total,
      audit: summary,
    },
  };
}

function validateManifest(manifest, inputs, policy) {
  if (manifest?.schemaVersion !== CACHE_SCHEMA || manifest.completed !== true)
    throw new Error('Invalid or incomplete cache manifest');
  if (manifest.inputsHash !== fingerprint(manifest.inputs))
    throw new Error('Corrupt cached input manifest');
  if (globalFingerprint(manifest.inputs) !== globalFingerprint(inputs))
    throw new Error('Global mutation inputs changed');
  assertCompatibleModes(manifest.inputs, inputs);
  reuseContext(manifest.inputs);
  reuseContext(inputs);
  if (policy && !samePolicyExceptContext(manifest.policy, policy))
    throw new Error('Equivalence policy changed beyond parser context');
}

function authenticatedBaselineSources(report, baselineFiles) {
  const baselineSources = new Map(
    Object.entries(report.files).map(([file, record]) => [file, record.source]),
  );
  const baselineHashes = new Map(baselineFiles.map((entry) => [entry[0], entry.at(-1)]));
  for (const [file, record] of Object.entries({ ...report.files, ...report.testFiles })) {
    if (baselineHashes.get(file) !== sha256(record.source))
      throw new Error('Cached report/input source mismatch');
  }
  return baselineSources;
}

export function validateCache(manifest, reportText, inputs, audit, policy) {
  validateManifest(manifest, inputs, policy);
  if (manifest.reportSha256 !== sha256(reportText)) throw new Error('Corrupt cached report');
  const report = JSON.parse(reportText);
  const baselineSources = authenticatedBaselineSources(report, manifest.inputs.files);
  const summary = audit(report, manifest.policy, baselineSources);
  if (
    fingerprint(inventory(report)) !== manifest.inventorySha256 ||
    summary.total !== manifest.total ||
    JSON.stringify(summary) !== JSON.stringify(manifest.audit)
  )
    throw new Error('Cached inventory or audit mismatch');
  return report;
}

export async function readCache(root, inputs, audit, policy) {
  try {
    const path = join(root, CACHE_DIRECTORY);
    for (const name of ['manifest.json', 'report.json']) {
      if (!(await lstat(join(path, name))).isFile())
        throw new Error('Cache entry must be a regular file');
    }
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    const reportText = await readFile(join(path, 'report.json'), 'utf8');
    return {
      report: validateCache(manifest, reportText, inputs, audit, policy),
      manifest,
      reason: 'validated baseline',
    };
  } catch (error) {
    return { report: null, reason: error.code === 'ENOENT' ? 'cache missing' : error.message };
  }
}

export async function promoteCache(root, report, inputs, summary, policy = null) {
  const directory = join(root, CACHE_DIRECTORY);
  await mkdir(directory, { recursive: true });
  let sourceCommit = null;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* Non-Git functional fixtures remain local-only. */
  }
  const { manifest, reportText } = createCache(report, inputs, summary, policy, sourceCommit);
  // Manifest last: interruption between writes is a digest mismatch (safe miss).
  await writeFile(join(directory, 'report.json.tmp'), reportText);
  await rename(join(directory, 'report.json.tmp'), join(directory, 'report.json'));
  await writeFile(join(directory, 'manifest.json.tmp'), JSON.stringify(manifest, null, 2) + '\n');
  await rename(join(directory, 'manifest.json.tmp'), join(directory, 'manifest.json'));
}

const mutantKey = (file, source, mutant) =>
  JSON.stringify([file, sha256(source), mutant.mutatorName, mutant.replacement, mutant.location]);

function validateStableInventory(report, baseline) {
  if (
    baseline &&
    Object.entries(baseline.files).every(
      ([file, record]) => report.files[file]?.source === record.source,
    ) &&
    fingerprint(inventory(report)) !== fingerprint(inventory(baseline))
  )
    throw new Error('Full mutant inventory changed despite identical parser sources');
}

function indexedEligibleMutants(eligible) {
  const old = new Map();
  if (eligible)
    for (const [file, record] of Object.entries(eligible.files))
      for (const mutant of record.mutants) old.set(mutantKey(file, record.source, mutant), mutant);
  return old;
}

function validateFreshExecution(mutant) {
  // Real hook kills can finish in zero ms. Missing duration, not zero,
  // identifies Stryker10.1.1 reuse. Timeouts still require positive evidence.
  if (
    !Number.isFinite(mutant.duration) ||
    (mutant.status === 'Timeout' ? mutant.duration <= 0 : mutant.duration < 0)
  )
    throw new Error(`No fresh execution: invalid duration for mutant ${mutant.id}`);
}

function validateReusedExecution(mutant, before, oldTests, currentTests) {
  const valid = new Set(
    (before?.killedBy ?? []).map((id) => oldTests.get(id)?.identity).filter(Boolean),
  );
  if (
    !before ||
    before.static ||
    before.status !== 'Killed' ||
    mutant.status !== 'Killed' ||
    before.testsCompleted !== mutant.testsCompleted ||
    !(mutant.killedBy ?? []).some((id) => valid.has(currentTests.get(id)?.identity))
  )
    throw new Error(`No fresh execution or validated killing-test witness for mutant ${mutant.id}`);
}

export function executionSummary(report, eligible = null, baseline = null) {
  validateStableInventory(report, baseline);
  const old = indexedEligibleMutants(eligible);
  const oldTests = eligible ? testWitnesses(eligible) : new Map();
  const currentTests = testWitnesses(report);
  let executed = 0;
  let reused = 0;
  for (const [file, record] of Object.entries(report.files)) {
    for (const mutant of record.mutants) {
      if (Object.hasOwn(mutant, 'duration')) {
        validateFreshExecution(mutant);
        executed++;
      } else {
        const before = old.get(mutantKey(file, record.source, mutant));
        validateReusedExecution(mutant, before, oldTests, currentTests);
        reused++;
      }
    }
  }
  return { executed, reused, total: executed + reused };
}
