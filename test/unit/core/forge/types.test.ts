import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestKey } from '../../../../src/core/forge/types';
import type { PullRequestSummary } from '../../../../src/core/forge/types';

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' },
    number: 1,
    title: 'a change',
    url: 'https://github.com/acme/widgets/pull/1',
    authorLogin: 'raj',
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    requestedReviewers: [],
    checkStatus: 'passing',
    reviewDecision: 'approved',
    hasConflicts: false,
    reviewedByMe: false,
    headSha: '',
    ...overrides,
  };
}

test('pullRequestKey: combines host, repo identity, and PR number', () => {
  assert.equal(pullRequestKey(pr()), 'github:acme/widgets#1');
});

test('pullRequestKey: the same PR number in a different repo is a different key', () => {
  const a = pullRequestKey(pr({ repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' } }));
  const b = pullRequestKey(pr({ repo: { host: 'github', identity: 'acme/other', label: 'acme/other' } }));
  assert.notEqual(a, b);
});

test('pullRequestKey: the same PR number and repo identity on a different host is a different key', () => {
  const a = pullRequestKey(pr({ repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' } }));
  const b = pullRequestKey(pr({ repo: { host: 'gitlab', identity: 'acme/widgets', label: 'acme/widgets' } }));
  assert.notEqual(a, b);
});
