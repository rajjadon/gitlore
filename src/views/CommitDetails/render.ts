import type { CommitDetail, FileChange } from '../../core/git/types';
import { formatAge, formatAbsolute } from '../../utils/date';
import { escapeHtml } from '../escapeHtml';
import { renderFileSections } from '../diffRender';
import { linkifyIssues, type IssueLinkOptions } from '../../utils/issueLinks';
import { buildGravatarUrl } from '../../utils/gravatar';
import { AI_ICON, COPY_ICON, EXTERNAL_ICON, FILES_ICON, MESSAGE_ICON, SEARCH_ICON, WRAP_ICON } from '../icons';
import { renderTooltipScript } from '../tooltipScript';

/** Where "Open on <host>" should send the user, when the repo has a remote we know the URL shape for. */
export interface RemoteTarget {
  /** Display name of the hosting service, e.g. "GitHub". */
  label: string;
  url: string;
}

export interface RenderCommitDetailsOptions {
  nonce: string;
  cspSource: string;
  /** Stylesheets to link, in order. Shared diff rules first, then the panel's own. */
  styleUris: string[];
  editorFontFamily: string;
  issueLinking?: IssueLinkOptions | null;
  remote?: RemoteTarget | null;
}

/** Escapes `text` as HTML, wrapping any issue references per `issueLinking` in a real `<a>` link. */
function linkifyHtml(text: string, issueLinking: IssueLinkOptions | null | undefined): string {
  if (!issueLinking) {
    return escapeHtml(text);
  }
  return linkifyIssues(text, issueLinking.pattern, issueLinking.urlTemplate)
    .map((segment) =>
      segment.url
        ? `<a href="${escapeHtml(segment.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(segment.text)}</a>`
        : escapeHtml(segment.text),
    )
    .join('');
}

export interface CommitDetailsData {
  commit: CommitDetail;
  files: FileChange[];
  diff: string;
  now?: Date;
}

/** Whole-commit totals for the section header, so the size of a change is legible without expanding anything. */
function renderTotals(files: FileChange[]): string {
  const insertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return `<span class="totals"><span class="stat-add">+${insertions}</span><span class="stat-del">&minus;${deletions}</span></span>`;
}

/**
 * The commit's action bar. Copy/open actions are read-only; Summarize is the one exception — it
 * calls out to whatever language model the user has configured — but it's still non-destructive
 * (unlike cherry-pick, revert, or branch-from-here, deliberately absent: a single click in a panel
 * is the wrong affordance for rewriting history), so it earns a place in the same row rather than
 * a separate section. It keeps the accent treatment so it still reads as the one AI action here,
 * not just another utility button.
 */
function renderActions(commit: CommitDetail, remote: RemoteTarget | null | undefined): string {
  const openOnRemote = remote
    ? `<button class="btn" id="open-remote" type="button" title="${escapeHtml(remote.url)}">${EXTERNAL_ICON}Open on ${escapeHtml(remote.label)}</button>`
    : '';
  return `<div class="actions">
<code class="sha" title="${escapeHtml(commit.sha)}">${escapeHtml(commit.shortSha)}</code>
<button class="btn" id="copy-sha" type="button">${COPY_ICON}Copy SHA</button>
<button class="btn" id="copy-message" type="button">${MESSAGE_ICON}Copy message</button>
${openOnRemote}
<button class="btn btn-accent" id="explain-commit" type="button" title="Summarize this commit with AI">${AI_ICON}Summarize</button>
</div>`;
}

/** Builds the commit details webview's full HTML document. Pure — nonce/cspSource/styleUris come from the caller, not from vscode APIs directly, so this is unit-testable without a real webview host. */
export function renderCommitDetailsHtml(data: CommitDetailsData, opts: RenderCommitDetailsOptions): string {
  const { commit, files, diff } = data;
  const now = data.now ?? new Date();
  const date = new Date(commit.date);
  const age = formatAge(date, now);
  const absoluteDate = formatAbsolute(date, 'yyyy-MM-dd HH:mm');
  const bodyRest = commit.body.slice(commit.message.length).replace(/^\n+/, '');
  const avatarUrl = buildGravatarUrl(commit.authorEmail, { size: 48 });
  const styles = opts.styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; img-src https: ${opts.cspSource}; script-src 'nonce-${opts.nonce}';" />
${styles}
<style nonce="${opts.nonce}">:root { --gitlore-editor-font: ${escapeHtml(opts.editorFontFamily)}; }</style>
<title>Commit ${escapeHtml(commit.shortSha)}</title>
</head>
<body>
<div class="head">
<img class="avatar" src="${avatarUrl}" alt="" width="24" height="24" />
<div class="head-text">
<h1 title="${escapeHtml(commit.message)}">${linkifyHtml(commit.message, opts.issueLinking)}</h1>
<div class="head-meta"><span class="head-author">${escapeHtml(commit.author)}</span><span class="head-sep">&middot;</span><span class="head-age" title="${escapeHtml(absoluteDate)}">${escapeHtml(age)}</span></div>
</div>
</div>
${renderActions(commit, opts.remote)}
${bodyRest ? `<pre class="commit-body">${linkifyHtml(bodyRest, opts.issueLinking)}</pre>` : ''}
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
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();

document.getElementById('copy-sha').addEventListener('click', () => {
  vscode.postMessage({ type: 'copySha' });
});
document.getElementById('copy-message').addEventListener('click', () => {
  vscode.postMessage({ type: 'copyMessage' });
});
const remoteBtn = document.getElementById('open-remote');
if (remoteBtn) {
  remoteBtn.addEventListener('click', () => vscode.postMessage({ type: 'openRemote' }));
}

const explainBtn = document.getElementById('explain-commit');
const summaryText = document.getElementById('ai-summary-text');
const summaryHint = document.getElementById('ai-summary-hint');
const summarySkeleton = document.getElementById('ai-summary-skeleton');
explainBtn.addEventListener('click', () => {
  explainBtn.disabled = true;
  summaryText.hidden = true;
  summaryText.textContent = '';
  summaryHint.hidden = true;
  summarySkeleton.hidden = false;
  vscode.postMessage({ type: 'explainCommit' });
});
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg.type === 'aiSummaryChunk') {
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
  }
});

// Opening a file's changes must not also toggle the <details> it lives in.
for (const btn of document.querySelectorAll('.row-btn')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'openFileDiff', path: btn.dataset.path });
  });
}

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
    // Expand matches while filtering: with the list narrowed to a handful of files, the
    // extra click to see each one is pure friction.
    if (q !== '' && match) el.open = true;
  }
  noMatchEl.hidden = shown > 0 || fileEls.length === 0;
});
${renderTooltipScript()}
</script>
</body>
</html>`;
}
