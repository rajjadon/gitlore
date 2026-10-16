import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeClosedPullRequests, categorizePullRequests } from '../../../../src/core/forge/categorize';
import type { ForgeRepoRef, PullRequestSummary } from '../../../../src/core/forge/types';

const REPO: ForgeRepoRef = { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' };
const ME = 'raj';

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    repo: REPO,
    number: 1,
    title: 'a change',
    url: 'https://github.com/acme/widgets/pull/1',
    authorLogin: ME,
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    requestedReviewers: [],
    checkStatus: 'passing',
    reviewDecision: 'approved',
    hasConflicts: false,
    reviewedByMe: false,
    headSha: '',
    ...overrides,
  };
}

const neverSnoozed = () => false;

test('categorizePullRequests: a snoozed PR always lands in "snoozed", regardless of any other state', () => {
  const result = categorizePullRequests(
    [pr({ isDraft: true, checkStatus: 'failing' })],
    ME,
    () => true,
  );
  assert.equal(result[0]?.bucket, 'snoozed');
});

test('categorizePullRequests: a draft is always "drafts", even with failing checks or conflicts', () => {
  const result = categorizePullRequests(
    [pr({ isDraft: true, checkStatus: 'failing', hasConflicts: true })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'drafts');
});

test('categorizePullRequests: failing checks land in "blocked"', () => {
  const result = categorizePullRequests([pr({ checkStatus: 'failing' })], ME, neverSnoozed);
  assert.equal(result[0]?.bucket, 'blocked');
});

test('categorizePullRequests: changes requested lands in "blocked"', () => {
  const result = categorizePullRequests([pr({ reviewDecision: 'changesRequested' })], ME, neverSnoozed);
  assert.equal(result[0]?.bucket, 'blocked');
});

test('categorizePullRequests: merge conflicts land in "blocked"', () => {
  const result = categorizePullRequests([pr({ hasConflicts: true })], ME, neverSnoozed);
  assert.equal(result[0]?.bucket, 'blocked');
});

test('categorizePullRequests: I am a requested reviewer -> "needsReview", even if checks are still pending', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], checkStatus: 'pending', reviewDecision: 'reviewRequired' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});

test('categorizePullRequests: needsReview wins over readyToMerge — being asked to review is the more actionable signal', () => {
  // Only one approval is required and someone else already gave it, so the PR-level decision is
  // already "approved" — but I'm still a requested (optional) reviewer.
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], reviewDecision: 'approved', checkStatus: 'passing' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});

test('categorizePullRequests: my own PR, approved and passing -> "readyToMerge"', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: ME, reviewDecision: 'approved', checkStatus: 'passing', hasConflicts: false })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'readyToMerge');
});

test('categorizePullRequests: my own PR, still awaiting review -> "waiting"', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: ME, reviewDecision: 'reviewRequired', checkStatus: 'pending' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'waiting');
});

test('categorizePullRequests: excludes PRs I have no stake in — not authored by me, not requesting my review', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: ['someone-else-again'] })],
    ME,
    neverSnoozed,
  );
  assert.deepEqual(result, []);
});

test('categorizePullRequests: no stake at all (never requested, never reviewed) still drops the PR', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [], reviewedByMe: false, reviewDecision: 'reviewRequired', checkStatus: 'pending' })],
    ME,
    neverSnoozed,
  );
  assert.deepEqual(result, []);
});

test('categorizePullRequests: a PR I already reviewed but do not own lands in "reviewed" instead of vanishing from the board (the bug "Reviewed" exists to fix)', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [], reviewedByMe: true, reviewDecision: 'reviewRequired', checkStatus: 'pending' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'reviewed');
});

test('categorizePullRequests: "reviewed" wins over blocked, even with failing checks and a conflict — your job as reviewer is done regardless of what happens afterward', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [], reviewedByMe: true, checkStatus: 'failing', hasConflicts: true })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'reviewed');
});

test('categorizePullRequests: "reviewed" wins over readyToMerge too — reviewedByMe alone decides the bucket for a PR you do not author', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [], reviewedByMe: true, reviewDecision: 'approved', checkStatus: 'passing' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'reviewed');
});

test('categorizePullRequests: never applies to your own authored PR, even if reviewedByMe were somehow true', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: ME, reviewedByMe: true, reviewDecision: 'reviewRequired', checkStatus: 'pending' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'waiting');
});

test('categorizePullRequests: a fresh re-request after an earlier review wins over "reviewed" — being asked again is more urgent than "already reviewed"', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], reviewedByMe: true, reviewDecision: 'reviewRequired', checkStatus: 'pending' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});

test('categorizePullRequests: snoozed still wins over "reviewed"', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [], reviewedByMe: true })],
    ME,
    () => true,
  );
  assert.equal(result[0]?.bucket, 'snoozed');
});

test('categorizeClosedPullRequests: a merged PR lands in "merged"', () => {
  const result = categorizeClosedPullRequests([pr({ merged: true, closedAt: '2024-01-05T00:00:00Z' })], ME);
  assert.equal(result[0]?.bucket, 'merged');
});

test('categorizeClosedPullRequests: a closed-without-merging PR lands in "closed"', () => {
  const result = categorizeClosedPullRequests([pr({ merged: false, closedAt: '2024-01-05T00:00:00Z' })], ME);
  assert.equal(result[0]?.bucket, 'closed');
});

test('categorizeClosedPullRequests: excludes PRs authored by someone else, even if I reviewed them', () => {
  const result = categorizeClosedPullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], merged: true, closedAt: '2024-01-05T00:00:00Z' })],
    ME,
  );
  assert.deepEqual(result, []);
});

// N5: case-insensitive login comparisons via sameLogin
test('categorizePullRequests: authorLogin match is case-insensitive (N5)', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'RAJ' })],
    'raj',
    neverSnoozed,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]?.bucket, 'readyToMerge');
});

test('categorizePullRequests: requestedReviewers match is case-insensitive (N5)', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: ['RAJ'], reviewDecision: 'reviewRequired' })],
    'raj',
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});

test('categorizeClosedPullRequests: authorLogin match is case-insensitive (N5)', () => {
  const result = categorizeClosedPullRequests([pr({ authorLogin: 'RAJ', merged: true, closedAt: '2024-01-05T00:00:00Z' })], 'raj');
  assert.equal(result[0]?.bucket, 'merged');
});

// ─── C4.1: reviewer-owned PR bucket rule (L9) ────────────────────────────────
// A PR you did NOT author never goes to Blocked — a requested review wins → Needs Review.
// Blocked is only for PRs you authored (failing CI / changes requested / conflicts).

test('C4.1: reviewer + failing CI → needsReview, not blocked (non-authored PR)', () => {
  // I am a requested reviewer on someone else's PR with failing CI
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], checkStatus: 'failing' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});

test('C4.1: own PR + failing CI → blocked', () => {
  const result = categorizePullRequests(
    [pr({ authorLogin: ME, checkStatus: 'failing' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'blocked');
});

test('C4.1: reviewer-requested + changes requested by someone else → needsReview, not blocked', () => {
  // Another reviewer requested changes, but I'm still a requested reviewer — not blocked (I don't own it)
  const result = categorizePullRequests(
    [pr({ authorLogin: 'someone-else', requestedReviewers: [ME], reviewDecision: 'changesRequested' })],
    ME,
    neverSnoozed,
  );
  assert.equal(result[0]?.bucket, 'needsReview');
});
