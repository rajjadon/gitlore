import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ForgeHttpError,
  isCredentialRejection,
  parseRetryAfterMs,
  forgeFetch,
  mapWithConcurrency,
  nextLinkFromHeader,
  fetchAllPages,
  sameLogin,
  MAX_PAGES,
  type ForgeFetchOptions,
} from '../../../../src/core/forge/forgeFetch';

// ── helpers ────────────────────────────────────────────────────────────────

function makeResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  const init: ResponseInit = { status, statusText: statusTextFor(status), headers };
  return new Response(body, init);
}

function statusTextFor(status: number): string {
  const map: Record<number, string> = {
    200: 'OK',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  };
  return map[status] ?? String(status);
}

/** Returns a recording sleep function and a getter for recorded delays. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: () => number[] } {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays: () => [...delays] };
}

const BASE_OPTS: ForgeFetchOptions = {
  fetchImpl: (() => Promise.resolve(makeResponse(200))) as typeof fetch,
};

// ── isCredentialRejection ──────────────────────────────────────────────────

test('isCredentialRejection: true only for kind=unauthorized (401)', () => {
  const err = new ForgeHttpError('401 from api.github.com', 'unauthorized', 401);
  assert.equal(isCredentialRejection(err), true);
});

test('isCredentialRejection: false for 403 forbidden', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('403', 'forbidden', 403)), false);
});

test('isCredentialRejection: false for 404', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('404', 'http', 404)), false);
});

test('isCredentialRejection: false for 429 rateLimited', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('429', 'rateLimited', 429)), false);
});

test('isCredentialRejection: false for 500 http', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('500', 'http', 500)), false);
});

test('isCredentialRejection: false for timeout', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('timeout', 'timeout')), false);
});

test('isCredentialRejection: false for network', () => {
  assert.equal(isCredentialRejection(new ForgeHttpError('network', 'network')), false);
});

test('isCredentialRejection: false for plain Error', () => {
  assert.equal(isCredentialRejection(new Error('plain')), false);
});

test('isCredentialRejection: false for non-error', () => {
  assert.equal(isCredentialRejection('string'), false);
});

// ── forgeFetch: 401 → throws unauthorized ─────────────────────────────────

test('forgeFetch: 401 throws ForgeHttpError kind=unauthorized', async () => {
  const opts: ForgeFetchOptions = { fetchImpl: (() => Promise.resolve(makeResponse(401))) as typeof fetch };
  await assert.rejects(
    () => forgeFetch('https://api.example.com/test', {}, opts),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.equal(err.kind, 'unauthorized');
      assert.equal(err.status, 401);
      assert.equal(isCredentialRejection(err), true);
      return true;
    },
  );
});

// ── forgeFetch: 429 with Retry-After: retries ──────────────────────────────

test('forgeFetch: 429 GET with Retry-After: 2 retries after 2000 ms', async () => {
  const { sleep, delays } = recordingSleep();
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    // Must not be retried for non-GETs, so confirm method
    void init;
    calls++;
    if (calls === 1) {
      return makeResponse(429, '', { 'retry-after': '2' });
    }
    return makeResponse(200);
  }) as typeof fetch;
  const opts: ForgeFetchOptions = { fetchImpl, sleep };
  await forgeFetch('https://api.example.com/test', { method: 'GET' }, opts);
  assert.equal(calls, 2);
  assert.deepEqual(delays(), [2000]);
});

// ── parseRetryAfterMs ─────────────────────────────────────────────────────

test('parseRetryAfterMs: seconds string → ms', () => {
  assert.equal(parseRetryAfterMs('5'), 5000);
});

test('parseRetryAfterMs: "0" → 0', () => {
  assert.equal(parseRetryAfterMs('0'), 0);
});

test('parseRetryAfterMs: HTTP-date → positive delta', () => {
  const now = Date.now();
  const futureMs = now + 3000;
  const futureDate = new Date(futureMs).toUTCString();
  const result = parseRetryAfterMs(futureDate, now);
  assert.ok(result !== undefined && result > 0 && result <= 3100);
});

test('parseRetryAfterMs: garbage → undefined', () => {
  assert.equal(parseRetryAfterMs('not-a-date'), undefined);
});

test('parseRetryAfterMs: null → undefined', () => {
  assert.equal(parseRetryAfterMs(null), undefined);
});

// ── forgeFetch: 403 + x-ratelimit-remaining=0 → rateLimited ───────────────

test('forgeFetch: 403 + x-ratelimit-remaining=0 → rateLimited, retries if wait ≤ 10s', async () => {
  const { sleep, delays } = recordingSleep();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      return makeResponse(403, '', { 'x-ratelimit-remaining': '0', 'retry-after': '1' });
    }
    return makeResponse(200);
  }) as typeof fetch;
  const opts: ForgeFetchOptions = { fetchImpl, sleep };
  await forgeFetch('https://api.example.com/test', { method: 'GET' }, opts);
  assert.equal(calls, 2);
  assert.deepEqual(delays(), [1000]);
});

test('forgeFetch: 403 + x-ratelimit-remaining=0 + Retry-After > 10s → throws rateLimited immediately', async () => {
  const { sleep } = recordingSleep();
  const fetchImpl = (async () => makeResponse(403, '', { 'x-ratelimit-remaining': '0', 'retry-after': '30' })) as typeof fetch;
  const opts: ForgeFetchOptions = { fetchImpl, sleep };
  await assert.rejects(
    () => forgeFetch('https://api.example.com/test', { method: 'GET' }, opts),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.equal(err.kind, 'rateLimited');
      return true;
    },
  );
});

// ── forgeFetch: POST/PATCH/PUT/DELETE are never retried ───────────────────

test('forgeFetch: POST on 429 is NOT retried — fetch called exactly once', async () => {
  const { sleep } = recordingSleep();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return makeResponse(429);
  }) as typeof fetch;
  const opts: ForgeFetchOptions = { fetchImpl, sleep };
  await assert.rejects(() => forgeFetch('https://api.example.com/test', { method: 'POST' }, opts));
  assert.equal(calls, 1);
});

test('forgeFetch: PATCH on 503 is NOT retried — fetch called exactly once', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return makeResponse(503);
  }) as typeof fetch;
  await assert.rejects(() => forgeFetch('https://api.example.com/test', { method: 'PATCH' }, { fetchImpl }));
  assert.equal(calls, 1);
});

test('forgeFetch: PUT on 503 is NOT retried', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return makeResponse(503);
  }) as typeof fetch;
  await assert.rejects(() => forgeFetch('https://api.example.com/test', { method: 'PUT' }, { fetchImpl }));
  assert.equal(calls, 1);
});

test('forgeFetch: DELETE on 503 is NOT retried', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return makeResponse(503);
  }) as typeof fetch;
  await assert.rejects(() => forgeFetch('https://api.example.com/test', { method: 'DELETE' }, { fetchImpl }));
  assert.equal(calls, 1);
});

// ── forgeFetch: 503 GET retries up to maxRetries ──────────────────────────

test('forgeFetch: 503 GET retries up to maxRetries then throws kind=http with host in message', async () => {
  const { sleep } = recordingSleep();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return makeResponse(503);
  }) as typeof fetch;
  const opts: ForgeFetchOptions = { fetchImpl, sleep, maxRetries: 2 };
  await assert.rejects(
    () => forgeFetch('https://api.example.com/test', { method: 'GET' }, opts),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 503);
      assert.ok(err.message.includes('api.example.com'));
      assert.ok(err.message.includes('503'));
      return true;
    },
  );
  assert.equal(calls, 3); // initial + 2 retries
});

// ── forgeFetch: error message format ──────────────────────────────────────

test('forgeFetch: non-2xx produces "<status> <statusText> from <host>: <detail>"', async () => {
  const fetchImpl = (async () => makeResponse(404, JSON.stringify({ message: 'Not Found' }))) as typeof fetch;
  await assert.rejects(
    () => forgeFetch('https://api.example.com/x', {}, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.ok(err.message.startsWith('404 Not Found from api.example.com'));
      assert.ok(err.message.includes('Not Found'));
      return true;
    },
  );
});

test('forgeFetch: network failure produces "couldn\'t reach <host>: <reason>"', async () => {
  const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  // No retries to keep test fast
  await assert.rejects(
    () => forgeFetch('https://api.example.com/x', { method: 'POST' }, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError);
      assert.equal(err.kind, 'network');
      assert.ok(err.message.startsWith("couldn't reach api.example.com"));
      assert.ok(err.message.includes('ECONNREFUSED'));
      return true;
    },
  );
});

// ── forgeFetch: malformed URL does not throw TypeError from error path ─────

test('forgeFetch: malformed URL in error path does not throw TypeError — message still produced', async () => {
  // A host with a totally invalid URL shouldn't mask the real error with a URL parse failure
  const fetchImpl = (async () => makeResponse(401)) as typeof fetch;
  await assert.rejects(
    () => forgeFetch('not-a-url', {}, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof ForgeHttpError); // not a TypeError
      return true;
    },
  );
});

// ── mapWithConcurrency ────────────────────────────────────────────────────

test('mapWithConcurrency: limit=2 with 5 slow items — never more than 2 in flight', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [1, 2, 3, 4, 5] as const;
  const results = await mapWithConcurrency(items, 2, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Yield the microtask queue so concurrency actually matters
    await Promise.resolve();
    inFlight--;
    return item * 2;
  });
  assert.equal(maxInFlight, 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]); // input order preserved
});

test('mapWithConcurrency: one rejection rejects the whole call', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('fail');
      return item;
    }),
    /fail/,
  );
});

test('mapWithConcurrency: results are in input order even with unequal settling times', async () => {
  const delays = [30, 10, 20];
  const results = await mapWithConcurrency(delays, 3, async (ms, i) => {
    await new Promise<void>((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(results, [0, 1, 2]);
});

// ── nextLinkFromHeader ────────────────────────────────────────────────────

test('nextLinkFromHeader: extracts the next URL', () => {
  const link = '<https://x/p?page=2>; rel="next", <https://x/p?page=9>; rel="last"';
  assert.equal(nextLinkFromHeader(link), 'https://x/p?page=2');
});

test('nextLinkFromHeader: no next → undefined', () => {
  assert.equal(nextLinkFromHeader('<https://x/p?page=9>; rel="last"'), undefined);
});

test('nextLinkFromHeader: null → undefined', () => {
  assert.equal(nextLinkFromHeader(null), undefined);
});

test('nextLinkFromHeader: empty string → undefined', () => {
  assert.equal(nextLinkFromHeader(''), undefined);
});

// ── fetchAllPages ─────────────────────────────────────────────────────────

test('fetchAllPages: follows next links across pages', async () => {
  const pages: Record<string, { items: number[]; next?: string }> = {
    'https://api.example.com/items?page=1': { items: [1, 2], next: 'https://api.example.com/items?page=2' },
    'https://api.example.com/items?page=2': { items: [3, 4], next: undefined },
  };
  const results = await fetchAllPages('https://api.example.com/items?page=1', async (url) => {
    const page = pages[url];
    if (!page) throw new Error(`unexpected url: ${url}`);
    return page;
  });
  assert.deepEqual(results, [1, 2, 3, 4]);
});

test('fetchAllPages: stops at maxPages even when next always returned', async () => {
  let callCount = 0;
  const getPage = async (_url: string): Promise<{ items: number[]; next?: string }> => {
    callCount++;
    return { items: [callCount], next: 'https://api.example.com/next' };
  };
  const results = await fetchAllPages('https://api.example.com/items', getPage, 3);
  assert.equal(callCount, 3);
  assert.deepEqual(results, [1, 2, 3]);
});

test('fetchAllPages: MAX_PAGES constant exported', () => {
  assert.equal(typeof MAX_PAGES, 'number');
  assert.ok(MAX_PAGES > 0);
});

// ── sameLogin ─────────────────────────────────────────────────────────────

test('sameLogin: case-insensitive match', () => {
  assert.equal(sameLogin('Amy', 'amy'), true);
});

test('sameLogin: identical strings', () => {
  assert.equal(sameLogin('raj', 'raj'), true);
});

test('sameLogin: different values', () => {
  assert.equal(sameLogin('raj', 'amy'), false);
});

test('sameLogin: empty strings → false', () => {
  assert.equal(sameLogin('', ''), false);
});

test('sameLogin: undefined first arg → false', () => {
  assert.equal(sameLogin(undefined, 'a'), false);
});

test('sameLogin: undefined second arg → false', () => {
  assert.equal(sameLogin('a', undefined), false);
});

test('sameLogin: both undefined → false', () => {
  assert.equal(sameLogin(undefined, undefined), false);
});
