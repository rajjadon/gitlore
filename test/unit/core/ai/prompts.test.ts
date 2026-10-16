import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCommitSummaryPrompt,
  buildCommitMessagePrompt,
  truncateForModel,
  buildPrExplanationPrompt,
  buildBranchCompareSummaryPrompt,
  buildChangelogPrompt,
  buildPrReviewDraftPrompt,
} from '../../../../src/core/ai/prompts';
import type { CommitDetail, Commit } from '../../../../src/core/git/types';
import type { PullRequestSummary, ConversationThread } from '../../../../src/core/forge/types';

const commit: CommitDetail = {
  sha: 'abc123',
  shortSha: 'abc123',
  author: 'Amy Dev',
  authorEmail: 'amy@example.com',
  date: '2024-02-01T10:00:00Z',
  message: 'fix: handle empty repo',
  body: 'fix: handle empty repo\n\nThis also fixes a crash when HEAD is unborn.',
};

test('truncateForModel: returns text unchanged when under the limit', () => {
  assert.equal(truncateForModel('short', 100), 'short');
});

test('truncateForModel: truncates and appends the marker when over the limit', () => {
  const text = 'a'.repeat(20);
  assert.equal(truncateForModel(text, 10), 'a'.repeat(10) + '[...truncated]');
});

test('truncateForModel: text exactly at the limit is not truncated', () => {
  const text = 'a'.repeat(10);
  assert.equal(truncateForModel(text, 10), text);
});

test('buildCommitSummaryPrompt: includes the full commit body and the diff', () => {
  const diff = '+line three\n-line two\n';
  const prompt = buildCommitSummaryPrompt(commit, diff, 8000);
  assert.match(prompt, /This also fixes a crash when HEAD is unborn\./);
  assert.match(prompt, /\+line three/);
});

test('buildCommitSummaryPrompt: passes a diff under the limit through unchanged', () => {
  const diff = 'short diff';
  const prompt = buildCommitSummaryPrompt(commit, diff, 8000);
  assert.match(prompt, /short diff/);
  assert.ok(!prompt.includes('[...truncated]'));
});

test('buildCommitSummaryPrompt: truncates a diff over the limit and marks it', () => {
  const diff = 'a'.repeat(20);
  const prompt = buildCommitSummaryPrompt(commit, diff, 10);
  assert.match(prompt, /a{10}\[\.\.\.truncated\]/);
  assert.ok(!prompt.includes('a'.repeat(11)));
});

test('buildCommitSummaryPrompt: handles an empty diff (e.g. a merge commit)', () => {
  const prompt = buildCommitSummaryPrompt(commit, '', 8000);
  assert.match(prompt, /fix: handle empty repo/);
});

test('buildCommitMessagePrompt: includes the staged diff', () => {
  const diff = '+line three\n-line two\n';
  const prompt = buildCommitMessagePrompt(diff, 8000);
  assert.match(prompt, /\+line three/);
});

test('buildCommitMessagePrompt: passes a diff under the limit through unchanged', () => {
  const diff = 'short diff';
  const prompt = buildCommitMessagePrompt(diff, 8000);
  assert.match(prompt, /short diff/);
  assert.ok(!prompt.includes('[...truncated]'));
});

test('buildCommitMessagePrompt: truncates a diff over the limit and marks it', () => {
  const diff = 'a'.repeat(20);
  const prompt = buildCommitMessagePrompt(diff, 10);
  assert.match(prompt, /a{10}\[\.\.\.truncated\]/);
  assert.ok(!prompt.includes('a'.repeat(11)));
});

function pr(): PullRequestSummary {
  return {
    repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' },
    number: 42,
    title: 'Fix flaky retry logic',
    url: 'https://github.com/acme/widgets/pull/42',
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
  };
}

test('buildPrExplanationPrompt: includes the PR title and diff', () => {
  const prompt = buildPrExplanationPrompt(pr(), 'diff --git a/x.ts b/x.ts\n+retry();', 8000);
  assert.match(prompt, /Fix flaky retry logic/);
  assert.match(prompt, /retry\(\);/);
});

test('buildPrExplanationPrompt: truncates a diff over maxDiffChars', () => {
  const prompt = buildPrExplanationPrompt(pr(), 'x'.repeat(20), 10);
  assert.match(prompt, /x{10}\[\.\.\.truncated\]/);
});

test('buildBranchCompareSummaryPrompt: includes both ref names and the diff', () => {
  const prompt = buildBranchCompareSummaryPrompt('main', 'feature/x', 'diff --git a/x.ts b/x.ts\n+thing();', 8000);
  assert.match(prompt, /main/);
  assert.match(prompt, /feature\/x/);
  assert.match(prompt, /thing\(\);/);
});

test('buildBranchCompareSummaryPrompt: truncates a diff over maxDiffChars', () => {
  const prompt = buildBranchCompareSummaryPrompt('main', 'feature/x', 'z'.repeat(20), 10);
  assert.match(prompt, /z{10}\[\.\.\.truncated\]/);
});

function changelogCommit(message: string): Commit {
  return {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    author: 'raj',
    authorEmail: 'raj@example.com',
    date: '2024-02-01T10:00:00Z',
    message,
  };
}

test('buildChangelogPrompt: includes both refs, commit subjects, and the diff', () => {
  const prompt = buildChangelogPrompt(
    'v1.0.0',
    'main',
    [changelogCommit('Fix retry bug'), changelogCommit('Add caching')],
    'diff --git a/x.ts b/x.ts\n+thing();',
    8000,
  );
  assert.match(prompt, /v1\.0\.0/);
  assert.match(prompt, /main/);
  assert.match(prompt, /Fix retry bug/);
  assert.match(prompt, /Add caching/);
  assert.match(prompt, /thing\(\);/);
});

test('buildChangelogPrompt: truncates a diff over maxDiffChars', () => {
  const prompt = buildChangelogPrompt('v1.0.0', 'main', [], 'w'.repeat(20), 10);
  assert.match(prompt, /w{10}\[\.\.\.truncated\]/);
});

test('buildPrReviewDraftPrompt: includes the PR title, diff, and existing conversation context', () => {
  const threads: ConversationThread[] = [{ id: 't1', body: 'Is this thread-safe?', authorLogin: 'amy', resolved: false, comments: [] }];
  const prompt = buildPrReviewDraftPrompt(pr(), 'diff --git a/x.ts b/x.ts\n+thing();', threads, 8000);
  assert.match(prompt, /Fix flaky retry logic/);
  assert.match(prompt, /thing\(\);/);
  assert.match(prompt, /Is this thread-safe\?/);
});

test('buildPrReviewDraftPrompt: truncates a diff over maxDiffChars', () => {
  const prompt = buildPrReviewDraftPrompt(pr(), 'v'.repeat(20), [], 10);
  assert.match(prompt, /v{10}\[\.\.\.truncated\]/);
});
