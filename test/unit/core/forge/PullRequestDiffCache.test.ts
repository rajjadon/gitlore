import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PullRequestDiffCache, diffCacheKey } from '../../../../src/core/forge/PullRequestDiffCache';
import type { PullRequestSummary, PullRequestDiff } from '../../../../src/core/forge/types';

function basePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    repo: { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' },
    number: 1,
    title: '',
    url: '',
    authorLogin: '',
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    requestedReviewers: [],
    checkStatus: 'none',
    reviewDecision: 'none',
    hasConflicts: false,
    reviewedByMe: false,
    headSha: 'abc123',
    ...overrides,
  };
}

/** A counting fake client. `callCount` is readable as a property. */
function fakeClient(opts: { result?: PullRequestDiff; throws?: Error; delayMs?: number } = {}): {
  getPullRequestDiff(repo: unknown, number: unknown): Promise<PullRequestDiff>;
  callCount: number;
} {
  let count = 0;
  return {
    get callCount() { return count; },
    async getPullRequestDiff() {
      count++;
      if (opts.delayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.throws) { throw opts.throws; }
      return opts.result ?? { files: [], diff: '' };
    },
  };
}

// ─── diffCacheKey ────────────────────────────────────────────────────────────

test('diffCacheKey: when headSha is set, different SHAs produce different keys', () => {
  const before = diffCacheKey(basePr({ headSha: 'sha1' }));
  const after  = diffCacheKey(basePr({ headSha: 'sha2' }));
  assert.notEqual(before, after);
});

test('diffCacheKey: same PR + same headSha → same key (stable cache hit)', () => {
  assert.equal(diffCacheKey(basePr({ headSha: 'abc' })), diffCacheKey(basePr({ headSha: 'abc' })));
});

test('diffCacheKey: empty headSha falls back to updatedAt, not a fixed empty string', () => {
  const key1 = diffCacheKey(basePr({ headSha: '', updatedAt: '2024-01-01T00:00:00Z' }));
  const key2 = diffCacheKey(basePr({ headSha: '', updatedAt: '2024-01-02T00:00:00Z' }));
  assert.notEqual(key1, key2, 'different updatedAt must produce different keys when headSha is empty');
});

test('diffCacheKey: empty headSha same updatedAt → same key (stable cache hit without SHA)', () => {
  const k1 = diffCacheKey(basePr({ headSha: '', updatedAt: '2024-01-01T00:00:00Z' }));
  const k2 = diffCacheKey(basePr({ headSha: '', updatedAt: '2024-01-01T00:00:00Z' }));
  assert.equal(k1, k2);
});

// ─── PullRequestDiffCache — happy path ───────────────────────────────────────

test('PullRequestDiffCache: first call fetches and returns the diff', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient({ result: { files: [], diff: 'patch' } });
  const result = await cache.getOrFetch(basePr(), client);
  assert.equal(result.diff, 'patch');
  assert.equal(client.callCount, 1);
});

test('PullRequestDiffCache: second call for the same key is served from cache (zero extra fetches)', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient({ result: { files: [], diff: 'patch' } });
  await cache.getOrFetch(basePr(), client);
  await cache.getOrFetch(basePr(), client);
  assert.equal(client.callCount, 1);
});

test('PullRequestDiffCache: load + explainPr + draftReview for the same headSha = exactly 1 getPullRequestDiff call', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient({ result: { files: [], diff: 'full diff' } });
  const pr = basePr({ headSha: 'abc123' });

  // Simulate load(), explainPr(), draftReview() each calling getOrFetch:
  const r1 = await cache.getOrFetch(pr, client);
  const r2 = await cache.getOrFetch(pr, client);
  const r3 = await cache.getOrFetch(pr, client);

  assert.equal(client.callCount, 1, 'exactly one network fetch for three callers with the same headSha');
  assert.equal(r1.diff, 'full diff');
  assert.equal(r2.diff, 'full diff');
  assert.equal(r3.diff, 'full diff');
});

// ─── B1.3 (a) Concurrent in-flight deduplication ────────────────────────────

test('PullRequestDiffCache (a): concurrent calls for the same key share one in-flight promise, not two fetches', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient({ result: { files: [], diff: 'concurrent' }, delayMs: 20 });
  const pr = basePr({ headSha: 'sha-concurrent' });

  // Both calls are launched before either resolves — they must share the single promise.
  const [r1, r2] = await Promise.all([
    cache.getOrFetch(pr, client),
    cache.getOrFetch(pr, client),
  ]);

  assert.equal(client.callCount, 1, 'only one fetch despite two concurrent callers');
  assert.equal(r1, r2, 'both callers receive the same result object');
});

// ─── B1.3 (b) Rejected fetch not cached ─────────────────────────────────────

test('PullRequestDiffCache (b): a rejected fetch is not cached — the next call retries the network', async () => {
  const cache = new PullRequestDiffCache();
  let attempt = 0;
  const client = {
    async getPullRequestDiff(): Promise<PullRequestDiff> {
      attempt++;
      if (attempt === 1) { throw new Error('transient network error'); }
      return { files: [], diff: 'retry success' };
    },
  };

  await assert.rejects(() => cache.getOrFetch(basePr({ headSha: 'sha-transient' }), client), /transient network error/);
  const result = await cache.getOrFetch(basePr({ headSha: 'sha-transient' }), client);

  assert.equal(attempt, 2, 'two total attempts: one failed, one successful retry');
  assert.equal(result.diff, 'retry success');
});

test('PullRequestDiffCache (b): concurrent calls that all fail do not poison subsequent callers with a stale reject', async () => {
  const cache = new PullRequestDiffCache();
  let attempt = 0;
  const client = {
    async getPullRequestDiff(): Promise<PullRequestDiff> {
      attempt++;
      // Only the first real fetch (attempt === 1) fails. Two concurrent callers share that one
      // in-flight, so attempt only reaches 1 from the pair. The subsequent single retry sees
      // attempt === 2, which succeeds.
      if (attempt === 1) { throw new Error('fail'); }
      return { files: [], diff: 'ok' };
    },
  };
  const pr = basePr({ headSha: 'sha-fail' });

  // Two concurrent calls both fail (they share the same in-flight, so getPullRequestDiff is called once)
  await assert.rejects(Promise.all([cache.getOrFetch(pr, client), cache.getOrFetch(pr, client)]));

  // After the failure the inflight entry is cleared — the next call retries and succeeds
  const result = await cache.getOrFetch(pr, client);
  assert.equal(attempt, 2, 'exactly one failed fetch + one successful retry');
  assert.equal(result.diff, 'ok');
});

// ─── B1.3 (c) Different headSha → different entry ───────────────────────────

test('PullRequestDiffCache (c): a force-push (different headSha, same PR number) is a cache miss', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient();
  await cache.getOrFetch(basePr({ headSha: 'before-push' }), client);
  await cache.getOrFetch(basePr({ headSha: 'after-push' }), client);
  assert.equal(client.callCount, 2, 'each distinct headSha fetches independently');
});

// ─── B1.3 (d) Empty headSha keys on updatedAt ────────────────────────────────

test('PullRequestDiffCache (d): when headSha is \'\', different updatedAt values produce separate entries', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient();
  await cache.getOrFetch(basePr({ headSha: '', updatedAt: '2024-01-01T00:00:00Z' }), client);
  await cache.getOrFetch(basePr({ headSha: '', updatedAt: '2024-01-02T00:00:00Z' }), client);
  assert.equal(client.callCount, 2, 'two different updatedAt timestamps → two fetches, no stale collapse');
});

test('PullRequestDiffCache (d): when headSha is \'\', same updatedAt is served from cache', async () => {
  const cache = new PullRequestDiffCache();
  const client = fakeClient();
  const pr = basePr({ headSha: '', updatedAt: '2024-01-01T00:00:00Z' });
  await cache.getOrFetch(pr, client);
  await cache.getOrFetch(pr, client);
  assert.equal(client.callCount, 1);
});
