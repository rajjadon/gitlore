import { LAUNCHPAD_BUCKETS, pullRequestKey } from '../../core/forge/types';
import type { CategorizedPullRequest, ForgeRepoRef, LaunchpadBucket, PullRequestSummary } from '../../core/forge/types';
import { formatAge, formatAbsolute } from '../../utils/date';
import { formatUpdatedAgo } from '../../utils/formatUpdatedAgo';
import { escapeHtml } from '../escapeHtml';
import { renderTooltipScript } from '../tooltipScript';
import {
  APPROVE_ICON,
  ARROW_DOWN_ICON,
  ARROW_UP_ICON,
  AUTHOR_ICON,
  CLOSE_ICON,
  FETCH_ICON,
  MERGE_ICON,
  OPEN_CHANGES_ICON,
  REFRESH_ICON,
  REOPEN_ICON,
  REQUEST_CHANGES_ICON,
  SIGN_OUT_ICON,
  SNOOZE_ICON,
} from '../icons';

const TERMINAL_BUCKETS = new Set<LaunchpadBucket>(['merged', 'closed']);

export interface RenderLaunchpadOptions {
  nonce: string;
  cspSource: string;
  styleUris: string[];
}

export interface LaunchpadRepoError {
  repo: ForgeRepoRef;
  message: string;
}

/** One workspace repo Launchpad found a git remote for — independent of whether its forge auth succeeded, since push/pull needs no host credential at all. */
export interface LaunchpadRepoRow {
  key: string;
  label: string;
}

export interface LaunchpadData {
  categorized: CategorizedPullRequest[];
  errors: LaunchpadRepoError[];
  repoRows?: LaunchpadRepoRow[];
  now?: Date;
  /** When set, renders "Updated N min ago" in the board header so the user knows how fresh the data is. */
  lastLoadedAt?: Date;
}

const BUCKET_LABELS: Record<LaunchpadBucket, string> = {
  needsReview: 'Needs Review',
  reviewed: 'Reviewed',
  readyToMerge: 'Ready to Merge',
  waiting: 'Waiting',
  blocked: 'Blocked',
  drafts: 'Drafts',
  snoozed: 'Snoozed',
  merged: 'Merged',
  closed: 'Closed',
};

/** Stale marker shown on cards whose data comes from a previous load because the repo's last refresh failed. */
const STALE_MARKER = '<span class="stale-marker" title="Data from last successful load — this repo\'s latest refresh failed" aria-label="stale data">&#x26A0;&#xFE0E; stale</span>';

function renderCard(pr: PullRequestSummary, now: Date, bucket: LaunchpadBucket, stale = false): string {
  const key = pullRequestKey(pr);
  const isTerminal = TERMINAL_BUCKETS.has(bucket);
  // A merged/closed card shows when it was closed, not when it was opened — that's the age that
  // actually matters once a PR is done.
  const date = new Date(isTerminal ? (pr.closedAt ?? pr.updatedAt) : pr.createdAt);
  const age = formatAge(date, now);
  const absolute = formatAbsolute(date, 'yyyy-MM-dd HH:mm');
  const ageLabel = bucket === 'merged' ? `merged ${age}` : bucket === 'closed' ? `closed ${age}` : age;
  const snoozeTitle = bucket === 'snoozed' ? 'Unsnooze' : 'Snooze';
  // Nothing to snooze or close on a PR that's already done — those two only make sense on an open
  // card. Viewing the diff applies either way, so it's not gated on `isTerminal`.
  // Approve/request-changes only make sense on an open card too — a host rejects a self-approval
  // attempt with its own clear error (surfaced the same way a failed close already is), so this
  // doesn't need its own "is this my own PR" check on top of that.
  // Reopen only makes sense on "closed", never "merged" — no host we support lets a merge be
  // undone through this action.
  // Merge only appears on a "readyToMerge" card — matching the board's own categorization (already
  // approved, checks passing, no conflicts) means clicking it never just bounces off a host-side
  // rejection (branch protection, failing checks) that the card itself already ruled out.
  const mergeButton =
    bucket === 'readyToMerge'
      ? `<button class="pr-card-merge icon-btn" type="button" data-key="${escapeHtml(key)}" data-title="${escapeHtml(pr.title)}" data-tooltip="Merge PR" aria-label="Merge ${escapeHtml(pr.title)}">${MERGE_ICON}</button>
`
      : '';
  const stateActions = isTerminal
    ? bucket === 'closed'
      ? `<button class="pr-card-reopen icon-btn" type="button" data-key="${escapeHtml(key)}" data-title="${escapeHtml(pr.title)}" data-tooltip="Reopen PR" aria-label="Reopen ${escapeHtml(pr.title)}">${REOPEN_ICON}</button>`
      : ''
    : `<button class="pr-card-snooze icon-btn" type="button" data-key="${escapeHtml(key)}" data-tooltip="${snoozeTitle} PR" aria-label="${snoozeTitle} ${escapeHtml(pr.title)}">${SNOOZE_ICON}</button>
<button class="pr-card-approve icon-btn" type="button" data-key="${escapeHtml(key)}" data-title="${escapeHtml(pr.title)}" data-tooltip="Approve PR" aria-label="Approve ${escapeHtml(pr.title)}">${APPROVE_ICON}</button>
<button class="pr-card-request-changes icon-btn" type="button" data-key="${escapeHtml(key)}" data-title="${escapeHtml(pr.title)}" data-tooltip="Request changes on PR" aria-label="Request changes on ${escapeHtml(pr.title)}">${REQUEST_CHANGES_ICON}</button>
${mergeButton}<button class="pr-card-close icon-btn" type="button" data-key="${escapeHtml(key)}" data-title="${escapeHtml(pr.title)}" data-tooltip="Close PR" aria-label="Close ${escapeHtml(pr.title)}">${CLOSE_ICON}</button>`;
  const actions = `<div class="pr-card-actions">
<button class="pr-card-details icon-btn" type="button" data-key="${escapeHtml(key)}" data-tooltip="View PR diff" aria-label="View diff for ${escapeHtml(pr.title)}">${OPEN_CHANGES_ICON}</button>
${stateActions}
</div>`;
  return `<div class="pr-card gitlore-enter" data-key="${escapeHtml(key)}" data-url="${escapeHtml(pr.url)}" tabindex="0" role="button" aria-label="Open ${escapeHtml(pr.title)} on ${escapeHtml(pr.repo.label)}">
<div class="pr-card-header">
<div class="pr-card-repo" title="${escapeHtml(pr.repo.label)}">${escapeHtml(pr.repo.label)}</div>
${actions}
</div>
<div class="pr-card-title">${escapeHtml(pr.title)}</div>
<div class="pr-card-meta">${AUTHOR_ICON}<span>${escapeHtml(pr.authorLogin)}</span><span class="pr-card-age" title="${escapeHtml(absolute)}">${escapeHtml(ageLabel)}</span>${stale ? STALE_MARKER : ''}</div>
</div>`;
}

/**
 * One row per workspace repo, with push/pull buttons — a local git operation, so these render
 * regardless of whether that repo's forge auth succeeded. No ahead/behind badge yet (would need a
 * `GitService.getBranches()` call per repo on every refresh); add one later if the repo list turns
 * out sparse enough that it's worth the extra latency.
 *
 * Sign Out renders here too, and regardless of auth outcome — the fix for "I signed in as the
 * wrong account and there's no way to change it": before this, a bad credential only ever cleared
 * itself automatically on an API failure, with no user-facing way to reset it proactively.
 */
function renderRepoRow(repo: LaunchpadRepoRow): string {
  const key = escapeHtml(repo.key);
  const label = escapeHtml(repo.label);
  return `<div class="repo-row" data-key="${key}">
<span class="repo-row-label">${label}</span>
<button class="repo-fetch icon-btn" type="button" data-key="${key}" data-tooltip="Fetch" aria-label="Fetch ${label}">${FETCH_ICON}</button>
<button class="repo-pull icon-btn" type="button" data-key="${key}" data-tooltip="Pull" aria-label="Pull ${label}">${ARROW_DOWN_ICON}</button>
<button class="repo-push icon-btn" type="button" data-key="${key}" data-tooltip="Push" aria-label="Push ${label}">${ARROW_UP_ICON}</button>
<button class="repo-signout icon-btn" type="button" data-key="${key}" data-title="${label}" data-tooltip="Sign Out" aria-label="Sign out of ${label}">${SIGN_OUT_ICON}</button>
</div>`;
}

function renderColumn(bucket: LaunchpadBucket, items: CategorizedPullRequest[], now: Date): string {
  const body =
    items.length === 0
      ? '<p class="column-empty">Nothing here.</p>'
      : items.map((item) => renderCard(item.pr, now, bucket, item.stale)).join('\n');
  return `<div class="column" data-bucket="${bucket}">
<div class="column-head"><span class="column-title">${BUCKET_LABELS[bucket]}</span><span class="badge">${items.length}</span></div>
<div class="column-body">${body}</div>
</div>`;
}

/** Builds Launchpad's full HTML document — a 6-column board of PRs pooled across every recognized repo in the workspace. Pure — nonce/cspSource/styleUris come from the caller, so this is unit-testable without a real webview host. */
export function renderLaunchpadHtml(data: LaunchpadData, opts: RenderLaunchpadOptions): string {
  const now = data.now ?? new Date();
  const updatedAgoText = data.lastLoadedAt ? escapeHtml(formatUpdatedAgo(data.lastLoadedAt, now)) : '';
  const styles = opts.styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n');

  const byBucket = new Map<LaunchpadBucket, CategorizedPullRequest[]>(LAUNCHPAD_BUCKETS.map((b) => [b, []]));
  for (const item of data.categorized) {
    byBucket.get(item.bucket)?.push(item);
  }
  const columns = LAUNCHPAD_BUCKETS.map((bucket) => renderColumn(bucket, byBucket.get(bucket) ?? [], now)).join('\n');

  const errors =
    data.errors.length === 0
      ? ''
      : `<div class="errors">${data.errors
          .map((e) => `<p class="error-row">${escapeHtml(e.repo.label)}: ${escapeHtml(e.message)}</p>`)
          .join('\n')}</div>`;

  const empty = data.categorized.length === 0 && data.errors.length === 0;

  const repoRows = data.repoRows ?? [];
  const repoList = repoRows.length === 0 ? '' : `<div class="repo-list">${repoRows.map(renderRepoRow).join('\n')}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; img-src https: ${opts.cspSource}; font-src ${opts.cspSource}; script-src 'nonce-${opts.nonce}';" />
${styles}
<title>GitLore Launchpad</title>
</head>
<body>
<div class="toolbar">
<span class="title">Launchpad</span>
<span class="spacer"></span>
${updatedAgoText ? `<span class="updated-ago" aria-live="polite">${updatedAgoText}</span>` : ''}
<button id="refresh" class="icon-btn" type="button" data-tooltip="Refresh" aria-label="Refresh Launchpad">${REFRESH_ICON}</button>
</div>
${repoList}
${errors}
${empty ? '<p class="empty">No pull requests need your attention right now.</p>' : `<div class="board">${columns}</div>`}
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();

for (const card of document.querySelectorAll('.pr-card')) {
  const open = () => vscode.postMessage({ type: 'openPr', url: card.dataset.url });
  card.addEventListener('click', (e) => {
    if (e.target.closest('.pr-card-snooze')) return;
    open();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
}

for (const btn of document.querySelectorAll('.pr-card-snooze')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'toggleSnooze', key: btn.dataset.key });
  });
}

for (const btn of document.querySelectorAll('.pr-card-close')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Confirmation happens on the extension side (a real modal, not this webview's own UI) —
    // this only ever sends the request to close.
    vscode.postMessage({ type: 'closePr', key: btn.dataset.key, title: btn.dataset.title });
  });
}

for (const btn of document.querySelectorAll('.pr-card-reopen')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'reopenPr', key: btn.dataset.key, title: btn.dataset.title });
  });
}

for (const btn of document.querySelectorAll('.pr-card-merge')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Strategy choice and confirmation both happen on the extension side (a real QuickPick and
    // modal, not this webview's own UI) — this only ever sends the request to merge.
    vscode.postMessage({ type: 'mergePr', key: btn.dataset.key, title: btn.dataset.title });
  });
}

for (const btn of document.querySelectorAll('.pr-card-approve')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'submitReview', key: btn.dataset.key, title: btn.dataset.title, decision: 'approve' });
  });
}

for (const btn of document.querySelectorAll('.pr-card-request-changes')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'submitReview', key: btn.dataset.key, title: btn.dataset.title, decision: 'requestChanges' });
  });
}

for (const btn of document.querySelectorAll('.pr-card-details')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'showPullRequestDetails', key: btn.dataset.key });
  });
}

for (const btn of document.querySelectorAll('.repo-fetch')) {
  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'fetch', key: btn.dataset.key });
  });
}

for (const btn of document.querySelectorAll('.repo-pull')) {
  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'pull', key: btn.dataset.key });
  });
}

for (const btn of document.querySelectorAll('.repo-push')) {
  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'push', key: btn.dataset.key });
  });
}

for (const btn of document.querySelectorAll('.repo-signout')) {
  btn.addEventListener('click', () => {
    // Confirmation happens on the extension side (a real modal, not this webview's own UI) —
    // this only ever sends the request to sign out.
    vscode.postMessage({ type: 'signOut', key: btn.dataset.key });
  });
}

document.getElementById('refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

${renderTooltipScript()}
</script>
</body>
</html>`;
}
