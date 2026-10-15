import type { CategorizedPullRequest, LaunchpadBucket, PullRequestSummary } from './types';
import { sameLogin } from './forgeFetch';

function bucketFor(pr: PullRequestSummary, myLogin: string, snoozed: boolean): LaunchpadBucket {
  if (snoozed) {
    return 'snoozed';
  }
  // A draft's readiness isn't about CI/review state at all — none of that is actionable while
  // it's still a draft, so this check comes before (and overrides) blocked/ready/needs-review.
  if (pr.isDraft) {
    return 'drafts';
  }
  // Once you've reviewed a PR you don't own, your job here is done — this wins over
  // blocked/ready-to-merge/waiting regardless of what happens to the PR afterward (CI turns red, a
  // conflict appears, another reviewer requests changes), UNLESS the host has put you back in
  // requestedReviewers — a fresh re-request after your earlier review is a more urgent, more
  // actionable signal than "already reviewed", so that still routes through the checks below.
  if (!sameLogin(pr.authorLogin, myLogin) && pr.reviewedByMe && !pr.requestedReviewers.some((r) => sameLogin(r, myLogin))) {
    return 'reviewed';
  }
  if (pr.checkStatus === 'failing' || pr.reviewDecision === 'changesRequested' || pr.hasConflicts) {
    return 'blocked';
  }
  // Still in requestedReviewers means I haven't submitted a review yet — GitHub (and the other
  // hosts, normalized the same way) removes a reviewer from this list the moment they do.
  if (pr.requestedReviewers.some((r) => sameLogin(r, myLogin))) {
    return 'needsReview';
  }
  if (pr.reviewDecision === 'approved' && pr.checkStatus !== 'pending' && !pr.hasConflicts) {
    return 'readyToMerge';
  }
  return 'waiting';
}

/**
 * Buckets open PRs into the board's columns. Only surfaces PRs the user actually has a stake in —
 * authored by them, still owed a review from them, or already reviewed by them — dropping the
 * rest: a triage board for "what needs my attention" shouldn't also show every other PR in a busy
 * shared repo. `|| pr.reviewedByMe` matters: without it, a PR you reviewed but don't own vanishes
 * from the board the moment the host removes you from `requestedReviewers`, instead of moving to
 * "Reviewed" the way it should.
 *
 * Pure — no I/O, no host-specific knowledge. Each `ForgeClient` normalizes its host's API shape
 * into `PullRequestSummary` first; this only ever sees the common shape.
 */
export function categorizePullRequests(
  pullRequests: PullRequestSummary[],
  currentUserLogin: string,
  isSnoozed: (pr: PullRequestSummary) => boolean,
): CategorizedPullRequest[] {
  return pullRequests
    .filter(
      (pr) => sameLogin(pr.authorLogin, currentUserLogin) || pr.requestedReviewers.some((r) => sameLogin(r, currentUserLogin)) || pr.reviewedByMe,
    )
    .map((pr) => ({ pr, bucket: bucketFor(pr, currentUserLogin, isSnoozed(pr)) }));
}

/**
 * Buckets recently closed/merged PRs into "merged" or "closed" — a completed PR's review/check
 * state is no longer actionable, so this skips `bucketFor` entirely rather than reusing it.
 *
 * Scoped to PRs the user authored, not ones they merely reviewed: `listRecentlyClosedPullRequests`
 * doesn't fetch reviewer data (nothing to enrich on a PR that's already done), so "requested
 * reviewer" isn't available to filter on the way it is for open PRs.
 */
export function categorizeClosedPullRequests(pullRequests: PullRequestSummary[], currentUserLogin: string): CategorizedPullRequest[] {
  return pullRequests
    .filter((pr) => sameLogin(pr.authorLogin, currentUserLogin))
    .map((pr) => ({ pr, bucket: pr.merged ? 'merged' : 'closed' }));
}
