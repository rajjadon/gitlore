import type { FileChange } from '../git/types';
import type { ForgeClient } from './ForgeClient';
import type {
  CheckDetail,
  CheckStatus,
  ConversationThread,
  CreatePullRequestOptions,
  ForgeRepoRef,
  MergeOptions,
  PullRequestDiff,
  PullRequestSummary,
  ReviewDecision,
  ReviewSubmission,
  ThreadComment,
} from './types';
import { forgeFetch, ForgeHttpError, fetchAllPages, nextLinkFromHeader, mapWithConcurrency, sameLogin } from './forgeFetch';

/**
 * Fetches review threads with cursor-based pagination (100 per page) and all comments per thread.
 * `$after` is `null` for the first page, the previous `endCursor` for subsequent ones.
 */
const REVIEW_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          originalLine
          comments(first: 100) {
            nodes {
              body
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const ADD_PULL_REQUEST_REVIEW_THREAD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

const UNRESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

interface GitHubReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string;
          /** Null once the thread's commit is no longer part of the PR (an outdated/superseded diff) — `originalLine` is always set for a line comment, so it's the fallback. */
          line: number | null;
          originalLine: number | null;
          comments: { nodes: Array<{ body: string; author: { login: string } | null; createdAt: string }> };
        }>;
      };
    };
  };
}

interface GitHubUser {
  login: string;
}

interface GitHubPull {
  number: number;
  title: string;
  html_url: string;
  user: GitHubUser | null;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  requested_reviewers?: GitHubUser[];
  head?: { sha: string };
}

/** Only present on `state=closed` results — `merged_at` is non-null exactly when the PR was merged rather than closed without merging. */
interface GitHubClosedPull extends GitHubPull {
  closed_at: string | null;
  merged_at: string | null;
}

interface GitHubReview {
  user: GitHubUser | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submitted_at?: string;
}

interface GitHubCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | 'stale' | null;
  html_url: string | null;
}

interface GitHubPullFile {
  filename: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and files too large to diff — GitHub's own signal for "no textual diff", reused directly as `FileChange.binary`. */
  patch?: string;
}

/**
 * Last *decisive* review per user wins. GitHub returns reviews in submission order.
 * COMMENTED and PENDING don't express a verdict — they must not overwrite an existing
 * APPROVED or CHANGES_REQUESTED (N1). DISMISSED means the host invalidated a prior verdict
 * (e.g. a force-push) — remove that user's entry entirely so they're no longer counted.
 */
function latestReviewPerUser(reviews: GitHubReview[]): GitHubReview[] {
  const byUser = new Map<string, GitHubReview>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    if (review.state === 'DISMISSED') {
      byUser.delete(login);
    } else if (review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      byUser.set(login, review);
    }
    // COMMENTED/PENDING: deliberately skip — must not overwrite a real verdict
  }
  return [...byUser.values()];
}

function computeReviewDecision(reviews: GitHubReview[], requestedReviewers: string[]): ReviewDecision {
  const latest = latestReviewPerUser(reviews);
  if (latest.some((r) => r.state === 'CHANGES_REQUESTED')) {
    return 'changesRequested';
  }
  // An approval from any reviewer is a real signal — requestedReviewers just tracks who's *still
  // owed* one, not whether the PR is in a bad state. An existing approval must not be buried
  // under a "more reviews needed" label (N2). reviewRequired only when nobody has approved yet.
  if (latest.some((r) => r.state === 'APPROVED')) {
    return 'approved';
  }
  if (requestedReviewers.length > 0) {
    return 'reviewRequired';
  }
  return 'none';
}

/**
 * Any non-DISMISSED review state counts — a COMMENTED-only review means the user engaged with the
 * PR, so it belongs in "Reviewed" on the board. We use the raw list (not latestReviewPerUser) so
 * a COMMENTED review left after a DISMISSED verdict still marks the PR as reviewed. DISMISSED means
 * the host invalidated a prior verdict, but the user still acted, so it counts for `reviewedByMe`.
 */
function computeReviewedByMe(reviews: GitHubReview[], myLogin: string | undefined): boolean {
  return reviews.some((r) => sameLogin(r.user?.login, myLogin));
}

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);

function toCheckDetailStatus(run: GitHubCheckRun): CheckStatus {
  if (run.status !== 'completed') return 'pending';
  if (run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion)) return 'failing';
  return 'passing';
}

function computeCheckStatus(checkRuns: GitHubCheckRun[]): CheckStatus {
  if (checkRuns.length === 0) {
    return 'none';
  }
  if (checkRuns.some((run) => run.status !== 'completed')) {
    return 'pending';
  }
  if (checkRuns.some((run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion))) {
    return 'failing';
  }
  return 'passing';
}

/**
 * The only place that talks to GitHub's REST API — same "one boundary" discipline as `GitService`
 * for git itself. `apiBaseUrl` is a constructor parameter, not hardcoded to `api.github.com`, so a
 * GitHub Enterprise Server instance (or Gitea/Forgejo, which speak a GitHub-compatible API) reuses
 * this client unchanged, just pointed at its own base URL via `gitLore.launchpad.customHosts`.
 */
export class GitHubClient implements ForgeClient {
  /** Set by `getAuthenticatedLogin` (always called once before the closed-PR list, per `LaunchpadViewProvider`) — used by `enrich` to compute `reviewedByMe` against each PR's own review list. */
  private authenticatedLogin: string | undefined;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAuthenticatedLogin(): Promise<string | null> {
    const res = await this.request('/user');
    const data = (await res.json()) as GitHubUser;
    this.authenticatedLogin = data.login;
    return data.login ?? null;
  }

  async listOpenPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    const myLogin = await this.ensureLogin();
    const raw = await fetchAllPages<GitHubPull>(
      `/repos/${repo.identity}/pulls?state=open&per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitHubPull[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    const enriched = await mapWithConcurrency(raw, 6, (pull) => this.enrichTiered(repo, pull, myLogin));
    return enriched.filter((r): r is PullRequestSummary => r !== undefined);
  }

  /** Same shape as a `listOpenPullRequests` item — reuses `enrich` directly, no separate normalization path. */
  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<PullRequestSummary> {
    await this.ensureLogin();
    const res = await this.request(`/repos/${repo.identity}/pulls/${number}`);
    const pull = (await res.json()) as GitHubPull;
    return this.enrich(repo, pull);
  }

  async listRecentlyClosedPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    // GitHub's one "closed" state covers both merged and closed-without-merging — `merged_at`
    // (present only on merged ones) is what tells the two apart. No server-side "authored by me"
    // filter here (unlike GitLab/Bitbucket/Azure DevOps): the REST pulls endpoint has no author
    // param, and the one that does (the Search API) has a much tighter rate limit (30/min) that a
    // multi-repo board refreshing repeatedly could burn through fast — `per_page=100` (the max)
    // is the safer mitigation for the same "your own older PRs got pushed out of the window"
    // truncation risk, even though it's not a complete server-side fix the way the other hosts get.
    const raw = await fetchAllPages<GitHubClosedPull>(
      `/repos/${repo.identity}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitHubClosedPull[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
      // One page by design: `ForgeClient.listRecentlyClosedPullRequests` is a bounded
      // most-recently-updated slice, and following Link would cost up to MAX_PAGES requests per
      // repo per refresh to find the few closed PRs the user authored.
      1,
    );
    return raw.map((pull) => ({
      repo,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      authorLogin: pull.user?.login ?? '',
      isDraft: pull.draft ?? false,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      headSha: pull.head?.sha ?? '',
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
      closedAt: pull.closed_at ?? pull.updated_at,
      merged: pull.merged_at !== null,
    }));
  }

  async closePullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    await this.request(`/repos/${repo.identity}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
  }

  /** GitHub refuses this with a real 422 if the PR's head branch or fork no longer exists — that's a legitimate failure the caller surfaces as-is, not something to detect ahead of time. */
  async reopenPullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    await this.request(`/repos/${repo.identity}/pulls/${number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open' }),
    });
  }

  /** GitHub's `application/vnd.github.v3.diff` media type returns the whole PR's unified diff as plain text directly — no reconstruction needed, unlike GitLab. Files are paginated via Link headers. */
  async getPullRequestDiff(repo: ForgeRepoRef, number: number): Promise<PullRequestDiff> {
    const [diff, rawFiles] = await Promise.all([
      (async () => (await this.request(`/repos/${repo.identity}/pulls/${number}`, { headers: { Accept: 'application/vnd.github.v3.diff' } })).text())(),
      fetchAllPages<GitHubPullFile>(
        `/repos/${repo.identity}/pulls/${number}/files?per_page=100`,
        async (url) => {
          const res = await this.request(url);
          const items = (await res.json()) as GitHubPullFile[];
          return { items, next: nextLinkFromHeader(res.headers.get('link')) };
        },
      ),
    ]);
    const files: FileChange[] = rawFiles.map((f) => ({
      path: f.filename,
      insertions: f.additions,
      deletions: f.deletions,
      binary: f.patch === undefined,
    }));
    return { files, diff };
  }

  async submitReview(repo: ForgeRepoRef, number: number, decision: ReviewSubmission, body?: string): Promise<void> {
    const payload: Record<string, unknown> = { event: decision === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES' };
    if (body && body.trim().length > 0) {
      payload['body'] = body;
    }
    await this.request(`/repos/${repo.identity}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /** PRs are issues for comment purposes on GitHub — there's no separate "PR comment" endpoint. */
  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    await this.request(`/repos/${repo.identity}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  /**
   * GitHub has no REST endpoint for review threads at all — only the GraphQL `reviewThreads`
   * connection (see `graphql()`, a second request path alongside the REST `request()` this class
   * otherwise exclusively uses). Paginated with cursor-based pagination; empty string is the
   * "no cursor yet" sentinel for `fetchAllPages`, which passes `null` to the GraphQL variable.
   */
  async listConversationThreads(repo: ForgeRepoRef, number: number): Promise<ConversationThread[]> {
    const [owner, name] = repo.identity.split('/');
    // Empty string = "no cursor yet"; the callback converts '' → null for the GraphQL $after variable.
    const nodes = await fetchAllPages(
      '',
      async (cursor) => {
        const data = await this.graphql<GitHubReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
          owner,
          name,
          number,
          after: cursor === '' ? null : cursor,
        });
        const rt = data.repository.pullRequest.reviewThreads;
        return {
          items: rt.nodes,
          next: rt.pageInfo.hasNextPage ? (rt.pageInfo.endCursor ?? undefined) : undefined,
        };
      },
    );
    return nodes.map((thread) => {
      const firstComment = thread.comments.nodes[0];
      const line = thread.line ?? thread.originalLine ?? undefined;
      const comments: ThreadComment[] = thread.comments.nodes.map((c) => ({
        authorLogin: c.author?.login ?? '',
        body: c.body,
        ...(c.createdAt ? { createdAt: c.createdAt } : {}),
      }));
      return {
        id: thread.id,
        body: firstComment?.body ?? '',
        authorLogin: firstComment?.author?.login ?? '',
        resolved: thread.isResolved,
        comments,
        ...(thread.path !== undefined ? { file: thread.path } : {}),
        ...(line !== undefined ? { line } : {}),
      };
    });
  }

  /** `resolveReviewThread` — the GraphQL mutation counterpart to `reviewThreads`; same reasoning as `listConversationThreads` for why this isn't a REST call. */
  async resolveConversationThread(_repo: ForgeRepoRef, _number: number, threadId: string): Promise<void> {
    await this.graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  }

  /** `addPullRequestReviewThreadReply` — GraphQL mutation; only thread replies have a dedicated thread-scoped mutation, top-level comments use the REST issues endpoint via `addComment`. */
  async replyToThread(_repo: ForgeRepoRef, _number: number, threadId: string, body: string): Promise<void> {
    await this.graphql(ADD_PULL_REQUEST_REVIEW_THREAD_REPLY_MUTATION, { threadId, body });
  }

  /** `unresolveReviewThread` — GraphQL mutation counterpart to `resolveReviewThread`. */
  async unresolveConversationThread(_repo: ForgeRepoRef, _number: number, threadId: string): Promise<void> {
    await this.graphql(UNRESOLVE_REVIEW_THREAD_MUTATION, { threadId });
  }

  /** Lists all check-runs for the PR's head commit. The SHA comes from a single PR fetch so the caller doesn't need to supply it. */
  async listChecks(repo: ForgeRepoRef, number: number): Promise<CheckDetail[]> {
    const prRes = await this.request(`/repos/${repo.identity}/pulls/${number}`);
    const pr = (await prRes.json()) as GitHubPull;
    const sha = pr.head?.sha ?? '';
    const runs = await fetchAllPages<GitHubCheckRun>(
      `/repos/${repo.identity}/commits/${sha}/check-runs?per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const data = (await res.json()) as { check_runs: GitHubCheckRun[] };
        return { items: data.check_runs ?? [], next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    return runs.map((run) => ({
      name: run.name,
      status: toCheckDetailStatus(run),
      ...(run.html_url ? { url: run.html_url } : {}),
    }));
  }

  /** `merge_method` maps directly to GitHub's own three strategies. Deleting the source branch is a separate call — GitHub's merge endpoint has no option for it — so it only fetches the head ref (one extra GET) when actually requested. */
  async mergePullRequest(repo: ForgeRepoRef, number: number, options: MergeOptions): Promise<void> {
    await this.request(`/repos/${repo.identity}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ merge_method: options.strategy }),
    });
    if (options.deleteSourceBranch) {
      const headInfo = await this.fetchHeadBranch(repo, number);
      // N3: only delete the branch on the base repo. A fork PR's head.repo is the fork, not the
      // base — deleting `refs/heads/feature` on the base repo when the PR came from a fork
      // that happens to have the same branch name would delete an unrelated branch.
      if (headInfo && headInfo.repoFullName === repo.identity) {
        await this.request(`/repos/${repo.identity}/git/refs/heads/${encodeURIComponent(headInfo.ref)}`, { method: 'DELETE' });
      }
    }
  }

  /** `head`/`base` map directly to GitHub's own field names; `draft` is a real boolean field on this endpoint. No enrichment call afterward — a PR seconds old has no reviews/checks yet. */
  async createPullRequest(repo: ForgeRepoRef, options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    const res = await this.request(`/repos/${repo.identity}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title: options.title, head: options.compare, base: options.base, draft: options.draft }),
    });
    const data = (await res.json()) as GitHubPull;
    return {
      repo,
      number: data.number,
      title: data.title,
      url: data.html_url,
      authorLogin: data.user?.login ?? '',
      isDraft: data.draft ?? options.draft,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      headSha: data.head?.sha ?? '',
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
    };
  }

  /**
   * One page only — a commit is in very few PRs. `merged_at !== null` identifies merged ones.
   * 404 means the commit is unknown to GitHub (not pushed, or wrong repo) — treated as null.
   */
  async findPullRequestForCommit(repo: ForgeRepoRef, sha: string): Promise<{ number: number; title: string; url: string } | null> {
    try {
      const res = await this.request(`/repos/${repo.identity}/commits/${sha}/pulls?per_page=100`);
      const prs = (await res.json()) as Array<{ number: number; title: string; html_url: string; merged_at: string | null }>;
      // Prefer merged (merged_at non-null) over open or closed-without-merging.
      const chosen = prs.find((pr) => pr.merged_at !== null) ?? prs[0];
      if (!chosen) {
        return null;
      }
      return { number: chosen.number, title: chosen.title, url: chosen.html_url };
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Best-effort: if this fails, the merge itself already succeeded, so the caller just keeps the source branch around rather than failing an otherwise-successful merge over branch cleanup. Returns both the ref name and the head repo's full_name so the caller can guard against cross-fork branch deletion (N3). */
  private async fetchHeadBranch(repo: ForgeRepoRef, number: number): Promise<{ ref: string; repoFullName: string } | undefined> {
    try {
      const res = await this.request(`/repos/${repo.identity}/pulls/${number}`);
      const data = (await res.json()) as { head?: { ref?: string; repo?: { full_name?: string } } };
      const ref = data.head?.ref;
      const repoFullName = data.head?.repo?.full_name;
      if (!ref || !repoFullName) return undefined;
      return { ref, repoFullName };
    } catch {
      return undefined;
    }
  }

  /** Calls `getAuthenticatedLogin()` once and caches the result — safe to call from both
   *  `listOpenPullRequests` and `getPullRequest` so both get a correct `reviewedByMe`. */
  private async ensureLogin(): Promise<string | undefined> {
    if (!this.authenticatedLogin) {
      await this.getAuthenticatedLogin();
    }
    return this.authenticatedLogin;
  }

  /**
   * Tiered enrichment — reduces API calls for PRs where the authenticated user has no stake:
   * - PRs authored by me, or where I'm a requested reviewer → full `enrich` (3 calls)
   * - All other PRs → reviews only (1 call); if not `reviewedByMe`, excluded from results entirely
   */
  private async enrichTiered(
    repo: ForgeRepoRef,
    pull: GitHubPull,
    myLogin: string | undefined,
  ): Promise<PullRequestSummary | undefined> {
    const requestedReviewers = (pull.requested_reviewers ?? []).map((u) => u.login);
    const isMine = sameLogin(pull.user?.login, myLogin);
    const isRequested = requestedReviewers.some((r) => sameLogin(r, myLogin));
    if (isMine || isRequested) {
      return this.enrich(repo, pull);
    }
    // Slim path: one reviews fetch to detect reviewedByMe; skip check-runs and mergeable_state
    const reviews = await this.fetchReviews(repo, pull.number);
    if (!computeReviewedByMe(reviews, myLogin)) {
      return undefined; // Not authored by me, not a requested reviewer, not reviewed — not on board
    }
    return {
      repo,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      authorLogin: pull.user?.login ?? '',
      isDraft: pull.draft ?? false,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      headSha: pull.head?.sha ?? '',
      requestedReviewers,
      checkStatus: 'none',
      reviewDecision: computeReviewDecision(reviews, requestedReviewers),
      reviewedByMe: true,
      hasConflicts: false,
    };
  }

  private async enrich(repo: ForgeRepoRef, pull: GitHubPull): Promise<PullRequestSummary> {
    const [reviews, checkRuns, mergeableState] = await Promise.all([
      this.fetchReviews(repo, pull.number),
      this.fetchCheckRuns(repo, pull.head?.sha ?? ''),
      this.fetchMergeableState(repo, pull.number),
    ]);
    const requestedReviewers = (pull.requested_reviewers ?? []).map((u) => u.login);
    return {
      repo,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      authorLogin: pull.user?.login ?? '',
      isDraft: pull.draft ?? false,
      createdAt: pull.created_at,
      updatedAt: pull.updated_at,
      headSha: pull.head?.sha ?? '',
      requestedReviewers,
      checkStatus: computeCheckStatus(checkRuns),
      reviewDecision: computeReviewDecision(reviews, requestedReviewers),
      reviewedByMe: computeReviewedByMe(reviews, this.authenticatedLogin),
      hasConflicts: mergeableState === 'dirty',
    };
  }

  private async fetchReviews(repo: ForgeRepoRef, prNumber: number): Promise<GitHubReview[]> {
    try {
      return await fetchAllPages<GitHubReview>(
        `/repos/${repo.identity}/pulls/${prNumber}/reviews?per_page=100`,
        async (url) => {
          const res = await this.request(url);
          const items = (await res.json()) as GitHubReview[];
          return { items, next: nextLinkFromHeader(res.headers.get('link')) };
        },
      );
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  private async fetchCheckRuns(repo: ForgeRepoRef, sha: string): Promise<GitHubCheckRun[]> {
    try {
      return await fetchAllPages<GitHubCheckRun>(
        `/repos/${repo.identity}/commits/${sha}/check-runs?per_page=100`,
        async (url) => {
          const res = await this.request(url);
          const data = (await res.json()) as { check_runs: GitHubCheckRun[] };
          const items = data.check_runs ?? [];
          return { items, next: nextLinkFromHeader(res.headers.get('link')) };
        },
      );
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  /**
   * `mergeable_state` only appears on the single-PR endpoint (not the list), and GitHub computes
   * it asynchronously — a fresh PR can report `null` ("still checking") for a few seconds. Treated
   * the same as "unknown, no conflicts" rather than polling for it to settle.
   */
  private async fetchMergeableState(repo: ForgeRepoRef, prNumber: number): Promise<string | null> {
    const res = await this.requestOrNull(`/repos/${repo.identity}/pulls/${prNumber}`);
    if (!res) {
      return null;
    }
    const data = (await res.json()) as { mergeable_state?: string | null };
    return data.mergeable_state ?? null;
  }

  /**
   * Throws `ForgeHttpError` on network failures, timeouts, or non-2xx responses.
   * `graphql()` passes a full absolute URL; everything else passes a relative path against `apiBaseUrl`.
   */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = /^https?:\/\//.test(path) ? path : `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      // Last, so a caller-supplied Accept (e.g. the raw-diff media type) wins over the default.
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    return forgeFetch(url, { ...init, headers }, { fetchImpl: this.fetchImpl });
  }

  /**
   * Only swallows 404s (endpoint absent for this PR) — a rate-limited or timed-out enrichment
   * call propagates so the board shows an error row instead of silently rendering wrong data.
   */
  private async requestOrNull(path: string): Promise<Response | null> {
    try {
      return await this.request(path);
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * REST lives at `{apiBaseUrl}{path}`; GraphQL is a wholly different endpoint, not a REST path —
   * `api.github.com`'s is `/graphql`, and a GitHub Enterprise Server instance's REST base
   * (`<host>/api/v3`) maps to `<host>/api/graphql`, not `<host>/api/v3/graphql`.
   */
  private graphqlUrl(): string {
    if (this.apiBaseUrl === 'https://api.github.com') {
      return 'https://api.github.com/graphql';
    }
    return this.apiBaseUrl.replace(/\/api\/v3\/?$/, '/api/graphql');
  }

  /**
   * GraphQL returns `200 OK` even when the query itself failed — errors live in an `errors` array
   * in the body, not the HTTP status — so this checks for that explicitly rather than trusting
   * `request()`'s ok-status check alone.
   */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.request(this.graphqlUrl(), { method: 'POST', body: JSON.stringify({ query, variables }) });
    const data = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (data.errors && data.errors.length > 0) {
      throw new Error(data.errors.map((e) => e.message).join('; '));
    }
    if (!data.data) {
      throw new Error('GitHub GraphQL API returned no data');
    }
    return data.data;
  }
}
