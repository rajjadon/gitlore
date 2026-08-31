import type { BranchInfo, Commit, FileChange } from '../../core/git/types';
import { formatAge, formatAbsolute } from '../../utils/date';
import { escapeHtml } from '../escapeHtml';
import { renderFileSections } from '../diffRender';
import { buildGravatarUrl } from '../../utils/gravatar';
import { renderTooltipScript } from '../tooltipScript';
import {
  AI_ICON,
  BRANCH_ICON,
  CHECK_ICON,
  EXTERNAL_ICON,
  FILES_ICON,
  OPEN_CHANGES_ICON,
  REFRESH_ICON,
  SEARCH_ICON,
  SWAP_ICON,
  WRAP_ICON,
} from '../icons';

/** Shown when the repo's remote resolves to a recognized forge host — the button posts `createPr` and the extension host does the rest (auth, title prompt, the actual API call). */
export interface PrTarget {
  /** Display name of the hosting service, e.g. "GitHub". */
  label: string;
}

export interface RenderBranchComparisonOptions {
  nonce: string;
  cspSource: string;
  /** Stylesheets to link, in order. Shared diff rules first, then the panel's own. */
  styleUris: string[];
  editorFontFamily: string;
  createPr?: PrTarget | null;
}

export interface BranchComparisonData {
  base: string;
  compare: string;
  /** Commits `compare` has that `base` doesn't. */
  aheadCommits: Commit[];
  /** Commits `base` has that `compare` doesn't. */
  behindCommits: Commit[];
  files: FileChange[];
  diff: string;
  /** Every local and remote branch, for the two ref pickers. */
  branches?: BranchInfo[];
  now?: Date;
}

type PaneId = 'ahead' | 'behind' | 'files';

function renderRefPicker(id: 'base' | 'compare', selected: string, branches: BranchInfo[], label: string): string {
  const local = branches.filter((b) => !b.isRemote);
  const remote = branches.filter((b) => b.isRemote);
  const option = (name: string): string =>
    `<option value="${escapeHtml(name)}"${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`;
  const group = (groupLabel: string, items: BranchInfo[]): string =>
    items.length === 0 ? '' : `<optgroup label="${groupLabel}">${items.map((b) => option(b.name)).join('')}</optgroup>`;
  // The currently-selected ref may be a tag or a raw SHA that isn't in the branch list at all —
  // include it explicitly so switching the *other* picker can't silently reset this one.
  const orphan = branches.some((b) => b.name === selected) ? '' : option(selected);

  return `<span class="ref-pick ref-${id}">${BRANCH_ICON}<select id="${id}" aria-label="${label}">${orphan}${group('Local', local)}${group('Remote', remote)}</select></span>`;
}

function renderCommitRows(commits: Commit[], now: Date): string {
  return commits
    .map((c) => {
      const date = new Date(c.date);
      const age = formatAge(date, now);
      const absolute = formatAbsolute(date, 'yyyy-MM-dd HH:mm');
      const avatarUrl = buildGravatarUrl(c.authorEmail, { size: 32 });
      return `<div class="commit-row" role="row" tabindex="0" data-sha="${escapeHtml(c.sha)}" aria-label="Show details for ${escapeHtml(c.message)}">
<img class="commit-avatar" src="${avatarUrl}" alt="" width="14" height="14" />
<span class="commit-message" title="${escapeHtml(c.message)}">${escapeHtml(c.message)}</span>
<span class="commit-author">${escapeHtml(c.author)}</span>
<span class="commit-age" title="${escapeHtml(absolute)}">${escapeHtml(age)}</span>
<code class="commit-sha">${escapeHtml(c.shortSha)}</code>
</div>`;
    })
    .join('\n');
}

/** An empty comparison pane is good news, not a failure — so it says what's true rather than "no results". */
function renderEmptyState(text: string): string {
  return `<p class="empty-state">${CHECK_ICON}<span>${escapeHtml(text)}</span></p>`;
}

function renderCommitPane(id: PaneId, commits: Commit[], emptyText: string, now: Date, active: boolean): string {
  const body = commits.length === 0 ? renderEmptyState(emptyText) : renderCommitRows(commits, now);
  return `<div class="pane" id="pane-${id}" role="tabpanel" aria-labelledby="tab-${id}"${active ? '' : ' hidden'}>${body}</div>`;
}

function renderTab(id: PaneId, label: string, count: number, active: boolean): string {
  return `<button class="tab${active ? ' active' : ''}" id="tab-${id}" role="tab" type="button" aria-selected="${active}" aria-controls="pane-${id}" tabindex="${active ? '0' : '-1'}" data-pane="${id}">${label}<span class="badge badge-${id}">${count}</span></button>`;
}

/** Builds the branch comparison webview's full HTML document. Pure — nonce/cspSource/styleUris come from the caller, so this is unit-testable without a real webview host. */
export function renderBranchComparisonHtml(
  data: BranchComparisonData,
  opts: RenderBranchComparisonOptions,
): string {
  const { base, compare, aheadCommits, behindCommits, files, diff, branches = [] } = data;
  const now = data.now ?? new Date();
  const styles = opts.styleUris.map((uri) => `<link rel="stylesheet" href="${uri}" />`).join('\n');
  const sameRef = base === compare;

  // Open on whichever pane has something to say, so the panel never greets you with an empty tab
  // when the answer is one click away.
  const initial: PaneId = aheadCommits.length > 0 ? 'ahead' : behindCommits.length > 0 ? 'behind' : 'files';

  const insertions = files.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);

  // Not renderEmptyState: that carries a checkmark, and a green tick next to an instruction reads
  // as "done" when the user hasn't done anything yet.
  const openAllBtn =
    files.length > 0
      ? `<button class="icon-btn" id="open-all" type="button" data-tooltip="Open all changes, diffed against the common base" aria-label="Open all changes, diffed against the common base">${OPEN_CHANGES_ICON}</button>`
      : '';

  const filesBody = sameRef
    ? '<p class="empty">Pick two different refs to compare.</p>'
    : `<div class="section-head">
${FILES_ICON}<span class="section-title">Files changed</span><span class="badge">${files.length}</span>
<span class="totals"><span class="stat-add">+${insertions}</span><span class="stat-del">&minus;${deletions}</span></span>
<span class="search">${SEARCH_ICON}<input id="file-filter" type="search" placeholder="Filter files…" aria-label="Filter changed files by path" autocomplete="off" spellcheck="false" /></span>
${openAllBtn}
<button class="icon-btn" id="wrap" type="button" aria-pressed="false" data-tooltip="Wrap long lines" aria-label="Wrap long lines">${WRAP_ICON}</button>
</div>
<div class="files" id="files">
${renderFileSections(files, diff)}
</div>
<p class="empty" id="no-match" hidden>No files match that filter.</p>`;

  const createPrBtn = opts.createPr
    ? `<button class="icon-btn" id="create-pr" type="button" data-tooltip="Create a PR on ${escapeHtml(opts.createPr.label)}" aria-label="Create a PR on ${escapeHtml(opts.createPr.label)}">${EXTERNAL_ICON}</button>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; img-src https: ${opts.cspSource}; script-src 'nonce-${opts.nonce}';" />
${styles}
<style nonce="${opts.nonce}">:root { --gitlore-editor-font: ${escapeHtml(opts.editorFontFamily)}; }</style>
<title>Compare ${escapeHtml(base)}...${escapeHtml(compare)}</title>
</head>
<body>
<div class="refbar">
${renderRefPicker('base', base, branches, 'Base ref — the side changes are measured from')}
<button class="icon-btn" id="swap" type="button" data-tooltip="Swap base and compare" aria-label="Swap base and compare">${SWAP_ICON}</button>
${renderRefPicker('compare', compare, branches, 'Compare ref — the side changes are measured to')}
<span class="refbar-spacer"></span>
<button class="btn btn-accent" id="summarize-comparison" type="button" title="Summarize this comparison with AI">${AI_ICON}Summarize</button>
${createPrBtn}
<button class="icon-btn" id="refresh" type="button" data-tooltip="Refresh" aria-label="Refresh the comparison">${REFRESH_ICON}</button>
</div>
<div class="ai-summary">
<p class="ai-summary-text" id="ai-summary-text" aria-live="polite" hidden></p>
<p class="ai-summary-hint" id="ai-summary-hint" role="status" hidden></p>
<div class="skeleton" id="ai-summary-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Generating…" hidden>
<div class="skeleton-row" style="width: 92%"></div>
<div class="skeleton-row" style="width: 68%"></div>
</div>
</div>
<div class="tabs" role="tablist" aria-label="Comparison views">
${renderTab('ahead', 'Ahead', aheadCommits.length, initial === 'ahead')}
${renderTab('behind', 'Behind', behindCommits.length, initial === 'behind')}
${renderTab('files', 'All Files', files.length, initial === 'files')}
</div>
${renderCommitPane('ahead', aheadCommits, `${compare} adds nothing over ${base}`, now, initial === 'ahead')}
${renderCommitPane('behind', behindCommits, `${compare} is up to date with ${base}`, now, initial === 'behind')}
<div class="pane pane-files" id="pane-files" role="tabpanel" aria-labelledby="tab-files"${initial === 'files' ? '' : ' hidden'}>
${filesBody}
</div>
<script nonce="${opts.nonce}">
const vscode = acquireVsCodeApi();
const tabs = Array.from(document.querySelectorAll('.tab'));

function activate(tab) {
  for (const other of tabs) {
    const on = other === tab;
    other.classList.toggle('active', on);
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById('pane-' + other.dataset.pane).hidden = !on;
  }
  tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener('click', () => activate(tab));
}

// role="tablist" promises arrow-key navigation to screen readers — so honour it.
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = tabs.indexOf(document.activeElement);
  if (i === -1) return;
  let next = null;
  if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else return;
  e.preventDefault();
  activate(next);
});

for (const row of document.querySelectorAll('.commit-row')) {
  const open = () => vscode.postMessage({ type: 'openCommit', sha: row.dataset.sha });
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
}

document.getElementById('base').addEventListener('change', (e) => {
  vscode.postMessage({ type: 'setRefs', base: e.target.value, compare: document.getElementById('compare').value });
});
document.getElementById('compare').addEventListener('change', (e) => {
  vscode.postMessage({ type: 'setRefs', base: document.getElementById('base').value, compare: e.target.value });
});
document.getElementById('swap').addEventListener('click', () => {
  vscode.postMessage({ type: 'setRefs', base: document.getElementById('compare').value, compare: document.getElementById('base').value });
});
document.getElementById('refresh').addEventListener('click', () => {
  vscode.postMessage({ type: 'refresh' });
});

const summarizeBtn = document.getElementById('summarize-comparison');
const summaryText = document.getElementById('ai-summary-text');
const summaryHint = document.getElementById('ai-summary-hint');
const summarySkeleton = document.getElementById('ai-summary-skeleton');
summarizeBtn.addEventListener('click', () => {
  summarizeBtn.disabled = true;
  summaryText.hidden = true;
  summaryText.textContent = '';
  summaryHint.hidden = true;
  summarySkeleton.hidden = false;
  vscode.postMessage({ type: 'summarizeComparison' });
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
    summarizeBtn.disabled = false;
  } else if (msg.type === 'aiSummaryDone') {
    summarySkeleton.hidden = true;
    summarizeBtn.disabled = false;
  } else if (msg.type === 'aiSummaryReset') {
    summarizeBtn.disabled = false;
    summaryText.hidden = true;
    summaryHint.hidden = true;
    summarySkeleton.hidden = true;
  } else if (msg.type === 'aiSummaryNoModel') {
    summaryText.hidden = true;
    summarySkeleton.hidden = true;
    summaryHint.hidden = false;
    summaryHint.textContent = msg.message;
    summarizeBtn.disabled = false;
  } else if (msg.type === 'aiSummaryError') {
    summaryText.hidden = true;
    summarySkeleton.hidden = true;
    summaryHint.hidden = false;
    summaryHint.textContent = 'Failed to generate summary: ' + msg.message;
    summarizeBtn.disabled = false;
  }
});

const createPrBtnEl = document.getElementById('create-pr');
if (createPrBtnEl) {
  createPrBtnEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'createPr' });
  });
}

const openAllBtnEl = document.getElementById('open-all');
if (openAllBtnEl) {
  openAllBtnEl.addEventListener('click', () => {
    vscode.postMessage({ type: 'openAllChanges' });
  });
}

for (const btn of document.querySelectorAll('.row-btn')) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'openFileDiff', path: btn.dataset.path });
  });
}

const wrapBtn = document.getElementById('wrap');
if (wrapBtn) {
  wrapBtn.addEventListener('click', () => {
    const on = document.body.classList.toggle('wrap');
    wrapBtn.setAttribute('aria-pressed', String(on));
  });
}

const filterEl = document.getElementById('file-filter');
if (filterEl) {
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
}
${renderTooltipScript()}
</script>
</body>
</html>`;
}
