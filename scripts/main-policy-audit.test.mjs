import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateChecks, requiredChecks } from './main-policy-audit-checks.mjs';
import { evaluateReviews } from './main-policy-audit-reviews.mjs';
import { createMetadataApi, collectChecks, collectCommits } from './main-policy-audit-api.mjs';
import { auditCommit, auditPush } from './main-policy-audit.mjs';

const repo = 'owner/project';
const head = 'a'.repeat(40);
const sha = 'b'.repeat(40);
const before = 'c'.repeat(40);
const mergedAt = '2026-10-25T12:00:00Z';
const early = '2026-10-25T11:00:00Z';
const late = '2026-10-25T13:00:00Z';
const pr = {
  number: 12,
  merged_at: mergedAt,
  merge_commit_sha: sha,
  head: { sha: head },
  base: { ref: 'main', repo: { full_name: repo } },
  user: { login: 'author' },
};
const commit = { sha, parents: [{ sha: before }], commit: { message: 'fix: safe change' } };
const check = (name = requiredChecks[0], overrides = {}) => ({
  id: 1,
  name,
  head_sha: head,
  app: { id: 15368, slug: 'github-actions' },
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-10-25T10:00:00Z',
  completed_at: early,
  ...overrides,
});
const checks = () => requiredChecks.map((name, index) => check(name, { id: index + 1 }));
const review = (overrides = {}) => ({
  id: 1,
  user: { login: 'reviewer' },
  state: 'APPROVED',
  commit_id: head,
  submitted_at: early,
  ...overrides,
});
const dismissal = (createdAt = early) => ({
  id: 30,
  event: 'review_dismissed',
  created_at: createdAt,
  dismissed_review: { review_id: 1, state: 'approved' },
});

test('stable exact-head timely successful GitHub Actions checks are required', () => {
  assert.deepEqual(requiredChecks, ['All checks', 'Conventional Commit PR title']);
  assert.deepEqual(evaluateChecks(pr, checks()), []);
  for (const patch of [
    { head_sha: before },
    { app: { id: 9, slug: 'github-actions' } },
    { app: { id: 15368, slug: 'impostor' } },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { conclusion: 'neutral' },
    { completed_at: late },
    { completed_at: mergedAt },
    { completed_at: null },
    { started_at: null },
    { completed_at: 'not a timestamp' },
  ]) {
    assert.notEqual(evaluateChecks(pr, [check(undefined, patch), checks()[1]]).length, 0);
  }
  assert.notEqual(evaluateChecks(pr, []).length, 0);
});

test('later reruns cannot retroactively cure an early merge', () => {
  const lateSuccess = check(undefined, { id: 3, started_at: late, completed_at: late });
  assert.notEqual(evaluateChecks(pr, [lateSuccess, checks()[1]]).length, 0);
  assert.notEqual(
    evaluateChecks(pr, [check(undefined, { conclusion: 'failure' }), lateSuccess, checks()[1]])
      .length,
    0,
  );
  assert.deepEqual(evaluateChecks(pr, [...checks(), lateSuccess]), []);
  assert.notEqual(
    evaluateChecks(pr, [
      ...checks(),
      check(undefined, { id: 4, started_at: early, completed_at: late }),
    ]).length,
    0,
  );
});

test('latest pre-merge attempt wins and indistinguishable conflicting attempts fail closed', () => {
  const newerFailure = check(undefined, { id: 5, started_at: early, conclusion: 'failure' });
  assert.notEqual(evaluateChecks(pr, [...checks(), newerFailure]).length, 0);
  assert.notEqual(
    evaluateChecks(pr, [...checks(), check(undefined, { id: 7, conclusion: 'failure' })]).length,
    0,
  );
  assert.throws(() => evaluateChecks({ ...pr, merged_at: 'invalid' }, checks()), /merge timestamp/);
});

test('zero ordinary reviewers: only latest timely decisive exact-head review is applicable', () => {
  assert.equal(evaluateReviews(pr, [], []).requiredApprovals, 0);
  assert.equal(evaluateReviews(pr, [review()], []).approved, 1);
  for (const next of [
    { state: 'CHANGES_REQUESTED' },
    { commit_id: before },
    { state: 'DISMISSED' },
  ]) {
    const second = review({ ...next, id: 2, submitted_at: '2026-10-25T11:30:00Z' });
    assert.equal(evaluateReviews(pr, [review(), second], []).approved, 0);
  }
  assert.equal(evaluateReviews(pr, [review({ user: { login: 'author' } })], []).approved, 0);
  assert.equal(evaluateReviews(pr, [review({ submitted_at: late })], []).approved, 0);
  assert.equal(evaluateReviews(pr, [review({ submitted_at: mergedAt })], []).approved, 0);
  const comment = review({ id: 2, state: 'COMMENTED', submitted_at: '2026-10-25T11:30:00Z' });
  assert.equal(evaluateReviews(pr, [review(), comment], []).approved, 1);
});

test('review dismissal event reconstructs only supported historical state', () => {
  const dismissed = review({ state: 'DISMISSED' });
  assert.equal(evaluateReviews(pr, [dismissed], [dismissal()]).approved, 0);
  assert.equal(evaluateReviews(pr, [dismissed], [dismissal(late)]).approved, 1);
  assert.equal(evaluateReviews(pr, [dismissed], []).unavailable, 1);
  assert.equal(evaluateReviews(pr, [dismissed], [dismissal(mergedAt)]).unavailable, 1);
});

test('all metadata pages are flattened and missing, duplicate or malformed pages reject', () => {
  const calls = [];
  const api = createMetadataApi((command, args) => {
    calls.push({ command, args });
    return JSON.stringify([[{ id: 1 }], [{ id: 2 }]]);
  });
  assert.deepEqual(api.list('repos/owner/project/pulls/12/reviews'), [{ id: 1 }, { id: 2 }]);
  assert.equal(calls[0].command, 'gh');
  assert.ok(calls[0].args.includes('--paginate'));
  assert.ok(calls[0].args.includes('--slurp'));
  assert.ok(calls[0].args.includes('GET'));
  assert.ok(calls[0].args.some((arg) => arg.includes('per_page=100')));
  for (const pages of [
    [],
    [{}],
    [[{ id: 1 }], [{ id: 1 }]],
    [{ check_runs: [], total_count: 1 }],
  ]) {
    const malformed = createMetadataApi(() => JSON.stringify(pages));
    assert.throws(() => malformed.list('repos/owner/project/checks', 'check_runs'));
  }
});

test('101+ reviews and suite pages are retained; incomplete history and API failures are explicit', () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({ id: index + 1 }));
  const chunks = [rows.slice(0, 100), rows.slice(100, 200), rows.slice(200)];
  const arrays = createMetadataApi(() => JSON.stringify(chunks));
  assert.equal(arrays.list('repos/owner/project/pulls/12/reviews').length, 201);
  const objects = createMetadataApi(() =>
    JSON.stringify(chunks.map((check_suites) => ({ check_suites, total_count: 201 }))),
  );
  assert.equal(
    objects.list('repos/owner/project/commits/head/check-suites', 'check_suites').length,
    201,
  );
  const duplicate = createMetadataApi(() => JSON.stringify([[{ id: 1 }], [{ id: 1 }]]));
  assert.throws(() => duplicate.list('repos/owner/project/pulls'), /Duplicate/);
  const absent = createMetadataApi(() => {
    throw new Error('private response body and token must not be printed');
  });
  assert.throws(
    () => absent.get('repos/owner/project/pulls/12'),
    /historical metadata unavailable/,
  );
  assert.throws(() => absent.get('https://other.example/secret'), /repository metadata/);
});

test('collector visits every suite and every run with filter=all', () => {
  const paths = [];
  const api = {
    list(path, field) {
      paths.push(path);
      if (field === 'check_suites') return [{ id: 10 }, { id: 20 }];
      return [check(undefined, { id: path.includes('/10/') ? 1 : 2 })];
    },
  };
  assert.equal(collectChecks(api, repo, head).length, 2);
  assert.ok(paths.slice(1).every((path) => path.includes('filter=all')));
  assert.ok(paths.every((path) => !path.includes('/commits/') || path.endsWith('/check-suites')));
});

test('pushed commit range is paginated and creation or incomplete range is unavailable', () => {
  const api = { list: () => [commit] };
  assert.deepEqual(collectCommits(api, repo, before, sha), [commit]);
  assert.throws(() => collectCommits(api, repo, '0'.repeat(40), sha), /creation/);
  assert.throws(() => collectCommits({ list: () => [] }, repo, before, sha), /range/);
  assert.throws(() => collectCommits(api, repo, before, head), /range/);
});

function completeApi(options = {}) {
  return {
    get: () => pr,
    list(path, field) {
      if (path.includes('/compare/')) return [commit];
      if (path.endsWith('/pulls')) return [pr];
      if (field === 'check_suites') return [{ id: 1 }];
      if (field === 'check_runs') return options.checks ?? checks();
      if (options.reviewsUnavailable) throw new Error('HTTP 403');
      return [];
    },
  };
}

test('commit audit needs no approval; unavailable optional history is explicit and nonblocking', () => {
  const result = auditCommit(commit, repo, completeApi({ reviewsUnavailable: true }));
  assert.deepEqual(result.failures, []);
  assert.match(result.reviews.evidence, /unavailable/);
  assert.equal(result.reviews.requiredApprovals, 0);
  assert.notEqual(auditCommit(commit, repo, completeApi({ checks: [] })).failures.length, 0);
});

test('push audit rejects forced, direct and non-squash history without logging untrusted subjects', () => {
  assert.notEqual(
    auditPush({ repo, before, after: sha, forced: true }, completeApi()).failures.length,
    0,
  );
  const bad = { ...commit, parents: [], commit: { message: 'invalid\n::error::injection' } };
  const result = auditCommit(bad, repo, completeApi());
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.every((message) => !message.includes('injection')));
  const directApi = { list: () => [] };
  assert.match(auditCommit(commit, repo, directApi).failures[0], /pull request/);
});
