import type { ForgeClient } from './ForgeClient';
import type { PullRequestDiff, PullRequestSummary } from './types';
import { pullRequestKey } from './types';
import { LruCache } from '../cache/LruCache';

/**
 * Stable cache key for one PR's diff content.
 *
 * When `headSha` is populated we key on it: a force-push changes the SHA, producing a miss and
 * triggering a fresh fetch. When `headSha` is `''` (the documented gap for hosts or endpoints that
 * don't expose the head commit SHA), we fall back to `updatedAt` instead of using a fixed empty
 * string — without this, all pushes to a `headSha`-less PR would collapse into one stale entry for
 * the entire session, since the `''` key never changes regardless of how many times the PR updates.
 */
export function diffCacheKey(pr: PullRequestSummary): string {
  const changeSuffix = pr.headSha !== '' ? pr.headSha : `@updated:${pr.updatedAt}`;
  return `${pullRequestKey(pr)}:${changeSuffix}`;
}

/**
 * Shared diff cache for `PullRequestDetailsViewProvider`. Each PR's changed-files + unified diff
 * is fetched at most once per head SHA (or per `updatedAt` when the host doesn't expose a SHA)
 * across all callers (`load`, `explainPr`, `draftReview`).
 *
 * Guarantees:
 * (a) Concurrent calls for the same key share ONE in-flight promise — no duplicate network call
 *     while the first is still pending.
 * (b) A rejected fetch is NOT cached — the inflight entry is always cleared in `finally` but the
 *     cache entry is only written on success, so the next call retries.
 * (c) A different headSha for the same PR number is a separate entry — a force-push refetches.
 * (d) When headSha is '' the key includes `updatedAt` so different pushes aren't collapsed into
 *     one stale entry (see `diffCacheKey` for the full explanation).
 */
export class PullRequestDiffCache {
  private readonly cache = new LruCache<string, PullRequestDiff>(20);
  /** In-flight promises keyed by cache key — deduplicates concurrent callers. */
  private readonly inflight = new Map<string, Promise<PullRequestDiff>>();

  async getOrFetch(
    pr: PullRequestSummary,
    client: Pick<ForgeClient, 'getPullRequestDiff'>,
  ): Promise<PullRequestDiff> {
    const key = diffCacheKey(pr);

    // Cache hit — return the stored result immediately.
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    // In-flight deduplication — concurrent callers for the same key await the same promise.
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    // No cache, no in-flight — start a new fetch. Store the promise BEFORE awaiting so a
    // concurrent caller that arrives while the fetch is in-progress finds it in `inflight`.
    const promise = (async () => {
      try {
        const result = await client.getPullRequestDiff(pr.repo, pr.number);
        // Only cache on success — a rejection must not be persisted.
        this.cache.set(key, result);
        return result;
      } finally {
        // Always clean up the inflight entry, whether the fetch succeeded or rejected.
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }
}
