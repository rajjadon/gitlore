import type { ConversationThread, PullRequestSummary } from '../../core/forge/types';
import type { FileChange } from '../../core/git/types';
import { formatAge, formatAbsolute } from '../../utils/date';
import { escapeHtml } from '../escapeHtml';
import { renderFileSections } from '../diffRender';
import { renderTooltipScript } from '../tooltipScript';
import {
  AI_ICON,
  APPROVE_ICON,
  AUTHOR_ICON,
  CLOSE_ICON,
  EXTERNAL_ICON,
  FILES_ICON,
  MERGE_ICON,
  MESSAGE_ICON,
  REFRESH_ICON,
  REOPEN_ICON,
  REQUEST_CHANGES_ICON,
  SEARCH_ICON,
  WRAP_ICON,
} from '../icons';

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

/** One review conversation, with a Resolve button only when it isn't already resolved — matches the same "no dead action on a thing that's already done" convention as a merged/closed Launchpad card's missing snooze/close buttons. */
function renderThread(thread: ConversationThread): string {
  const resolveBtn = thread.resolved
    ? ''
    : `<button class="thread-resolve icon-btn" type="button" data-thread-id="${escapeHtml(thread.id)}" data-tooltip="Resolve" aria-label="Resolve this conversation">${APPROVE_ICON}</button>`;
  // Absent for a general PR-level comment, not attached to any diff line — only shown when the
  // host actually reported one, so a thread never claims a location it doesn't have.
  const location =
    thread.file !== undefined
      ? `<div class="thread-location">${escapeHtml(thread.file.replace(/^\//, ''))}${thread.line !== undefined ? `:${thread.line}` : ''}</div>`
      : '';
  return `<div class="thread gitlore-enter${thread.resolved ? ' thread-resolved' : ''}" data-thread-id="${escapeHtml(thread.id)}">
${location}
<div class="thread-body">${escapeHtml(thread.body)}</div>
<div class="thread-meta"><span class="thread-author">${escapeHtml(thread.authorLogin)}</span>${resolveBtn}</div>
</div>`;
}

function renderThreads(threads: ConversationThread[]): string {
  if (threads.length === 0) {
    return '<p class="empty">No review conversations on this pull request.</p>';
  }
  return threads.map(renderThread).join('\n');
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
<div class="section-head">
${MESSAGE_ICON}<span class="section-title">Conversations</span><span class="badge">${threads.length}</span>
</div>
<div class="threads" id="threads">
${renderThreads(threads)}
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

document.getElementById('approve-pr')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'submitReview', decision: 'approve' });
});
document.getElementById('request-changes-pr')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'submitReview', decision: 'requestChanges' });
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
for (const btn of document.querySelectorAll('.thread-resolve')) {
  btn.addEventListener('click', () => {
    btn.disabled = true;
    vscode.postMessage({ type: 'resolveThread', threadId: btn.dataset.threadId });
  });
}

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
    if (btn) {
      btn.disabled = false;
    }
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
  } else if (msg.type === 'draftReviewChunk') {
    commentBody.value += msg.text;
  } else if (msg.type === 'draftReviewDone' || msg.type === 'draftReviewReset' || msg.type === 'draftReviewNoModel') {
    document.getElementById('draft-review').disabled = false;
    if (msg.type === 'draftReviewNoModel') {
      commentStatus.hidden = false;
      commentStatus.textContent = msg.message;
    }
  } else if (msg.type === 'draftReviewError') {
    document.getElementById('draft-review').disabled = false;
    commentStatus.hidden = false;
    commentStatus.textContent = 'Failed to draft a review: ' + msg.message;
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
