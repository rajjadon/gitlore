import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ForgeClient } from '../../../../src/core/forge/ForgeClient';
import type { ForgeRepoRef, PullRequestSummary } from '../../../../src/core/forge/types';
import { ForgeHttpError } from '../../../../src/core/forge/forgeFetch';
import { loadBoard, recategorize, pruneSnoozed } from '../../../../src/core/forge/loadBoard';

// Minimal PullRequestSummary builder
function makePr(overrides: Partial<PullRequestSummary> & { number: number; authorLogin: string }): PullRequestSummary {
  const base: PullRequestSummary = {
    repo: repoA,
    number: overrides.number,
    title: `PR #${overrides.number}`,
    url: `https://github.com/org/repo/pull/${overrides.number}`,
    authorLogin: overrides.authorLogin,
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    requestedReviewers: [],
    checkStatus: 'none',
    reviewDecision: 'none',
    hasConflicts: false,
    reviewedByMe: false,
  };
  return { ...base, ...overrides };
}

const repoA: ForgeRepoRef = { host: 'github', identity: 'org/repoA', label: 'org/repoA' };
const repoB: ForgeRepoRef = { host: 'github', identity: 'org/repoB', label: 'org/repoB' };

/** Fake client that resolves immediately with canned data. */
function makeClient(login: string, openPrs: PullRequestSummary[], delay = 0): ForgeClient & { loginCalls: number; openCalls: number } {
  let loginCalls = 0;
  let openCalls = 0;
  const client = {
    get loginCalls() { return loginCalls; },
    get openCalls() { return openCalls; },
    async getAuthenticatedLogin() {
      loginCalls++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return login;
    },
    async listOpenPullRequests(_repo: ForgeRepoRef) {
      openCalls++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return openPrs;
    },
    async listRecentlyClosedPullRequests() { return []; },
    // Unused in these tests — stub enough for the interface
    async getPullRequest() { throw new Error('not implemented'); },
    async closePullRequest() { /* no-op */ },
    async reopenPullRequest() { /* no-op */ },
    async mergePullRequest() { /* no-op */ },
    async createPullRequest() { throw new Error('not implemented'); },
    async getPullRequestDiff() { throw new Error('not implemented'); },
    async submitReview() { /* no-op */ },
    async addComment() { /* no-op */ },
    async listConversationThreads() { return []; },
    async resolveConversationThread() { /* no-op */ },
  } as unknown as ForgeClient & { loginCalls: number; openCalls: number };
  return client;
}

describe('loadBoard', () => {
  it('loads two repos concurrently (second starts before first resolves)', async () => {
    // Repo A has a 50 ms delay; repo B has no delay. With concurrency >= 2, B's
    // listOpenPullRequests should be invoked while A's is still in-flight.
    const starts: string[] = [];
    let aOpen = false;

    const clientA = {
      async getAuthenticatedLogin() { return 'alice'; },
      async listOpenPullRequests() {
        starts.push('A');
        await new Promise((r) => setTimeout(r, 50));
        aOpen = true;
        return [];
      },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const clientB = {
      async getAuthenticatedLogin() { return 'bob'; },
      async listOpenPullRequests() {
        starts.push('B');
        // Verify B starts before A finishes
        assert.equal(aOpen, false, 'B should start before A resolves');
        return [];
      },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [
        { repo: repoA, client: clientA, displayHost: 'github.com' },
        { repo: repoB, client: clientB, displayHost: 'github.com' },
      ],
      isSnoozed: () => false,
      onCredentialRejected: async () => { /* no-op */ },
      logError: () => { /* no-op */ },
      concurrency: 4,
    });

    assert.deepEqual(starts, ['A', 'B'], 'both repos should start concurrently');
    assert.equal(result.errors.length, 0);
  });

  it('503 error: repo 2 still on board, repo 1 in errors, no credential wipe', async () => {
    const credentialRejectedRepos: ForgeRepoRef[] = [];
    const pr = makePr({ number: 1, authorLogin: 'bob', repo: repoB });
    const clientA = {
      async getAuthenticatedLogin() { return 'alice'; },
      async listOpenPullRequests() {
        throw new ForgeHttpError('503 Service Unavailable from api.github.com', 'http', 503);
      },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;
    const clientB = makeClient('bob', [pr]);

    const result = await loadBoard({
      repos: [
        { repo: repoA, client: clientA, displayHost: 'github.com' },
        { repo: repoB, client: clientB, displayHost: 'github.com' },
      ],
      isSnoozed: () => false,
      onCredentialRejected: async (repo) => { credentialRejectedRepos.push(repo); },
      logError: () => { /* no-op */ },
    });

    // Repo A should be in errors
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.repo.identity, repoA.identity);
    // Repo B's PR should be categorized
    assert.ok(result.categorized.some((c) => c.pr.number === 1), 'repo B PR should appear');
    // No credential wipe for a 503
    assert.equal(credentialRejectedRepos.length, 0);
  });

  it('unauthorized error: onCredentialRejected called exactly once', async () => {
    const credentialRejectedRepos: ForgeRepoRef[] = [];
    const clientA = {
      async getAuthenticatedLogin() { return 'alice'; },
      async listOpenPullRequests() {
        throw new ForgeHttpError('401 Unauthorized from api.github.com', 'unauthorized', 401);
      },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [{ repo: repoA, client: clientA, displayHost: 'github.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async (repo) => { credentialRejectedRepos.push(repo); },
      logError: () => { /* no-op */ },
    });

    assert.equal(credentialRejectedRepos.length, 1);
    assert.equal(credentialRejectedRepos[0]?.identity, repoA.identity);
    assert.equal(result.errors.length, 1);
  });

  it('getAuthenticatedLogin returns null: error row, no throw', async () => {
    const client = {
      async getAuthenticatedLogin() { return null; },
      async listOpenPullRequests() { return []; },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [{ repo: repoA, client, displayHost: 'gitlab.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async () => { /* no-op */ },
      logError: () => { /* no-op */ },
    });

    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]?.message ?? '', /Couldn't authenticate with gitlab\.com\./);
    assert.equal(result.categorized.length, 0);
  });

  it('login throws 401: error uses displayHost format and onCredentialRejected is called', async () => {
    const rejected: ForgeRepoRef[] = [];
    const client = {
      async getAuthenticatedLogin() {
        throw new ForgeHttpError('401 Unauthorized from gitlab.com', 'unauthorized', 401);
      },
      async listOpenPullRequests() { return []; },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [{ repo: repoA, client, displayHost: 'gitlab.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async (repo) => { rejected.push(repo); },
      logError: () => { /* no-op */ },
    });

    assert.equal(result.errors.length, 1);
    assert.equal(
      result.errors[0]?.message,
      "Couldn't authenticate with gitlab.com: 401 Unauthorized from gitlab.com",
    );
    assert.equal(rejected.length, 1, 'onCredentialRejected must be called for a 401');
  });

  it('login throws 503: error uses displayHost format but onCredentialRejected is NOT called', async () => {
    const rejected: ForgeRepoRef[] = [];
    const client = {
      async getAuthenticatedLogin() {
        throw new ForgeHttpError('503 Service Unavailable from gitlab.com', 'http', 503);
      },
      async listOpenPullRequests() { return []; },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [{ repo: repoA, client, displayHost: 'gitlab.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async (repo) => { rejected.push(repo); },
      logError: () => { /* no-op */ },
    });

    assert.equal(result.errors.length, 1);
    assert.equal(
      result.errors[0]?.message,
      "Couldn't authenticate with gitlab.com: 503 Service Unavailable from gitlab.com",
    );
    assert.equal(rejected.length, 0, 'onCredentialRejected must NOT be called for a 503');
  });

  it('login returns null: Couldn\'t authenticate message with displayHost and onCredentialRejected called', async () => {
    const rejected: ForgeRepoRef[] = [];
    const client = {
      async getAuthenticatedLogin() { return null; },
      async listOpenPullRequests() { return []; },
      async listRecentlyClosedPullRequests() { return []; },
      async closePullRequest() { /* no-op */ },
      async reopenPullRequest() { /* no-op */ },
      async mergePullRequest() { /* no-op */ },
      async createPullRequest() { throw new Error('not implemented'); },
      async getPullRequest() { throw new Error('not implemented'); },
      async getPullRequestDiff() { throw new Error('not implemented'); },
      async submitReview() { /* no-op */ },
      async addComment() { /* no-op */ },
      async listConversationThreads() { return []; },
      async resolveConversationThread() { /* no-op */ },
    } as unknown as ForgeClient;

    const result = await loadBoard({
      repos: [{ repo: repoA, client, displayHost: 'gitlab.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async (repo) => { rejected.push(repo); },
      logError: () => { /* no-op */ },
    });

    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.message, "Couldn't authenticate with gitlab.com.");
    assert.equal(rejected.length, 1, 'onCredentialRejected must be called for a null login');
  });

  it('client is null: produces "Not signed in." error row', async () => {
    const result = await loadBoard({
      repos: [{ repo: repoA, client: null, displayHost: 'github.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async () => { /* no-op */ },
      logError: () => { /* no-op */ },
    });

    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]?.message.includes('Not signed in.'));
    assert.equal(result.categorized.length, 0);
  });
});

describe('recategorize', () => {
  it('moves PR to snoozed bucket without any client call', async () => {
    // Load once with nothing snoozed
    const pr = makePr({ number: 1, authorLogin: 'alice', repo: repoA });
    const client = makeClient('alice', [pr]);

    const result = await loadBoard({
      repos: [{ repo: repoA, client, displayHost: 'github.com' }],
      isSnoozed: () => false,
      onCredentialRejected: async () => { /* no-op */ },
      logError: () => { /* no-op */ },
    });

    const callsAfterLoad = client.openCalls;
    assert.ok(callsAfterLoad >= 1, 'should have called listOpenPullRequests');

    // Now recategorize with isSnoozed = true — no additional client calls
    const recategorized = recategorize(result.rawByRepoKey, () => true);
    assert.equal(client.openCalls, callsAfterLoad, 'recategorize must not call client');
    assert.ok(recategorized.some((c) => c.bucket === 'snoozed'), 'PR should be snoozed');
  });
});

describe('pruneSnoozed', () => {
  it('removes keys not in livePrKeys', () => {
    const result = pruneSnoozed(['a:r#1', 'a:r#2', 'a:r#3'], new Set(['a:r#2']));
    assert.deepEqual(result, ['a:r#2']);
  });

  it('keeps all when all are live', () => {
    const keys = ['a:r#1', 'a:r#2'];
    const result = pruneSnoozed(keys, new Set(keys));
    assert.deepEqual(result, keys);
  });

  it('returns empty when no keys are live', () => {
    const result = pruneSnoozed(['a:r#1', 'a:r#2'], new Set());
    assert.deepEqual(result, []);
  });

  it('handles empty input', () => {
    const result = pruneSnoozed([], new Set(['a:r#1']));
    assert.deepEqual(result, []);
  });
});
