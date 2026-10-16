import type { CheckDetail, ConversationThread, PullRequestSummary, ThreadComment } from '../../core/forge/types';
import type { FileChange } from '../../core/git/types';
import { formatAge, formatAbsolute } from '../../utils/date';
import { escapeHtml } from '../escapeHtml';
import { renderFileSections } from '../diffRender';
import { renderTooltipScript } from '../tooltipScript';
import {
  AI_ICON,
  APPROVE_ICON,
  AUTHOR_ICON,
  CHECKS_ICON,
  CLOCK_ICON,
  CLOSE_ICON,
  EXTERNAL_ICON,
  FILES_ICON,
  MERGE_ICON,
  MESSAGE_ICON,
  REFRESH_ICON,
  REOPEN_ICON,
  REQUEST_CHANGES_ICON,
  SEARCH_ICON,
  WARNING_INLINE_ICON,
  WRAP_ICON,
} from '../icons';
// Re-export diffCacheKey so existing callers that import it from here keep working. The canonical
// definition lives in src/core/forge/PullRequestDiffCache.ts (vscode-free, unit-tested).
export { diffCacheKey } from '../../core/forge/PullRequestDiffCache';

export interface RenderPullRequestDetailsOptions {
  nonce: string;
  cspSource: string;
  /** Shared diff rules first, then the panel's own. */
  styleUris: string[];
}

export interface PullRequestDetailsData {
  pr: PullRequestSummary;
  files: FileChange[];
  diff: string;
  threads: ConversationThread[];
  now?: Date;
}

/** Only http(s) URLs may be opened from a check link — any other scheme is rejected here at the
 *  render layer (data attribute omitted) and again in the provider's message handler. */
function isSafeUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** One check row: status icon + name + optional log link (https/http only). */
function renderCheckRow(check: CheckDetail): string {
  const name = escapeHtml(check.name);
  const statusIcon = check.status === 'failing' ? REQUEST_CHANGES_ICON
    : check.status === 'pending' ? CLOCK_ICON
    : APPROVE_ICON;
  const linkBtn = check.url && isSafeUrl(check.url)
    ? ` <button class="check-link icon-btn" type="button" data-check-url="${escapeHtml(check.url)}" data-tooltip="Open check log" aria-label="Open ${name} check log">${EXTERNAL_ICON}</button>`
    : '';
  return `<div class="check-row check-${escapeHtml(check.status)}">${statusIcon}<span class="check-name">${name}</span>${linkBtn}</div>`;
}

/**
 * Renders the checks list. Exported so tests can call it directly (checks load lazily after
 * the main HTML is rendered, so the initial HTML only contains a skeleton). Ordering: failing
 * first, then pending, then passing collapsed to a count — the most actionable information
 * at the top. Pure — no I/O, no vscode import.
 */
export function renderChecks(checks: CheckDetail[], error?: string): string {
  if (error) {
    return `<p class="error-inline">Checks failed to load: ${escapeHtml(error)}</p>`;
  }
  if (checks.length === 0) {
    return '<p class="muted">No checks on this pull request.</p>';
  }
  const failing = checks.filter((c) => c.status === 'failing');
  const pending = checks.filter((c) => c.status === 'pending');
  const passing = checks.filter((c) => c.status === 'passing');

  const rows = [...failing, ...pending].map(renderCheckRow).join('\n');
  const passingCount = passing.length;
  const passingLine = passingCount > 0
    ? `<div class="check-passing-count">${APPROVE_ICON}<span>${passingCount} check${passingCount === 1 ? '' : 's'} passing</span></div>`
    : '';
  return rows + passingLine;
}

/** One comment in a thread, oldest-first. `createdAt` is optional — absent for threads fetched
 *  from hosts that don't expose individual comment timestamps. */
function renderComment(comment: ThreadComment, now: Date): string {
  const time = comment.createdAt
    ? ` · <span class="thread-comment-time">${escapeHtml(formatAge(new Date(comment.createdAt), now))}</span>`
    : '';
  return `<div class="thread-comment">
<div class="thread-body">${escapeHtml(comment.body)}</div>
<div class="thread-comment-meta"><span class="thread-author">${escapeHtml(comment.authorLogin)}</span>${time}</div>
</div>`;
}

/**
 * Thread location as a jump button: clicking scrolls the diff to that file's section. Disabled
 * with an explanatory title when the file isn't in the diff (e.g. deleted files, renamed files
 * the diff shows under a different path). Azure DevOps prefixes paths with `/` — normalized here
 * for display and for the anchor lookup.
 */
function renderThreadLocation(file: string, line: number | undefined, diffFiles: Set<string>): string {
  const normalized = file.replace(/^\//, '');
  const label = `${normalized}${line !== undefined ? `:${line}` : ''}`;
  const isInDiff = diffFiles.has(normalized.toLowerCase());
  if (isInDiff) {
    return `<button class="thread-location thread-jump-btn" type="button" data-anchor-file="${escapeHtml(normalized)}" data-tooltip="Scroll to this file in the diff" aria-label="Jump to ${escapeHtml(label)} in the diff">${escapeHtml(label)}</button>`;
  }
  return `<button class="thread-location thread-jump-btn" type="button" disabled title="This file isn't in the diff for this PR" aria-label="${escapeHtml(label)} (not in diff)">${escapeHtml(label)}</button>`;
}

/** One review conversation: all comments, a reply box, and a Resolve/Unresolve button. */
function renderThread(thread: ConversationThread, diffFiles: Set<string>, now: Date): string {
  // Resolve on unresolved threads; Unresolve on already-resolved ones (B2.3).
  const actionBtn = thread.resolved
    ? `<button class="thread-unresolve icon-btn" type="button" data-thread-id="${escapeHtml(thread.id)}" data-tooltip="Unresolve" aria-label="Unresolve this conversation">${REFRESH_ICON}</button>`
    : `<button class="thread-resolve icon-btn" type="button" data-thread-id="${escapeHtml(thread.id)}" data-tooltip="Resolve" aria-label="Resolve this conversation">${APPROVE_ICON}</button>`;

  // Location button only when the host reported one (absent for general PR-level comments).
  const location = thread.file !== undefined
    ? renderThreadLocation(thread.file, thread.line, diffFiles)
    : '';

  // All comments in the thread, oldest first (B2.3).
  const commentsHtml = thread.comments.map((c) => renderComment(c, now)).join('\n');

  // Reply box — disabled while posting, cleared on success, error-toast + re-enabled on failure (B2.3).
  const threadId = escapeHtml(thread.id);
  const replyBox = `<div class="thread-reply">
<textarea class="thread-reply-body" data-thread-id="${threadId}" placeholder="Reply to this thread…" aria-label="Reply to this conversation thread" rows="2"></textarea>
<div class="thread-reply-actions">
<button class="btn thread-reply-btn" type="button" data-thread-id="${threadId}">Reply</button>
</div>
</div>`;

  return `<div class="thread gitlore-enter${thread.resolved ? ' thread-resolved' : ''}" data-thread-id="${threadId}">
${location}
${commentsHtml}
<div class="thread-meta">${actionBtn}</div>
${replyBox}
</div>`;
}

function renderThreads(threads: ConversationThread[], diffFiles: Set<string>, now: Date): string {
  if (threads.length === 0) {
    return '<p class="empty">No review conversations on this pull request.</p>';
  }
  return threads.map((t) => renderThread(t, diffFiles, now)).join('\n');
}

/**
 * Merge only appears when the PR is already approved, checks aren't pending, and there are no
 * conflicts — the exact same "ready to merge" rule `categorize.ts`'s `bucketFor` uses for
 * Launchpad's own board, so clicking it here never bounces off a host-side rejection the badges
 * above already would have predicted. Approve/Request Changes/Close show on any open PR (matching
 * Launchpad's own card, which doesn't special-case drafts either); Reopen only on a closed (not
 * merged) one — no host we support lets a merge be undone this way.
 */
function renderActionButtons(pr: PullRequestSummary): string {
  if (pr.closedAt) {
    return pr.merged
      ? ''
      : `<button class="icon-btn" id="reopen-pr" type="button" data-tooltip="Reopen PR" aria-label="Reopen this pull request">${REOPEN_ICON}</button>`;
  }
  const canMerge = pr.reviewDecision === 'approved' && pr.checkStatus !== 'pending' && !pr.hasConflicts;
  const mergeButton = canMerge
    ? `<button class="icon-btn" id="merge-pr" type="button" data-tooltip="Merge PR" aria-label="Merge this pull request">${MERGE_ICON}</button>`
    : '';
  return `<button class="icon-btn" id="approve-pr" type="button" data-tooltip="Approve PR" aria-label="Approve this pull request">${APPROVE_ICON}</button>
<button class="icon-btn" id="request-changes-pr" type="button" data-tooltip="Request changes on PR" aria-label="Request changes on this pull request">${REQUEST_CHANGES_ICON}</button>
${mergeButton}<button class="icon-btn" id="close-pr" type="button" data-tooltip="Close PR" aria-label="Close this pull request">${CLOSE_ICON}</button>`;
}

/**
 * Every field read here is already fetched onto `PullRequestSummary` for Launchpad's board
 * categorization (`categorize.ts`) but was never surfaced once you actually open a PR's own
 * details — so the panel used to give no indication a PR is a draft, already merged/closed, has
 * failing checks, has conflicts, or is still owed reviews. Text-only, no icon: the badge's own
 * label already satisfies "never rely on color alone" (CLAUDE.md §18) without needing to stretch
 * one icon shape across two unrelated meanings (e.g. "changes requested" vs. "has conflicts").
 */
function renderStatusBadges(pr: PullRequestSummary, now: Date): string {
  const badges: string[] = [];

  if (pr.isDraft) {
    badges.push('<span class="badge">Draft</span>');
  }
  // A merged/closed PR's diff already landed (or never will) — without this, its details panel
  // looks identical to a live, still-open PR.
  if (pr.closedAt) {
    badges.push(pr.merged ? '<span class="badge badge-success">Merged</span>' : '<span class="badge">Closed</span>');
  }

  if (pr.checkStatus === 'passing') {
    badges.push('<span class="badge badge-success">Checks passing</span>');
  } else if (pr.checkStatus === 'failing') {
    badges.push('<span class="badge badge-danger">Checks failing</span>');
  } else if (pr.checkStatus === 'pending') {
    badges.push('<span class="badge">Checks running</span>');
  }

  if (pr.reviewDecision === 'approved') {
    badges.push('<span class="badge badge-success">Approved</span>');
  } else if (pr.reviewDecision === 'changesRequested') {
    badges.push('<span class="badge badge-danger">Changes requested</span>');
  } else if (pr.reviewDecision === 'reviewRequired') {
    const count = pr.requestedReviewers.length;
    badges.push(`<span class="badge">${count} ${count === 1 ? 'review' : 'reviews'} requested</span>`);
  }

  if (pr.hasConflicts) {
    badges.push('<span class="badge badge-danger">Has conflicts</span>');
  }

  // Same "closed date once terminal, else created date" convention Launchpad's own card age
  // already uses — that's the age that actually matters once a PR is done.
  const date = new Date(pr.closedAt ?? pr.createdAt);
  badges.push(
    `<span class="head-age" title="${escapeHtml(formatAbsolute(date, 'yyyy-MM-dd HH:mm'))}">${escapeHtml(formatAge(date, now))}</span>`,
  );

  return badges.join('\n');
}

/** Whole-PR totals for the section header — `0` for every file (Azure DevOps' documented gap, see `AzureDevOpsClient.getPullRequestDiff`) reads the same as "no changes", which is the honest fallback here rather than a misleading non-zero guess. */
function renderTotals(files: FileChange[]): string {
  const insertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return `<span class="totals"><span class="stat-add">+${insertions}</span><span class="stat-del">&minus;${deletions}</span></span>`;
}

/** Builds the PR Details webview's full HTML document. Pure — nonce/cspSource/styleUris come from the caller, so this is unit-testable without a real webview host. */
export function renderPullRequestDetailsHtml(data: PullRequestDetailsData, opts: RenderPullRequestDetailsOptions): string {
  const { pr, files, diff, threads } = data;
  const now = data.now ?? new Date();
  const styles = opts.styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n');

  // Build the set of normalized (no leading slash, lowercased) file paths present in the diff,
  // used to enable/disable thread jump buttons (B5.1).
  const diffFiles = new Set(files.map((f) => f.path.replace(/^\//, '').toLowerCase()));

  // Count unresolved threads for the badge (B6.1). Only shown when > 0.
  const unresolvedCount = threads.filter((t) => !t.resolved).length;
  const unresolvedBadge = unresolvedCount > 0
    ? `<span class="badge badge-danger" aria-label="${unresolvedCount} unresolved">${WARNING_INLINE_ICON}${unresolvedCount} unresolved</span>`
    : '';

  // Review textarea is only meaningful on open PRs (approve/request changes only exist there).
  const reviewBodyForm = !pr.closedAt
    ? `<div class="review-body-form">
<label for="review-body">Review comment (optional)</label>
<textarea id="review-body" placeholder="Add a comment with your review…" aria-label="Review comment" rows="2"></textarea>
</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; img-src https: ${opts.cspSource}; script-src 'nonce-${opts.nonce}';" />
${styles}
<title>${escapeHtml(pr.title)}</title>
</head>
<body>
<div class="head">
<div class="head-text">
<h1 title="${escapeHtml(pr.title)}">${escapeHtml(pr.title)}</h1>
<div class="head-meta"><span class="head-author">${AUTHOR_ICON}${escapeHtml(pr.authorLogin)}</span><span class="head-sep">&middot;</span><span class="head-repo">${escapeHtml(pr.repo.label)}</span></div>
<div class="head-badges">${renderStatusBadges(pr, now)}</div>
</div>
</div>
${reviewBodyForm}
<div class="actions">
<button class="btn" id="open-remote" type="button" title="${escapeHtml(pr.url)}">${EXTERNAL_ICON}Open on ${escapeHtml(pr.repo.host)}</button>
<button class="icon-btn" id="refresh-pr" type="button" data-tooltip="Refresh — picks up changes made elsewhere (e.g. a review submitted from Launchpad)" aria-label="Refresh this pull request's details">${REFRESH_ICON}</button>
${renderActionButtons(pr)}
<button class="btn btn-accent" id="explain-pr" type="button" title="Explain this PR with AI">${AI_ICON}Explain</button>
<button class="btn" id="draft-review" type="button" title="Draft a review comment with AI">${AI_ICON}Draft Review</button>
</div>
<div class="ai-summary">
<p class="ai-summary-text" id="ai-summary-text" aria-live="polite" hidden></p>
<p class="ai-summary-hint" id="ai-summary-hint" role="status" hidden></p>
<p class="ai-review-progress" id="ai-review-progress" role="status" aria-live="polite" hidden></p>
<div class="skeleton" id="ai-summary-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Generating…" hidden>
<div class="skeleton-row" style="width: 92%"></div>
<div class="skeleton-row" style="width: 68%"></div>
</div>
</div>
<div class="section-head">
${FILES_ICON}<span class="section-title">Files changed</span><span class="badge">${files.length}</span>
${renderTotals(files)}
<span class="search">${SEARCH_ICON}<input id="file-filter" type="search" placeholder="Filter files…" aria-label="Filter changed files by path" autocomplete="off" spellcheck="false" /></span>
<button class="icon-btn" id="wrap" type="button" aria-pressed="false" data-tooltip="Wrap long lines" aria-label="Wrap long lines">${WRAP_ICON}</button>
</div>
<div class="files" id="files">
${renderFileSections(files, diff)}
</div>
<p class="empty" id="no-match" hidden>No files match that filter.</p>
<div class="section-head" id="checks-section-head">
${CHECKS_ICON}<span class="section-title">Checks</span>
</div>
<div class="checks" id="checks-container">
<div class="skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Loading checks…">
<div class="skeleton-row" style="width: 70%"></div>
<div class="skeleton-row" style="width: 50%"></div>
</div>
</div>
<div class="section-head">
${MESSAGE_ICON}<span class="section-title">Conversations</span><span class="badge">${threads.length}</span>
${unresolvedBadge}
</div>
<div class="threads" id="threads">
${renderThreads(threads, diffFiles, now)}
</div>
<div class="comment-form">
<textarea id="comment-body" placeholder="Leave a comment…" aria-label="Comment on this pull request" rows="3"></textarea>
<div class="comment-form-actions">
<p class="comment-status" id="comment-status" role="status" hidden></p>
<div class="skeleton" id="comment-status-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Posting…" hidden>
<div class="skeleton-row" style="width: 64px"></div>
</div>
<button class="btn" id="post-comment" type="button">${MESSAGE_ICON}Comment</button>
</div>
</div>
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();

document.getElementById('open-remote').addEventListener('click', () => {
  vscode.postMessage({ type: 'openRemote' });
});

document.getElementById('refresh-pr').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

// Approve and Request Changes include the optional review-body textarea value (B3.2).
// The textarea is always visible for open PRs (above the action bar); its value is trimmed
// and passed as the review body — undefined when empty so no blank comment is sent.
const reviewBodyEl = document.getElementById('review-body');
document.getElementById('approve-pr')?.addEventListener('click', () => {
  const body = reviewBodyEl?.value?.trim() || undefined;
  vscode.postMessage({ type: 'submitReview', decision: 'approve', body });
});
document.getElementById('request-changes-pr')?.addEventListener('click', () => {
  const body = reviewBodyEl?.value?.trim() || undefined;
  vscode.postMessage({ type: 'submitReview', decision: 'requestChanges', body });
});
document.getElementById('merge-pr')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'mergePr' });
});
document.getElementById('close-pr')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'closePr' });
});
document.getElementById('reopen-pr')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'reopenPr' });
});

const explainBtn = document.getElementById('explain-pr');
const summaryText = document.getElementById('ai-summary-text');
const summaryHint = document.getElementById('ai-summary-hint');
const summarySkeleton = document.getElementById('ai-summary-skeleton');
explainBtn.addEventListener('click', () => {
  explainBtn.disabled = true;
  summaryText.hidden = true;
  summaryText.textContent = '';
  summaryHint.hidden = true;
  summarySkeleton.hidden = false;
  vscode.postMessage({ type: 'explainPr' });
});

document.getElementById('draft-review').addEventListener('click', () => {
  document.getElementById('draft-review').disabled = true;
  vscode.postMessage({ type: 'draftReview' });
});

const commentBody = document.getElementById('comment-body');
const commentStatus = document.getElementById('comment-status');
const commentStatusSkeleton = document.getElementById('comment-status-skeleton');
const postCommentBtn = document.getElementById('post-comment');
postCommentBtn.addEventListener('click', () => {
  const body = commentBody.value.trim();
  if (!body) {
    return;
  }
  postCommentBtn.disabled = true;
  commentStatus.hidden = true;
  commentStatusSkeleton.hidden = false;
  vscode.postMessage({ type: 'addComment', body });
});

// ── Thread actions (B2.3) ──────────────────────────────────────────────────
// Delegated listeners so they work for threads rendered in the initial HTML
// and for threads added later without re-binding.
document.getElementById('threads').addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const resolveBtn = target.closest('.thread-resolve');
  if (resolveBtn && !resolveBtn.disabled) {
    resolveBtn.disabled = true;
    vscode.postMessage({ type: 'resolveThread', threadId: resolveBtn.dataset.threadId });
    return;
  }
  const unresolveBtn = target.closest('.thread-unresolve');
  if (unresolveBtn && !unresolveBtn.disabled) {
    unresolveBtn.disabled = true;
    vscode.postMessage({ type: 'unresolveThread', threadId: unresolveBtn.dataset.threadId });
    return;
  }
  const replyBtn = target.closest('.thread-reply-btn');
  if (replyBtn && !replyBtn.disabled) {
    const threadId = replyBtn.dataset.threadId;
    const textarea = document.querySelector('.thread-reply-body[data-thread-id="' + threadId + '"]');
    const body = textarea && textarea.value.trim();
    if (!body) { return; }
    replyBtn.disabled = true;
    if (textarea) textarea.disabled = true;
    vscode.postMessage({ type: 'replyToThread', threadId, body });
    return;
  }
  // Jump-to-line button (B5.1): scroll to the matching file section in the diff.
  const jumpBtn = target.closest('.thread-jump-btn');
  if (jumpBtn && !jumpBtn.disabled) {
    const anchorFile = jumpBtn.dataset.anchorFile;
    const fileEl = Array.from(document.querySelectorAll('.file[data-filter]'))
      .find((el) => el.dataset.filter === anchorFile.toLowerCase());
    if (fileEl) {
      fileEl.open = true;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      fileEl.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    }
  }
});

// ── Checks link handler (B4.3) ─────────────────────────────────────────────
// The check URL is validated in the provider before opening; rejecting non-http(s) here too
// so the message is never even sent for an unsafe scheme (defense in depth).
document.getElementById('checks-container').addEventListener('click', (e) => {
  const target = /** @type {HTMLElement} */ (e.target);
  const btn = target.closest('.check-link');
  if (btn) {
    vscode.postMessage({ type: 'openCheckUrl', url: btn.dataset.checkUrl });
  }
});

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'commentPosted') {
    postCommentBtn.disabled = false;
    commentBody.value = '';
    commentStatusSkeleton.hidden = true;
    commentStatus.hidden = false;
    commentStatus.textContent = 'Comment posted.';
    setTimeout(() => { commentStatus.hidden = true; }, 3000);
  } else if (msg.type === 'commentFailed') {
    postCommentBtn.disabled = false;
    commentStatusSkeleton.hidden = true;
  } else if (msg.type === 'resolveThreadFailed') {
    const btn = document.querySelector('.thread-resolve[data-thread-id="' + msg.threadId + '"]');
    if (btn) { btn.disabled = false; }
  } else if (msg.type === 'unresolveThreadFailed') {
    const btn = document.querySelector('.thread-unresolve[data-thread-id="' + msg.threadId + '"]');
    if (btn) { btn.disabled = false; }
  } else if (msg.type === 'replyPosted') {
    const threadId = msg.threadId;
    const textarea = document.querySelector('.thread-reply-body[data-thread-id="' + threadId + '"]');
    const replyBtn = document.querySelector('.thread-reply-btn[data-thread-id="' + threadId + '"]');
    if (textarea) { textarea.disabled = false; textarea.value = ''; }
    if (replyBtn) { replyBtn.disabled = false; }
  } else if (msg.type === 'replyFailed') {
    const threadId = msg.threadId;
    const textarea = document.querySelector('.thread-reply-body[data-thread-id="' + threadId + '"]');
    const replyBtn = document.querySelector('.thread-reply-btn[data-thread-id="' + threadId + '"]');
    if (textarea) { textarea.disabled = false; }
    if (replyBtn) { replyBtn.disabled = false; }
  } else if (msg.type === 'checksLoaded') {
    document.getElementById('checks-container').innerHTML = msg.html;
  } else if (msg.type === 'checksFailed') {
    document.getElementById('checks-container').innerHTML =
      '<p class="error-inline">Checks failed to load: ' + msg.message + '</p>';
  } else if (msg.type === 'aiSummaryChunk') {
    summaryText.hidden = false;
    summaryText.textContent += msg.text;
    summarySkeleton.hidden = true;
  } else if (msg.type === 'aiSummaryCached') {
    summaryText.hidden = false;
    summaryText.textContent = msg.text;
    summarySkeleton.hidden = true;
    explainBtn.disabled = false;
  } else if (msg.type === 'aiSummaryDone') {
    summarySkeleton.hidden = true;
    explainBtn.disabled = false;
  } else if (msg.type === 'aiSummaryReset') {
    explainBtn.disabled = false;
    summaryText.hidden = true;
    summaryHint.hidden = true;
    summarySkeleton.hidden = true;
  } else if (msg.type === 'aiSummaryNoModel') {
    summaryText.hidden = true;
    summarySkeleton.hidden = true;
    summaryHint.hidden = false;
    summaryHint.textContent = msg.message;
    explainBtn.disabled = false;
  } else if (msg.type === 'aiSummaryError') {
    summaryText.hidden = true;
    summarySkeleton.hidden = true;
    summaryHint.hidden = false;
    summaryHint.textContent = 'Failed to generate summary: ' + msg.message;
    explainBtn.disabled = false;
  } else if (msg.type === 'aiSummaryProgress') {
    // Per-file progress during the map step for a large-diff explainPr.
    summaryHint.hidden = false;
    summaryHint.textContent = msg.message;
  } else if (msg.type === 'draftReviewProgress') {
    // Per-file progress during the map step for a large-diff draftReview (E1.2).
    const progressEl = document.getElementById('ai-review-progress');
    if (progressEl) {
      progressEl.hidden = false;
      progressEl.textContent = msg.message;
    }
  } else if (msg.type === 'draftReviewChunk') {
    commentBody.value += msg.text;
    // Hide progress once the synthesis output starts streaming.
    const progressEl = document.getElementById('ai-review-progress');
    if (progressEl) { progressEl.hidden = true; }
  } else if (msg.type === 'draftReviewDone' || msg.type === 'draftReviewReset' || msg.type === 'draftReviewNoModel') {
    document.getElementById('draft-review').disabled = false;
    const progressEl = document.getElementById('ai-review-progress');
    if (progressEl) { progressEl.hidden = true; }
    if (msg.type === 'draftReviewNoModel') {
      commentStatus.hidden = false;
      commentStatus.textContent = msg.message;
    }
  } else if (msg.type === 'draftReviewError') {
    document.getElementById('draft-review').disabled = false;
    const progressEl = document.getElementById('ai-review-progress');
    if (progressEl) { progressEl.hidden = true; }
    commentStatus.hidden = false;
    commentStatus.textContent = 'Failed to draft a review: ' + msg.message;
  } else if (msg.type === 'actionFailed') {
    // Re-enable any action button that may have been disabled — the provider posts this on
    // failures where the button's own state needs restoring, but the render already reloads
    // for successes so no per-button restoration is needed there.
  }
});

const wrapBtn = document.getElementById('wrap');
wrapBtn.addEventListener('click', () => {
  const on = document.body.classList.toggle('wrap');
  wrapBtn.setAttribute('aria-pressed', String(on));
});

const filterEl = document.getElementById('file-filter');
const fileEls = Array.from(document.querySelectorAll('.files .file'));
const noMatchEl = document.getElementById('no-match');
filterEl.addEventListener('input', () => {
  const q = filterEl.value.trim().toLowerCase();
  let shown = 0;
  for (const el of fileEls) {
    const match = q === '' || el.dataset.filter.includes(q);
    el.hidden = !match;
    if (match) shown += 1;
    if (q !== '' && match) el.open = true;
  }
  noMatchEl.hidden = shown > 0 || fileEls.length === 0;
});
${renderTooltipScript()}
</script>
</body>
</html>`;
}
