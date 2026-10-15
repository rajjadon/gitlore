/**
 * Shared PR action flows — no vscode import. Consumed by both LaunchpadViewProvider and
 * PullRequestDetailsViewProvider via a PullRequestActionUi adapter. Each flow returns true only if
 * the action actually reached the host; the caller is responsible for refreshing the view after.
 */
import type { ForgeClient } from '../core/forge/ForgeClient';
import type { MergeStrategy, PullRequestSummary, ReviewSubmission } from '../core/forge/types';
import { sameLogin } from '../core/forge/forgeFetch';

export interface PullRequestActionUi {
  confirm(message: string, ...buttons: string[]): Promise<string | undefined>;
  pickMergeStrategy(pr: PullRequestSummary): Promise<MergeStrategy | undefined>;
  warn(message: string): void;
  error(message: string): void;
}

export interface ActionContext {
  pr: PullRequestSummary;
  client: ForgeClient;
  ui: PullRequestActionUi;
  logError: (message: string, err: unknown) => void;
  /** The authenticated user's login for this repo's host — used only by submitReviewFlow to guard against self-review. Undefined when not yet resolved. */
  myLogin?: string;
}

export async function closePullRequestFlow(ctx: ActionContext): Promise<boolean> {
  const { pr, client, ui, logError } = ctx;
  const confirmed = await ui.confirm(`Close "${pr.title}"? This closes it on ${pr.repo.label} without merging.`, 'Close PR');
  if (confirmed !== 'Close PR') {
    return false;
  }
  try {
    await client.closePullRequest(pr.repo, pr.number);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to close PR #${pr.number}`, err);
    ui.error(`GitLore: couldn't close the PR — ${message}`);
    return false;
  }
}

export async function reopenPullRequestFlow(ctx: ActionContext): Promise<boolean> {
  const { pr, client, ui, logError } = ctx;
  const confirmed = await ui.confirm(`Reopen "${pr.title}" on ${pr.repo.label}?`, 'Reopen PR');
  if (confirmed !== 'Reopen PR') {
    return false;
  }
  try {
    await client.reopenPullRequest(pr.repo, pr.number);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to reopen PR #${pr.number}`, err);
    ui.error(`GitLore: couldn't reopen the PR — ${message}`);
    return false;
  }
}

export async function mergePullRequestFlow(ctx: ActionContext): Promise<boolean> {
  const { pr, client, ui, logError } = ctx;
  const strategy = await ui.pickMergeStrategy(pr);
  if (!strategy) {
    return false;
  }
  const confirmed = await ui.confirm(
    `Merge "${pr.title}" on ${pr.repo.label}? This can't be undone.`,
    'Merge',
    'Merge & Delete Branch',
  );
  if (confirmed !== 'Merge' && confirmed !== 'Merge & Delete Branch') {
    return false;
  }
  try {
    await client.mergePullRequest(pr.repo, pr.number, {
      strategy,
      deleteSourceBranch: confirmed === 'Merge & Delete Branch',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to merge PR #${pr.number}`, err);
    ui.error(`GitLore: couldn't merge the PR — ${message}`);
    return false;
  }
}

export async function submitReviewFlow(ctx: ActionContext, decision: ReviewSubmission): Promise<boolean> {
  const { pr, client, ui, logError, myLogin } = ctx;
  // Every host rejects a self-review one way or another — catching it here produces one clear
  // message instead of a different opaque API rejection per host.
  if (sameLogin(pr.authorLogin, myLogin)) {
    ui.warn("GitLore: you can't review your own pull request.");
    return false;
  }
  const verb = decision === 'approve' ? 'Approve' : 'Request changes on';
  const confirmed = await ui.confirm(`${verb} "${pr.title}" on ${pr.repo.label}?`, verb);
  if (confirmed !== verb) {
    return false;
  }
  try {
    await client.submitReview(pr.repo, pr.number, decision);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`failed to submit a review for PR #${pr.number}`, err);
    ui.error(`GitLore: couldn't submit that review — ${message}`);
    return false;
  }
}
