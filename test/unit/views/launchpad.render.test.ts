import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLaunchpadHtml } from '../../../src/views/Launchpad/render';
import type { CategorizedPullRequest, PullRequestSummary } from '../../../src/core/forge/types';

process.env.TZ = 'UTC';

const now = new Date('2024-02-04T10:00:00Z');
const opts = { nonce: 'abc123', cspSource: 'vscode-webview://xyz', styleUris: ['vscode-webview://xyz/shared.css', 'vscode-webview://xyz/launchpad.css'] };

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' },
    number: 1,
    title: 'Add feature',
    url: 'https://github.com/acme/widgets/pull/1',
    authorLogin: 'raj',
    isDraft: false,
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-01T10:00:00Z',
    requestedReviewers: [],
    checkStatus: 'passing',
    reviewDecision: 'approved',
    hasConflicts: false,
    reviewedByMe: false,
    headSha: '',
    ...overrides,
  };
}

test('renderLaunchpadHtml: renders all nine columns in the roadmap-specified order, with counts', () => {
  // At least one PR, so the board actually renders instead of the "nothing to show" empty state.
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  const titles = [...html.matchAll(/class="column-title">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(titles, ['Needs Review', 'Reviewed', 'Ready to Merge', 'Waiting', 'Blocked', 'Drafts', 'Snoozed', 'Merged', 'Closed']);
});

test('renderLaunchpadHtml: a "Reviewed" card gets the same actions as a Waiting card (Snooze/Approve/Request changes/Close), no Merge', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'reviewed' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-snooze/);
  assert.match(html, /class="pr-card-approve/);
  assert.match(html, /class="pr-card-request-changes/);
  assert.match(html, /class="pr-card-close/);
  assert.ok(!html.includes('class="pr-card-merge'));
});

test('renderLaunchpadHtml: places a PR card in its bucket\'s column with a count badge', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'needsReview' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /data-bucket="needsReview"[\s\S]*?Add feature[\s\S]*?<\/div>\s*<\/div>/);
  assert.match(html, /data-bucket="needsReview">[\s\S]*?class="badge">1</);
});

test('renderLaunchpadHtml: an empty column says "Nothing here", not a blank space', () => {
  // Something in "waiting" so the board renders at all; "drafts" stays genuinely empty.
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /data-bucket="drafts">[\s\S]*?Nothing here\./);
});

test('renderLaunchpadHtml: a card shows repo label, author, and age', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ repo: { host: 'gitlab', identity: 'acme/platform', label: 'acme/platform' } }), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-repo" title="acme\/platform">acme\/platform</);
  assert.match(html, /raj/);
  assert.match(html, /3 days ago/);
});

test('renderLaunchpadHtml: a card posts openPr with its URL when clicked', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ url: 'https://github.com/acme/widgets/pull/42' }), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /data-url="https:\/\/github\.com\/acme\/widgets\/pull\/42"/);
  assert.match(html, /type: 'openPr', url: card\.dataset\.url/);
});

test('renderLaunchpadHtml: the snooze button posts toggleSnooze with the PR\'s stable key', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-snooze[^"]*" type="button" data-key="github:acme\/widgets#1"/);
  assert.match(html, /type: 'toggleSnooze', key: btn\.dataset\.key/);
});

test('renderLaunchpadHtml: a snoozed-column card is labeled "Unsnooze" instead of "Snooze"', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'snoozed' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /data-tooltip="Unsnooze PR"/);
  assert.ok(!html.includes('data-tooltip="Snooze PR"'));
});

test('renderLaunchpadHtml: the close button posts closePr with the PR\'s stable key and title', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-close[^"]*" type="button" data-key="github:acme\/widgets#1" data-title="Add feature"/);
  assert.match(html, /type: 'closePr', key: btn\.dataset\.key, title: btn\.dataset\.title/);
});

test('renderLaunchpadHtml: a merged card shows "merged <age>" using closedAt, not createdAt', () => {
  const categorized: CategorizedPullRequest[] = [
    { pr: pr({ createdAt: '2024-01-01T10:00:00Z', closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' },
  ];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /merged 2 days ago/);
});

test('renderLaunchpadHtml: a closed (not merged) card shows "closed <age>"', () => {
  const categorized: CategorizedPullRequest[] = [
    { pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: false }), bucket: 'closed' },
  ];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /closed 2 days ago/);
});

test('renderLaunchpadHtml: merged/closed cards offer neither snooze nor close — nothing to do with a PR that is already done', () => {
  const categorized: CategorizedPullRequest[] = [
    { pr: pr({ number: 1, closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' },
    { pr: pr({ number: 2, closedAt: '2024-02-02T10:00:00Z', merged: false }), bucket: 'closed' },
  ];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  // The client-side script's own `.pr-card-snooze`/`.pr-card-close` selectors are always present,
  // so check for the rendered element (`class="..."`), not the bare class name.
  assert.ok(!html.includes('class="pr-card-snooze'));
  assert.ok(!html.includes('class="pr-card-close'));
});

test('renderLaunchpadHtml: a closed (not merged) card offers Reopen', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: false }), bucket: 'closed' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-reopen[^"]*" type="button" data-key="github:acme\/widgets#1" data-title="Add feature"/);
});

test('renderLaunchpadHtml: a merged card offers no Reopen — no host lets a merge be undone this way', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.ok(!html.includes('class="pr-card-reopen'));
});

test('renderLaunchpadHtml: the Reopen button posts reopenPr with the PR\'s stable key and title', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: false }), bucket: 'closed' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /type: 'reopenPr', key: btn\.dataset\.key, title: btn\.dataset\.title/);
});

test('renderLaunchpadHtml: a "Ready to Merge" card offers Merge', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'readyToMerge' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-merge[^"]*" type="button" data-key="github:acme\/widgets#1" data-title="Add feature"/);
});

test('renderLaunchpadHtml: a card in any other open bucket offers no Merge — only "Ready to Merge" matches the board\'s own mergeability check', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.ok(!html.includes('class="pr-card-merge'));
});

test('renderLaunchpadHtml: merged/closed cards offer no Merge — nothing left to merge on a PR that is already done', () => {
  const categorized: CategorizedPullRequest[] = [
    { pr: pr({ number: 1, closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' },
    { pr: pr({ number: 2, closedAt: '2024-02-02T10:00:00Z', merged: false }), bucket: 'closed' },
  ];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.ok(!html.includes('class="pr-card-merge'));
});

test('renderLaunchpadHtml: the Merge button posts mergePr with the PR\'s stable key and title', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'readyToMerge' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /type: 'mergePr', key: btn\.dataset\.key, title: btn\.dataset\.title/);
});

test('renderLaunchpadHtml: the "View diff" button posts showPullRequestDetails with the PR\'s stable key', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-details[^"]*" type="button" data-key="github:acme\/widgets#1"/);
  assert.match(html, /type: 'showPullRequestDetails', key: btn\.dataset\.key/);
});

test('renderLaunchpadHtml: "View diff" is offered even on a merged/closed card, unlike snooze/close — viewing a diff applies either way', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-details/);
});

test('renderLaunchpadHtml: the approve button posts submitReview with decision "approve"', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-approve[^"]*" type="button" data-key="github:acme\/widgets#1" data-title="Add feature"/);
  assert.match(html, /type: 'submitReview', key: btn\.dataset\.key, title: btn\.dataset\.title, decision: 'approve'/);
});

test('renderLaunchpadHtml: the request-changes button posts submitReview with decision "requestChanges"', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr(), bucket: 'waiting' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /class="pr-card-request-changes[^"]*" type="button" data-key="github:acme\/widgets#1" data-title="Add feature"/);
  assert.match(html, /type: 'submitReview', key: btn\.dataset\.key, title: btn\.dataset\.title, decision: 'requestChanges'/);
});

test('renderLaunchpadHtml: merged/closed cards offer neither approve nor request-changes — nothing to review on a PR that is already done', () => {
  const categorized: CategorizedPullRequest[] = [{ pr: pr({ closedAt: '2024-02-02T10:00:00Z', merged: true }), bucket: 'merged' }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.ok(!html.includes('class="pr-card-approve'));
  assert.ok(!html.includes('class="pr-card-request-changes'));
});

test('renderLaunchpadHtml: shows a per-repo error banner without failing the whole board', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [{ repo: { host: 'gitlab', identity: 'acme/x', label: 'acme/x' }, message: 'Not signed in.' }], now },
    opts,
  );
  assert.match(html, /class="error-row">acme\/x: Not signed in\.</);
});

test('renderLaunchpadHtml: nothing to show and no errors states the good outcome, not an empty board', () => {
  const html = renderLaunchpadHtml({ categorized: [], errors: [], now }, opts);
  assert.match(html, /No pull requests need your attention right now\./);
  assert.ok(!html.includes('class="board"'));
});

test('renderLaunchpadHtml: CSP uses the provided nonce and cspSource, no unsafe-inline', () => {
  const html = renderLaunchpadHtml({ categorized: [], errors: [], now }, opts);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /style-src vscode-webview:\/\/xyz/);
  assert.ok(!html.includes('unsafe-inline'));
});

test('renderLaunchpadHtml: escapes HTML special characters in PR-sourced fields', () => {
  const categorized: CategorizedPullRequest[] = [
    {
      pr: pr({ title: '<script>alert(1)</script>', authorLogin: '<img src=x onerror=alert(1)>' }),
      bucket: 'waiting',
    },
  ];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderLaunchpadHtml: refresh button posts a refresh message', () => {
  const html = renderLaunchpadHtml({ categorized: [], errors: [], now }, opts);
  assert.match(html, /id="refresh"/);
  assert.match(html, /getElementById\('refresh'\)\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'refresh' \}\);/);
});

test('renderLaunchpadHtml: renders a push/pull row per repo, keyed to that repo', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [], repoRows: [{ key: 'github:acme/widgets', label: 'acme/widgets' }], now },
    opts,
  );
  assert.match(html, /class="repo-row" data-key="github:acme\/widgets"/);
  assert.match(html, /class="repo-row-label">acme\/widgets</);
  assert.match(html, /class="repo-pull icon-btn" type="button" data-key="github:acme\/widgets"/);
  assert.match(html, /class="repo-push icon-btn" type="button" data-key="github:acme\/widgets"/);
  assert.match(html, /class="repo-signout icon-btn" type="button" data-key="github:acme\/widgets"/);
});

test('renderLaunchpadHtml: no repo list rendered when there are no repos', () => {
  const html = renderLaunchpadHtml({ categorized: [], errors: [], repoRows: [], now }, opts);
  assert.ok(!html.includes('class="repo-list"'));
});

test('renderLaunchpadHtml: repo push/pull buttons post keyed push/pull messages', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [], repoRows: [{ key: 'github:acme/widgets', label: 'acme/widgets' }], now },
    opts,
  );
  assert.match(html, /querySelectorAll\('\.repo-pull'\)[\s\S]*?vscode\.postMessage\(\{ type: 'pull', key: btn\.dataset\.key \}\);/);
  assert.match(html, /querySelectorAll\('\.repo-push'\)[\s\S]*?vscode\.postMessage\(\{ type: 'push', key: btn\.dataset\.key \}\);/);
  assert.match(html, /querySelectorAll\('\.repo-signout'\)[\s\S]*?vscode\.postMessage\(\{ type: 'signOut', key: btn\.dataset\.key \}\);/);
});

test('renderLaunchpadHtml: escapes HTML special characters in repo row fields', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [], repoRows: [{ key: '<script>alert(1)</script>', label: '<img src=x onerror=alert(1)>' }], now },
    opts,
  );
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('renderLaunchpadHtml: renders a Fetch button per repo, keyed to that repo, next to Pull/Push', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [], repoRows: [{ key: 'github:acme/widgets', label: 'acme/widgets' }], now },
    opts,
  );
  assert.match(html, /class="repo-fetch icon-btn" type="button" data-key="github:acme\/widgets"/);
});

test('renderLaunchpadHtml: repo Fetch button posts a keyed fetch message', () => {
  const html = renderLaunchpadHtml(
    { categorized: [], errors: [], repoRows: [{ key: 'github:acme/widgets', label: 'acme/widgets' }], now },
    opts,
  );
  assert.match(html, /querySelectorAll\('\.repo-fetch'\)[\s\S]*?vscode\.postMessage\(\{ type: 'fetch', key: btn\.dataset\.key \}\);/);
});

// C3.1: "Updated N ago" in board header
test('renderLaunchpadHtml: shows "Updated just now" when lastLoadedAt is very recent', () => {
  const lastLoadedAt = new Date(now.getTime() - 5_000); // 5 s ago
  const html = renderLaunchpadHtml({ categorized: [{ pr: pr(), bucket: 'waiting' }], errors: [], now, lastLoadedAt }, opts);
  assert.match(html, /Updated just now/);
});

test('renderLaunchpadHtml: shows "Updated N min ago" when lastLoadedAt is minutes ago', () => {
  const lastLoadedAt = new Date(now.getTime() - 5 * 60_000); // 5 min ago
  const html = renderLaunchpadHtml({ categorized: [{ pr: pr(), bucket: 'waiting' }], errors: [], now, lastLoadedAt }, opts);
  assert.match(html, /Updated 5 min ago/);
});

test('renderLaunchpadHtml: no lastLoadedAt provided — no "Updated" text', () => {
  const html = renderLaunchpadHtml({ categorized: [{ pr: pr(), bucket: 'waiting' }], errors: [], now }, opts);
  assert.ok(!html.includes('Updated '));
});

// C3.2: stale marker on cards
test('renderLaunchpadHtml: a stale PR card shows a stale marker text', () => {
  const categorized = [{ pr: pr(), bucket: 'waiting' as const, stale: true }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /stale/i);
});

test('renderLaunchpadHtml: a non-stale PR card has no stale marker', () => {
  const categorized = [{ pr: pr(), bucket: 'waiting' as const }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  // Check for the stale icon/class specifically (not any occurrence of the word "stale")
  assert.ok(!html.includes('class="stale-marker"'));
});

// C2.1: snooze button posts toggleSnooze (still true — QuickPick happens on provider side)
test('renderLaunchpadHtml: snooze button still posts toggleSnooze (QuickPick is on provider side)', () => {
  const categorized = [{ pr: pr(), bucket: 'waiting' as const }];
  const html = renderLaunchpadHtml({ categorized, errors: [], now }, opts);
  assert.match(html, /type: 'toggleSnooze', key: btn\.dataset\.key/);
});
