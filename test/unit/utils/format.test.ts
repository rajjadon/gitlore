// test/unit/utils/format.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBlameHover, formatLineHistoryHover } from '../../../src/utils/format';
import type { BlameLine, Commit, FileChange } from '../../../src/core/git/types';
import type { LineExplanationState } from '../../../src/core/ai/lineExplanationKey';

process.env.TZ = 'UTC';

const now = new Date('2024-02-04T10:00:00Z');

const entry: BlameLine = {
  line: 2,
  sha: '5a93a8d3e93fcc0a1f409e89d3aaca4346ced8ec',
  author: 'Amy Dev',
  authorEmail: 'amy@example.com',
  authorTime: Math.floor(new Date('2024-02-01T10:00:00Z').getTime() / 1000),
  summary: 'add line three',
  isUncommitted: false,
};

const diffStat: FileChange = { path: 'tracked.txt', insertions: 3, deletions: 1, binary: false };

test('formatBlameHover: includes gravatar, author, message, age, date, sha, and diff stat', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /!\[\]\(https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=20&d=identicon\)/);
  assert.match(md, /\*\*Amy Dev\*\*/);
  assert.match(md, /add line three/);
  assert.match(md, /3 days ago/);
  assert.match(md, /2024-02-01/);
  assert.match(md, /`5a93a8d`/);
  assert.match(md, /\+3 -1/);
});

test('formatBlameHover: puts the avatar and name in a two-cell table row, not a bare paragraph', () => {
  // Regression: `![](url) **name**` baseline-aligns the image with the text, leaving the avatar
  // visibly floating above the name. A table's cells default to vertical-align: middle, which a
  // bare paragraph can never get for a plain <img> under VS Code's hover sanitizer (no style/class
  // allowed on <img>). This locks in the table so the fix can't quietly regress back to a paragraph.
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /^\| !\[\]\(https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=20&d=identicon\) \| \*\*Amy Dev\*\* \|$/m);
  assert.match(md, /^\| :--- \| :--- \|$/m);
});

test('formatBlameHover: omits the diff stat line when there is none', () => {
  const md = formatBlameHover(entry, null, 'tracked.txt', 'line three', undefined, now);
  assert.doesNotMatch(md, /\+\d+ -\d+/);
});

test('formatBlameHover: omits the diff stat line for binary files', () => {
  const md = formatBlameHover(
    entry,
    { path: 'image.png', insertions: 0, deletions: 0, binary: true },
    'image.png',
    'line three',
    undefined,
    now,
  );
  assert.doesNotMatch(md, /\+\d+ -\d+/);
});

test('formatBlameHover: uncommitted lines get a short fixed message, no gravatar, no AI link', () => {
  const md = formatBlameHover({ ...entry, isUncommitted: true }, null, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /Uncommitted changes/);
  assert.doesNotMatch(md, /gravatar\.com/);
  assert.ok(!md.includes('command:gitLore.explainLine'));
});

test('formatBlameHover: escapes markdown special characters from git-sourced fields', () => {
  const malicious: BlameLine = {
    ...entry,
    author: '[Evil](http://evil.com)',
    summary: 'click **here** or [here](http://evil.com)',
  };
  const md = formatBlameHover(malicious, null, 'tracked.txt', 'line three', undefined, now);
  assert.ok(!md.includes('[Evil](http://evil.com)'));
  assert.ok(!md.includes('[here](http://evil.com)'));
  assert.ok(!md.includes('**here**'));
  assert.ok(md.includes('\\[Evil\\]\\(http://evil\\.com\\)'));
});

test('formatBlameHover: links an issue reference in the message when issueLinking is provided', () => {
  const withIssue: BlameLine = { ...entry, summary: 'fix #12 crash' };
  const md = formatBlameHover(withIssue, null, 'tracked.txt', 'line three', undefined, now, {
    pattern: '#(\\d+)',
    urlTemplate: 'https://github.com/o/r/issues/{issue}',
  });
  assert.ok(md.includes('[\\#12](https://github.com/o/r/issues/12)'));
});

test('formatBlameHover: without issueLinking, "#12" is left as escaped plain text, not a link', () => {
  const withIssue: BlameLine = { ...entry, summary: 'fix #12 crash' };
  const md = formatBlameHover(withIssue, null, 'tracked.txt', 'line three', undefined, now);
  assert.ok(!md.includes('issues/12'));
  assert.ok(md.includes('\\#12'));
});

test('formatBlameHover: with no line-explanation state, shows the Explain this line link with sparkle icon', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /\[\$\(sparkle\) Explain this line\]\(command:gitLore\.explainLine\?/);
  const match = /command:gitLore\.explainLine\?(\S+)\)/.exec(md);
  assert.ok(match, 'expected an encoded command link');
  const args = JSON.parse(decodeURIComponent(match[1] ?? '')) as unknown[];
  assert.deepEqual(args, ['tracked.txt', entry.sha, 'line three']);
});

test('formatBlameHover: pending state shows a generating notice, no link', () => {
  const state: LineExplanationState = { status: 'pending' };
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', state, now);
  assert.match(md, /Generating explanation/);
  assert.ok(!md.includes('command:gitLore.explainLine'));
});

test('formatBlameHover: done state shows the explanation text, no link', () => {
  const state: LineExplanationState = { status: 'done', text: 'This line guards against an unborn HEAD.' };
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', state, now);
  assert.match(md, /Why this line exists/);
  // Trailing "." is markdown-escaped by the 'done' branch (see the dedicated escaping test
  // below), so this only asserts the unescaped text content, not exact punctuation.
  assert.match(md, /This line guards against an unborn HEAD/);
  assert.ok(!md.includes('command:gitLore.explainLine'));
});

test('formatBlameHover: done state escapes markdown special characters in the model output', () => {
  const state: LineExplanationState = { status: 'done', text: 'Uses [a link](http://evil.com) and **bold**.' };
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', state, now);
  assert.ok(!md.includes('[a link](http://evil.com)'));
  assert.ok(!md.includes('**bold**'));
});

test('formatBlameHover: noModel state shows the caller-supplied reason and a retry link', () => {
  const state: LineExplanationState = { status: 'noModel', message: 'Cursor doesn\'t expose a language model.' };
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', state, now);
  assert.match(md, /Cursor doesn't expose a language model\./);
  assert.match(md, /\[\$\(sparkle\) Explain this line\]\(command:gitLore\.explainLine\?/);
});

test('formatBlameHover: error state shows the message and a retry link', () => {
  const state: LineExplanationState = { status: 'error', message: 'network timeout' };
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', state, now);
  assert.match(md, /Failed to generate explanation: network timeout/);
  assert.match(md, /\[\$\(sparkle\) Explain this line\]\(command:gitLore\.explainLine\?/);
});

test('formatBlameHover: every render path ends with a trailing --- divider', () => {
  const endsWithDivider = (md: string) => md.trimEnd().endsWith('---');

  // committed, no explanation state
  assert.ok(endsWithDivider(formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now)));
  // uncommitted early-return path
  assert.ok(endsWithDivider(formatBlameHover({ ...entry, isUncommitted: true }, null, 'tracked.txt', 'line three', undefined, now)));
  // pending
  assert.ok(endsWithDivider(formatBlameHover(entry, null, 'tracked.txt', 'line three', { status: 'pending' }, now)));
  // done
  assert.ok(endsWithDivider(formatBlameHover(entry, null, 'tracked.txt', 'line three', { status: 'done', text: 'short' }, now)));
  // noModel
  assert.ok(endsWithDivider(formatBlameHover(entry, null, 'tracked.txt', 'line three', { status: 'noModel', message: 'x' }, now)));
  // error
  assert.ok(endsWithDivider(formatBlameHover(entry, null, 'tracked.txt', 'line three', { status: 'error', message: 'oops' }, now)));
});

test('formatBlameHover: done state truncates explanations over MAX_EXPLANATION_CHARS with a trailing ellipsis', () => {
  const long = 'a'.repeat(501);
  const state: LineExplanationState = { status: 'done', text: long };
  const md = formatBlameHover(entry, null, 'tracked.txt', 'line three', state, now);
  // Must end with '…' (before the trailing ---)
  assert.ok(md.includes('a'.repeat(500) + '…'), 'expected truncation at 500 chars');
  assert.ok(!md.includes('a'.repeat(501)), 'expected the 501st char to be cut');
});

test('formatBlameHover: done state does not truncate explanations at or under MAX_EXPLANATION_CHARS', () => {
  const atLimit = 'b'.repeat(500);
  const state: LineExplanationState = { status: 'done', text: atLimit };
  const md = formatBlameHover(entry, null, 'tracked.txt', 'line three', state, now);
  assert.ok(md.includes('b'.repeat(500)), 'expected full text preserved');
  assert.ok(!md.includes('…'), 'expected no ellipsis when text is exactly at the limit');
});

test('formatBlameHover: diffstat includes "in this file" scope label', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /in this file/);
  assert.match(md, /\$\(diff\)/);
});

test('formatBlameHover: includes Compare / File History / Copy SHA quick actions', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.match(md, /\[\$\(git-compare\) Compare\]\(command:gitLore\.compareBranches\)/);
  assert.match(md, /\[\$\(history\) File History\]\(command:gitLore\.showFileHistory\)/);
  const match = /\[\$\(copy\) Copy SHA\]\(command:gitLore\.copySha\?(\S+)\)/.exec(md);
  assert.ok(match, 'expected a Copy SHA command link');
  assert.deepEqual(JSON.parse(decodeURIComponent(match[1] ?? '')), [entry.sha]);
});

test('formatBlameHover: uncommitted lines get no quick actions — there is no committed sha to act on', () => {
  const md = formatBlameHover({ ...entry, isUncommitted: true }, null, 'tracked.txt', 'line three', undefined, now);
  assert.ok(!md.includes('command:gitLore.compareBranches'));
  assert.ok(!md.includes('command:gitLore.copySha'));
});

test('formatBlameHover: shows a lone "Older" link to start stepping through the line\'s history', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  const match = /\[\$\(chevron-left\) Older\]\(command:gitLore\.stepLineHistory\?(\S+)\)/.exec(md);
  assert.ok(match, 'expected an Older command link');
  assert.deepEqual(JSON.parse(decodeURIComponent(match[1] ?? '')), ['tracked.txt', entry.line, 'prev']);
  // No count shown yet — that would require fetching the full -L history on every hover.
  assert.ok(!/\d+ of \d+/.test(md));
});

const historicalCommit: Commit = {
  sha: '4096af71a8a482397d0a44565e6262b1222986ac',
  shortSha: '4096af7',
  author: 'Raj Jadon',
  authorEmail: 'raj@example.com',
  date: '2024-01-01T10:00:00Z',
  message: 'first commit',
};

test('formatLineHistoryHover: includes gravatar, author, message, date, sha, and diff stat', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 1, 3, now);
  assert.match(md, /!\[\]\(https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?s=20&d=identicon\)/);
  assert.match(md, /\*\*Raj Jadon\*\*/);
  assert.match(md, /first commit/);
  assert.match(md, /2024-01-01/);
  assert.match(md, /`4096af7`/);
  assert.match(md, /\+3 -1/);
});

test('formatLineHistoryHover: has no AI-explain link — it only applies to the live line content', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 1, 3, now);
  assert.ok(!md.includes('command:gitLore.explainLine'));
  assert.ok(!md.includes('$(sparkle)'));
});

test('formatLineHistoryHover: includes quick actions scoped to the historical commit\'s sha', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 1, 3, now);
  const match = /\[\$\(copy\) Copy SHA\]\(command:gitLore\.copySha\?(\S+)\)/.exec(md);
  assert.ok(match);
  assert.deepEqual(JSON.parse(decodeURIComponent(match[1] ?? '')), [historicalCommit.sha]);
});

test('formatLineHistoryHover: shows "N of M" with both prev and next as links in the middle of history', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 1, 3, now);
  assert.match(md, /2 of 3/);
  const prev = /\[\$\(chevron-left\)\]\(command:gitLore\.stepLineHistory\?(\S+)\)/.exec(md);
  const next = /\[\$\(chevron-right\)\]\(command:gitLore\.stepLineHistory\?(\S+)\)/.exec(md);
  assert.ok(prev, 'expected prev to be a link in the middle of history');
  assert.ok(next, 'expected next to always be a link');
  assert.deepEqual(JSON.parse(decodeURIComponent(prev[1] ?? '')), ['tracked.txt', 2, 'prev']);
  assert.deepEqual(JSON.parse(decodeURIComponent(next[1] ?? '')), ['tracked.txt', 2, 'next']);
});

test('formatLineHistoryHover: prev becomes plain (non-link) text at the oldest revision', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 2, 3, now);
  assert.match(md, /3 of 3/);
  assert.ok(!md.includes('"prev"'));
  assert.match(md, /(?<!\[)\$\(chevron-left\)(?!\])/);
});

test('formatLineHistoryHover: ends with a trailing --- divider, like the live card', () => {
  const md = formatLineHistoryHover(historicalCommit, diffStat, 'tracked.txt', 2, 1, 3, now);
  assert.ok(md.trimEnd().endsWith('---'));
});

test('formatLineHistoryHover: escapes markdown special characters from git-sourced fields', () => {
  const malicious: Commit = { ...historicalCommit, author: '[Evil](http://evil.com)', message: 'click **here**' };
  const md = formatLineHistoryHover(malicious, null, 'tracked.txt', 2, 1, 3, now);
  assert.ok(!md.includes('[Evil](http://evil.com)'));
  assert.ok(!md.includes('**here**'));
});

// ─── F2.4: "Open PR" hover link gating tests ──────────────────────────────

test('formatBlameHover: "Open PR" link is absent by default (launchpadEnabled not passed)', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now);
  assert.ok(!md.includes('openPullRequestForCommit'), '"Open PR" must not appear when launchpad is off');
});

test('formatBlameHover: "Open PR" link is absent when launchpadEnabled is false', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now, null, false);
  assert.ok(!md.includes('openPullRequestForCommit'), '"Open PR" must not appear when launchpadEnabled=false');
});

test('formatBlameHover: "Open PR" link is present when launchpadEnabled is true', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now, null, true);
  assert.match(md, /\[\$\(git-pull-request\) Open PR\]\(command:gitLore\.openPullRequestForCommit\?/);
});

test('formatBlameHover: "Open PR" link carries the file path and sha as encoded JSON args', () => {
  const md = formatBlameHover(entry, diffStat, 'tracked.txt', 'line three', undefined, now, null, true);
  const match = /command:gitLore\.openPullRequestForCommit\?(\S+)\)/.exec(md);
  assert.ok(match, 'expected an encoded command link');
  const args = JSON.parse(decodeURIComponent(match[1] ?? '')) as unknown[];
  assert.deepEqual(args, ['tracked.txt', entry.sha]);
});

test('formatBlameHover: "Open PR" link is absent for uncommitted lines even with launchpadEnabled=true', () => {
  const md = formatBlameHover({ ...entry, isUncommitted: true }, null, 'tracked.txt', 'line three', undefined, now, null, true);
  assert.ok(!md.includes('openPullRequestForCommit'), '"Open PR" must never appear on an uncommitted line');
});
