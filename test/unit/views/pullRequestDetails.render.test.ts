import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPullRequestDetailsHtml, renderChecks } from '../../../src/views/PullRequestDetails/render';
import { diffCacheKey } from '../../../src/core/forge/PullRequestDiffCache';
import type { CheckDetail, ConversationThread, PullRequestSummary } from '../../../src/core/forge/types';
import type { FileChange } from '../../../src/core/git/types';

process.env.TZ = 'UTC';

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

const files: FileChange[] = [{ path: 'src/a.ts', insertions: 3, deletions: 1, binary: false }];
const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1,2 +1,3 @@\n line one\n+line two\n';

const opts = {
  nonce: 'abc123',
  cspSource: 'vscode-webview://xyz',
  styleUris: ['vscode-webview://xyz/shared.css', 'vscode-webview://xyz/pullRequestDetails.css'],
};

test('renderPullRequestDetailsHtml: includes PR metadata, files, and diff', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /<h1 title="Add feature">Add feature<\/h1>/);
  assert.match(html, /raj/);
  assert.match(html, /acme\/widgets/);
  assert.match(html, /src\/a\.ts/);
  assert.match(html, /class="dc diff-add">\+line two</);
});

test('renderPullRequestDetailsHtml: heads the file section with a count and whole-PR totals', () => {
  const twoFiles: FileChange[] = [
    { path: 'a.ts', insertions: 10, deletions: 2, binary: false },
    { path: 'b.ts', insertions: 5, deletions: 8, binary: false },
  ];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files: twoFiles, diff: '', threads: [] }, opts);
  assert.match(html, /class="badge">2</);
  assert.match(html, /class="stat-add">\+15</);
  assert.match(html, /class="stat-del">&minus;10</);
});

test('renderPullRequestDetailsHtml: no fabricated stats for a host with no diff text (Azure DevOps gap) — shows 0/0, not a guess', () => {
  const noStatFiles: FileChange[] = [{ path: 'src/a.ts', insertions: 0, deletions: 0, binary: false }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files: noStatFiles, diff: '', threads: [] }, opts);
  assert.match(html, /No textual diff for this file\./);
  assert.match(html, /class="stat-add">\+0</);
});

test('renderPullRequestDetailsHtml: "Open on <host>" button posts openRemote', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /id="open-remote"/);
  assert.match(html, /getElementById\('open-remote'\)\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'openRemote' \}\);/);
});

test('renderPullRequestDetailsHtml: the comment button posts addComment with the textarea\'s value', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /id="comment-body"/);
  assert.match(html, /id="post-comment"/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'addComment', body \}\);/);
});

test('renderPullRequestDetailsHtml: posting a comment shows a shimmering skeleton, carrying the message as an aria-label instead of visible "Posting…" text', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /class="skeleton" id="comment-status-skeleton" role="status" aria-live="polite" aria-busy="true" aria-label="Posting…" hidden/);
  assert.match(html, /class="skeleton-row"/);
  assert.match(
    html,
    /postCommentBtn\.disabled = true;\s*commentStatus\.hidden = true;\s*commentStatusSkeleton\.hidden = false;/,
  );
  assert.ok(!html.includes('>Posting…<'));
});

test('renderPullRequestDetailsHtml: a posted or failed comment hides the skeleton', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /msg\.type === 'commentPosted'\) \{[^}]*commentStatusSkeleton\.hidden = true;/s);
  assert.match(html, /msg\.type === 'commentFailed'\) \{[^}]*commentStatusSkeleton\.hidden = true;/s);
});

test('renderPullRequestDetailsHtml: escapes HTML special characters in PR-sourced fields', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ title: '<script>alert(1)</script>', authorLogin: '<img src=x onerror=alert(1)>' }), files, diff, threads: [] },
    opts,
  );
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderPullRequestDetailsHtml: CSP uses the provided nonce and cspSource, no unsafe-inline', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /style-src vscode-webview:\/\/xyz/);
  assert.ok(!html.includes('unsafe-inline'));
});

test('renderPullRequestDetailsHtml: shows a "No review conversations" message when there are none', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /No review conversations on this pull request\./);
});

test('renderPullRequestDetailsHtml: an unresolved thread gets a Resolve button; a resolved one doesn\'t', () => {
  const threads: ConversationThread[] = [
    { id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] },
    { id: 't2', body: 'Already fine', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Already fine' }] },
  ];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="thread gitlore-enter" data-thread-id="t1">[\s\S]*?class="thread-resolve[^"]*" type="button" data-thread-id="t1"/);
  assert.ok(!/class="thread gitlore-enter thread-resolved" data-thread-id="t2">[\s\S]*?class="thread-resolve/.test(html));
  assert.match(html, /class="thread gitlore-enter thread-resolved" data-thread-id="t2"/);
});

test('renderPullRequestDetailsHtml: the Resolve button posts resolveThread with the thread\'s id', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  // Delegated listener — the resolveThread message is posted inside the threads click handler
  assert.match(html, /type: 'resolveThread', threadId:/);
});

test('renderPullRequestDetailsHtml: escapes HTML special characters in thread fields', () => {
  const threads: ConversationThread[] = [
    { id: 't1', body: '<script>alert(1)</script>', authorLogin: '<img src=x onerror=alert(1)>', resolved: false, comments: [{ authorLogin: '<img src=x onerror=alert(1)>', body: '<script>alert(1)</script>' }] },
  ];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('renderPullRequestDetailsHtml: a thread anchored to a diff line shows its file and line as a jump button', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'src/a.ts', line: 42, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="thread-location thread-jump-btn"[^>]*>src\/a\.ts:42</);
});

test('renderPullRequestDetailsHtml: Azure DevOps\' leading-slash file paths are shown without it as a jump button', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: '/src/a.ts', line: 3, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="thread-location thread-jump-btn"[^>]*>src\/a\.ts:3</);
});

test('renderPullRequestDetailsHtml: a general PR-level comment (not attached to any line) shows no location', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Looks good overall', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Looks good overall' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.ok(!html.includes('thread-location'));
});

test('renderPullRequestDetailsHtml: a Refresh button posts refresh', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.match(html, /id="refresh-pr"/);
  assert.match(html, /getElementById\('refresh-pr'\)\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'refresh' \}\);/);
});

const now = new Date('2024-02-10T10:00:00Z');

test('renderPullRequestDetailsHtml: the author line carries the author icon, matching Launchpad\'s own card convention', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.match(html, /class="head-author">.*svg.*raj/s);
});

test('renderPullRequestDetailsHtml: a draft PR shows a Draft badge', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ isDraft: true }), files, diff, threads: [], now }, opts);
  assert.match(html, /class="badge[^"]*">Draft</);
});

test('renderPullRequestDetailsHtml: a merged PR shows a Merged badge instead of ever looking like an untouched open PR', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: true }), files, diff, threads: [], now },
    opts,
  );
  assert.match(html, /class="badge[^"]*">Merged</);
});

test('renderPullRequestDetailsHtml: a closed-without-merging PR shows a Closed badge, not Merged', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: false }), files, diff, threads: [], now },
    opts,
  );
  assert.match(html, /class="badge[^"]*">Closed</);
  assert.ok(!html.includes('>Merged<'));
});

test('renderPullRequestDetailsHtml: an open PR (no closedAt) shows neither Merged nor Closed', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.ok(!html.includes('>Merged<'));
  assert.ok(!html.includes('>Closed<'));
});

test('renderPullRequestDetailsHtml: checkStatus "failing" shows a Checks failing badge', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ checkStatus: 'failing' }), files, diff, threads: [], now }, opts);
  assert.match(html, /class="badge[^"]*">Checks failing</);
});

test('renderPullRequestDetailsHtml: checkStatus "pending" shows a Checks running badge', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ checkStatus: 'pending' }), files, diff, threads: [], now }, opts);
  assert.match(html, /class="badge[^"]*">Checks running</);
});

test('renderPullRequestDetailsHtml: checkStatus "none" shows no checks status badge (passing/failing/running) — nothing to report', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ checkStatus: 'none' }), files, diff, threads: [], now }, opts);
  // The "Checks" section head is always shown; only the STATUS badge is absent for 'none'
  assert.ok(!html.includes('Checks passing') && !html.includes('Checks failing') && !html.includes('Checks running'));
});

test('renderPullRequestDetailsHtml: reviewDecision "changesRequested" shows a Changes requested badge', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ reviewDecision: 'changesRequested' }), files, diff, threads: [], now }, opts);
  assert.match(html, /class="badge[^"]*">Changes requested</);
});

test('renderPullRequestDetailsHtml: reviewDecision "reviewRequired" shows how many reviewers are still owed one', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ reviewDecision: 'reviewRequired', requestedReviewers: ['amy', 'sam'] }), files, diff, threads: [], now },
    opts,
  );
  assert.match(html, /class="badge[^"]*">2 reviews requested</);
});

test('renderPullRequestDetailsHtml: reviewDecision "none" shows no review badge at all', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr({ reviewDecision: 'none' }), files, diff, threads: [], now }, opts);
  assert.ok(!html.includes('review requested') && !html.includes('reviews requested') && !html.includes('>Approved<') && !html.includes('Changes requested'));
});

test('renderPullRequestDetailsHtml: hasConflicts shows a Has conflicts badge; a clean PR shows none', () => {
  const withConflicts = renderPullRequestDetailsHtml({ pr: pr({ hasConflicts: true }), files, diff, threads: [], now }, opts);
  assert.match(withConflicts, /class="badge[^"]*">Has conflicts</);
  const clean = renderPullRequestDetailsHtml({ pr: pr({ hasConflicts: false }), files, diff, threads: [], now }, opts);
  assert.ok(!clean.includes('Has conflicts'));
});

test('renderPullRequestDetailsHtml: always shows the PR\'s age, using closedAt when terminal and createdAt otherwise', () => {
  const open = renderPullRequestDetailsHtml({ pr: pr({ createdAt: '2024-02-08T10:00:00Z' }), files, diff, threads: [], now }, opts);
  assert.match(open, /class="head-age"[^>]*title="2024-02-08 10:00"/);
  const merged = renderPullRequestDetailsHtml(
    { pr: pr({ createdAt: '2024-01-01T00:00:00Z', closedAt: '2024-02-09T10:00:00Z', merged: true }), files, diff, threads: [], now },
    opts,
  );
  assert.match(merged, /class="head-age"[^>]*title="2024-02-09 10:00"/);
});

test('renderPullRequestDetailsHtml: an open PR shows Approve, Request Changes, and Close buttons', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.match(html, /id="approve-pr"/);
  assert.match(html, /id="request-changes-pr"/);
  assert.match(html, /id="close-pr"/);
});

test('renderPullRequestDetailsHtml: a merged or closed PR shows none of Approve/Request Changes/Close', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: true }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!html.includes('id="approve-pr"'));
  assert.ok(!html.includes('id="request-changes-pr"'));
  assert.ok(!html.includes('id="close-pr"'));
});

test('renderPullRequestDetailsHtml: a closed-without-merging PR shows a Reopen button; a merged one does not', () => {
  const closed = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: false }), files, diff, threads: [], now },
    opts,
  );
  assert.match(closed, /id="reopen-pr"/);
  const merged = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: true }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!merged.includes('id="reopen-pr"'));
});

test('renderPullRequestDetailsHtml: an open PR shows no Reopen button', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.ok(!html.includes('id="reopen-pr"'));
});

test('renderPullRequestDetailsHtml: shows Merge only when approved, checks aren\'t pending, and there are no conflicts — matching Launchpad\'s own "ready to merge" rule', () => {
  const ready = renderPullRequestDetailsHtml(
    { pr: pr({ reviewDecision: 'approved', checkStatus: 'passing', hasConflicts: false }), files, diff, threads: [], now },
    opts,
  );
  assert.match(ready, /id="merge-pr"/);

  const notApproved = renderPullRequestDetailsHtml(
    { pr: pr({ reviewDecision: 'reviewRequired', checkStatus: 'passing', hasConflicts: false }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!notApproved.includes('id="merge-pr"'));

  const pendingChecks = renderPullRequestDetailsHtml(
    { pr: pr({ reviewDecision: 'approved', checkStatus: 'pending', hasConflicts: false }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!pendingChecks.includes('id="merge-pr"'));

  const conflicted = renderPullRequestDetailsHtml(
    { pr: pr({ reviewDecision: 'approved', checkStatus: 'passing', hasConflicts: true }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!conflicted.includes('id="merge-pr"'));
});

test('renderPullRequestDetailsHtml: Approve posts submitReview with decision "approve" and optional body; Request Changes posts "requestChanges"', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  // Body is captured from the review-body textarea and included in the message
  assert.match(html, /getElementById\('approve-pr'\)\?\.addEventListener\('click'/);
  assert.match(html, /type: 'submitReview', decision: 'approve'/);
  assert.match(html, /getElementById\('request-changes-pr'\)\?\.addEventListener\('click'/);
  assert.match(html, /type: 'submitReview', decision: 'requestChanges'/);
});

test('renderPullRequestDetailsHtml: Close/Reopen/Merge buttons post closePr/reopenPr/mergePr', () => {
  const open = renderPullRequestDetailsHtml({ pr: pr({ reviewDecision: 'approved', checkStatus: 'passing' }), files, diff, threads: [], now }, opts);
  assert.match(open, /getElementById\('close-pr'\)\?\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'closePr' \}\);/);
  assert.match(open, /getElementById\('merge-pr'\)\?\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'mergePr' \}\);/);

  const closed = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: false }), files, diff, threads: [], now },
    opts,
  );
  assert.match(closed, /getElementById\('reopen-pr'\)\?\.addEventListener\('click', \(\) => \{\s*vscode\.postMessage\(\{ type: 'reopenPr' \}\);/);
});

// ─── B1.3 — diffCacheKey ────────────────────────────────────────────────────

test('diffCacheKey: includes headSha so a force-push produces a different key', () => {
  const base = {
    repo: { host: 'github' as const, identity: 'acme/widgets', label: 'acme/widgets' },
    number: 1, title: '', url: '', authorLogin: '', isDraft: false,
    createdAt: '', updatedAt: '', requestedReviewers: [], checkStatus: 'none' as const,
    reviewDecision: 'none' as const, hasConflicts: false, reviewedByMe: false,
  };
  const beforePush = diffCacheKey({ ...base, headSha: 'abc123' });
  const afterPush  = diffCacheKey({ ...base, headSha: 'def456' });
  assert.notEqual(beforePush, afterPush);
});

test('diffCacheKey: same PR + same headSha → same key (cache hit)', () => {
  const base = {
    repo: { host: 'github' as const, identity: 'acme/widgets', label: 'acme/widgets' },
    number: 1, title: '', url: '', authorLogin: '', isDraft: false,
    createdAt: '', updatedAt: '', requestedReviewers: [], checkStatus: 'none' as const,
    reviewDecision: 'none' as const, hasConflicts: false, reviewedByMe: false, headSha: 'abc123',
  };
  assert.equal(diffCacheKey(base), diffCacheKey({ ...base }));
});

// ─── B2.3 — thread multi-comment, reply, unresolve ──────────────────────────

test('renderPullRequestDetailsHtml: thread renders all comments (multi-comment thread)', () => {
  const threads: ConversationThread[] = [{
    id: 't1', body: 'First comment', authorLogin: 'amy', resolved: false,
    comments: [
      { authorLogin: 'amy', body: 'First comment' },
      { authorLogin: 'raj', body: 'Second comment', createdAt: '2024-02-09T12:00:00Z' },
    ],
  }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads, now }, opts);
  assert.match(html, /First comment/);
  assert.match(html, /Second comment/);
  assert.match(html, /class="thread-author">amy</);
  assert.match(html, /class="thread-author">raj</);
});

test('renderPullRequestDetailsHtml: thread comment with createdAt shows relative time', () => {
  const threads: ConversationThread[] = [{
    id: 't1', body: 'Note', authorLogin: 'amy', resolved: false,
    comments: [{ authorLogin: 'amy', body: 'Note', createdAt: '2024-02-09T12:00:00Z' }],
  }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads, now }, opts);
  // now = 2024-02-10T10:00:00Z, createdAt = 2024-02-09T12:00:00Z → ~22 hours ago
  assert.match(html, /22 hours ago/);
});

test('renderPullRequestDetailsHtml: reply textarea and button are present in each thread', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="thread-reply-body"[^>]*data-thread-id="t1"/);
  assert.match(html, /class="[^"]*thread-reply-btn"[^>]*data-thread-id="t1"/);
});

test('renderPullRequestDetailsHtml: reply button posts replyToThread message via delegated listener', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /type: 'replyToThread'/);
});

test('renderPullRequestDetailsHtml: a resolved thread has an Unresolve button, not a Resolve button', () => {
  const threads: ConversationThread[] = [{ id: 't2', body: 'Done', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Done' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="[^"]*thread-unresolve[^"]*"/);
  assert.ok(!html.includes('class="thread-resolve'));
});

test('renderPullRequestDetailsHtml: unresolve button posts unresolveThread message', () => {
  const threads: ConversationThread[] = [{ id: 't2', body: 'Done', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Done' }] }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /type: 'unresolveThread'/);
});

test('renderPullRequestDetailsHtml: XSS escaping in thread comment author and body (B7.1)', () => {
  const threads: ConversationThread[] = [{
    id: 't1', body: '<script>evil()</script>', authorLogin: '<img onerror=x>', resolved: false,
    comments: [{ authorLogin: '<img onerror=x>', body: '<script>evil()</script>' }],
  }];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.ok(!html.includes('<script>evil()</script>'));
  assert.ok(!html.includes('<img onerror=x>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ─── B3.2 — review body textarea ────────────────────────────────────────────

test('renderPullRequestDetailsHtml: a review-body textarea is rendered for open PRs (always visible, not hidden)', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.match(html, /id="review-body"/);
  // Must NOT be hidden by default — the old hidden-until-focus approach caused layout shifts
  assert.ok(!/<textarea[^>]*id="review-body"[^>]*hidden/.test(html), 'textarea must not carry the hidden attribute');
});

test('renderPullRequestDetailsHtml: review-body has a visible label with correct for association', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.match(html, /<label[^>]*for="review-body"/);
  assert.match(html, /Review comment \(optional\)/);
});

test('renderPullRequestDetailsHtml: review-body section appears before the Approve button in DOM order (sits above review actions)', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  const reviewBodyIdx = html.indexOf('id="review-body"');
  const approveIdx = html.indexOf('id="approve-pr"');
  assert.ok(reviewBodyIdx > 0, 'review-body must be present');
  assert.ok(approveIdx > 0, 'approve-pr must be present');
  assert.ok(reviewBodyIdx < approveIdx, 'review-body textarea must appear before the Approve button');
});

test('renderPullRequestDetailsHtml: merged/closed PR does not render the review-body textarea', () => {
  const html = renderPullRequestDetailsHtml(
    { pr: pr({ closedAt: '2024-02-05T00:00:00Z', merged: true }), files, diff, threads: [], now },
    opts,
  );
  assert.ok(!html.includes('id="review-body"'), 'no review textarea on a merged PR');
});

test('renderPullRequestDetailsHtml: Approve and Request Changes include the review body in the message', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  // The script reads the review-body textarea value and includes it as `body`
  assert.match(html, /getElementById\('review-body'\)/);
  assert.match(html, /body.*submitReview|submitReview.*body/s);
});

// ─── B4.3 — checks section ──────────────────────────────────────────────────

test('renderPullRequestDetailsHtml: includes a checks section with a skeleton initially', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [], now }, opts);
  assert.match(html, /id="checks-container"/);
  assert.match(html, /class="skeleton"/);
});

test('renderChecks: failing checks appear before pending, pending before passing count', () => {
  const checks: CheckDetail[] = [
    { name: 'lint', status: 'passing' },
    { name: 'ci/build', status: 'pending' },
    { name: 'ci/test', status: 'failing' },
  ];
  const html = renderChecks(checks);
  const failIdx = html.indexOf('ci/test');
  const pendingIdx = html.indexOf('ci/build');
  const passingIdx = html.indexOf('passing');
  assert.ok(failIdx < pendingIdx, 'failing before pending');
  assert.ok(pendingIdx < passingIdx, 'pending before passing count');
});

test('renderChecks: passing checks are collapsed to a count, not listed individually', () => {
  const checks: CheckDetail[] = [
    { name: 'lint', status: 'passing' },
    { name: 'ci', status: 'passing' },
  ];
  const html = renderChecks(checks);
  // A count like "2 checks passing" is shown; individual names NOT listed
  assert.match(html, /2 checks? passing/);
  // Individual passing check names should NOT appear as check rows
  assert.ok(!html.includes('class="check-row check-passing"'));
});

test('renderChecks: a single passing check uses singular "check passing"', () => {
  const checks: CheckDetail[] = [{ name: 'ci', status: 'passing' }];
  const html = renderChecks(checks);
  assert.match(html, /1 check passing/);
});

test('renderChecks: a check with a valid https URL is rendered as a link button', () => {
  const checks: CheckDetail[] = [{ name: 'ci/test', status: 'failing', url: 'https://ci.example.com/job/1' }];
  const html = renderChecks(checks);
  assert.match(html, /data-check-url="https:\/\/ci\.example\.com\/job\/1"/);
});

test('renderChecks: a check with a javascript: URL is not rendered as a link (scheme validation)', () => {
  const checks: CheckDetail[] = [{ name: 'ci/test', status: 'failing', url: 'javascript:alert(1)' }];
  const html = renderChecks(checks);
  assert.ok(!html.includes('data-check-url="javascript:alert(1)"'));
});

test('renderChecks: a check with no URL has no link button', () => {
  const checks: CheckDetail[] = [{ name: 'lint', status: 'failing' }];
  const html = renderChecks(checks);
  assert.ok(!html.includes('data-check-url'));
});

test('renderChecks: empty checks array shows a "no checks" message', () => {
  const html = renderChecks([]);
  assert.match(html, /No checks/);
});

test('renderChecks: error string shows an inline error, not an empty list', () => {
  const html = renderChecks([], 'network timeout');
  assert.match(html, /network timeout/);
});

test('renderChecks: XSS escaping in check names and URLs (B7.1)', () => {
  const checks: CheckDetail[] = [{ name: '<script>evil()</script>', status: 'failing', url: 'https://safe.example.com' }];
  const html = renderChecks(checks);
  assert.ok(!html.includes('<script>evil()</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ─── B5.1 — jump-to-line button ─────────────────────────────────────────────

test('renderPullRequestDetailsHtml: thread with file in diff gets enabled jump button (B5.1)', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'src/a.ts', line: 5, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  // files includes 'src/a.ts'
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  // Button is enabled (no disabled attribute) and carries the anchor file
  assert.match(html, /class="thread-location thread-jump-btn"[^>]*data-anchor-file="src\/a\.ts"/);
  assert.ok(!html.includes('disabled>src/a.ts'));
});

test('renderPullRequestDetailsHtml: thread with file NOT in diff gets disabled jump button with explanation (B5.1)', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'other/file.ts', line: 5, comments: [{ authorLogin: 'amy', body: 'Fix this' }] }];
  // files only has 'src/a.ts', not 'other/file.ts'
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.match(html, /class="thread-location thread-jump-btn"[^>]*disabled/);
  assert.match(html, /other\/file\.ts/);
});

// ─── B6.1 — unresolved badge ────────────────────────────────────────────────

test('renderPullRequestDetailsHtml: unresolved badge shows count when > 0 (B6.1)', () => {
  const threads: ConversationThread[] = [
    { id: 't1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] },
    { id: 't2', body: 'Fix that', authorLogin: 'raj', resolved: false, comments: [{ authorLogin: 'raj', body: 'Fix that' }] },
    { id: 't3', body: 'Done', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Done' }] },
  ];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  // Badge must show count AND text (not color alone)
  assert.match(html, /2 unresolved/);
});

test('renderPullRequestDetailsHtml: unresolved badge is hidden when all threads are resolved (B6.1)', () => {
  const threads: ConversationThread[] = [
    { id: 't1', body: 'Done', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Done' }] },
  ];
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads }, opts);
  assert.ok(!html.includes('unresolved'));
});

test('renderPullRequestDetailsHtml: unresolved badge is hidden when there are no threads (B6.1)', () => {
  const html = renderPullRequestDetailsHtml({ pr: pr(), files, diff, threads: [] }, opts);
  assert.ok(!html.includes('unresolved'));
});
