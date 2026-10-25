import assert from 'node:assert/strict';
import { timestamp } from './main-policy-audit-checks.mjs';

// https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#review_dismissed
// Current DISMISSED state alone cannot tell whether dismissal preceded the historical merge.
function stateAtMerge(review, events, merged) {
  const dismissals = events.filter(
    (event) =>
      event.event === 'review_dismissed' &&
      String(event.dismissed_review?.review_id) === String(review.id),
  );
  if (dismissals.length === 0) return review.state === 'DISMISSED' ? 'UNKNOWN' : review.state;
  if (dismissals.length !== 1) return 'UNKNOWN';
  const event = dismissals[0];
  const dismissed = timestamp(event.created_at);
  if (!Number.isFinite(dismissed) || dismissed === merged) return 'UNKNOWN';
  if (dismissed < merged) return 'DISMISSED';
  const original = event.dismissed_review.state?.toUpperCase();
  return ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(original) ? original : 'UNKNOWN';
}

function applicableReview(pr, review, events, merged) {
  if (review.state === 'PENDING') return null;
  const submitted = timestamp(review.submitted_at);
  assert.ok(Number.isFinite(submitted), 'Review submission timestamp unavailable');
  assert.ok(review.user?.login, 'Review identity unavailable');
  if (submitted >= merged || review.user.login === pr.user.login) return null;
  const state = stateAtMerge(review, events, merged);
  if (state === 'COMMENTED') return null; // A comment does not replace a prior approval/change request.
  assert.ok(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED', 'UNKNOWN'].includes(state));
  return {
    login: review.user.login,
    id: review.id,
    state,
    submitted,
    current: review.commit_id === pr.head.sha,
  };
}

function rememberLatest(latest, next) {
  const previous = latest.get(next.login);
  if (!previous || next.submitted > previous.submitted) latest.set(next.login, next);
  if (previous?.submitted === next.submitted && previous.id !== next.id) {
    latest.set(next.login, { ...next, state: 'UNKNOWN' });
  }
}

export function evaluateReviews(pr, reviews, events) {
  const merged = timestamp(pr.merged_at);
  assert.ok(Number.isFinite(merged), 'Valid merge timestamp is required');
  const latest = new Map();
  for (const review of reviews) {
    const next = applicableReview(pr, review, events, merged);
    if (next) rememberLatest(latest, next);
  }
  const decisions = [...latest.values()];
  return {
    requiredApprovals: 0,
    approved: decisions.filter((review) => review.state === 'APPROVED' && review.current).length,
    unavailable: decisions.filter((review) => review.state === 'UNKNOWN').length,
    decisions,
    evidence: 'informational only; ordinary code pull requests require zero approvals',
  };
}
