import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export { fingerprint, mutationEnvironment, mutationInputs } from './mutation-cache-inputs.mjs';

export const WORKING_REPORT = '.cache/mutation/working.json';
export const BASELINE = '.cache/mutation/native-baseline.json';

// Native reports are copied unchanged. Stryker owns matching, coverage and reuse.
export function validateCache(baseline, key, sourceCommit, audit) {
  if (
    !/^(?:[a-f0-9]{40}|local)$/.test(sourceCommit) ||
    !/^[a-f0-9]{64}$/.test(key ?? '') ||
    baseline?.schemaVersion !== 1 ||
    baseline.completed !== true ||
    baseline.key !== key ||
    baseline.sourceCommit !== sourceCommit
  )
    throw new Error('No compatible authenticated native baseline');
  audit(baseline.report, { nativeReuse: true });
  return baseline.report;
}

export async function readCache(root, key, sourceCommit, audit) {
  try {
    const baseline = JSON.parse(await readFile(join(root, BASELINE), 'utf8'));
    return {
      report: validateCache(baseline, key, sourceCommit, audit),
      reason: 'native-same-input-reuse',
    };
  } catch {
    return { report: null, reason: 'native-baseline-missing-or-incompatible' };
  }
}

export function executionSummary(report, nativeReuse) {
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  // In the pinned native differ, retained results omit duration. Zero milliseconds
  // is a legitimate fresh result; never invent or copy timings into the report.
  const reused = nativeReuse
    ? mutants.filter((mutant) => !Object.hasOwn(mutant, 'duration')).length
    : 0;
  return { total: mutants.length, executed: mutants.length - reused, reused };
}

export async function promoteCache(root, report, key, sourceCommit) {
  if (!/^(?:[a-f0-9]{40}|local)$/.test(sourceCommit) || !/^[a-f0-9]{64}$/.test(key ?? ''))
    throw new Error('Invalid native baseline identity');
  const path = join(root, BASELINE);
  await mkdir(join(root, '.cache/mutation'), { recursive: true });
  await writeFile(
    path + '.tmp',
    JSON.stringify({
      schemaVersion: 1,
      completed: true,
      key,
      sourceCommit,
      report,
    }),
  );
  await rename(path + '.tmp', path);
}
