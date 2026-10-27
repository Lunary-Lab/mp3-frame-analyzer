import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export { fingerprint, mutationEnvironment, mutationInputs } from './mutation-cache-inputs.mjs';

export const WORKING_REPORT = '.cache/mutation/working.json';
export const BASELINE = '.cache/mutation/native-baseline.json';
export const PR_BASELINE = '.cache/mutation/pr-baseline.json';
const sourceIdentity = /^(?:[a-f0-9]{40}|local|pr:[1-9]\d*:[1-9]\d*)$/;

export function pullRequestIdentity(env) {
  const ref = /^refs\/pull\/([1-9]\d*)\/merge$/.exec(env.GITHUB_REF ?? '');
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'pull_request' ||
    !ref ||
    !/^[1-9]\d*$/.test(env.GITHUB_REPOSITORY_ID ?? '')
  )
    return null;
  return `pr:${env.GITHUB_REPOSITORY_ID}:${ref[1]}`;
}

// Native reports are copied unchanged. Stryker owns matching, coverage and reuse.
export function validateCache(baseline, key, identity, audit) {
  if (
    !sourceIdentity.test(identity) ||
    !/^[a-f0-9]{64}$/.test(key ?? '') ||
    baseline?.schemaVersion !== 1 ||
    baseline.completed !== true ||
    baseline.key !== key ||
    baseline[identity.startsWith('pr:') ? 'prIdentity' : 'sourceCommit'] !== identity
  )
    throw new Error('No compatible native baseline for this scope');
  audit(baseline.report, { nativeReuse: true });
  return baseline.report;
}

export async function readCache(root, key, identity, audit) {
  try {
    const baseline = JSON.parse(
      await readFile(join(root, identity?.startsWith('pr:') ? PR_BASELINE : BASELINE), 'utf8'),
    );
    return {
      report: validateCache(baseline, key, identity, audit),
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

export async function promoteCache(root, report, key, identity) {
  if (!sourceIdentity.test(identity) || !/^[a-f0-9]{64}$/.test(key ?? ''))
    throw new Error('Invalid native baseline identity');
  const path = join(root, identity.startsWith('pr:') ? PR_BASELINE : BASELINE);
  await mkdir(join(root, '.cache/mutation'), { recursive: true });
  await writeFile(
    path + '.tmp',
    JSON.stringify({
      schemaVersion: 1,
      completed: true,
      key,
      [identity.startsWith('pr:') ? 'prIdentity' : 'sourceCommit']: identity,
      report,
    }),
  );
  await rename(path + '.tmp', path);
}
