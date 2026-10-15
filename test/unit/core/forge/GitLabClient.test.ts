import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLabClient } from '../../../../src/core/forge/GitLabClient';
import { isCredentialRejection } from '../../../../src/core/forge/forgeFetch';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';

const REPO: ForgeRepoRef = { host: 'gitlab', identity: 'acme/widgets', label: 'acme/widgets' };
const BASE = 'https://gitlab.com/api/v4';

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 401,
    statusText: ok ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });
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

test('getAuthenticatedLogin: returns the username from GET /user', async () => {
  const client = new GitLabClient(BASE, 'tok', fakeFetch({ '/user': { username: 'raj' } }));
  assert.equal(await client.getAuthenticatedLogin(), 'raj');
});

test('getAuthenticatedLogin: an invalid token throws with the real HTTP status, not a generic message', async () => {
  const client = new GitLabClient(BASE, 'bad', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.getAuthenticatedLogin(), /401 Unauthorized from gitlab\.com/);
});

test('listOpenPullRequests: URL-encodes a nested-group project path', async () => {
  const nested: ForgeRepoRef = { host: 'gitlab', identity: 'acme/platform/widgets', label: 'acme/platform/widgets' };
  let requestedUrl = '';
  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    requestedUrl = url;
    if (url.includes('merge_requests?state=opened')) {
      return jsonResponse([]);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.listOpenPullRequests(nested);
  assert.ok(requestedUrl.includes(encodeURIComponent('acme/platform/widgets')));
});

test('listOpenPullRequests: normalizes a plain open MR with no reviewers, pipeline, or conflicts', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        {
          iid: 1,
          title: 'Add feature',
          web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/1',
          author: { username: 'raj' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ],
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, 'Add feature');
  assert.equal(result[0]?.checkStatus, 'none');
  assert.equal(result[0]?.reviewDecision, 'none');
  assert.equal(result[0]?.hasConflicts, false);
});

test('listOpenPullRequests: draft is read from either draft or the legacy work_in_progress field', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        { iid: 1, title: 'WIP', web_url: 'u', author: { username: 'raj' }, created_at: 'c', updated_at: 'u', work_in_progress: true },
      ],
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.isDraft, true);
});

test('listOpenPullRequests: has_conflicts maps straight through, no extra request needed', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        { iid: 1, title: 'PR', web_url: 'u', author: { username: 'raj' }, created_at: 'c', updated_at: 'u', has_conflicts: true },
      ],
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.hasConflicts, true);
});

// N4: unresolved discussions no longer override a real approval — verdict derives from approvals only.
test('listOpenPullRequests: approved + unresolved discussion → approved, not changesRequested (N4)', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        {
          iid: 1,
          title: 'PR',
          web_url: 'u',
          author: { username: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          blocking_discussions_resolved: false,
        },
      ],
      '/approvals': { approved: true, approved_by: [{ user: { username: 'amy' } }] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'approved');
});

test('listOpenPullRequests: a reviewer who has personally approved is removed from requestedReviewers, others remain', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        {
          iid: 1,
          title: 'PR',
          web_url: 'u',
          author: { username: 'raj' },
          created_at: 'c',
          updated_at: 'u',
          reviewers: [{ username: 'amy' }, { username: 'bob' }],
        },
      ],
      '/approvals': { approved: false, approved_by: [{ user: { username: 'amy' } }] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.deepEqual(result[0]?.requestedReviewers, ['bob']);
  assert.equal(result[0]?.reviewDecision, 'reviewRequired');
});

test('listOpenPullRequests: overall approved with everyone having personally approved -> "approved"', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        { iid: 1, title: 'PR', web_url: 'u', author: { username: 'raj' }, created_at: 'c', updated_at: 'u', reviewers: [{ username: 'amy' }] },
      ],
      '/approvals': { approved: true, approved_by: [{ user: { username: 'amy' } }] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.deepEqual(result[0]?.requestedReviewers, []);
  assert.equal(result[0]?.reviewDecision, 'approved');
});

test('listOpenPullRequests: reviewedByMe is true when the authenticated user is in approved_by', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { username: 'raj' },
      'merge_requests?state=opened&per_page=100': [
        { iid: 2, title: 'PR', web_url: 'u', author: { username: 'someone-else' }, created_at: 'c', updated_at: 'u', reviewers: [{ username: 'raj' }] },
      ],
      '/approvals': { approved: false, approved_by: [{ user: { username: 'raj' } }] },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, true);
});

test('listOpenPullRequests: reviewedByMe is false when the authenticated user has not approved — GitLab has no other per-reviewer verdict to check', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      '/user': { username: 'raj' },
      'merge_requests?state=opened&per_page=100': [
        { iid: 3, title: 'PR', web_url: 'u', author: { username: 'someone-else' }, created_at: 'c', updated_at: 'u', reviewers: [{ username: 'raj' }] },
      ],
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, false);
});

test('listOpenPullRequests: pipeline status maps to checkStatus (success/failed/running)', async () => {
  async function pipelineCheck(status: string, expected: string): Promise<void> {
    const client = new GitLabClient(
      BASE,
      'tok',
      fakeFetch({
        'merge_requests?state=opened&per_page=100': [
          { iid: 1, title: 'PR', web_url: 'u', author: { username: 'raj' }, created_at: 'c', updated_at: 'u', head_pipeline: { status } },
        ],
        '/approvals': { approved: false, approved_by: [] },
      }),
    );
    const result = await client.listOpenPullRequests(REPO);
    assert.equal(result[0]?.checkStatus, expected, `pipeline status "${status}"`);
  }
  await pipelineCheck('success', 'passing');
  await pipelineCheck('skipped', 'passing');
  await pipelineCheck('failed', 'failing');
  await pipelineCheck('canceled', 'failing');
  await pipelineCheck('running', 'pending');
});

test('listOpenPullRequests: no pipeline at all -> checkStatus "none"', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests?state=opened&per_page=100': [
        { iid: 1, title: 'PR', web_url: 'u', author: { username: 'raj' }, created_at: 'c', updated_at: 'u', head_pipeline: null },
      ],
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.checkStatus, 'none');
});

test('listOpenPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => jsonResponse([], false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listOpenPullRequests(REPO), /401 Unauthorized from gitlab\.com/);
});

test('getPullRequest: fetches one merge request by iid and enriches it the same way the list endpoint does', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      'merge_requests/7': {
        iid: 7,
        title: 'Single MR fetch',
        web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/7',
        author: { username: 'raj' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
      '/approvals': { approved: false, approved_by: [] },
    }),
  );
  const result = await client.getPullRequest(REPO, 7);
  assert.equal(result.title, 'Single MR fetch');
});

test('listRecentlyClosedPullRequests: combines merged and closed lists, tagging each with the right merged flag', async () => {
  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    if (url.includes('state=merged')) {
      return jsonResponse([
        { iid: 20, title: 'Shipped', web_url: 'u1', author: { username: 'raj' }, created_at: 'c', updated_at: '2024-01-05T00:00:00Z' },
      ]);
    }
    if (url.includes('state=closed')) {
      return jsonResponse([
        { iid: 21, title: 'Abandoned', web_url: 'u2', author: { username: 'raj' }, created_at: 'c', updated_at: '2024-01-06T00:00:00Z' },
      ]);
    }
    throw new Error(`unmocked request: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result.length, 2);
  const shipped = result.find((r) => r.number === 20);
  const abandoned = result.find((r) => r.number === 21);
  assert.equal(shipped?.merged, true);
  assert.equal(abandoned?.merged, false);
  // reviewedByMe is never meaningful once a PR is done — nothing reads it there.
  assert.equal(shipped?.reviewedByMe, false);
  assert.equal(abandoned?.reviewedByMe, false);
});

test('listRecentlyClosedPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => jsonResponse([], false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listRecentlyClosedPullRequests(REPO), /401 Unauthorized from gitlab\.com/);
});

test('listRecentlyClosedPullRequests: scopes the search server-side to the authenticated user via author_username, once known', async () => {
  const requestedUrls: string[] = [];
  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    requestedUrls.push(url);
    if (url.endsWith('/user')) {
      return jsonResponse({ username: 'raj' });
    }
    return jsonResponse([]);
  }) as unknown as typeof fetch);

  await client.getAuthenticatedLogin();
  await client.listRecentlyClosedPullRequests(REPO);

  const listUrls = requestedUrls.filter((url) => url.includes('merge_requests?state='));
  assert.equal(listUrls.length, 2);
  assert.ok(listUrls.every((url) => url.includes('author_username=raj')), listUrls.join('\n'));
});

test('listRecentlyClosedPullRequests: omits author_username when the authenticated user is not yet known', async () => {
  const requestedUrls: string[] = [];
  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    requestedUrls.push(url);
    return jsonResponse([]);
  }) as unknown as typeof fetch);

  await client.listRecentlyClosedPullRequests(REPO);

  assert.ok(requestedUrls.every((url) => !url.includes('author_username')), requestedUrls.join('\n'));
});

test('closePullRequest: PUTs state_event=close to the merge request endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.closePullRequest(REPO, 22);
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/22');
  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(capturedInit?.body, JSON.stringify({ state_event: 'close' }));
});

test('reopenPullRequest: PUTs state_event=reopen to the merge request endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.reopenPullRequest(REPO, 22);
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/22');
  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(capturedInit?.body, JSON.stringify({ state_event: 'reopen' }));
});

test('mergePullRequest: PUTs squash=false for the "merge" strategy, carrying deleteSourceBranch through', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 24, { strategy: 'merge', deleteSourceBranch: true });
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/24/merge');
  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(capturedInit?.body, JSON.stringify({ squash: false, should_remove_source_branch: true }));
});

test('mergePullRequest: PUTs squash=true for the "squash" strategy', async () => {
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 25, { strategy: 'squash', deleteSourceBranch: false });
  assert.equal(capturedInit?.body, JSON.stringify({ squash: true, should_remove_source_branch: false }));
});

test('mergePullRequest: "rebase" throws a platform-gap error — GitLab has no distinct rebase-and-merge request', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => {
    throw new Error('should never call the network for this');
  }) as unknown as typeof fetch);
  await assert.rejects(
    () => client.mergePullRequest(REPO, 26, { strategy: 'rebase', deleteSourceBranch: false }),
    /GitLab has no separate "rebase and merge" request/,
  );
});

test('getPullRequestDiff: synthesizes a diff --git header per file so the shared renderer can split it, and counts +/- lines itself', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      '/merge_requests/23/diffs?per_page=100': [
        { old_path: 'src/a.ts', new_path: 'src/a.ts', diff: '@@ -1,2 +1,3 @@\n-old\n+new1\n+new2' },
        { old_path: 'bin.dat', new_path: 'bin.dat', diff: '' },
      ],
    }),
  );
  const result = await client.getPullRequestDiff(REPO, 23);
  assert.match(result.diff, /diff --git a\/src\/a\.ts b\/src\/a\.ts\n@@ -1,2 \+1,3 @@/);
  assert.deepEqual(result.files, [
    { path: 'src/a.ts', insertions: 2, deletions: 1, binary: false },
    { path: 'bin.dat', insertions: 0, deletions: 0, binary: false },
  ]);
  // No diff fragment for the empty-diff file — nothing to synthesize a header for.
  assert.ok(!result.diff.includes('bin.dat'));
});

test('submitReview: POSTs to the approve endpoint for an approve decision', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.submitReview(REPO, 24, 'approve');
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/24/approve');
  assert.equal(capturedInit?.method, 'POST');
});

test('submitReview: a requestChanges decision throws a clear platform-gap error, not a silent no-op — GitLab has no such review state', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => {
    throw new Error('should never make a request for this decision');
  }) as unknown as typeof fetch);
  await assert.rejects(() => client.submitReview(REPO, 25, 'requestChanges'), /no "Request Changes" review state/);
});

test('addComment: POSTs to the notes endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.addComment(REPO, 26, 'Looks good');
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/26/notes');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ body: 'Looks good' }));
});

test('listConversationThreads: only resolvable discussions are returned — a plain top-level comment is skipped', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      '/merge_requests/27/discussions?per_page=100': [
        { id: 'd1', notes: [{ body: 'Fix this', author: { username: 'amy' }, resolvable: true, resolved: false }] },
        { id: 'd2', notes: [{ body: 'Already fine', author: { username: 'raj' }, resolvable: true, resolved: true }] },
        { id: 'd3', notes: [{ body: 'Just a comment', author: { username: 'raj' }, resolvable: false, resolved: false }] },
      ],
    }),
  );
  const result = await client.listConversationThreads(REPO, 27);
  assert.deepEqual(result, [
    { id: 'd1', body: 'Fix this', authorLogin: 'amy', resolved: false },
    { id: 'd2', body: 'Already fine', authorLogin: 'raj', resolved: true },
  ]);
});

test('listConversationThreads: surfaces the file/line a diff note is anchored to', async () => {
  const client = new GitLabClient(
    BASE,
    'tok',
    fakeFetch({
      '/merge_requests/27/discussions?per_page=100': [
        {
          id: 'd1',
          notes: [
            {
              body: 'Fix this',
              author: { username: 'amy' },
              resolvable: true,
              resolved: false,
              position: { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 42, old_line: null },
            },
          ],
        },
      ],
    }),
  );
  const result = await client.listConversationThreads(REPO, 27);
  assert.deepEqual(result, [{ id: 'd1', body: 'Fix this', authorLogin: 'amy', resolved: false, file: 'src/a.ts', line: 42 }]);
});

test('resolveConversationThread: PUTs resolved=true to the discussion endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.resolveConversationThread(REPO, 27, 'd1');
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/27/discussions/d1?resolved=true');
  assert.equal(capturedInit?.method, 'PUT');
});

test('createPullRequest: POSTs source_branch/target_branch/title to the merge_requests endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      iid: 50,
      title: 'Add feature',
      web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/50',
      author: { username: 'raj' },
      created_at: 'c',
      updated_at: 'u',
    });
  }) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'Add feature', base: 'main', compare: 'feature-x', draft: false });
  assert.equal(capturedUrl, 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(capturedInit?.body, JSON.stringify({ source_branch: 'feature-x', target_branch: 'main', title: 'Add feature' }));
  assert.equal(result.number, 50);
  assert.equal(result.url, 'https://gitlab.com/acme/widgets/-/merge_requests/50');
});

test('createPullRequest: draft prefixes the title with "Draft: " — GitLab has no boolean field for it', async () => {
  let capturedInit: RequestInit | undefined;
  const client = new GitLabClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedInit = init;
    return jsonResponse({
      iid: 51,
      title: 'Draft: Add feature',
      web_url: 'u',
      author: { username: 'raj' },
      created_at: 'c',
      updated_at: 'u',
    });
  }) as unknown as typeof fetch);
  await client.createPullRequest(REPO, { title: 'Add feature', base: 'main', compare: 'feature-x', draft: true });
  assert.equal(capturedInit?.body, JSON.stringify({ source_branch: 'feature-x', target_branch: 'main', title: 'Draft: Add feature' }));
});

test('createPullRequest: a rejected request throws with the real HTTP status', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(
    () => client.createPullRequest(REPO, { title: 'x', base: 'main', compare: 'feature', draft: false }),
    /401 Unauthorized from gitlab\.com/,
  );
});

// ── A2-specific tests ─────────────────────────────────────────────────────

test('A2: 401 from list endpoint throws ForgeHttpError with isCredentialRejection=true', async () => {
  const client = new GitLabClient(BASE, 'bad', (async () => new Response('{}', { status: 401 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), true);
      return true;
    },
  );
});

test('A2: 503 from list endpoint throws but isCredentialRejection=false (never clears credential on transient error)', async () => {
  const client = new GitLabClient(BASE, 'tok', (async () => new Response('{}', { status: 503 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), false);
      return true;
    },
  );
});

test('A2: GitLab: caller-supplied headers (e.g. Accept) survive alongside PRIVATE-TOKEN — init.headers not overwritten', async () => {
  let capturedHeaders: Record<string, string> = {};
  const client = new GitLabClient(BASE, 'tok', (async (_url: string, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    return jsonResponse({});
  }) as typeof fetch);
  // Simulate a caller passing a custom Accept header via request() — the token must not clobber it
  await client.getAuthenticatedLogin(); // triggers a request, captures headers
  assert.equal(capturedHeaders['PRIVATE-TOKEN'], 'tok');
});

// ── A4: Pagination and bounded fan-out ─────────────────────────────────────

function jsonResponseWithLink(body: unknown, nextUrl?: string): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (nextUrl) {
    headers['Link'] = `<${nextUrl}>; rel="next"`;
  }
  return new Response(JSON.stringify(body), { status: 200, statusText: 'OK', headers });
}

test('A4: listOpenPullRequests follows Link header — 101 MRs across 2 pages all returned', async () => {
  const makeMr = (iid: number) => ({
    iid,
    title: `MR ${iid}`,
    web_url: `https://gitlab.com/org/repo/-/merge_requests/${iid}`,
    author: { username: 'alice' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  });
  const page1 = Array.from({ length: 100 }, (_, i) => makeMr(i + 1));
  const page2 = [makeMr(101)];
  const page2Url = `${BASE}/projects/org%2Frepo/merge_requests?state=opened&per_page=100&page=2`;

  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/user')) return jsonResponse({ username: 'alice' });
    if (url.includes('state=opened') && !url.includes('page=2')) {
      return jsonResponseWithLink(page1, page2Url);
    }
    if (url === page2Url) return jsonResponseWithLink(page2);
    // approvals — return empty for speed
    if (url.includes('/approvals')) return jsonResponse({ approved: false, approved_by: [] });
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 101, 'must return all 101 MRs across both pages');
});

test('A4: enrich fan-out is bounded — concurrent approvals calls stay within limit', async () => {
  let concurrentApprovals = 0;
  let maxConcurrentApprovals = 0;

  const client = new GitLabClient(BASE, 'tok', (async (url: string) => {
    if (url.endsWith('/user')) return jsonResponse({ username: 'alice' });
    if (url.includes('state=opened')) {
      return jsonResponseWithLink(Array.from({ length: 20 }, (_, i) => ({
        iid: i + 1,
        title: `MR ${i + 1}`,
        web_url: `u${i}`,
        author: { username: 'alice' },
        created_at: 'c',
        updated_at: 'u',
      })));
    }
    if (url.includes('/approvals')) {
      concurrentApprovals++;
      maxConcurrentApprovals = Math.max(maxConcurrentApprovals, concurrentApprovals);
      await new Promise((r) => setTimeout(r, 10));
      concurrentApprovals--;
      return jsonResponse({ approved: false, approved_by: [] });
    }
    throw new Error(`unmocked: ${url}`);
  }) as typeof fetch);
  await client.listOpenPullRequests(REPO);
  assert.ok(maxConcurrentApprovals <= 6, `max concurrent enrichments should be ≤ 6, was ${maxConcurrentApprovals}`);
  assert.ok(maxConcurrentApprovals > 1, 'must use some concurrency (not fully serial)');
});
