import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createMetadataApi, collectChecks, collectCommits } from './main-policy-audit-api.mjs';
import { evaluateChecks } from './main-policy-audit-checks.mjs';
import { evaluateReviews } from './main-policy-audit-reviews.mjs';

const conventional =
  /^(feat|fix|perf|docs|style|refactor|test|build|ci|chore|revert)(?:\([^\r\n()]+\))?!?: \S[^\r\n]*$/;

function matchingPullRequest(candidate, sha, repo) {
  return (
    candidate.merged_at &&
    candidate.merge_commit_sha === sha &&
    candidate.base.ref === 'main' &&
    candidate.base.repo.full_name === repo
  );
}

function collectReviews(api, repo, pr) {
  try {
    const reviews = api.list(`repos/${repo}/pulls/${pr.number}/reviews`);
    const events = api.list(`repos/${repo}/issues/${pr.number}/events`);
    return evaluateReviews(pr, reviews, events);
  } catch {
    return { requiredApprovals: 0, evidence: 'optional historical review evidence unavailable' };
  }
}

export function auditCommit(commit, repo, api) {
  const failures = [];
  if (commit.parents.length !== 1) failures.push(`${commit.sha}: not a squash commit`);
  if (!conventional.test(commit.commit.message.split('\n', 1)[0])) {
    failures.push(`${commit.sha}: subject is not a Conventional Commit`);
  }
  const pulls = api.list(`repos/${repo}/commits/${commit.sha}/pulls`);
  const matches = pulls.filter((candidate) => matchingPullRequest(candidate, commit.sha, repo));
  if (matches.length !== 1) {
    failures.push(`${commit.sha}: exactly one merged main pull request is required`);
    return { sha: commit.sha, failures };
  }
  const pr = api.get(`repos/${repo}/pulls/${matches[0].number}`);
  assert.ok(
    matchingPullRequest(pr, commit.sha, repo),
    'Pull request identity changed during audit',
  );
  assert.match(pr.head.sha, /^[a-f\d]{40}$/, 'Exact pull request head unavailable');
  const checks = evaluateChecks(pr, collectChecks(api, repo, pr.head.sha));
  failures.push(...checks.map((failure) => `${commit.sha}: PR #${pr.number} ${failure}`));
  return {
    sha: commit.sha,
    pr: pr.number,
    head: pr.head.sha,
    mergedAt: pr.merged_at,
    failures,
    reviews: collectReviews(api, repo, pr),
  };
}

export function auditPush({ repo, before, after, forced }, api = createMetadataApi()) {
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  assert.match(before, /^[a-f\d]{40}$/);
  assert.match(after, /^[a-f\d]{40}$/);
  const failures = forced ? ['main was force-pushed; its previous history was rewritten'] : [];
  const commits = collectCommits(api, repo, before, after);
  const audits = commits.map((commit) => auditCommit(commit, repo, api));
  failures.push(...audits.flatMap((audit) => audit.failures));
  return { failures, audits };
}

function main() {
  try {
    const result = auditPush({
      repo: process.env.GH_REPO,
      before: process.env.BEFORE_SHA,
      after: process.env.AFTER_SHA,
      forced: process.env.FORCED === 'true',
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.failures.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(
      `Main policy audit inconclusive; required historical evidence unavailable: ${error.message}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
