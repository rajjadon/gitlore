import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../../../../src/core/forge/GitHubClient';
import { isCredentialRejection } from '../../../../src/core/forge/forgeFetch';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';

const REPO: ForgeRepoRef = { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' };
const BASE = 'https://api.github.com';

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 401,
    statusText: ok ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string): Response {
  return new Response(body, { status: 200, statusText: 'OK' });
}

/** Routes a fake fetch by matching against the tail of the requested URL, so each test only wires up the endpoints it actually needs. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return jsonResponse(body);
      }
    }
    throw new Error(`unmocked request: ${url}`);
  }) as typeof fetch;
}

test('getAuthenticatedLogin: returns the login from GET /user', async () => {
  const client = new GitHubClient(BASE, 'tok', fakeFetch({ '/user': { login: 'raj' } }));
  assert.equal(await client.getAuthenticatedLogin(), 'raj');
});

test('getAuthenticatedLogin: a failed request (bad/expired token) throws with the real HTTP status, not a generic message', async () => {
  const client = new GitHubClient(BASE, 'bad-tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.getAuthenticatedLogin(), /401 Unauthorized from api\.github\.com/);
});

test('listOpenPullRequests: normalizes a plain open PR with no reviews, checks, or requested reviewers', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/repos/acme/widgets/pulls?state=open&per_page=100': [
        {
          number: 1,
          title: 'Add feature',
          html_url: 'https://github.com/acme/widgets/pull/1',
          user: { login: 'raj' },
          draft: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          requested_reviewers: [],
          head: { sha: 'abc123' },
        },
      ],
      '/pulls/1/reviews?per_page=100': [],
      '/commits/abc123/check-runs?per_page=100': { check_runs: [] },
      '/pulls/1': { mergeable_state: 'unknown' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, 'Add feature');
  assert.equal(result[0]?.authorLogin, 'raj');
  assert.equal(result[0]?.checkStatus, 'none');
  assert.equal(result[0]?.reviewDecision, 'none');
  assert.equal(result[0]?.hasConflicts, false);
});

test('listOpenPullRequests: a requested reviewer who has not submitted a review -> reviewDecision "reviewRequired"', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        {
          number: 2,
          title: 'PR',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          requested_reviewers: [{ login: 'amy' }],
          head: { sha: 'sha2' },
        },
      ],
      '/reviews?per_page=100': [],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/2': { mergeable_state: 'clean' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.deepEqual(result[0]?.requestedReviewers, ['amy']);
  assert.equal(result[0]?.reviewDecision, 'reviewRequired');
});

test('listOpenPullRequests: a changes-requested review wins over a stale earlier approval from the same reviewer', () => testReviewDecision(
  [
    { user: { login: 'amy' }, state: 'APPROVED' },
    { user: { login: 'amy' }, state: 'CHANGES_REQUESTED' },
  ],
  [],
  'changesRequested',
));

test('listOpenPullRequests: an approval after an earlier changes-requested from the same reviewer resolves to approved', () => testReviewDecision(
  [
    { user: { login: 'amy' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'amy' }, state: 'APPROVED' },
  ],
  [],
  'approved',
));

test('listOpenPullRequests: changesRequested takes priority over a still-outstanding requested reviewer', () => testReviewDecision(
  [{ user: { login: 'amy' }, state: 'CHANGES_REQUESTED' }],
  ['bob'],
  'changesRequested',
));

async function testReviewDecision(
  reviews: unknown[],
  requestedReviewers: string[],
  expected: string,
): Promise<void> {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        {
          number: 3,
          title: 'PR',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          requested_reviewers: requestedReviewers.map((login) => ({ login })),
          head: { sha: 'sha3' },
        },
      ],
      '/reviews?per_page=100': reviews,
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/3': { mergeable_state: 'clean' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, expected);
}

test('listOpenPullRequests: an in-progress check run -> checkStatus "pending", even if another already failed', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 4, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha4' } },
      ],
      '/reviews?per_page=100': [],
      '/check-runs?per_page=100': {
        check_runs: [
          { status: 'completed', conclusion: 'failure' },
          { status: 'in_progress', conclusion: null },
        ],
      },
      '/pulls/4': { mergeable_state: 'clean' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.checkStatus, 'pending');
});

test('listOpenPullRequests: all check runs completed and successful -> checkStatus "passing"', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 5, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha5' } },
      ],
      '/reviews?per_page=100': [],
      '/check-runs?per_page=100': { check_runs: [{ status: 'completed', conclusion: 'success' }] },
      '/pulls/5': { mergeable_state: 'clean' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.checkStatus, 'passing');
});

test('listOpenPullRequests: mergeable_state "dirty" -> hasConflicts true', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 6, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha6' } },
      ],
      '/reviews?per_page=100': [],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/6': { mergeable_state: 'dirty' },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.hasConflicts, true);
});

test('listOpenPullRequests: mergeable_state null (still computing) is treated as no known conflict', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 7, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha7' } },
      ],
      '/reviews?per_page=100': [],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/7': { mergeable_state: null },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.hasConflicts, false);
});

test('listOpenPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => jsonResponse([], false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listOpenPullRequests(REPO), /401 Unauthorized from api\.github\.com/);
});

test('listOpenPullRequests: a 404 on an enrichment endpoint degrades that field (endpoint absent) instead of throwing', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    (async (url: string) => {
      if (url === `${BASE}/user`) {
        return jsonResponse({ login: 'raj' });
      }
      if (url.includes('/check-runs')) {
        return new Response('Not Found', { status: 404 });
      }
      if (url.endsWith('/pulls?state=open&per_page=100')) {
        return jsonResponse([
          { number: 8, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha8' } },
        ]);
      }
      if (url.endsWith('/reviews?per_page=100')) {
        return jsonResponse([]);
      }
      if (url.endsWith('/pulls/8')) {
        return jsonResponse({ mergeable_state: 'clean' });
      }
      throw new Error(`unmocked: ${url}`);
    }) as unknown as typeof fetch,
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.checkStatus, 'none');
});

// ── A2-specific tests ─────────────────────────────────────────────────────

test('A2: 401 from list endpoint throws ForgeHttpError with isCredentialRejection=true', async () => {
  const client = new GitHubClient(BASE, 'bad', (async () => new Response('{}', { status: 401 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), true);
      return true;
    },
  );
});

test('A2: 503 from list endpoint throws but isCredentialRejection=false (never clears credential on transient error)', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => new Response('{}', { status: 503 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), false);
      return true;
    },
  );
});

test('A2: caller-supplied Accept header wins over the default (raw-diff media type)', async () => {
  let diffAccept = '';
  let filesAccept = '';
  // Already correct in GitHub — this test pins the header-merge contract
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    const h = (init?.headers as Record<string, string>) ?? {};
    if (url.includes('/files')) {
      filesAccept = h['Accept'] ?? '';
      return new Response(JSON.stringify([]), { status: 200, statusText: 'OK' });
    }
    diffAccept = h['Accept'] ?? '';
    return new Response('diff text', { status: 200, statusText: 'OK' });
  }) as typeof fetch);
  // The diff endpoint passes Accept: application/vnd.github.v3.diff — it must not be overwritten
  // by the default 'application/vnd.github+json'; and the files endpoint must still use the default.
  await client.getPullRequestDiff(REPO, 1);
  assert.equal(diffAccept, 'application/vnd.github.v3.diff');
  assert.equal(filesAccept, 'application/vnd.github+json');
});

test('listOpenPullRequests: reviewedByMe is true when the authenticated user has a review on this PR, regardless of its state', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 30, title: 'PR', html_url: 'u', user: { login: 'someone-else' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha30' } },
      ],
      '/reviews?per_page=100': [{ user: { login: 'raj' }, state: 'COMMENTED' }],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/30': { mergeable_state: 'clean' },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, true);
});

test('listOpenPullRequests: a non-mine PR not reviewed by the authenticated user is excluded from results entirely', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 31, title: 'PR', html_url: 'u', user: { login: 'someone-else' }, created_at: 'c', updated_at: 'u', head: { sha: 'sha31' } },
      ],
      // Slim path: only /reviews is fetched; 'raj' is not in it
      '/reviews?per_page=100': [{ user: { login: 'amy' }, state: 'APPROVED' }],
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  // Under tiering, a non-mine unreviewed PR returns undefined and is filtered out
  assert.equal(result.length, 0, 'non-mine unreviewed PR must not appear on board');
});

test('getPullRequest: fetches one PR by number and enriches it the same way the list endpoint does', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/repos/acme/widgets/pulls/7': {
        number: 7,
        title: 'Single PR fetch',
        html_url: 'https://github.com/acme/widgets/pull/7',
        user: { login: 'raj' },
        draft: false,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        head: { sha: 'abc123' },
        requested_reviewers: [],
        mergeable_state: 'clean',
      },
      '/pulls/7/reviews?per_page=100': [],
      '/commits/abc123/check-runs?per_page=100': { check_runs: [] },
    }),
  );
  const result = await client.getPullRequest(REPO, 7);
  assert.equal(result.title, 'Single PR fetch');
  assert.equal(result.number, 7);
});

test('listRecentlyClosedPullRequests: reviewedByMe is always false — nothing reads it on a closed/merged PR', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/pulls?state=closed&sort=updated&direction=desc&per_page=100': [
        {
          number: 32,
          title: 'Shipped',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          closed_at: 'c2',
          merged_at: 'c2',
          head: { sha: 'sha32' },
        },
      ],
    }),
  );
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, false);
});

test('listRecentlyClosedPullRequests: merged_at present -> merged true, and closedAt uses closed_at', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/pulls?state=closed&sort=updated&direction=desc&per_page=100': [
        {
          number: 10,
          title: 'Shipped feature',
          html_url: 'https://github.com/acme/widgets/pull/10',
          user: { login: 'raj' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-05T00:00:00Z',
          closed_at: '2024-01-05T00:00:00Z',
          merged_at: '2024-01-05T00:00:00Z',
          head: { sha: 'sha10' },
        },
      ],
    }),
  );
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.merged, true);
  assert.equal(result[0]?.closedAt, '2024-01-05T00:00:00Z');
});

test('listRecentlyClosedPullRequests: merged_at null -> merged false (closed without merging)', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/pulls?state=closed&sort=updated&direction=desc&per_page=100': [
        {
          number: 11,
          title: 'Abandoned idea',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          closed_at: '2024-01-06T00:00:00Z',
          merged_at: null,
          head: { sha: 'sha11' },
        },
      ],
    }),
  );
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result[0]?.merged, false);
});

test('listRecentlyClosedPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => jsonResponse([], false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listRecentlyClosedPullRequests(REPO), /401 Unauthorized from api\.github\.com/);
});

test('closePullRequest: PATCHes state=closed to the PR endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.closePullRequest(REPO, 12);
  assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/pulls/12');
  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.body, JSON.stringify({ state: 'closed' }));
});

test('closePullRequest: a rejected request throws with the real HTTP status', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.closePullRequest(REPO, 13), /401 Unauthorized from api\.github\.com/);
});

test('reopenPullRequest: PATCHes state=open to the PR endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.reopenPullRequest(REPO, 12);
  assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/pulls/12');
  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.body, JSON.stringify({ state: 'open' }));
});

test('getPullRequestDiff: fetches raw diff text via the diff media type, and stats from /files', async () => {
  let capturedAccept: string | undefined;
  const client = new GitHubClient(
    BASE,
    'tok',
    (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/pulls/14/files?per_page=100')) {
        return jsonResponse([
          { filename: 'src/a.ts', additions: 3, deletions: 1, patch: '@@ -1 +1,3 @@\n+x' },
          { filename: 'image.png', additions: 0, deletions: 0 },
        ]);
      }
      if (url.endsWith('/pulls/14')) {
        capturedAccept = (init?.headers as Record<string, string>).Accept;
        return textResponse('diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,3 @@\n+x');
      }
      throw new Error(`unmocked: ${url}`);
    }) as unknown as typeof fetch,
  );
  const result = await client.getPullRequestDiff(REPO, 14);
  assert.equal(capturedAccept, 'application/vnd.github.v3.diff');
  assert.match(result.diff, /diff --git a\/src\/a\.ts/);
  assert.deepEqual(result.files, [
    { path: 'src/a.ts', insertions: 3, deletions: 1, binary: false },
    { path: 'image.png', insertions: 0, deletions: 0, binary: true },
  ]);
});

test('submitReview: POSTs event=APPROVE for an approve decision', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 15, 'approve');
  assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/pulls/15/reviews');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ event: 'APPROVE' }));
});

test('submitReview: POSTs event=REQUEST_CHANGES for a requestChanges decision', async () => {
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 16, 'requestChanges');
  assert.equal(capturedInit?.body, JSON.stringify({ event: 'REQUEST_CHANGES' }));
});

test('addComment: POSTs to the issue-comments endpoint (PRs are issues for comments on GitHub)', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.addComment(REPO, 17, 'Looks good');
  assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/issues/17/comments');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ body: 'Looks good' }));
});

test('listConversationThreads: POSTs a GraphQL query to /graphql (not REST) and normalizes the reviewThreads response', async () => {
  let capturedUrl: string | undefined;
  let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: 'PRRT_1', isResolved: false, comments: { nodes: [{ body: 'Fix this', author: { login: 'amy' } }] } },
                { id: 'PRRT_2', isResolved: true, comments: { nodes: [{ body: 'Already fine', author: { login: 'raj' } }] } },
              ],
            },
          },
        },
      },
    });
  }) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(capturedUrl, 'https://api.github.com/graphql');
  assert.match(capturedBody?.query ?? '', /reviewThreads/);
  // First page: after=null (sentinel '' is converted to null before sending)
  assert.deepEqual(capturedBody?.variables, { owner: 'acme', name: 'widgets', number: 18, after: null });
  assert.deepEqual(result, [
    { id: 'PRRT_1', body: 'Fix this', authorLogin: 'amy', resolved: false, comments: [{ authorLogin: 'amy', body: 'Fix this' }] },
    { id: 'PRRT_2', body: 'Already fine', authorLogin: 'raj', resolved: true, comments: [{ authorLogin: 'raj', body: 'Already fine' }] },
  ]);
});

test('listConversationThreads: surfaces the file/line a review comment is anchored to', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () =>
    jsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PRRT_1',
                  isResolved: false,
                  path: 'src/a.ts',
                  line: 42,
                  originalLine: 40,
                  comments: { nodes: [{ body: 'Fix this', author: { login: 'amy' } }] },
                },
                {
                  // Outdated — the thread's commit is no longer part of the PR, so `line` is null
                  // and `originalLine` (always set for a line comment) is the fallback.
                  id: 'PRRT_2',
                  isResolved: false,
                  path: 'src/b.ts',
                  line: null,
                  originalLine: 7,
                  comments: { nodes: [{ body: 'Also fix this', author: { login: 'amy' } }] },
                },
              ],
            },
          },
        },
      },
    })) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.deepEqual(result, [
    { id: 'PRRT_1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'src/a.ts', line: 42, comments: [{ authorLogin: 'amy', body: 'Fix this' }] },
    { id: 'PRRT_2', body: 'Also fix this', authorLogin: 'amy', resolved: false, file: 'src/b.ts', line: 7, comments: [{ authorLogin: 'amy', body: 'Also fix this' }] },
  ]);
});

test('resolveConversationThread: POSTs the resolveReviewThread mutation with the thread id', async () => {
  let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } });
  }) as unknown as typeof fetch);
  await client.resolveConversationThread(REPO, 18, 'PRRT_1');
  assert.match(capturedBody?.query ?? '', /resolveReviewThread/);
  assert.deepEqual(capturedBody?.variables, { threadId: 'PRRT_1' });
});

test('GraphQL calls throw the real error message when GitHub returns a 200 with an "errors" array', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () =>
    jsonResponse({ errors: [{ message: 'Could not resolve to a PullRequest' }] })) as unknown as typeof fetch);
  await assert.rejects(() => client.resolveConversationThread(REPO, 18, 'bad-id'), /Could not resolve to a PullRequest/);
});

test('GraphQL calls against a GitHub Enterprise Server apiBaseUrl use <host>/api/graphql, not <host>/api/v3/graphql', async () => {
  let capturedUrl: string | undefined;
  const client = new GitHubClient('https://ghe.example.com/api/v3', 'tok', (async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ data: { resolveReviewThread: { thread: { id: 'x', isResolved: true } } } });
  }) as unknown as typeof fetch);
  await client.resolveConversationThread(REPO, 18, 'x');
  assert.equal(capturedUrl, 'https://ghe.example.com/api/graphql');
});

test('mergePullRequest: PUTs merge_method to the merge endpoint, one call per strategy', async () => {
  for (const strategy of ['merge', 'squash', 'rebase'] as const) {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({});
    }) as unknown as typeof fetch);
    await client.mergePullRequest(REPO, 20, { strategy, deleteSourceBranch: false });
    assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/pulls/20/merge');
    assert.equal(capturedInit?.method, 'PUT');
    assert.equal(capturedInit?.body, JSON.stringify({ merge_method: strategy }));
  }
});

test('mergePullRequest: deleteSourceBranch fetches the head ref and deletes it, URL-encoding a slash in the branch name', async () => {
  const calls: string[] = [];
  const client = new GitHubClient(
    BASE,
    'tok',
    (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/pulls/21/merge')) {
        return jsonResponse({});
      }
      if (url.endsWith('/pulls/21')) {
        return jsonResponse({ head: { ref: 'feature/x', repo: { full_name: 'acme/widgets' } } });
      }
      if (url.endsWith('/git/refs/heads/feature%2Fx')) {
        return jsonResponse({});
      }
      throw new Error(`unmocked: ${url}`);
    }) as unknown as typeof fetch,
  );
  await client.mergePullRequest(REPO, 21, { strategy: 'squash', deleteSourceBranch: true });
  assert.ok(calls.includes('DELETE https://api.github.com/repos/acme/widgets/git/refs/heads/feature%2Fx'));
});

test('mergePullRequest: deleteSourceBranch false never fetches or deletes the head ref', async () => {
  let calls = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    calls++;
    if (url.endsWith('/pulls/22/merge')) {
      return jsonResponse({});
    }
    throw new Error(`unexpected call: ${url}`);
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 22, { strategy: 'merge', deleteSourceBranch: false });
  assert.equal(calls, 1);
});

test('mergePullRequest: a rejected request throws with the real HTTP status', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(
    () => client.mergePullRequest(REPO, 23, { strategy: 'merge', deleteSourceBranch: false }),
    /401 Unauthorized from api\.github\.com/,
  );
});

test('createPullRequest: POSTs head/base/draft to the pulls endpoint, mapping the response into a PullRequestSummary', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      number: 50,
      title: 'Add feature',
      html_url: 'https://github.com/acme/widgets/pull/50',
      user: { login: 'raj' },
      draft: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      head: { sha: 'newpr-sha' },
    });
  }) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'Add feature', base: 'main', compare: 'feature-x', draft: true });
  assert.equal(capturedUrl, 'https://api.github.com/repos/acme/widgets/pulls');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ title: 'Add feature', head: 'feature-x', base: 'main', draft: true }));
  assert.equal(result.number, 50);
  assert.equal(result.url, 'https://github.com/acme/widgets/pull/50');
  assert.equal(result.isDraft, true);
  assert.equal(result.reviewedByMe, false);
});

test('createPullRequest: a rejected request throws with the real HTTP status', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(
    () => client.createPullRequest(REPO, { title: 'x', base: 'main', compare: 'feature', draft: false }),
    /401 Unauthorized from api\.github\.com/,
  );
});

// ── A4: Pagination and bounded fan-out ─────────────────────────────────────

function jsonResponseWithLink(body: unknown, nextUrl?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (nextUrl) {
    headers['Link'] = `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"`;
  }
  return new Response(JSON.stringify(body), { status: 200, statusText: 'OK', headers });
}

test('A4: listOpenPullRequests follows Link header — 101 PRs across 2 pages all returned', async () => {
  const page1Prs = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1,
    title: `PR ${i + 1}`,
    html_url: `https://github.com/acme/widgets/pull/${i + 1}`,
    user: { login: 'alice' },
    draft: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    requested_reviewers: [],
    head: { sha: `sha${i + 1}` },
  }));
  const page2Prs = [{
    number: 101,
    title: 'PR 101',
    html_url: 'https://github.com/acme/widgets/pull/101',
    user: { login: 'alice' },
    draft: false,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    requested_reviewers: [],
    head: { sha: 'sha101' },
  }];
  const page2Url = `${BASE}/repos/acme/widgets/pulls?state=open&per_page=100&page=2`;

  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'alice' });
    if (url === `${BASE}/repos/acme/widgets/pulls?state=open&per_page=100`) {
      return jsonResponseWithLink(page1Prs, page2Url);
    }
    if (url === page2Url) return jsonResponseWithLink(page2Prs);
    // Enrich calls — return empty for speed
    if (url.includes('/reviews')) return jsonResponseWithLink([]);
    if (url.includes('/check-runs')) return jsonResponseWithLink({ check_runs: [] });
    if (url.match(/\/pulls\/\d+$/) && !url.includes('/reviews')) return jsonResponse({ mergeable_state: 'clean' });
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 101, 'must return all 101 PRs across both pages');
});

test('A4: listOpenPullRequests stops at MAX_PAGES when Link next always present', async () => {
  const { MAX_PAGES } = await import('../../../../src/core/forge/forgeFetch.js');
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'alice' });
    // Enrichment calls don't count toward page limit
    if (url.includes('/reviews')) return jsonResponseWithLink([]);
    if (url.includes('/check-runs')) return jsonResponseWithLink({ check_runs: [] });
    if (url.match(/\/pulls\/\d+$/) && !url.includes('/reviews')) return jsonResponse({ mergeable_state: 'clean' });
    // Always return 1 PR with a next link — infinite source
    callCount++;
    const nextUrl = `${BASE}/repos/acme/widgets/pulls?state=open&per_page=100&page=${callCount + 1}`;
    return jsonResponseWithLink([{
      number: callCount,
      title: `PR ${callCount}`,
      html_url: `https://github.com/acme/widgets/pull/${callCount}`,
      user: { login: 'alice' },
      draft: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      requested_reviewers: [],
      head: { sha: `sha${callCount}` },
    }], nextUrl);
  }) as typeof fetch);
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(callCount, MAX_PAGES, `should stop at MAX_PAGES (${MAX_PAGES}) list requests`);
  assert.equal(result.length, MAX_PAGES, 'one PR per page');
});

// The closed list is a documented "bounded, most-recently-updated slice" — following Link here
// turned one request per repo per refresh into up to MAX_PAGES (~1000 closed PRs) to find a few of
// the user's own.
test('listRecentlyClosedPullRequests: stays one request even when the host offers a next page', async () => {
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async () => {
    callCount++;
    return jsonResponseWithLink(
      [
        {
          number: callCount,
          title: `Closed ${callCount}`,
          html_url: `https://github.com/acme/widgets/pull/${callCount}`,
          user: { login: 'alice' },
          draft: false,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          closed_at: '2024-01-02T00:00:00Z',
          merged_at: null,
          head: { sha: `sha${callCount}` },
        },
      ],
      `${BASE}/repos/acme/widgets/pulls?state=closed&per_page=100&page=${callCount + 1}`,
    );
  }) as typeof fetch);
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(callCount, 1, 'exactly one closed-list request');
  assert.equal(result.length, 1, 'only the first page is returned');
});

test('A4: reviews are paginated — a review on page 2 is not lost', async () => {
  const page2ReviewsUrl = `${BASE}/repos/acme/widgets/pulls/1/reviews?per_page=100&page=2`;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'raj' });
    if (url.endsWith('/pulls?state=open&per_page=100')) {
      return jsonResponseWithLink([{
        number: 1,
        title: 'PR',
        html_url: 'u',
        user: { login: 'raj' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        requested_reviewers: [],
        head: { sha: 'sha1' },
      }]);
    }
    if (url.endsWith('/pulls/1/reviews?per_page=100')) {
      return jsonResponseWithLink(
        [{ user: { login: 'amy' }, state: 'APPROVED' }],
        page2ReviewsUrl,
      );
    }
    if (url === page2ReviewsUrl) {
      return jsonResponseWithLink([{ user: { login: 'bob' }, state: 'CHANGES_REQUESTED' }]);
    }
    if (url.includes('/check-runs')) return jsonResponseWithLink({ check_runs: [] });
    if (url.endsWith('/pulls/1')) return jsonResponse({ mergeable_state: 'clean' });
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  // page 2 has CHANGES_REQUESTED — this must win (last state per user)
  // bob's CHANGES_REQUESTED on page 2 should make reviewDecision changesRequested
  assert.equal(result[0]?.reviewDecision, 'changesRequested', 'review from page 2 must not be lost');
});

test('A4: enrich fan-out is bounded — concurrent PR enrichments stay within limit', async () => {
  // Track concurrent "enrich" operations by counting /reviews requests in-flight.
  // Each enrich makes exactly one /reviews call, so this proxies enrich concurrency.
  let concurrentEnrichs = 0;
  let maxConcurrentEnrichs = 0;

  const slowFetch = async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (u === `${BASE}/user`) return jsonResponse({ login: 'alice' });
    if (u.endsWith('/pulls?state=open&per_page=100')) {
      return jsonResponseWithLink(Array.from({ length: 20 }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        html_url: `u${i}`,
        user: { login: 'alice' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        requested_reviewers: [],
        head: { sha: `sha${i}` },
      })));
    }
    // Count concurrent reviews calls as proxy for concurrent enrich operations
    if (u.includes('/reviews')) {
      concurrentEnrichs++;
      maxConcurrentEnrichs = Math.max(maxConcurrentEnrichs, concurrentEnrichs);
      await new Promise((r) => setTimeout(r, 10));
      concurrentEnrichs--;
      return jsonResponseWithLink([]);
    }
    if (u.includes('/check-runs')) return jsonResponseWithLink({ check_runs: [] });
    return jsonResponse({ mergeable_state: 'clean' });
  };
  const client = new GitHubClient(BASE, 'tok', slowFetch as typeof fetch);
  await client.getAuthenticatedLogin();
  await client.listOpenPullRequests(REPO);
  assert.ok(maxConcurrentEnrichs <= 6, `max concurrent enrichments should be ≤ 6, was ${maxConcurrentEnrichs}`);
  assert.ok(maxConcurrentEnrichs > 1, 'must use some concurrency (not fully serial)');
});

// ── A5: Normalization bugs ─────────────────────────────────────────────────

test('A5 N1: a COMMENTED review after CHANGES_REQUESTED does not overwrite changesRequested', async () => {
  const client = new GitHubClient(
    BASE, 'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 50, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', requested_reviewers: [], head: { sha: 'sha50' } },
      ],
      '/reviews?per_page=100': [
        { user: { login: 'amy' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'amy' }, state: 'COMMENTED' },
      ],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/50': { mergeable_state: 'clean' },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'changesRequested', 'COMMENTED must not overwrite prior CHANGES_REQUESTED');
});

test('A5 N1: a PENDING review after APPROVED does not overwrite approved', async () => {
  const client = new GitHubClient(
    BASE, 'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 51, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', requested_reviewers: [], head: { sha: 'sha51' } },
      ],
      '/reviews?per_page=100': [
        { user: { login: 'amy' }, state: 'APPROVED' },
        { user: { login: 'amy' }, state: 'PENDING' },
      ],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/51': { mergeable_state: 'clean' },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'approved', 'PENDING must not overwrite prior APPROVED');
});

test('A5 N1: DISMISSED clears a prior verdict (no longer changesRequested)', async () => {
  const client = new GitHubClient(
    BASE, 'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        { number: 52, title: 'PR', html_url: 'u', user: { login: 'raj' }, created_at: 'c', updated_at: 'u', requested_reviewers: [], head: { sha: 'sha52' } },
      ],
      '/reviews?per_page=100': [
        { user: { login: 'amy' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'amy' }, state: 'DISMISSED' },
      ],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/52': { mergeable_state: 'clean' },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'none', 'DISMISSED must clear prior CHANGES_REQUESTED');
});

test('A5 N2: approved + still-requested reviewer = approved (requestedReviewers must not override approval)', async () => {
  const client = new GitHubClient(
    BASE, 'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/pulls?state=open&per_page=100': [
        {
          number: 53,
          title: 'PR',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          requested_reviewers: [{ login: 'bob' }],
          head: { sha: 'sha53' },
        },
      ],
      '/reviews?per_page=100': [{ user: { login: 'amy' }, state: 'APPROVED' }],
      '/check-runs?per_page=100': { check_runs: [] },
      '/pulls/53': { mergeable_state: 'clean' },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  // Amy approved, bob's review is still outstanding. Current bug: requestedReviewers wins over any approval.
  // Fix: if approved and no CHANGES_REQUESTED, return approved regardless of requestedReviewers.
  assert.equal(result[0]?.reviewDecision, 'approved', 'an approval must not be overridden by still-requested reviewers');
});

// ── A4 Step 4: GitHub review tiering ──────────────────────────────────────

test('A4 Step 4: 50 PRs where 2 are mine → 2×3 + 48×1 = 54 enrichment requests', async () => {
  let enrichmentRequests = 0;
  const myPrNumbers = new Set([1, 2]); // PRs authored by 'raj'

  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'raj' });
    if (url.endsWith('/pulls?state=open&per_page=100')) {
      return jsonResponseWithLink(Array.from({ length: 50 }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        html_url: `u${i}`,
        user: { login: myPrNumbers.has(i + 1) ? 'raj' : 'other' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        requested_reviewers: [],
        head: { sha: `sha${i}` },
      })));
    }
    if (url.includes('/reviews')) { enrichmentRequests++; return jsonResponseWithLink([]); }
    if (url.includes('/check-runs')) { enrichmentRequests++; return jsonResponseWithLink({ check_runs: [] }); }
    // fetchMergeableState: /repos/acme/widgets/pulls/N (no trailing path)
    if (/\/pulls\/\d+$/.test(url)) { enrichmentRequests++; return jsonResponse({ mergeable_state: 'clean' }); }
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);

  const result = await client.listOpenPullRequests(REPO);
  // 2 mine → 3 enrichment calls each = 6; 48 others → 1 review call each = 48; total = 54
  assert.equal(enrichmentRequests, 54, `expected 54 enrichment requests, got ${enrichmentRequests}`);
  // Only my 2 PRs; the 48 others have no 'raj' review → filtered out
  assert.equal(result.length, 2, 'only the 2 authored-by-me PRs should appear');
});

test('A4 Step 4: a non-mine PR reviewed by me is included with reviewedByMe: true and slim fields', async () => {
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'raj' });
    if (url.endsWith('/pulls?state=open&per_page=100')) {
      return jsonResponseWithLink([{
        number: 5,
        title: 'Someone elses PR',
        html_url: 'u5',
        user: { login: 'alice' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        requested_reviewers: [],
        head: { sha: 'sha5' },
      }]);
    }
    if (url.includes('/reviews')) {
      return jsonResponseWithLink([{ user: { login: 'raj' }, state: 'APPROVED' }]);
    }
    // Slim path: check-runs and mergeable_state must NOT be fetched
    throw new Error(`unmocked (slim path should not reach here): ${url}`);
  }) as typeof fetch);

  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.reviewedByMe, true);
  assert.equal(result[0]?.checkStatus, 'none', 'slim path sets checkStatus to none');
  assert.equal(result[0]?.hasConflicts, false, 'slim path sets hasConflicts to false');
  assert.equal(result[0]?.authorLogin, 'alice');
});

test('A4 Step 4: a non-mine PR NOT reviewed by me is excluded from results', async () => {
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) return jsonResponse({ login: 'raj' });
    if (url.endsWith('/pulls?state=open&per_page=100')) {
      return jsonResponseWithLink([{
        number: 6, title: 'Not my PR', html_url: 'u6',
        user: { login: 'alice' }, draft: false, created_at: 'c', updated_at: 'u',
        requested_reviewers: [], head: { sha: 'sha6' },
      }]);
    }
    if (url.includes('/reviews')) {
      return jsonResponseWithLink([{ user: { login: 'bob' }, state: 'APPROVED' }]);
    }
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);

  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 0, 'non-mine unreviewed PR must be excluded from results');
});

test('A4 Step 4: getPullRequest on a fresh client resolves login lazily and computes reviewedByMe', async () => {
  // No prior call to getAuthenticatedLogin — ensureLogin() must set it transparently
  const client = new GitHubClient(BASE, 'tok', fakeFetch({
    '/user': { login: 'raj' },
    '/repos/acme/widgets/pulls/9': {
      number: 9, title: 'Fresh PR', html_url: 'u9',
      user: { login: 'raj' }, draft: false, created_at: 'c', updated_at: 'u',
      requested_reviewers: [], head: { sha: 'sha9' },
    },
    '/pulls/9/reviews?per_page=100': [{ user: { login: 'raj' }, state: 'APPROVED' }],
    '/commits/sha9/check-runs?per_page=100': { check_runs: [] },
    '/pulls/9': { mergeable_state: 'clean' },
  }));
  const result = await client.getPullRequest(REPO, 9);
  assert.equal(result.number, 9);
  assert.equal(result.reviewedByMe, true);
});

test('A4 Step 4: getAuthenticatedLogin is not called a second time when login is already cached', async () => {
  let userFetchCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url === `${BASE}/user`) { userFetchCount++; return jsonResponse({ login: 'raj' }); }
    if (url.endsWith('/pulls?state=open&per_page=100')) return jsonResponseWithLink([]);
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);

  await client.getAuthenticatedLogin(); // explicit first call
  await client.listOpenPullRequests(REPO); // ensureLogin must NOT fetch /user again
  assert.equal(userFetchCount, 1, 'getAuthenticatedLogin must not be called twice when login is already cached');
});

test('A5 N3: deleteSourceBranch on a fork PR with same-named branch does not delete the wrong branch', async () => {
  const fetchedUrls: string[] = [];
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    fetchedUrls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.includes('/pulls/99') && !url.includes('/merge') && !url.includes('/reviews')) {
      // Fork PR: head.repo is different from base repo
      return jsonResponse({
        number: 99,
        title: 'Fork PR',
        html_url: 'u',
        user: { login: 'fork-user' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        requested_reviewers: [],
        head: { sha: 'sha99', ref: 'main', repo: { full_name: 'fork-user/widgets' } }, // fork repo
        base: { ref: 'main', repo: { full_name: 'acme/widgets' } }, // base repo
        merged_at: '2024-01-01T00:00:00Z',
        merge_commit_sha: 'abc',
        mergeable_state: 'clean',
      });
    }
    if (url.includes('/pulls/99/merge')) {
      return new Response(null, { status: 204, statusText: 'No Content' });
    }
    return jsonResponse({});
  }) as typeof fetch);
  await client.mergePullRequest(REPO, 99, { strategy: 'merge', deleteSourceBranch: true });
  const deletedBranches = fetchedUrls.filter((u) => u.startsWith('DELETE') && u.includes('/git/refs/'));
  assert.equal(deletedBranches.length, 0, 'must not delete a branch on the base repo when the PR is from a fork');
});

// ── B1.1: headSha in PullRequestSummary ───────────────────────────────────

test('B1.1: enrich populates headSha from pull.head.sha', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { login: 'raj' },
      '/repos/acme/widgets/pulls/7': {
        number: 7,
        title: 'PR',
        html_url: 'u',
        user: { login: 'raj' },
        draft: false,
        created_at: 'c',
        updated_at: 'u',
        head: { sha: 'deadbeef' },
        requested_reviewers: [],
        mergeable_state: 'clean',
      },
      '/pulls/7/reviews?per_page=100': [],
      '/commits/deadbeef/check-runs?per_page=100': { check_runs: [] },
    }),
  );
  const result = await client.getPullRequest(REPO, 7);
  assert.equal(result.headSha, 'deadbeef');
});

test('B1.1: listRecentlyClosedPullRequests populates headSha', async () => {
  const client = new GitHubClient(
    BASE,
    'tok',
    fakeFetch({
      '/pulls?state=closed&sort=updated&direction=desc&per_page=100': [
        {
          number: 99,
          title: 'Closed',
          html_url: 'u',
          user: { login: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          closed_at: 'c2',
          merged_at: null,
          head: { sha: 'cafebabe' },
        },
      ],
    }),
  );
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result[0]?.headSha, 'cafebabe');
});

test('B1.1: createPullRequest populates headSha from the API response', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () =>
    jsonResponse({
      number: 77,
      title: 'New PR',
      html_url: 'u',
      user: { login: 'raj' },
      draft: false,
      created_at: 'c',
      updated_at: 'u',
      head: { sha: 'abc000' },
    })) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'New PR', base: 'main', compare: 'feat', draft: false });
  assert.equal(result.headSha, 'abc000');
});

test('B1.1: createPullRequest with response lacking head returns headSha ""', async () => {
  const client = new GitHubClient(BASE, 'tok', (() =>
    jsonResponse({ number: 78, title: 'No Head PR', html_url: 'u', user: { login: 'raj' }, draft: false, created_at: 'c', updated_at: 'u' })) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'No Head PR', base: 'main', compare: 'feat', draft: false });
  assert.equal(result.headSha, '', 'must return empty string when head is absent');
});

// ── B1.2: pagination — /pulls/{n}/files and GraphQL reviewThreads ──────────

test('B1.2: getPullRequestDiff paginates /files via Link header and returns all files', async () => {
  const page2Url = `${BASE}/repos/acme/widgets/pulls/14/files?per_page=100&page=2`;
  const client = new GitHubClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/pulls/14')) {
      return textResponse('diff text');
    }
    if (url.endsWith('/pulls/14/files?per_page=100')) {
      return new Response(
        JSON.stringify([{ filename: 'a.ts', additions: 1, deletions: 0, patch: '@@' }]),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Link': `<${page2Url}>; rel="next"` } },
      );
    }
    if (url === page2Url) {
      return jsonResponse([{ filename: 'b.ts', additions: 2, deletions: 1, patch: '@@' }]);
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 14);
  assert.equal(result.files.length, 2, 'must return files from both pages');
  assert.equal(result.files[0]?.path, 'a.ts');
  assert.equal(result.files[1]?.path, 'b.ts');
});

test('B1.2: listConversationThreads paginates GraphQL reviewThreads via cursor (2 pages)', async () => {
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
    callCount++;
    if (body.variables.after === null) {
      // First page
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: true, endCursor: 'cursor1' },
                nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [{ body: 'A', author: { login: 'amy' } }] } }],
              },
            },
          },
        },
      });
    }
    // Second page (cursor1)
    return jsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: 'T2', isResolved: true, comments: { nodes: [{ body: 'B', author: { login: 'raj' } }] } }],
            },
          },
        },
      },
    });
  }) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(callCount, 2, 'must make exactly 2 GraphQL calls for 2 pages');
  assert.equal(result.length, 2, 'must return threads from both pages');
  assert.equal(result[0]?.id, 'T1');
  assert.equal(result[1]?.id, 'T2');
});

// B1.2 boundary: GitHub /files — 100 items (single page), 101 items (two pages), cap

test('B1.2: getPullRequestDiff /files — exactly 100 items single page, no second request', async () => {
  let reqCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/15')) return textResponse('diff');
    if (url.includes('/pulls/15/files')) {
      reqCount++;
      // 100 files, no Link header → single page
      return jsonResponse(Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0, patch: '@@' })));
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 15);
  assert.equal(reqCount, 1, 'exactly one /files request for 100 items');
  assert.equal(result.files.length, 100);
});

test('B1.2: getPullRequestDiff /files — 101 items across 2 pages, all returned', async () => {
  const page2Url = `${BASE}/repos/acme/widgets/pulls/16/files?per_page=100&page=2`;
  let reqCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/16')) return textResponse('diff');
    if (url.endsWith('/pulls/16/files?per_page=100')) {
      reqCount++;
      return new Response(
        JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0, patch: '@@' }))),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Link': `<${page2Url}>; rel="next"` } },
      );
    }
    if (url === page2Url) {
      reqCount++;
      return jsonResponse([{ filename: 'extra.ts', additions: 1, deletions: 0, patch: '@@' }]);
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 16);
  assert.equal(reqCount, 2, 'two /files requests for 101 items');
  assert.equal(result.files.length, 101);
});

test('B1.2: getPullRequestDiff /files — always-next source stops at MAX_PAGES (10)', async () => {
  let reqCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/17')) return textResponse('diff');
    if (url.includes('/pulls/17/files')) {
      reqCount++;
      const nextUrl = `${BASE}/repos/acme/widgets/pulls/17/files?per_page=100&page=${reqCount + 1}`;
      return new Response(
        JSON.stringify([{ filename: `f${reqCount}.ts`, additions: 1, deletions: 0, patch: '@@' }]),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Link': `<${nextUrl}>; rel="next"` } },
      );
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 17);
  assert.equal(reqCount, 10, 'must stop at MAX_PAGES=10');
  assert.equal(result.files.length, 10);
});

// B1.2 boundary: GitHub GraphQL reviewThreads cursor — 100 nodes (single call), 101 (two calls), cap

function makeThreadsResponse(nodes: Array<{ id: string }>, hasNextPage: boolean, endCursor: string | null) {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage, endCursor },
            nodes: nodes.map((n) => ({ ...n, isResolved: false, comments: { nodes: [{ body: 'x', author: { login: 'u' }, createdAt: '2024-01-01T00:00:00Z' }] } })),
          },
        },
      },
    },
  });
}

test('B1.2: listConversationThreads GraphQL — 100 threads in single call, no second request', async () => {
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async () => {
    callCount++;
    return makeThreadsResponse(Array.from({ length: 100 }, (_, i) => ({ id: `T${i}` })), false, null);
  }) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(callCount, 1, 'single GraphQL call for 100 threads');
  assert.equal(result.length, 100);
});

test('B1.2: listConversationThreads GraphQL — 101 threads across 2 calls, all returned', async () => {
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    callCount++;
    const body = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
    if (body.variables.after === null) {
      return makeThreadsResponse(Array.from({ length: 100 }, (_, i) => ({ id: `T${i}` })), true, 'cursor1');
    }
    return makeThreadsResponse([{ id: 'T100' }], false, null);
  }) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(callCount, 2, '2 GraphQL calls for 101 threads');
  assert.equal(result.length, 101);
});

test('B1.2: listConversationThreads GraphQL — always-next cursor stops at MAX_PAGES (10)', async () => {
  let callCount = 0;
  const client = new GitHubClient(BASE, 'tok', (async () => {
    callCount++;
    return makeThreadsResponse([{ id: `T${callCount}` }], true, `cursor${callCount}`);
  }) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(callCount, 10, 'must stop at MAX_PAGES=10');
  assert.equal(result.length, 10);
});

// ── B2.1: ConversationThread.comments array ────────────────────────────────

test('B2.1: listConversationThreads maps all comments (multiple per thread) to ThreadComment[]', async () => {
  const client = new GitHubClient(BASE, 'tok', (async () =>
    jsonResponse({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'T1',
                  isResolved: false,
                  comments: {
                    nodes: [
                      { body: 'First', author: { login: 'amy' }, createdAt: '2024-01-01T00:00:00Z' },
                      { body: 'Reply', author: { login: 'raj' }, createdAt: '2024-01-02T00:00:00Z' },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    })) as unknown as typeof fetch);
  const result = await client.listConversationThreads(REPO, 18);
  assert.equal(result[0]?.comments.length, 2);
  assert.deepEqual(result[0]?.comments[0], { authorLogin: 'amy', body: 'First', createdAt: '2024-01-01T00:00:00Z' });
  assert.deepEqual(result[0]?.comments[1], { authorLogin: 'raj', body: 'Reply', createdAt: '2024-01-02T00:00:00Z' });
});

// ── B2.2: replyToThread + unresolveConversationThread ─────────────────────

test('B2.2: replyToThread POSTs the addPullRequestReviewThreadReply mutation with threadId+body', async () => {
  let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ data: { addPullRequestReviewThreadReply: { comment: { id: 'C1' } } } });
  }) as unknown as typeof fetch);
  await client.replyToThread(REPO, 18, 'PRRT_1', 'LGTM!');
  assert.match(capturedBody?.query ?? '', /addPullRequestReviewThreadReply/);
  assert.deepEqual(capturedBody?.variables, { threadId: 'PRRT_1', body: 'LGTM!' });
});

test('B2.2: unresolveConversationThread POSTs the unresolveReviewThread mutation', async () => {
  let capturedBody: { query: string; variables: Record<string, unknown> } | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return jsonResponse({ data: { unresolveReviewThread: { thread: { id: 'PRRT_1', isResolved: false } } } });
  }) as unknown as typeof fetch);
  await client.unresolveConversationThread(REPO, 18, 'PRRT_1');
  assert.match(capturedBody?.query ?? '', /unresolveReviewThread/);
  assert.deepEqual(capturedBody?.variables, { threadId: 'PRRT_1' });
});

// ── B3.1: submitReview with optional body ─────────────────────────────────

test('B3.1: submitReview includes body in payload when provided and non-empty', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 15, 'approve', 'Great work!');
  assert.equal(capturedBody?.['event'], 'APPROVE');
  assert.equal(capturedBody?.['body'], 'Great work!');
});

test('B3.1: submitReview omits body from payload when body is whitespace-only', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 15, 'approve', '   ');
  assert.equal(capturedBody?.['event'], 'APPROVE');
  assert.ok(!('body' in (capturedBody ?? {})), 'body must not be present when whitespace-only');
});

test('B3.1: submitReview omits body when not provided (backward compat)', async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const client = new GitHubClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 15, 'requestChanges');
  assert.equal(capturedBody?.['event'], 'REQUEST_CHANGES');
  assert.ok(!('body' in (capturedBody ?? {})), 'body must not be present when not supplied');
});

// ── B4.1: listChecks ──────────────────────────────────────────────────────

test('B4.1: listChecks fetches PR for SHA then check-runs, returning CheckDetail[]', async () => {
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/200')) {
      return jsonResponse({ number: 200, head: { sha: 'sha200' } });
    }
    if (url.includes('/commits/sha200/check-runs')) {
      return jsonResponse({
        check_runs: [
          { name: 'CI / build', status: 'completed', conclusion: 'success', html_url: 'https://ci.example.com/1' },
          { name: 'CI / lint', status: 'in_progress', conclusion: null, html_url: 'https://ci.example.com/2' },
          { name: 'CI / test', status: 'completed', conclusion: 'failure', html_url: null },
        ],
      });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listChecks(REPO, 200);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { name: 'CI / build', status: 'passing', url: 'https://ci.example.com/1' });
  assert.deepEqual(result[1], { name: 'CI / lint', status: 'pending', url: 'https://ci.example.com/2' });
  assert.deepEqual(result[2], { name: 'CI / test', status: 'failing' });
});

test('B4.1: listChecks paginates check-runs across pages', async () => {
  const page2Url = `${BASE}/repos/acme/widgets/commits/sha201/check-runs?per_page=100&page=2`;
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/201')) {
      return jsonResponse({ number: 201, head: { sha: 'sha201' } });
    }
    if (url.endsWith('/commits/sha201/check-runs?per_page=100')) {
      return new Response(
        JSON.stringify({ check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null }] }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Link': `<${page2Url}>; rel="next"` } },
      );
    }
    if (url === page2Url) {
      return jsonResponse({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure', html_url: null }] });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listChecks(REPO, 201);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.name, 'build');
  assert.equal(result[1]?.name, 'test');
});

test('B4.1: listChecks returns empty array when no check-runs exist', async () => {
  const client = new GitHubClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pulls/202')) return jsonResponse({ number: 202, head: { sha: 'sha202' } });
    if (url.includes('/commits/sha202/check-runs')) return jsonResponse({ check_runs: [] });
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listChecks(REPO, 202);
  assert.deepEqual(result, []);
});
