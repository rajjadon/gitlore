import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BitbucketClient } from '../../../../src/core/forge/BitbucketClient';
import { isCredentialRejection } from '../../../../src/core/forge/forgeFetch';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';

const REPO: ForgeRepoRef = { host: 'bitbucket', identity: 'acme/widgets', label: 'acme/widgets' };
const BASE = 'https://api.bitbucket.org/2.0';

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

test('getAuthenticatedLogin: returns username from GET /user', async () => {
  const client = new BitbucketClient(BASE, 'tok', fakeFetch({ '/user': { username: 'raj' } }));
  assert.equal(await client.getAuthenticatedLogin(), 'raj');
});

test('getAuthenticatedLogin: falls back to nickname when username is absent', async () => {
  const client = new BitbucketClient(BASE, 'tok', fakeFetch({ '/user': { nickname: 'raj-nick' } }));
  assert.equal(await client.getAuthenticatedLogin(), 'raj-nick');
});

test('getAuthenticatedLogin: an invalid token throws with the real HTTP status, not a generic message', async () => {
  const client = new BitbucketClient(BASE, 'bad', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.getAuthenticatedLogin(), /401 Unauthorized from api\.bitbucket\.org/);
});

test('listOpenPullRequests: normalizes a plain open PR with no reviewers or build statuses', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 1,
            title: 'Add feature',
            links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/1' } },
            author: { username: 'raj' },
            created_on: '2024-01-01T00:00:00Z',
            updated_on: '2024-01-02T00:00:00Z',
            source: { commit: { hash: 'abc123' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, 'Add feature');
  assert.equal(result[0]?.checkStatus, 'none');
  assert.equal(result[0]?.reviewDecision, 'none');
  assert.equal(result[0]?.hasConflicts, false);
});

test('listOpenPullRequests: a reviewer with state changes_requested -> reviewDecision "changesRequested"', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 2,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'raj' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'amy' }, role: 'REVIEWER', approved: false, state: 'changes_requested' }],
            source: { commit: { hash: 'sha2' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'changesRequested');
  assert.deepEqual(result[0]?.requestedReviewers, ['amy']);
});

test('listOpenPullRequests: an unapproved reviewer with no explicit state -> "reviewRequired"', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 3,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'raj' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'amy' }, role: 'REVIEWER', approved: false, state: null }],
            source: { commit: { hash: 'sha3' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'reviewRequired');
  assert.deepEqual(result[0]?.requestedReviewers, ['amy']);
});

test('listOpenPullRequests: every reviewer approved -> "approved", nobody left in requestedReviewers', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 4,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'raj' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'amy' }, role: 'REVIEWER', approved: true, state: 'approved' }],
            source: { commit: { hash: 'sha4' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'approved');
  assert.deepEqual(result[0]?.requestedReviewers, []);
});

test('listOpenPullRequests: reviewedByMe is true when the authenticated user approved as a REVIEWER', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { username: 'raj' },
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 5,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'someone-else' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'raj' }, role: 'REVIEWER', approved: true, state: 'approved' }],
            source: { commit: { hash: 'sha5' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, true);
});

test('listOpenPullRequests: reviewedByMe is true when the authenticated user requested changes as a REVIEWER', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { username: 'raj' },
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 6,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'someone-else' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'raj' }, role: 'REVIEWER', approved: false, state: 'changes_requested' }],
            source: { commit: { hash: 'sha6' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, true);
});

test('listOpenPullRequests: reviewedByMe is false for a REVIEWER who has not approved or requested changes yet', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { username: 'raj' },
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 7,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'someone-else' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'raj' }, role: 'REVIEWER', approved: false, state: null }],
            source: { commit: { hash: 'sha7' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, false);
});

test('listOpenPullRequests: a PARTICIPANT (not a REVIEWER) never counts toward review decision', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests?state=OPEN&pagelen=50': {
        values: [
          {
            id: 5,
            title: 'PR',
            links: { html: { href: 'u' } },
            author: { username: 'raj' },
            created_on: 'c',
            updated_on: 'u',
            participants: [{ user: { username: 'bystander' }, role: 'PARTICIPANT', approved: false, state: null }],
            source: { commit: { hash: 'sha5' } },
          },
        ],
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'none');
  assert.deepEqual(result[0]?.requestedReviewers, []);
});

test('listOpenPullRequests: build status maps to checkStatus (SUCCESSFUL/FAILED/INPROGRESS)', async () => {
  async function statusCheck(state: string, expected: string): Promise<void> {
    const client = new BitbucketClient(
      BASE,
      'tok',
      fakeFetch({
        'pullrequests?state=OPEN&pagelen=50': {
          values: [
            { id: 6, title: 'PR', links: { html: { href: 'u' } }, author: { username: 'raj' }, created_on: 'c', updated_on: 'u', source: { commit: { hash: 'sha6' } } },
          ],
        },
        '/statuses': { values: [{ state }] },
      }),
    );
    const result = await client.listOpenPullRequests(REPO);
    assert.equal(result[0]?.checkStatus, expected, `build state "${state}"`);
  }
  await statusCheck('SUCCESSFUL', 'passing');
  await statusCheck('FAILED', 'failing');
  await statusCheck('STOPPED', 'failing');
  await statusCheck('INPROGRESS', 'pending');
});

test('listOpenPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listOpenPullRequests(REPO), /401 Unauthorized from api\.bitbucket\.org/);
});

test('getPullRequest: fetches one PR by id and enriches it the same way the list endpoint does', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests/7': {
        id: 7,
        title: 'Single PR fetch',
        links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/7' } },
        author: { username: 'raj' },
        created_on: '2024-01-01T00:00:00Z',
        updated_on: '2024-01-01T00:00:00Z',
        source: { commit: { hash: 'abc123' } },
      },
      '/statuses': { values: [] },
    }),
  );
  const result = await client.getPullRequest(REPO, 7);
  assert.equal(result.title, 'Single PR fetch');
});

test('listRecentlyClosedPullRequests: combines MERGED and DECLINED, tagging each with the right merged flag', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    if (url.includes('state=MERGED')) {
      return jsonResponse({
        values: [
          { id: 30, title: 'Shipped', links: { html: { href: 'u1' } }, author: { username: 'raj' }, created_on: 'c', updated_on: 'u' },
        ],
      });
    }
    if (url.includes('state=DECLINED')) {
      return jsonResponse({
        values: [
          { id: 31, title: 'Declined', links: { html: { href: 'u2' } }, author: { username: 'raj' }, created_on: 'c', updated_on: 'u' },
        ],
      });
    }
    throw new Error(`unmocked request: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result.length, 2);
  assert.equal(result.find((r) => r.number === 30)?.merged, true);
  assert.equal(result.find((r) => r.number === 31)?.merged, false);
  // reviewedByMe is never meaningful once a PR is done — nothing reads it there.
  assert.equal(result.find((r) => r.number === 30)?.reviewedByMe, false);
  assert.equal(result.find((r) => r.number === 31)?.reviewedByMe, false);
});

test('listRecentlyClosedPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listRecentlyClosedPullRequests(REPO), /401 Unauthorized from api\.bitbucket\.org/);
});

test('listRecentlyClosedPullRequests: scopes the search server-side to the authenticated user via author.uuid, once known', async () => {
  const requestedUrls: string[] = [];
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    requestedUrls.push(url);
    if (url.endsWith('/user')) {
      return jsonResponse({ username: 'raj', uuid: '{user-uuid-123}' });
    }
    return jsonResponse({ values: [] });
  }) as unknown as typeof fetch);

  await client.getAuthenticatedLogin();
  await client.listRecentlyClosedPullRequests(REPO);

  const listUrls = requestedUrls.filter((url) => url.includes('pullrequests?state='));
  assert.equal(listUrls.length, 2);
  assert.ok(
    listUrls.every((url) => url.includes(encodeURIComponent('author.uuid="{user-uuid-123}"'))),
    listUrls.join('\n'),
  );
});

test('listRecentlyClosedPullRequests: omits the author filter when the authenticated user is not yet known', async () => {
  const requestedUrls: string[] = [];
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    requestedUrls.push(url);
    return jsonResponse({ values: [] });
  }) as unknown as typeof fetch);

  await client.listRecentlyClosedPullRequests(REPO);

  assert.ok(requestedUrls.every((url) => !url.includes('q=')), requestedUrls.join('\n'));
});

test('closePullRequest: POSTs to the decline endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.closePullRequest(REPO, 32);
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/32/decline');
  assert.equal(capturedInit?.method, 'POST');
});

test('reopenPullRequest: throws a clear platform-gap error — Bitbucket Cloud has no way to reopen a declined PR', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => {
    throw new Error('should never call the network for this');
  }) as unknown as typeof fetch);
  await assert.rejects(() => client.reopenPullRequest(REPO, 32), /Bitbucket has no way to reopen a declined pull request/);
});

test('mergePullRequest: POSTs merge_strategy=merge_commit for the "merge" strategy, carrying close_source_branch through', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 40, { strategy: 'merge', deleteSourceBranch: true });
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/40/merge');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ merge_strategy: 'merge_commit', close_source_branch: true }));
});

test('mergePullRequest: POSTs merge_strategy=squash for the "squash" strategy', async () => {
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 41, { strategy: 'squash', deleteSourceBranch: false });
  assert.equal(capturedInit?.body, JSON.stringify({ merge_strategy: 'squash', close_source_branch: false }));
});

test('mergePullRequest: "rebase" throws a platform-gap error — Bitbucket has no true rebase-and-merge', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => {
    throw new Error('should never call the network for this');
  }) as unknown as typeof fetch);
  await assert.rejects(
    () => client.mergePullRequest(REPO, 42, { strategy: 'rebase', deleteSourceBranch: false }),
    /Bitbucket has no true rebase-and-merge/,
  );
});

test('getPullRequestDiff: fetches raw diff text from /diff and stats from /diffstat', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pullrequests/33/diff')) {
      return textResponse('diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1,2 @@\n+x');
    }
    if (url.endsWith('/pullrequests/33/diffstat')) {
      return jsonResponse({
        values: [{ status: 'modified', lines_added: 2, lines_removed: 1, old: { path: 'src/a.ts' }, new: { path: 'src/a.ts' } }],
      });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 33);
  assert.match(result.diff, /diff --git a\/src\/a\.ts/);
  assert.deepEqual(result.files, [{ path: 'src/a.ts', insertions: 2, deletions: 1, binary: false }]);
});

test('getPullRequestDiff: a removed file has no "new" path, falls back to "old"', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/pullrequests/34/diff')) {
      return textResponse('');
    }
    if (url.endsWith('/pullrequests/34/diffstat')) {
      return jsonResponse({ values: [{ status: 'removed', lines_added: 0, lines_removed: 5, old: { path: 'gone.ts' }, new: null }] });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 34);
  assert.deepEqual(result.files, [{ path: 'gone.ts', insertions: 0, deletions: 5, binary: false }]);
});

test('submitReview: POSTs to /approve for an approve decision', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 35, 'approve');
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/35/approve');
  assert.equal(capturedInit?.method, 'POST');
});

test('submitReview: POSTs to /request-changes for a requestChanges decision', async () => {
  let capturedUrl: string | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    capturedUrl = url;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 36, 'requestChanges');
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/36/request-changes');
});

test('addComment: POSTs content.raw to the comments endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.addComment(REPO, 37, 'Looks good');
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/37/comments');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ content: { raw: 'Looks good' } }));
});

test('listConversationThreads: only top-level comments (no parent) are returned — a reply is not its own thread', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests/38/comments': {
        values: [
          { id: 1, content: { raw: 'Fix this' }, user: { username: 'amy' } },
          { id: 2, content: { raw: 'On it' }, user: { username: 'raj' }, parent: { id: 1 } },
          { id: 3, content: { raw: 'Already fine' }, user: { username: 'raj' }, resolution: { user: { username: 'raj' } } },
        ],
      },
    }),
  );
  const result = await client.listConversationThreads(REPO, 38);
  assert.deepEqual(result, [
    { id: '1', body: 'Fix this', authorLogin: 'amy', resolved: false },
    { id: '3', body: 'Already fine', authorLogin: 'raj', resolved: true },
  ]);
});

test('listConversationThreads: surfaces the file/line an inline comment is anchored to', async () => {
  const client = new BitbucketClient(
    BASE,
    'tok',
    fakeFetch({
      'pullrequests/38/comments': {
        values: [{ id: 1, content: { raw: 'Fix this' }, user: { username: 'amy' }, inline: { path: 'src/a.ts', to: 42 } }],
      },
    }),
  );
  const result = await client.listConversationThreads(REPO, 38);
  assert.deepEqual(result, [{ id: '1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'src/a.ts', line: 42 }]);
});

test('resolveConversationThread: POSTs to /comments/{id}/resolve', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.resolveConversationThread(REPO, 38, '1');
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/38/comments/1/resolve');
  assert.equal(capturedInit?.method, 'POST');
});

test('createPullRequest: POSTs source/destination branch objects to the pullrequests endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new BitbucketClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      id: 50,
      title: 'Add feature',
      links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/50' } },
      author: { username: 'raj' },
      created_on: 'c',
      updated_on: 'u',
    });
  }) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'Add feature', base: 'main', compare: 'feature-x', draft: false });
  assert.equal(capturedUrl, 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    capturedInit?.body,
    JSON.stringify({ title: 'Add feature', source: { branch: { name: 'feature-x' } }, destination: { branch: { name: 'main' } } }),
  );
  assert.equal(result.number, 50);
  assert.equal(result.isDraft, false);
});

test('createPullRequest: draft throws a platform-gap error — Bitbucket Cloud has no draft pull requests', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => {
    throw new Error('should never call the network for this');
  }) as unknown as typeof fetch);
  await assert.rejects(
    () => client.createPullRequest(REPO, { title: 'x', base: 'main', compare: 'feature', draft: true }),
    /Bitbucket Cloud has no draft pull requests/,
  );
});

// ── A2-specific tests ─────────────────────────────────────────────────────

test('A2: 401 from list endpoint throws ForgeHttpError with isCredentialRejection=true', async () => {
  const client = new BitbucketClient(BASE, 'bad', (async () => new Response('{}', { status: 401 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), true);
      return true;
    },
  );
});

test('A2: 503 from list endpoint throws but isCredentialRejection=false', async () => {
  const client = new BitbucketClient(BASE, 'tok', (async () => new Response('{}', { status: 503 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), false);
      return true;
    },
  );
});

test('A2: Bitbucket: Authorization header always present in outgoing requests', async () => {
  let capturedHeaders: Record<string, string> = {};
  const client = new BitbucketClient(BASE, 'mytoken', (async (_url: string, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return jsonResponse({ username: 'raj' });
  }) as typeof fetch);
  await client.getAuthenticatedLogin();
  assert.equal(capturedHeaders['Authorization'], 'Bearer mytoken');
});

// ── A4: Pagination and bounded fan-out ─────────────────────────────────────

function makeBbPr(id: number) {
  return {
    id,
    title: `PR ${id}`,
    links: { html: { href: `https://bitbucket.org/org/repo/pull-requests/${id}` } },
    author: { account_id: `user-${id}`, nickname: 'alice', uuid: '{uuid-alice}' },
    created_on: '2024-01-01T00:00:00.000000+00:00',
    updated_on: '2024-01-01T00:00:00.000000+00:00',
    source: { commit: { hash: `sha${id}` }, branch: { name: 'feature' }, repository: { full_name: 'org/repo' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'org/repo' } },
    participants: [],
  };
}

test('A4: listOpenPullRequests follows body.next — 101 PRs across 2 pages all returned', async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => makeBbPr(i + 1));
  const page2 = Array.from({ length: 51 }, (_, i) => makeBbPr(51 + i));
  const page2Url = `${BASE}/repositories/org/repo/pullrequests?state=OPEN&pagelen=50&page=2`;

  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    if (url.includes('/pullrequests?state=OPEN&pagelen=50') && !url.includes('page=2')) {
      return new Response(JSON.stringify({ values: page1, next: page2Url }), { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    }
    if (url === page2Url) {
      return new Response(JSON.stringify({ values: page2 }), { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    }
    // Enrich calls
    if (url.includes('/commit/') && url.includes('/statuses')) return jsonResponse({ values: [] });
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 101, 'must return all 101 PRs across both pages');
});

test('A4: enrich fan-out is bounded — concurrent enrichment calls stay within limit', async () => {
  let concurrentEnrichs = 0;
  let maxConcurrentEnrichs = 0;

  const client = new BitbucketClient(BASE, 'tok', (async (url: string) => {
    if (url.includes('/pullrequests?state=OPEN&pagelen=50')) {
      return new Response(JSON.stringify({ values: Array.from({ length: 20 }, (_, i) => makeBbPr(i + 1)) }), { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/commit/') && url.includes('/statuses')) {
      concurrentEnrichs++;
      maxConcurrentEnrichs = Math.max(maxConcurrentEnrichs, concurrentEnrichs);
      await new Promise((r) => setTimeout(r, 10));
      concurrentEnrichs--;
      return jsonResponse({ values: [] });
    }
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  await client.listOpenPullRequests(REPO);
  assert.ok(maxConcurrentEnrichs <= 6, `max concurrent enrichments should be ≤ 6, was ${maxConcurrentEnrichs}`);
  assert.ok(maxConcurrentEnrichs > 1, 'must use some concurrency (not fully serial)');
});
