import { LruCache } from '../cache/LruCache';
import type { ForgeClient } from './ForgeClient';
import type { DetectedForgeHost } from './hostDetection';
import type { ForgeRepoRef } from './types';

export type PullRequestStub = { number: number; title: string; url: string };

/**
 * Factory that builds a `ForgeClient` for a specific host and credential. Injectable so the
 * resolver is unit-testable without a real network — swap in a fake client factory in tests.
 */
export type CommitClientFactory = (detected: DetectedForgeHost, identity: string, token: string) => ForgeClient;

/**
 * Private sentinel distinguishing "we fetched and found nothing" (cached null) from "we haven't
 * fetched yet" (cache miss, undefined). Storing `null` directly in the LruCache would be
 * indistinguishable from a cache miss since LruCache returns `undefined` on miss.
 */
const NOT_FOUND: unique symbol = Symbol('NOT_FOUND');
type CacheEntry = PullRequestStub | typeof NOT_FOUND;

/**
 * Per-(repo, sha) cache for `findPullRequestForCommit` results. Caches both positive results and
 * definitive "not found" (null) outcomes — errors are never cached so a transient failure can be
 * retried on the next click. Concurrent calls for the same key share a single in-flight request.
 *
 * Lives in `src/core/forge/` — pure, no vscode import; the VS Code command handler in
 * `commands/pullRequestCommands.ts` owns the interaction layer.
 */
export class CommitPullRequestResolver {
  private readonly cache = new LruCache<string, CacheEntry>(200);
  /** Deduplicates concurrent calls for the same key so only one request hits the host. */
  private readonly inflight = new Map<string, Promise<PullRequestStub | null>>();

  constructor(private readonly buildClient: CommitClientFactory) {}

  /**
   * Resolves the PR (if any) associated with the given commit SHA. Returns `null` both when the
   * host confirms no PR and when the `token` is null/empty (unsigned — no client call is made, and
   * the caller is responsible for showing the "sign in" message).
   *
   * Callers must check `token !== null` before calling if they need to distinguish "unsigned" from
   * "no PR" — this method does not throw on a null token; it returns null to avoid making a
   * network call at all (privacy contract: zero calls while unsigned).
   */
  async resolve(
    repo: ForgeRepoRef,
    sha: string,
    detected: DetectedForgeHost,
    token: string | null,
  ): Promise<PullRequestStub | null> {
    if (!token) {
      // Privacy: never call out to a host without a credential. The caller shows the sign-in
      // message; we return null so it can be distinguished from a cached "not found".
      return null;
    }
    const key = `${repo.host}:${repo.identity}:${sha}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached === NOT_FOUND ? null : cached;
    }
    // Deduplicate concurrent calls for the same key
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }
    const promise = (async (): Promise<PullRequestStub | null> => {
      try {
        const client = this.buildClient(detected, repo.identity, token);
        const result = await client.findPullRequestForCommit(repo, sha);
        // Cache both positive and negative results; errors fall through without caching so the
        // next click can retry (a rate-limit or transient 5xx shouldn't permanently suppress the button).
        this.cache.set(key, result ?? NOT_FOUND);
        return result;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}
