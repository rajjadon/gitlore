/**
 * F2.3 – unit tests for CommitPullRequestResolver.
 * Covers: cache hit, cache miss, negative cached, error-not-cached,
 * concurrent calls sharing one request, and unsigned (null token) outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommitPullRequestResolver } from '../../../../src/core/forge/CommitPullRequestResolver';
import type { CommitClientFactory, PullRequestStub } from '../../../../src/core/forge/CommitPullRequestResolver';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';
import type { DetectedForgeHost } from '../../../../src/core/forge/hostDetection';
import type { ForgeClient } from '../../../../src/core/forge/ForgeClient';

const REPO: ForgeRepoRef = { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' };
const SHA = 'abc1234abc1234abc1234abc1234abc1234abc1234';
const DETECTED: DetectedForgeHost = { flavor: 'github', apiBaseUrl: 'https://api.github.com', displayHost: 'github.com' };
const PR_STUB: PullRequestStub = { number: 7, title: 'My PR', url: 'https://github.com/acme/widgets/pull/7' };

/** Minimal fake client that resolves findPullRequestForCommit with `result`. */
function fakeClient(result: PullRequestStub | null, callCount: { n: number }): ForgeClient {
  return {
    async findPullRequestForCommit() {
      callCount.n++;
      return result;
    },
  } as unknown as ForgeClient;
}

/** Factory that counts how many clients were constructed. */
function countingFactory(result: PullRequestStub | null, constructCount: { n: number }, callCount: { n: number }): CommitClientFactory {
  return (_detected, _identity, _token) => {
    constructCount.n++;
    return fakeClient(result, callCount);
  };
}

/** Factory that throws on the first call, then returns `result` on subsequent ones. */
function failThenSucceedFactory(result: PullRequestStub | null): CommitClientFactory {
  let calls = 0;
  return (_detected, _identity, _token) => ({
    async findPullRequestForCommit() {
      calls++;
      if (calls === 1) throw new Error('transient error');
      return result;
    },
  } as unknown as ForgeClient);
}

// ─── cache hit ───────────────────────────────────────────────────────────────

test('CommitPullRequestResolver: cache hit — second resolve for same key does not call the host again', async () => {
  const callCount = { n: 0 };
  const constructCount = { n: 0 };
  const resolver = new CommitPullRequestResolver(countingFactory(PR_STUB, constructCount, callCount));

  const r1 = await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  const r2 = await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  assert.deepEqual(r1, PR_STUB);
  assert.deepEqual(r2, PR_STUB);
  assert.equal(callCount.n, 1, 'host called once, second is cache hit');
});

// ─── cache miss ──────────────────────────────────────────────────────────────

test('CommitPullRequestResolver: cache miss — different sha triggers a second host call', async () => {
  const callCount = { n: 0 };
  const resolver = new CommitPullRequestResolver(countingFactory(PR_STUB, { n: 0 }, callCount));

  await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  await resolver.resolve(REPO, SHA + 'X', DETECTED, 'tok');
  assert.equal(callCount.n, 2, 'two different shas = two calls');
});

// ─── negative cached ─────────────────────────────────────────────────────────

test('CommitPullRequestResolver: negative result (null) is cached — host not called again', async () => {
  const callCount = { n: 0 };
  const resolver = new CommitPullRequestResolver(countingFactory(null, { n: 0 }, callCount));

  const r1 = await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  const r2 = await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  assert.equal(r1, null);
  assert.equal(r2, null);
  assert.equal(callCount.n, 1, 'negative result cached, host called only once');
});

// ─── error not cached ────────────────────────────────────────────────────────

test('CommitPullRequestResolver: transient error is NOT cached — next call retries the host', async () => {
  const resolver = new CommitPullRequestResolver(failThenSucceedFactory(PR_STUB));

  await assert.rejects(() => resolver.resolve(REPO, SHA, DETECTED, 'tok'), /transient error/);
  // Second call should succeed (error not cached)
  const r2 = await resolver.resolve(REPO, SHA, DETECTED, 'tok');
  assert.deepEqual(r2, PR_STUB);
});

// ─── concurrent calls share one request ──────────────────────────────────────

test('CommitPullRequestResolver: concurrent calls for the same key share a single in-flight request', async () => {
  let callCount = 0;
  const resolver = new CommitPullRequestResolver((_detected, _identity, _token) => ({
    async findPullRequestForCommit() {
      callCount++;
      // Simulate async delay
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return PR_STUB;
    },
  } as unknown as ForgeClient));

  // Fire three concurrent calls before any resolves
  const [r1, r2, r3] = await Promise.all([
    resolver.resolve(REPO, SHA, DETECTED, 'tok'),
    resolver.resolve(REPO, SHA, DETECTED, 'tok'),
    resolver.resolve(REPO, SHA, DETECTED, 'tok'),
  ]);
  assert.deepEqual(r1, PR_STUB);
  assert.deepEqual(r2, PR_STUB);
  assert.deepEqual(r3, PR_STUB);
  assert.equal(callCount, 1, 'only one actual host call despite three concurrent invocations');
});

// ─── unsigned (null token) ───────────────────────────────────────────────────

test('CommitPullRequestResolver: null token returns null immediately without calling the host', async () => {
  const callCount = { n: 0 };
  const resolver = new CommitPullRequestResolver(countingFactory(PR_STUB, { n: 0 }, callCount));

  // Privacy contract: zero network calls when unsigned.
  const result = await resolver.resolve(REPO, SHA, DETECTED, null);
  assert.equal(result, null);
  assert.equal(callCount.n, 0, 'no host call with null token');
});

test('CommitPullRequestResolver: empty-string token also results in null with no host call', async () => {
  const callCount = { n: 0 };
  const resolver = new CommitPullRequestResolver(countingFactory(PR_STUB, { n: 0 }, callCount));

  const result = await resolver.resolve(REPO, SHA, DETECTED, '');
  assert.equal(result, null);
  assert.equal(callCount.n, 0, 'empty-string token treated same as null');
});
