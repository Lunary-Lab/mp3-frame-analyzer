// Bounded read-only discovery; timestamps and artifact names never prove ancestry.
export const BASELINE_NAME = 'validated-mutation-baseline';
export const BASELINE_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  candidates: 8,
  downloads: 4,
  requests: 32,
  elapsedMs: 60_000,
});
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const commitId = (value) => /^[a-f0-9]{40}$/.test(value ?? '') && !/^0+$/.test(value);
export class BaselineMiss extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function trustedRepository(run, repository) {
  return (
    positiveId(run.repository?.id) &&
    run.head_repository?.id === run.repository.id &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository
  );
}
function successfulMainRun(run) {
  return (
    run.head_branch === 'main' &&
    run.event === 'push' &&
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    run.path === '.github/workflows/ci.yml'
  );
}
export function trustedRun(run, repository, commit) {
  return (
    positiveId(run?.id) &&
    positiveId(run.run_attempt) &&
    trustedRepository(run, repository) &&
    commitId(commit) &&
    run.head_sha === commit &&
    successfulMainRun(run)
  );
}
function trustedArtifactMetadata(artifact) {
  return (
    positiveId(artifact?.id) &&
    artifact.name === BASELINE_NAME &&
    artifact.expired === false &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= BASELINE_LIMITS.archiveBytes &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '')
  );
}
export function trustedArtifact(artifact, run) {
  return (
    trustedArtifactMetadata(artifact) &&
    artifact.workflow_run?.id === run.id &&
    artifact.workflow_run.head_sha === run.head_sha &&
    artifact.workflow_run.head_branch === 'main' &&
    artifact.workflow_run.repository_id === run.repository.id &&
    artifact.workflow_run.head_repository_id === run.repository.id
  );
}
function comparisonIdentity(comparison, candidate, anchor) {
  return (
    comparison.base_commit?.sha === candidate &&
    comparison.merge_base_commit?.sha === candidate &&
    (!Object.hasOwn(comparison, 'head_commit') || comparison.head_commit?.sha === anchor)
  );
}
export function trustedAncestry(comparison, candidate, anchor) {
  const status = candidate === anchor ? 'identical' : 'ahead';
  return (
    comparison?.status === status &&
    comparisonIdentity(comparison, candidate, anchor) &&
    comparison.behind_by === 0 &&
    (status === 'identical' ? comparison.ahead_by === 0 : positiveId(comparison.ahead_by))
  );
}
export function restoreSession(api, now = () => performance.now()) {
  const started = now();
  let requests = 0;
  let downloads = 0;
  const reasons = new Set();
  const remaining = () => {
    const value = Math.floor(BASELINE_LIMITS.elapsedMs - (now() - started));
    if (value <= 0) throw new BaselineMiss('restore-budget-exhausted');
    return value;
  };
  return {
    reasons,
    remaining,
    async request(path, binary = false) {
      if (
        ++requests > BASELINE_LIMITS.requests ||
        (binary && ++downloads > BASELINE_LIMITS.downloads)
      )
        throw new BaselineMiss('restore-budget-exhausted');
      const timeout = remaining();
      try {
        const value = await api(path, binary || undefined, timeout);
        remaining();
        return value;
      } catch (error) {
        if (error instanceof BaselineMiss) throw error;
        throw new BaselineMiss('transport-unavailable');
      }
    },
  };
}
export async function responseJson(session, path, key) {
  const text = await session.request(path);
  try {
    const value = JSON.parse(text);
    if (key && !Array.isArray(value?.[key])) throw new Error('Missing array');
    return value;
  } catch {
    throw new BaselineMiss('invalid-api-response');
  }
}
async function hasAncestry(session, repository, candidate, anchor) {
  if (candidate === anchor) return true;
  const comparison = await responseJson(
    session,
    `repos/${repository}/compare/${candidate}...${anchor}?per_page=1`,
  );
  return trustedAncestry(comparison, candidate, anchor);
}
export function baselineCoordinates(repository, anchor, currentHead) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !commitId(anchor))
    throw new BaselineMiss('invalid-baseline-coordinates');
  if (!commitId(currentHead)) throw new BaselineMiss('invalid-tested-head');
}
function* trustedCandidates(runs, repository, seen, session) {
  for (const run of runs) {
    if (seen.has(run?.id)) continue;
    if (!trustedRun(run, repository, run?.head_sha)) {
      session.reasons.add('run-provenance-rejected');
      continue;
    }
    if (seen.size >= BASELINE_LIMITS.candidates) throw new BaselineMiss('restore-budget-exhausted');
    seen.add(run.id);
    yield run;
  }
}
export async function* baselineCandidates(repository, anchor, currentHead, session) {
  baselineCoordinates(repository, anchor, currentHead);
  // The event's previous SHA is not necessarily an ancestor after a force-push.
  if (!(await hasAncestry(session, repository, anchor, currentHead)))
    throw new BaselineMiss('anchor-ancestry-rejected');
  const queries = [
    `head_sha=${anchor}&event=push&status=success&per_page=100`,
    'branch=main&event=push&status=success&per_page=100',
  ];
  const seen = new Set();
  const ancestry = new Map();
  for (const query of queries) {
    const { workflow_runs: runs } = await responseJson(
      session,
      `repos/${repository}/actions/workflows/ci.yml/runs?${query}`,
      'workflow_runs',
    );
    if (query.startsWith('head_sha=') && !runs.some((run) => trustedRun(run, repository, anchor)))
      session.reasons.add('exact-run-unavailable');
    for (const run of trustedCandidates(runs, repository, seen, session)) {
      if (!ancestry.has(run.head_sha))
        ancestry.set(run.head_sha, await hasAncestry(session, repository, run.head_sha, anchor));
      if (ancestry.get(run.head_sha)) yield run;
      else session.reasons.add('ancestry-rejected');
    }
  }
}
export async function candidateArtifact(repository, run, session) {
  const { artifacts } = await responseJson(
    session,
    `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    'artifacts',
  );
  const matches = artifacts.filter((artifact) => trustedArtifact(artifact, run));
  if (matches.length !== 1) throw new BaselineMiss('artifact-provenance-rejected');
  return matches[0];
}
export async function recheckRun(repository, run, session) {
  const current = await responseJson(session, `repos/${repository}/actions/runs/${run.id}`);
  if (
    !trustedRun(current, repository, run.head_sha) ||
    current.id !== run.id ||
    current.repository.id !== run.repository.id ||
    current.run_attempt !== run.run_attempt
  )
    throw new BaselineMiss('run-changed-during-restore');
}
