import { describeErrorBody } from './httpError';

export type ForgeErrorKind = 'unauthorized' | 'forbidden' | 'rateLimited' | 'timeout' | 'network' | 'http';

export class ForgeHttpError extends Error {
  constructor(
    message: string,
    readonly kind: ForgeErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ForgeHttpError';
  }
}

/**
 * Only a 401 proves the stored credential itself is bad. 403 (scope/rate limit), 404, 429, 5xx,
 * timeouts and network failures all say nothing about the token — clearing it on those turned a
 * transient blip into a forced re-prompt.
 */
export function isCredentialRejection(err: unknown): boolean {
  return err instanceof ForgeHttpError && err.kind === 'unauthorized';
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

/** The soft ceiling on how many pages any paginated call will follow — ~1000 items. */
export const MAX_PAGES = 10; // ponytail: 10-page ceiling; raise only if a real repo needs it

export interface ForgeFetchOptions {
  fetchImpl: typeof fetch;
  /** Default: 30 000 ms */
  timeoutMs?: number;
  /** Default: 2 */
  maxRetries?: number;
  /** Injectable clock boundary for tests — defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort: a malformed `apiBaseUrl` must not mask the real error with a `TypeError`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Parses a `Retry-After` header value. Returns milliseconds to wait, or `undefined` for garbage input. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) {
    return true;
  }
  // GitHub sends a 403 with `x-ratelimit-remaining: 0` for secondary rate limits — treat it
  // identically to a 429 so we back off instead of clearing the credential (N1 context: the
  // original code swallowed these as a generic HTTP error, which the caller then treated as a
  // credential rejection).
  return res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
}

/**
 * One shared HTTP transport for all four `ForgeClient`s. Adds:
 * - Timeout via `AbortSignal.timeout`
 * - Bounded retry on transient GET failures (503, 504, 502, 429)
 * - `Retry-After` awareness (seconds *or* HTTP-date)
 * - **Never retries non-GET methods** — a retried merge/approve/comment would duplicate the write
 * - Typed `ForgeHttpError` instead of a plain `Error`
 */
export async function forgeFetch(url: string, init: RequestInit, opts: ForgeFetchOptions): Promise<Response> {
  const { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, sleep = defaultSleep } = opts;
  // Only GETs are idempotent enough to retry — a retried PATCH/POST/PUT/DELETE would duplicate writes.
  const idempotent = (init.method ?? 'GET').toUpperCase() === 'GET';
  const host = hostOf(url);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const isAbort = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (isAbort) {
        throw new ForgeHttpError(`timed out reaching ${host} after ${timeoutMs / 1000}s`, 'timeout');
      }
      if (idempotent && attempt < maxRetries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new ForgeHttpError(`couldn't reach ${host}: ${reason}`, 'network');
    }

    if (res.ok) {
      return res;
    }

    const rateLimited = isRateLimited(res);
    const transient = res.status === 502 || res.status === 503 || res.status === 504;
    const retryable = idempotent && attempt < maxRetries && (rateLimited || transient);

    if (retryable) {
      const wait = rateLimited ? (parseRetryAfterMs(res.headers.get('retry-after')) ?? 1000 * (attempt + 1)) : 500 * (attempt + 1);
      if (wait <= MAX_RETRY_WAIT_MS) {
        await sleep(wait);
        continue;
      }
    }

    const detail = describeErrorBody(await res.text());
    const kind: ForgeErrorKind = rateLimited
      ? 'rateLimited'
      : res.status === 401
        ? 'unauthorized'
        : res.status === 403
          ? 'forbidden'
          : 'http';
    throw new ForgeHttpError(
      `${res.status} ${res.statusText} from ${host}${detail ? `: ${detail}` : ''}`,
      kind,
      res.status,
    );
  }
}

/**
 * Like `Promise.all(items.map(fn))` but with at most `limit` items running concurrently. Results
 * preserve input order. A single rejection rejects the whole call (same contract as `Promise.all`).
 *
 * Uses a shared iterator so each worker pulls the next unclaimed item — no index-math or casting.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const iterator = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of iterator) {
      results[index] = await fn(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Parses a `Link` header (RFC 8288) and returns the URL for `rel="next"`, or `undefined` if
 * absent. Every host that paginates via Link headers uses this exact format.
 */
export function nextLinkFromHeader(link: string | null): string | undefined {
  if (!link) {
    return undefined;
  }
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * Follows paginated `next` links up to `maxPages` pages, collecting all items. Stops as soon as
 * `getPage` returns no `next` link — guaranteed to terminate even if a buggy host always returns
 * a `next` URL (the page cap is the safety valve).
 */
export async function fetchAllPages<T>(
  firstUrl: string,
  getPage: (url: string) => Promise<{ items: T[]; next?: string }>,
  maxPages: number = MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url !== undefined && page < maxPages; page++) {
    const { items, next } = await getPage(url);
    all.push(...items);
    url = next;
  }
  return all;
}

/**
 * Case-insensitive login comparison — GitHub logins are case-insensitive by the host's own spec,
 * and it's safe to normalize all hosts the same way. Returns `false` if either value is absent or
 * empty, so an unauthenticated call can never accidentally match.
 */
export function sameLogin(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
