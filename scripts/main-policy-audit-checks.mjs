import assert from 'node:assert/strict';

// These names and the issuing App are the required-check contract, not job titles to rename casually.
export const requiredChecks = ['All checks', 'Conventional Commit PR title'];
const actionsApp = { id: 15368, slug: 'github-actions' };

export function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return NaN;
  return Date.parse(value);
}

function exactCheck(run, name, head) {
  return (
    run.name === name &&
    run.head_sha === head &&
    run.app?.id === actionsApp.id &&
    run.app?.slug === actionsApp.slug
  );
}

function successfulBefore(run, merged) {
  const started = timestamp(run.started_at);
  const completed = timestamp(run.completed_at);
  return (
    run.status === 'completed' &&
    run.conclusion === 'success' &&
    Number.isFinite(completed) &&
    completed >= started &&
    completed < merged
  );
}

function checkFailure(runs, name, merged) {
  if (runs.some((run) => !Number.isFinite(timestamp(run.started_at)))) {
    return `"${name}": historical start time unavailable`;
  }
  const applicable = runs.filter((run) => timestamp(run.started_at) < merged);
  if (applicable.length === 0) {
    return `"${name}": no exact-head GitHub Actions evidence from before the merge`;
  }
  const latest = Math.max(...applicable.map((run) => timestamp(run.started_at)));
  const tied = applicable.filter((run) => timestamp(run.started_at) === latest);
  if (tied.every((run) => successfulBefore(run, merged))) return null;
  // Equal-second events cannot establish ordering. Missing/deleted/overwritten history is not a pass.
  return `"${name}": latest applicable check was not proven successful before the merge`;
}

export function evaluateChecks(pr, runs) {
  const merged = timestamp(pr.merged_at);
  assert.ok(Number.isFinite(merged), 'Valid merge timestamp is required');
  assert.ok(Array.isArray(runs), 'Check history must be an array');
  return requiredChecks
    .map((name) =>
      checkFailure(
        runs.filter((run) => exactCheck(run, name, pr.head.sha)),
        name,
        merged,
      ),
    )
    .filter(Boolean);
}
