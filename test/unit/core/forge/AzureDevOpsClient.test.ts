import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureDevOpsClient } from '../../../../src/core/forge/AzureDevOpsClient';
import { buildAzureDevOpsIdentity } from '../../../../src/core/forge/azureDevOpsIdentity';
import { isCredentialRejection } from '../../../../src/core/forge/forgeFetch';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';

const IDENTITY = buildAzureDevOpsIdentity({ organization: 'acme', project: 'Widgets', repository: 'widgets-api' });
const REPO: ForgeRepoRef = { host: 'azureDevOps', identity: IDENTITY, label: 'acme/Widgets/widgets-api' };

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 401,
    statusText: ok ? 'OK' : 'Unauthorized',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Azure DevOps' Items API returns a file's raw content directly as the response body (not a JSON
 * envelope) when `$format=json` isn't requested — this mirrors that real behavior, including
 * `.json()` throwing a genuine `SyntaxError` on non-JSON text, the same way the real Fetch API's
 * `Response.json()` does. Using real `Response` means `.json()` actually parses, so a caller that
 * wrongly calls `.json()` on non-JSON text will throw the same SyntaxError as the real API does.
 */
function textResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    for (const [suffix, body] of Object.entries(routes)) {
      if (url.includes(suffix)) {
        return jsonResponse(body);
      }
    }
    throw new Error(`unmocked request: ${url}`);
  }) as typeof fetch;
}

test('getAuthenticatedLogin: reads emailAddress from the org-scoped vssps profile endpoint, not the legacy global host', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    (async (url: string) => {
      assert.ok(url.startsWith('https://vssps.dev.azure.com/acme/'), `expected the org-scoped profile host, got ${url}`);
      return jsonResponse({ emailAddress: 'raj@acme.com' });
    }) as unknown as typeof fetch,
  );
  assert.equal(await client.getAuthenticatedLogin(), 'raj@acme.com');
});

test('getAuthenticatedLogin: falls back to the global vssps host when the identity cannot be parsed', async () => {
  const client = new AzureDevOpsClient(
    'not-a-valid-identity',
    'pat',
    'pat',
    (async (url: string) => {
      assert.ok(url.startsWith('https://app.vssps.visualstudio.com/'), `expected the global profile host, got ${url}`);
      return jsonResponse({ emailAddress: 'raj@acme.com' });
    }) as unknown as typeof fetch,
  );
  assert.equal(await client.getAuthenticatedLogin(), 'raj@acme.com');
});

test('getAuthenticatedLogin: falls back to displayName when emailAddress is absent', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({ displayName: 'Raj Jadon' })) as unknown as typeof fetch);
  assert.equal(await client.getAuthenticatedLogin(), 'Raj Jadon');
});

test('getAuthenticatedLogin: an invalid PAT throws with the real HTTP status, not a generic message', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'bad', 'pat', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.getAuthenticatedLogin(), /401 Unauthorized from vssps\.dev\.azure\.com/);
});

test('credentialScheme "pat": sends the token as HTTP Basic with an empty username', async () => {
  let capturedAuth: string | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'my-pat', 'pat', (async (_url: string, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>).Authorization;
    return jsonResponse({ emailAddress: 'raj@acme.com' });
  }) as unknown as typeof fetch);
  await client.getAuthenticatedLogin();
  assert.equal(capturedAuth, `Basic ${Buffer.from(':my-pat').toString('base64')}`);
});

test('credentialScheme "oauth": sends the token as a Bearer, not Basic — a JWT can\'t be Basic-authed', async () => {
  let capturedAuth: string | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'aad-access-token', 'oauth', (async (_url: string, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>).Authorization;
    return jsonResponse({ emailAddress: 'raj@acme.com' });
  }) as unknown as typeof fetch);
  await client.getAuthenticatedLogin();
  assert.equal(capturedAuth, 'Bearer aad-access-token');
});

test('listOpenPullRequests: builds the repo URL from organization/project/repository, not owner/repo', async () => {
  let requestedListUrl = '';
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('pullrequests?searchCriteria.status=active')) {
      requestedListUrl = url;
      return jsonResponse({ value: [] });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.listOpenPullRequests(REPO);
  assert.ok(requestedListUrl.includes('/acme/Widgets/_apis/git/repositories/widgets-api/'), requestedListUrl);
});

test('listOpenPullRequests: a malformed identity (not 3 parts) returns an empty array rather than throwing', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({ value: [] })) as unknown as typeof fetch);
  const malformed: ForgeRepoRef = { host: 'azureDevOps', identity: 'acme/widgets-api', label: 'acme/widgets-api' };
  assert.deepEqual(await client.listOpenPullRequests(malformed), []);
});

test('listOpenPullRequests: normalizes a plain PR with no reviewers or statuses', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 1,
            title: 'Add feature',
            createdBy: { uniqueName: 'raj@acme.com' },
            creationDate: '2024-01-01T00:00:00Z',
          },
        ],
      },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.title, 'Add feature');
  assert.equal(result[0]?.authorLogin, 'raj@acme.com');
  assert.equal(result[0]?.url, 'https://dev.azure.com/acme/Widgets/_git/widgets-api/pullrequest/1');
  assert.equal(result[0]?.checkStatus, 'none');
  assert.equal(result[0]?.reviewDecision, 'none');
  assert.equal(result[0]?.hasConflicts, false);
});

test('listOpenPullRequests: a reviewer who rejected (vote -10) -> reviewDecision "changesRequested"', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 2,
            title: 'PR',
            createdBy: { uniqueName: 'raj@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'amy@acme.com', vote: -10 }],
          },
        ],
      },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'changesRequested');
  assert.deepEqual(result[0]?.requestedReviewers, ['amy@acme.com']);
});

test('listOpenPullRequests: a reviewer who has not voted (vote 0) -> "reviewRequired"', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 3,
            title: 'PR',
            createdBy: { uniqueName: 'raj@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'amy@acme.com', vote: 0 }],
          },
        ],
      },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'reviewRequired');
  assert.deepEqual(result[0]?.requestedReviewers, ['amy@acme.com']);
});

test('listOpenPullRequests: every reviewer approved (vote 10) -> "approved"', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 4,
            title: 'PR',
            createdBy: { uniqueName: 'raj@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'amy@acme.com', vote: 10 }],
          },
        ],
      },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewDecision, 'approved');
  assert.deepEqual(result[0]?.requestedReviewers, []);
});

test('listOpenPullRequests: reviewedByMe is true when the authenticated user has a real vote (not 0, not -5)', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'profile/profiles/me?api-version=7.1': { emailAddress: 'raj@acme.com' },
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 10,
            title: 'PR',
            createdBy: { uniqueName: 'someone-else@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'raj@acme.com', vote: 10 }],
          },
        ],
      },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, true);
});

test('listOpenPullRequests: reviewedByMe is false for a vote of -5 ("waiting for author") — the reviewer punted, not a real verdict', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'profile/profiles/me?api-version=7.1': { emailAddress: 'raj@acme.com' },
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 11,
            title: 'PR',
            createdBy: { uniqueName: 'someone-else@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'raj@acme.com', vote: -5 }],
          },
        ],
      },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, false);
});

test('listOpenPullRequests: reviewedByMe is false when the authenticated user has not voted at all (vote 0)', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'profile/profiles/me?api-version=7.1': { emailAddress: 'raj@acme.com' },
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 12,
            title: 'PR',
            createdBy: { uniqueName: 'someone-else@acme.com' },
            creationDate: 'c',
            reviewers: [{ uniqueName: 'raj@acme.com', vote: 0 }],
          },
        ],
      },
    }),
  );
  await client.getAuthenticatedLogin();
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.reviewedByMe, false);
});

test('listOpenPullRequests: mergeStatus "conflicts" -> hasConflicts true', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'searchCriteria.status=active&api-version=7.1': {
        value: [
          {
            pullRequestId: 5,
            title: 'PR',
            createdBy: { uniqueName: 'raj@acme.com' },
            creationDate: 'c',
            mergeStatus: 'conflicts',
          },
        ],
      },
    }),
  );
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result[0]?.hasConflicts, true);
});

test('listOpenPullRequests: status checks map to checkStatus (succeeded/failed/pending)', async () => {
  async function statusCheck(state: string, expected: string): Promise<void> {
    const client = new AzureDevOpsClient(
      IDENTITY,
      'pat',
      'pat',
      fakeFetch({
        'searchCriteria.status=active&api-version=7.1': {
          value: [
            {
              pullRequestId: 6,
              title: 'PR',
              createdBy: { uniqueName: 'raj@acme.com' },
              creationDate: 'c',
              lastMergeSourceCommit: { commitId: 'sha6' },
            },
          ],
        },
        '/statuses?api-version=7.1': { value: [{ state }] },
      }),
    );
    const result = await client.listOpenPullRequests(REPO);
    assert.equal(result[0]?.checkStatus, expected, `status state "${state}"`);
  }
  await statusCheck('succeeded', 'passing');
  await statusCheck('failed', 'failing');
  await statusCheck('error', 'failing');
  await statusCheck('pending', 'pending');
});

test('listOpenPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listOpenPullRequests(REPO), /401 Unauthorized from dev\.azure\.com/);
});

test('getPullRequest: fetches one PR by id and enriches it the same way the list endpoint does', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/pullrequests/7?api-version')) {
      return jsonResponse({
        pullRequestId: 7,
        title: 'Single PR fetch',
        createdBy: { uniqueName: 'raj@acme.com' },
        creationDate: '2024-01-01T00:00:00Z',
      });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequest(REPO, 7);
  assert.equal(result.title, 'Single PR fetch');
});

test('listRecentlyClosedPullRequests: combines completed and abandoned, tagging each with the right merged flag', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('searchCriteria.status=completed')) {
      return jsonResponse({
        value: [{ pullRequestId: 40, title: 'Shipped', createdBy: { uniqueName: 'raj@acme.com' }, creationDate: 'c' }],
      });
    }
    if (url.includes('searchCriteria.status=abandoned')) {
      return jsonResponse({
        value: [{ pullRequestId: 41, title: 'Abandoned', createdBy: { uniqueName: 'raj@acme.com' }, creationDate: 'c' }],
      });
    }
    throw new Error(`unmocked request: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.listRecentlyClosedPullRequests(REPO);
  assert.equal(result.length, 2);
  assert.equal(result.find((r) => r.number === 40)?.merged, true);
  assert.equal(result.find((r) => r.number === 41)?.merged, false);
  // reviewedByMe is never meaningful once a PR is done — nothing reads it there.
  assert.equal(result.find((r) => r.number === 40)?.reviewedByMe, false);
  assert.equal(result.find((r) => r.number === 41)?.reviewedByMe, false);
});

test('listRecentlyClosedPullRequests: a failed list request throws with the real status, not a silent empty array', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(() => client.listRecentlyClosedPullRequests(REPO), /401 Unauthorized from dev\.azure\.com/);
});

test('listRecentlyClosedPullRequests: scopes the search server-side to the authenticated user via searchCriteria.creatorId, once known', async () => {
  const requestedUrls: string[] = [];
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    requestedUrls.push(url);
    if (url.startsWith('https://vssps.dev.azure.com/')) {
      return jsonResponse({ id: 'user-guid-123', emailAddress: 'raj@acme.com' });
    }
    return jsonResponse({ value: [] });
  }) as unknown as typeof fetch);

  await client.getAuthenticatedLogin();
  await client.listRecentlyClosedPullRequests(REPO);

  const listUrls = requestedUrls.filter((url) => url.includes('searchCriteria.status='));
  assert.equal(listUrls.length, 2);
  assert.ok(listUrls.every((url) => url.includes('searchCriteria.creatorId=user-guid-123')), listUrls.join('\n'));
});

test('listRecentlyClosedPullRequests: omits creatorId when the authenticated user is not yet known', async () => {
  const requestedUrls: string[] = [];
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    requestedUrls.push(url);
    return jsonResponse({ value: [] });
  }) as unknown as typeof fetch);

  await client.listRecentlyClosedPullRequests(REPO);

  assert.ok(requestedUrls.every((url) => !url.includes('searchCriteria.creatorId')), requestedUrls.join('\n'));
});

test('closePullRequest: PATCHes status=abandoned to the pull request endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.closePullRequest(REPO, 42);
  assert.equal(
    capturedUrl,
    `https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests/42?api-version=7.1`,
  );
  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.body, JSON.stringify({ status: 'abandoned' }));
});

test('reopenPullRequest: PATCHes status=active to the pull request endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.reopenPullRequest(REPO, 42);
  assert.equal(
    capturedUrl,
    `https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests/42?api-version=7.1`,
  );
  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.body, JSON.stringify({ status: 'active' }));
});

test('mergePullRequest: fetches the PR fresh for its head commit, then PATCHes completed with the mapped strategy', async () => {
  const mapping: Array<['merge' | 'squash' | 'rebase', string]> = [
    ['merge', 'noFastForward'],
    ['squash', 'squash'],
    ['rebase', 'rebase'],
  ];
  for (const [strategy, azureStrategy] of mapping) {
    let patchBody: string | undefined;
    const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
      // `AzureDevOpsClient.request` always passes a real `init` object to `fetchImpl` (it merges
      // in headers even when the caller passed none), so the GET call's `init` is never actually
      // `undefined` here — `init?.method` (present only on the PATCH) is what distinguishes them.
      if (url.endsWith('/pullrequests/60?api-version=7.1') && !init?.method) {
        return jsonResponse({ lastMergeSourceCommit: { commitId: 'abc123' } });
      }
      if (url.endsWith('/pullrequests/60?api-version=7.1') && init?.method === 'PATCH') {
        patchBody = init.body as string;
        return jsonResponse({});
      }
      throw new Error(`unmocked: ${url}`);
    }) as unknown as typeof fetch);
    await client.mergePullRequest(REPO, 60, { strategy, deleteSourceBranch: false });
    assert.equal(
      patchBody,
      JSON.stringify({
        status: 'completed',
        lastMergeSourceCommit: { commitId: 'abc123' },
        completionOptions: { mergeStrategy: azureStrategy, deleteSourceBranch: false },
      }),
    );
  }
});

test('mergePullRequest: carries deleteSourceBranch through to completionOptions', async () => {
  let patchBody: string | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    if (!init?.method) {
      return jsonResponse({ lastMergeSourceCommit: { commitId: 'def456' } });
    }
    patchBody = init.body as string;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.mergePullRequest(REPO, 61, { strategy: 'squash', deleteSourceBranch: true });
  assert.match(patchBody ?? '', /"deleteSourceBranch":true/);
});

test('mergePullRequest: no lastMergeSourceCommit yet (still computing) throws a clear message instead of PATCHing garbage', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({})) as unknown as typeof fetch);
  await assert.rejects(
    () => client.mergePullRequest(REPO, 62, { strategy: 'merge', deleteSourceBranch: false }),
    /hasn't finished computing this pull request's mergeability yet/,
  );
});

test('mergePullRequest: a rejected completion PATCH throws with the real HTTP status', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (_url: string, init?: RequestInit) => {
    if (!init?.method) {
      return jsonResponse({ lastMergeSourceCommit: { commitId: 'abc123' } });
    }
    return jsonResponse({}, false);
  }) as unknown as typeof fetch);
  await assert.rejects(
    () => client.mergePullRequest(REPO, 63, { strategy: 'merge', deleteSourceBranch: false }),
    /401 Unauthorized from dev\.azure\.com/,
  );
});

test('getPullRequestDiff: no diff text is available — returns changed files (leading slash stripped) with 0/0 stats, not fabricated numbers', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1 }, { id: 2 }] });
    }
    if (url.includes('/iterations/2/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/src/a.ts' }, changeType: 'edit' }] });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 50);
  assert.equal(result.diff, '');
  assert.deepEqual(result.files, [{ path: 'src/a.ts', insertions: 0, deletions: 0, binary: false }]);
});

test('getPullRequestDiff: a change entry with no item.path (a folder-level entry, in practice) is skipped, not a crash', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1 }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({
        changeEntries: [
          { item: { path: '/src/a.ts' }, changeType: 'edit' },
          { changeType: 'edit' },
          { item: {}, changeType: 'edit' },
        ],
      });
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 60);
  assert.deepEqual(result.files, [{ path: 'src/a.ts', insertions: 0, deletions: 0, binary: false }]);
});

test('getPullRequestDiff: uses the latest iteration, not the first', async () => {
  const requestedUrls: string[] = [];
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    requestedUrls.push(url);
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    }
    return jsonResponse({ changeEntries: [] });
  }) as unknown as typeof fetch);
  await client.getPullRequestDiff(REPO, 51);
  assert.ok(requestedUrls.some((url) => url.includes('/iterations/3/changes')), requestedUrls.join('\n'));
});

/**
 * Real content-diffing tests: the latest iteration now also carries `sourceRefCommit`/
 * `commonRefCommit` (a real Azure DevOps API field this codebase wasn't reading before), which is
 * what unlocks fetching old/new blob content per changed file and diffing them client-side.
 */
test('getPullRequestDiff: diffs an edited text file using the merge-base and PR-head commit content', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/src/a.ts' }, changeType: 'edit' }] });
    }
    if (url.includes('path=%2Fsrc%2Fa.ts') && url.includes('version=base1')) {
      return textResponse('line1\nline2\nline3\n');
    }
    if (url.includes('path=%2Fsrc%2Fa.ts') && url.includes('version=head1')) {
      return textResponse('line1\nCHANGED\nline3\n');
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 50);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.path, 'src/a.ts');
  assert.equal(result.files[0]?.insertions, 1);
  assert.equal(result.files[0]?.deletions, 1);
  assert.equal(result.files[0]?.binary, false);
  assert.match(result.diff, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);
  assert.match(result.diff, /-line2/);
  assert.match(result.diff, /\+CHANGED/);
});

test('getPullRequestDiff: an added file is diffed as entirely new content, without fetching non-existent old content', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/src/new.ts' }, changeType: 'add' }] });
    }
    if (url.includes('version=base1')) {
      throw new Error(`must not fetch old content for an added file: ${url}`);
    }
    if (url.includes('path=%2Fsrc%2Fnew.ts') && url.includes('version=head1')) {
      return textResponse('export const x = 1;\n');
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 52);
  assert.equal(result.files[0]?.insertions, 1);
  assert.equal(result.files[0]?.deletions, 0);
  assert.match(result.diff, /\+export const x = 1;/);
});

test('getPullRequestDiff: a deleted file is diffed as entirely removed content, without fetching non-existent new content', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/src/old.ts' }, changeType: 'delete' }] });
    }
    if (url.includes('version=head1')) {
      throw new Error(`must not fetch new content for a deleted file: ${url}`);
    }
    if (url.includes('path=%2Fsrc%2Fold.ts') && url.includes('version=base1')) {
      return textResponse('export const y = 2;\n');
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 53);
  assert.equal(result.files[0]?.insertions, 0);
  assert.equal(result.files[0]?.deletions, 1);
  assert.match(result.diff, /-export const y = 2;/);
});

test('getPullRequestDiff: binary content (a NUL byte) is reported as binary, not diffed', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/assets/icon.png' }, changeType: 'edit' }] });
    }
    if (url.includes('version=base1')) {
      return textResponse('PNG\0\0\0old');
    }
    if (url.includes('version=head1')) {
      return textResponse('PNG\0\0\0new');
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 54);
  assert.equal(result.files[0]?.binary, true);
  assert.equal(result.files[0]?.insertions, 0);
  assert.equal(result.files[0]?.deletions, 0);
  assert.doesNotMatch(result.diff, /assets\/icon\.png/);
});

test('getPullRequestDiff: content over the size cap is listed but not diffed, same graceful degrade as an unreadable file', async () => {
  const hugeContent = 'x'.repeat(400_000);
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/generated/bundle.js' }, changeType: 'edit' }] });
    }
    if (url.includes('version=base1')) {
      return textResponse(hugeContent);
    }
    if (url.includes('version=head1')) {
      return textResponse(`${hugeContent}y`);
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 55);
  assert.equal(result.files[0]?.insertions, 0);
  assert.equal(result.files[0]?.deletions, 0);
  assert.doesNotMatch(result.diff, /generated\/bundle\.js/);
});

test('getPullRequestDiff: identical content (e.g. a pure rename) produces no hunks — falls back to "no textual diff" for that file', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('/iterations?api-version')) {
      return jsonResponse({ value: [{ id: 1, sourceRefCommit: { commitId: 'head1' }, commonRefCommit: { commitId: 'base1' } }] });
    }
    if (url.includes('/iterations/1/changes')) {
      return jsonResponse({ changeEntries: [{ item: { path: '/src/renamed.ts' }, changeType: 'rename' }] });
    }
    if (url.includes('version=base1') || url.includes('version=head1')) {
      return textResponse('unchanged content\n');
    }
    throw new Error(`unmocked: ${url}`);
  }) as unknown as typeof fetch);
  const result = await client.getPullRequestDiff(REPO, 56);
  assert.equal(result.files[0]?.insertions, 0);
  assert.equal(result.files[0]?.deletions, 0);
  assert.doesNotMatch(result.diff, /@@/);
});

test('submitReview: PUTs vote=10 to the authenticated user\'s own reviewer entry for an approve decision', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://vssps.dev.azure.com/')) {
      return jsonResponse({ id: 'user-guid-123', emailAddress: 'raj@acme.com' });
    }
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.getAuthenticatedLogin();
  await client.submitReview(REPO, 52, 'approve');
  assert.equal(
    capturedUrl,
    'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests/52/reviewers/user-guid-123?api-version=7.1',
  );
  assert.equal(capturedInit?.method, 'PUT');
  assert.equal(capturedInit?.body, JSON.stringify({ vote: 10 }));
});

test('submitReview: PUTs vote=-10 for a requestChanges decision', async () => {
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://vssps.dev.azure.com/')) {
      return jsonResponse({ id: 'user-guid-123' });
    }
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.getAuthenticatedLogin();
  await client.submitReview(REPO, 53, 'requestChanges');
  assert.equal(capturedInit?.body, JSON.stringify({ vote: -10 }));
});

test('submitReview: throws a clear error rather than a confusing 404 when the authenticated user isn\'t known yet', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({})) as unknown as typeof fetch);
  await assert.rejects(() => client.submitReview(REPO, 54, 'approve'), /not signed in yet/);
});

test('addComment: POSTs a new single-comment thread matching the documented shape', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.addComment(REPO, 55, 'Looks good');
  assert.equal(
    capturedUrl,
    'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests/55/threads?api-version=7.1',
  );
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    capturedInit?.body,
    JSON.stringify({ comments: [{ parentCommentId: 0, content: 'Looks good', commentType: 1 }], status: 1 }),
  );
});

test('listConversationThreads: excludes deleted threads and system-generated ones (vote-change notifications)', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'pullrequests/56/threads?api-version=7.1': {
        value: [
          { id: 1, status: 'active', comments: [{ content: 'Fix this', author: { uniqueName: 'amy@acme.com' }, commentType: 'text' }] },
          { id: 2, status: 'fixed', comments: [{ content: 'Already fine', author: { uniqueName: 'raj@acme.com' }, commentType: 'text' }] },
          { id: 3, status: 'closed', isDeleted: true, comments: [{ content: 'Deleted', author: { uniqueName: 'raj@acme.com' }, commentType: 'text' }] },
          { id: 4, status: 'active', comments: [{ content: 'raj voted 10', author: { uniqueName: 'raj@acme.com' }, commentType: 'system' }] },
        ],
      },
    }),
  );
  const result = await client.listConversationThreads(REPO, 56);
  assert.deepEqual(result, [
    { id: '1', body: 'Fix this', authorLogin: 'amy@acme.com', resolved: false },
    { id: '2', body: 'Already fine', authorLogin: 'raj@acme.com', resolved: true },
  ]);
});

test('listConversationThreads: surfaces the file/line a code thread is anchored to', async () => {
  const client = new AzureDevOpsClient(
    IDENTITY,
    'pat',
    'pat',
    fakeFetch({
      'pullrequests/56/threads?api-version=7.1': {
        value: [
          {
            id: 1,
            status: 'active',
            comments: [{ content: 'Fix this', author: { uniqueName: 'amy@acme.com' }, commentType: 'text' }],
            threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 42 } },
          },
        ],
      },
    }),
  );
  const result = await client.listConversationThreads(REPO, 56);
  assert.deepEqual(result, [{ id: '1', body: 'Fix this', authorLogin: 'amy@acme.com', resolved: false, file: '/src/a.ts', line: 42 }]);
});

test('resolveConversationThread: PATCHes status="fixed" (the enum name, not a number) to the thread endpoint', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({});
  }) as unknown as typeof fetch);
  await client.resolveConversationThread(REPO, 56, '1');
  assert.equal(
    capturedUrl,
    'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests/56/threads/1?api-version=7.1',
  );
  assert.equal(capturedInit?.method, 'PATCH');
  assert.equal(capturedInit?.body, JSON.stringify({ status: 'fixed' }));
});

test('createPullRequest: POSTs sourceRefName/targetRefName/isDraft with the refs/heads/ prefix', async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      pullRequestId: 70,
      title: 'Add feature',
      createdBy: { uniqueName: 'raj@acme.com' },
      creationDate: 'c',
      isDraft: true,
    });
  }) as unknown as typeof fetch);
  const result = await client.createPullRequest(REPO, { title: 'Add feature', base: 'main', compare: 'feature-x', draft: true });
  assert.equal(capturedUrl, 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api/pullrequests?api-version=7.1');
  assert.equal(capturedInit?.method, 'POST');
  assert.equal(
    capturedInit?.body,
    JSON.stringify({ sourceRefName: 'refs/heads/feature-x', targetRefName: 'refs/heads/main', title: 'Add feature', isDraft: true }),
  );
  assert.equal(result.number, 70);
  assert.equal(result.isDraft, true);
  assert.equal(result.url, 'https://dev.azure.com/acme/Widgets/_git/widgets-api/pullrequest/70');
});

test('createPullRequest: a rejected request throws with the real HTTP status', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async () => jsonResponse({}, false)) as unknown as typeof fetch);
  await assert.rejects(
    () => client.createPullRequest(REPO, { title: 'x', base: 'main', compare: 'feature', draft: false }),
    /401 Unauthorized from dev\.azure\.com/,
  );
});

// ── A2-specific tests ─────────────────────────────────────────────────────

test('A2: 401 from list endpoint throws ForgeHttpError with isCredentialRejection=true', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'bad', 'pat', (async () => new Response('{}', { status: 401 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), true);
      return true;
    },
  );
});

test('A2: 503 from list endpoint throws but isCredentialRejection=false', async () => {
  const client = new AzureDevOpsClient(IDENTITY, 'tok', 'pat', (async () => new Response('{}', { status: 503 })) as typeof fetch);
  await assert.rejects(
    () => client.listOpenPullRequests(REPO),
    (err: unknown) => {
      assert.equal(isCredentialRejection(err), false);
      return true;
    },
  );
});

test('A2: Azure DevOps: Authorization header present and Content-Type on requests with a body', async () => {
  let capturedHeaders: Record<string, string> = {};
  let capturedContentType = '';
  const client = new AzureDevOpsClient(IDENTITY, 'my-pat', 'pat', (async (_url: string, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) ?? {};
    capturedContentType = capturedHeaders['Content-Type'] ?? '';
    return jsonResponse({});
  }) as typeof fetch);
  await client.closePullRequest(REPO, 1);
  assert.ok(capturedHeaders['Authorization']?.startsWith('Basic '));
  assert.equal(capturedContentType, 'application/json');
});

// ── A4: Pagination and bounded fan-out ─────────────────────────────────────

function makeAdoPr(id: number) {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    createdBy: { uniqueName: `user${id}@acme.com` },
    creationDate: '2024-01-01T00:00:00Z',
  };
}

test('A4: listOpenPullRequests uses $top/$skip — 101 PRs across 2 pages all returned', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => makeAdoPr(i + 1));
  const page2 = [makeAdoPr(101)];
  const BASE_URL = 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets-api';

  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('searchCriteria.status=active') && url.includes('$skip=0')) {
      return jsonResponse({ value: page1 });
    }
    if (url.includes('searchCriteria.status=active') && url.includes('$skip=100')) {
      return jsonResponse({ value: page2 });
    }
    // Enrich calls — no reviewers, no statuses
    return jsonResponse({ value: [] });
  }) as typeof fetch);
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 101, 'must return all 101 PRs across both pages');
});

test('A4: listOpenPullRequests stops when a short page is returned', async () => {
  let callCount = 0;
  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('searchCriteria.status=active')) {
      callCount++;
      // Page 1 full (100 items), page 2 short (5 items)
      if (url.includes('$skip=0')) return jsonResponse({ value: Array.from({ length: 100 }, (_, i) => makeAdoPr(i + 1)) });
      if (url.includes('$skip=100')) return jsonResponse({ value: Array.from({ length: 5 }, (_, i) => makeAdoPr(101 + i)) });
    }
    return jsonResponse({ value: [] });
  }) as typeof fetch);
  const result = await client.listOpenPullRequests(REPO);
  assert.equal(result.length, 105);
  assert.equal(callCount, 2, 'should stop after the short page (2 requests total)');
});

test('A4: enrich fan-out is bounded — concurrent enrichment calls stay within limit', async () => {
  let concurrentEnrichs = 0;
  let maxConcurrentEnrichs = 0;

  // Provide PRs with lastMergeSourceCommit so enrich calls fetchStatuses (the only enrichment request)
  const prsWithCommit = Array.from({ length: 20 }, (_, i) => ({
    ...makeAdoPr(i + 1),
    lastMergeSourceCommit: { commitId: `sha${i + 1}` },
  }));

  const client = new AzureDevOpsClient(IDENTITY, 'pat', 'pat', (async (url: string) => {
    if (url.includes('searchCriteria.status=active')) {
      return jsonResponse({ value: prsWithCommit });
    }
    // Track concurrent statuses calls as proxy for enrich concurrency
    if (url.includes('/statuses')) {
      concurrentEnrichs++;
      maxConcurrentEnrichs = Math.max(maxConcurrentEnrichs, concurrentEnrichs);
      await new Promise((r) => setTimeout(r, 10));
      concurrentEnrichs--;
      return jsonResponse({ value: [] });
    }
    return jsonResponse({ value: [] });
  }) as typeof fetch);
  await client.listOpenPullRequests(REPO);
  assert.ok(maxConcurrentEnrichs <= 6, `max concurrent enrichments should be ≤ 6, was ${maxConcurrentEnrichs}`);
  assert.ok(maxConcurrentEnrichs > 1, 'must use some concurrency (not fully serial)');
});
