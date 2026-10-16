/**
 * F2.1 – per-host unit tests for `findPullRequestForCommit`.
 * Each test asserts: exact request (method + URL + body where applicable), merged-preferred over
 * open, null when the array is empty, and 404 ⇒ null while other HTTP errors throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../../../../src/core/forge/GitHubClient';
import { GitLabClient } from '../../../../src/core/forge/GitLabClient';
import { BitbucketClient } from '../../../../src/core/forge/BitbucketClient';
import { AzureDevOpsClient } from '../../../../src/core/forge/AzureDevOpsClient';
import { buildAzureDevOpsIdentity } from '../../../../src/core/forge/azureDevOpsIdentity';
import type { ForgeRepoRef } from '../../../../src/core/forge/types';

// ─── helpers ────────────────────────────────────────────────────────────────

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function jsonErr(status: number): Response {
  return new Response(JSON.stringify({ message: 'error' }), { status, statusText: 'Error' });
}

const SHA = 'abc1234def5678901234567890abcdef01234567';

// ─── GitHub ─────────────────────────────────────────────────────────────────

const GH_REPO: ForgeRepoRef = { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' };

test('GitHub findPullRequestForCommit: sends GET /repos/{r}/commits/{sha}/pulls, prefers merged PR', async () => {
  let capturedUrl = '';
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    (async (url: string) => {
      capturedUrl = url;
      return jsonOk([
        { number: 42, title: 'Merged PR', html_url: 'https://github.com/acme/widgets/pull/42', merged_at: '2024-01-10T00:00:00Z' },
        { number: 1, title: 'Open PR', html_url: 'https://github.com/acme/widgets/pull/1', merged_at: null },
      ]);
    }) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(GH_REPO, SHA);
  assert.equal(capturedUrl, `https://api.github.com/repos/acme/widgets/commits/${SHA}/pulls?per_page=100`);
  assert.deepEqual(result, { number: 42, title: 'Merged PR', url: 'https://github.com/acme/widgets/pull/42' });
});

test('GitHub findPullRequestForCommit: returns first PR when none is merged', async () => {
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    (async () => jsonOk([
      { number: 7, title: 'Open PR', html_url: 'https://github.com/acme/widgets/pull/7', merged_at: null },
    ])) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(GH_REPO, SHA);
  assert.deepEqual(result, { number: 7, title: 'Open PR', url: 'https://github.com/acme/widgets/pull/7' });
});

test('GitHub findPullRequestForCommit: returns null when array is empty', async () => {
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    (async () => jsonOk([])) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(GH_REPO, SHA), null);
});

test('GitHub findPullRequestForCommit: 404 ⇒ null (commit not known to the host)', async () => {
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    (async () => jsonErr(404)) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(GH_REPO, SHA), null);
});

test('GitHub findPullRequestForCommit: 401 throws (not silently null)', async () => {
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    (async () => jsonErr(401)) as typeof fetch,
  );
  await assert.rejects(() => client.findPullRequestForCommit(GH_REPO, SHA), /401/);
});

test('GitHub findPullRequestForCommit: 429 throws (rate limit not silenced)', async () => {
  const client = new GitHubClient(
    'https://api.github.com',
    'tok',
    // 429 with no retry-after; forgeFetch will not retry a first exhausted attempt
    (async () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })) as typeof fetch,
  );
  await assert.rejects(() => client.findPullRequestForCommit(GH_REPO, SHA), /429|rateLimited/i);
});

// ─── GitLab ─────────────────────────────────────────────────────────────────

const GL_REPO: ForgeRepoRef = { host: 'gitlab', identity: 'acme/widgets', label: 'acme/widgets' };

test('GitLab findPullRequestForCommit: sends GET /projects/:id/repository/commits/:sha/merge_requests, prefers merged', async () => {
  let capturedUrl = '';
  const client = new GitLabClient(
    'https://gitlab.com/api/v4',
    'tok',
    (async (url: string) => {
      capturedUrl = url;
      return jsonOk([
        { iid: 10, title: 'Open MR', web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/10', state: 'opened' },
        { iid: 5, title: 'Merged MR', web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/5', state: 'merged' },
      ]);
    }) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(GL_REPO, SHA);
  assert.equal(
    capturedUrl,
    `https://gitlab.com/api/v4/projects/acme%2Fwidgets/repository/commits/${SHA}/merge_requests?per_page=100`,
  );
  assert.deepEqual(result, { number: 5, title: 'Merged MR', url: 'https://gitlab.com/acme/widgets/-/merge_requests/5' });
});

test('GitLab findPullRequestForCommit: returns null when array is empty', async () => {
  const client = new GitLabClient(
    'https://gitlab.com/api/v4',
    'tok',
    (async () => jsonOk([])) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(GL_REPO, SHA), null);
});

test('GitLab findPullRequestForCommit: 404 ⇒ null', async () => {
  const client = new GitLabClient(
    'https://gitlab.com/api/v4',
    'tok',
    (async () => jsonErr(404)) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(GL_REPO, SHA), null);
});

test('GitLab findPullRequestForCommit: 403 throws', async () => {
  const client = new GitLabClient(
    'https://gitlab.com/api/v4',
    'tok',
    (async () => jsonErr(403)) as typeof fetch,
  );
  await assert.rejects(() => client.findPullRequestForCommit(GL_REPO, SHA), /403/);
});

// ─── Bitbucket ───────────────────────────────────────────────────────────────

const BB_REPO: ForgeRepoRef = { host: 'bitbucket', identity: 'acme/widgets', label: 'acme/widgets' };

test('Bitbucket findPullRequestForCommit: sends GET /repositories/{r}/commit/{sha}/pullrequests, prefers MERGED', async () => {
  let capturedUrl = '';
  const client = new BitbucketClient(
    'https://api.bitbucket.org/2.0',
    'tok',
    (async (url: string) => {
      capturedUrl = url;
      return jsonOk({
        values: [
          { id: 3, title: 'Open PR', links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/3' } }, state: 'OPEN' },
          { id: 1, title: 'Merged PR', links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/1' } }, state: 'MERGED' },
        ],
      });
    }) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(BB_REPO, SHA);
  assert.equal(
    capturedUrl,
    `https://api.bitbucket.org/2.0/repositories/acme/widgets/commit/${SHA}/pullrequests?pagelen=50`,
  );
  assert.deepEqual(result, { number: 1, title: 'Merged PR', url: 'https://bitbucket.org/acme/widgets/pull-requests/1' });
});

test('Bitbucket findPullRequestForCommit: returns null when values is empty', async () => {
  const client = new BitbucketClient(
    'https://api.bitbucket.org/2.0',
    'tok',
    (async () => jsonOk({ values: [] })) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(BB_REPO, SHA), null);
});

test('Bitbucket findPullRequestForCommit: 404 ⇒ null', async () => {
  const client = new BitbucketClient(
    'https://api.bitbucket.org/2.0',
    'tok',
    (async () => jsonErr(404)) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(BB_REPO, SHA), null);
});

test('Bitbucket findPullRequestForCommit: 5xx throws', async () => {
  const client = new BitbucketClient(
    'https://api.bitbucket.org/2.0',
    'tok',
    (async () => jsonErr(500)) as typeof fetch,
  );
  await assert.rejects(() => client.findPullRequestForCommit(BB_REPO, SHA), /500/);
});

// ─── Azure DevOps ────────────────────────────────────────────────────────────

const ADO_IDENTITY = buildAzureDevOpsIdentity({ organization: 'acme', project: 'Proj', repository: 'widgets' });
const ADO_REPO: ForgeRepoRef = { host: 'azureDevOps', identity: ADO_IDENTITY, label: 'acme/Proj/widgets' };

test('Azure DevOps findPullRequestForCommit: sends POST .../pullrequestquery with two query types, prefers lastMergeCommit', async () => {
  let capturedUrl = '';
  let capturedBody = '';
  const client = new AzureDevOpsClient(
    ADO_IDENTITY,
    'pat',
    'pat',
    (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = (init?.body as string) ?? '';
      // results[0] = lastMergeCommit (merged), results[1] = commit (active)
      return jsonOk({
        results: [
          { [SHA]: [{ pullRequestId: 99, title: 'Merged PR' }] },
          { [SHA]: [{ pullRequestId: 3, title: 'Open PR' }] },
        ],
      });
    }) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(ADO_REPO, SHA);
  assert.match(capturedUrl, /pullrequestquery\?api-version=7\.1$/);
  const body = JSON.parse(capturedBody) as { queries: Array<{ type: string; items: string[] }> };
  assert.deepEqual(body.queries[0], { type: 'lastMergeCommit', items: [SHA] });
  assert.deepEqual(body.queries[1], { type: 'commit', items: [SHA] });
  // Prefers from results[0] (lastMergeCommit = merged PR)
  assert.deepEqual(result, {
    number: 99,
    title: 'Merged PR',
    url: `https://dev.azure.com/acme/Proj/_git/widgets/pullrequest/99`,
  });
});

test('Azure DevOps findPullRequestForCommit: falls through to commit type when lastMergeCommit empty', async () => {
  const client = new AzureDevOpsClient(
    ADO_IDENTITY,
    'pat',
    'pat',
    (async () => jsonOk({
      results: [
        { [SHA]: [] },
        { [SHA]: [{ pullRequestId: 3, title: 'Open PR' }] },
      ],
    })) as typeof fetch,
  );
  const result = await client.findPullRequestForCommit(ADO_REPO, SHA);
  assert.deepEqual(result, {
    number: 3,
    title: 'Open PR',
    url: `https://dev.azure.com/acme/Proj/_git/widgets/pullrequest/3`,
  });
});

test('Azure DevOps findPullRequestForCommit: returns null when both result sets are empty', async () => {
  const client = new AzureDevOpsClient(
    ADO_IDENTITY,
    'pat',
    'pat',
    (async () => jsonOk({
      results: [{ [SHA]: [] }, { [SHA]: [] }],
    })) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(ADO_REPO, SHA), null);
});

test('Azure DevOps findPullRequestForCommit: 404 ⇒ null', async () => {
  const client = new AzureDevOpsClient(
    ADO_IDENTITY,
    'pat',
    'pat',
    (async () => jsonErr(404)) as typeof fetch,
  );
  assert.equal(await client.findPullRequestForCommit(ADO_REPO, SHA), null);
});

test('Azure DevOps findPullRequestForCommit: 401 throws', async () => {
  const client = new AzureDevOpsClient(
    ADO_IDENTITY,
    'pat',
    'pat',
    (async () => jsonErr(401)) as typeof fetch,
  );
  await assert.rejects(() => client.findPullRequestForCommit(ADO_REPO, SHA), /401/);
});
