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
import { forgeFetch, ForgeHttpError, fetchAllPages, mapWithConcurrency, sameLogin } from './forgeFetch';

interface BitbucketUser {
  username?: string;
  nickname?: string;
  uuid?: string;
}

interface BitbucketParticipant {
  user: BitbucketUser;
  role: 'REVIEWER' | 'PARTICIPANT';
  approved: boolean;
  state: 'approved' | 'changes_requested' | null;
}

interface BitbucketPullRequest {
  id: number;
  title: string;
  links: { html: { href: string } };
  author: BitbucketUser | null;
  draft?: boolean;
  created_on: string;
  updated_on: string;
  participants?: BitbucketParticipant[];
  source: { commit: { hash: string } };
}

interface BitbucketPage<T> {
  values: T[];
  /** Full URL of the next page, present when there are more results. */
  next?: string;
}

interface BitbucketBuildStatus {
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
}

interface BitbucketBuildStatusDetail {
  key: string;
  name?: string;
  state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED';
  url?: string;
}

/** Bitbucket has no separate "thread" object — a top-level comment (no `parent`) *is* the conversation; replies carry a `parent`. `resolution` is present only once a top-level comment has been resolved. */
interface BitbucketComment {
  id: number;
  content: { raw: string };
  user: BitbucketUser | null;
  parent?: { id: number };
  resolution?: unknown;
  created_on?: string;
  /** Only present on a comment attached to a specific diff line — absent for a general PR comment. `to` is the line on the new side; `from` is the old side, used when the comment is on a removed line. */
  inline?: { path: string; to?: number | null; from?: number | null };
}

interface BitbucketDiffstatEntry {
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'merge conflict';
  lines_added: number;
  lines_removed: number;
  old: { path: string } | null;
  new: { path: string } | null;
}

function loginOf(user: BitbucketUser | null | undefined): string {
  return user?.username ?? user?.nickname ?? '';
}

function computeCheckStatus(statuses: BitbucketBuildStatus[]): CheckStatus {
  if (statuses.length === 0) {
    return 'none';
  }
  if (statuses.some((s) => s.state === 'INPROGRESS')) {
    return 'pending';
  }
  if (statuses.some((s) => s.state === 'FAILED' || s.state === 'STOPPED')) {
    return 'failing';
  }
  return 'passing';
}

function toBuildCheckStatus(state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS' | 'STOPPED'): CheckStatus {
  if (state === 'SUCCESSFUL') return 'passing';
  if (state === 'FAILED' || state === 'STOPPED') return 'failing';
  return 'pending';
}

/**
 * Bitbucket's PR object already carries per-reviewer approval state in its own `participants`
 * array (`approved`/`state`), unlike GitHub — no separate reviews call needed.
 */
function reviewersInfo(pr: BitbucketPullRequest): { requestedReviewers: string[]; reviewDecision: ReviewDecision } {
  const reviewers = (pr.participants ?? []).filter((p) => p.role === 'REVIEWER');
  if (reviewers.some((r) => r.state === 'changes_requested')) {
    return { requestedReviewers: reviewers.filter((r) => !r.approved).map((r) => loginOf(r.user)), reviewDecision: 'changesRequested' };
  }
  const stillOwed = reviewers.filter((r) => !r.approved).map((r) => loginOf(r.user));
  if (stillOwed.length > 0) {
    return { requestedReviewers: stillOwed, reviewDecision: 'reviewRequired' };
  }
  if (reviewers.length > 0) {
    return { requestedReviewers: [], reviewDecision: 'approved' };
  }
  return { requestedReviewers: [], reviewDecision: 'none' };
}

/** A reviewer with `approved: true` or `state: 'changes_requested'` has given a real verdict — this is about whether *this specific person* has acted, independent of the PR's overall `reviewDecision`. */
function computeReviewedByMe(pr: BitbucketPullRequest, myLogin: string | undefined): boolean {
  if (!myLogin) {
    return false;
  }
  return (pr.participants ?? []).some(
    (p) => p.role === 'REVIEWER' && sameLogin(loginOf(p.user), myLogin) && (p.approved || p.state === 'changes_requested'),
  );
}

/**
 * The only place that talks to Bitbucket Cloud's REST API 2.0. Uses Bitbucket's newer Access
 * Token model (Bearer auth), not the legacy App Password (HTTP Basic, username+password pair) —
 * keeps the credential shape a single string, consistent with every other `ForgeClient`.
 *
 * `hasConflicts` is always `false`: Bitbucket's PR object doesn't expose mergeability without an
 * actual merge-preview attempt, which isn't a clean read the way GitHub's `mergeable_state` or
 * GitLab's `has_conflicts` are. Documented gap, not a silent guess.
 */
export class BitbucketClient implements ForgeClient {
  /** Set by `getAuthenticatedLogin` (always called once before the closed-PR list, per `LaunchpadViewProvider`) — `username`/`nickname` can be hidden by privacy settings, but `uuid` is always present, so it's what scopes `fetchClosedList`'s author filter. */
  private authenticatedUserUuid: string | undefined;
  /** Set alongside `authenticatedUserUuid` — used by `enrich` to compute `reviewedByMe` against each PR's own `participants` entries, which are keyed by login/nickname, not uuid. */
  private authenticatedLogin: string | undefined;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAuthenticatedLogin(): Promise<string | null> {
    const res = await this.request('/user');
    const data = (await res.json()) as BitbucketUser;
    this.authenticatedUserUuid = data.uuid;
    const login = loginOf(data);
    this.authenticatedLogin = login || undefined;
    return login || null;
  }

  async listOpenPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    const raw = await fetchAllPages<BitbucketPullRequest>(
      `/repositories/${repo.identity}/pullrequests?state=OPEN&pagelen=50`,
      async (url) => {
        const res = await this.request(url);
        const page = (await res.json()) as BitbucketPage<BitbucketPullRequest>;
        return { items: page.values, next: page.next };
      },
    );
    return mapWithConcurrency(raw, 6, (pr) => this.enrich(repo, pr));
  }

  /** Same shape as a `listOpenPullRequests` item — reuses `enrich` directly, no separate normalization path. */
  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<PullRequestSummary> {
    const res = await this.request(`/repositories/${repo.identity}/pullrequests/${number}`);
    const pr = (await res.json()) as BitbucketPullRequest;
    return this.enrich(repo, pr);
  }

  async listRecentlyClosedPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    // Bitbucket calls a closed-without-merging PR "declined" — MERGED and DECLINED are separate
    // state values, same as GitLab's merged/closed split.
    const [merged, declined] = await Promise.all([
      this.fetchClosedList(repo, 'MERGED', true),
      this.fetchClosedList(repo, 'DECLINED', false),
    ]);
    return [...merged, ...declined];
  }

  private async fetchClosedList(repo: ForgeRepoRef, state: 'MERGED' | 'DECLINED', merged: boolean): Promise<PullRequestSummary[]> {
    // Filtered server-side by author.uuid, not fetched-then-filtered client-side: this repo's
    // most recently closed/declined PRs project-wide would otherwise push the current user's own
    // older ones out of the `pagelen` window before `categorizeClosedPullRequests` ever gets to
    // filter by author.
    const authorFilter = this.authenticatedUserUuid
      ? `&q=${encodeURIComponent(`author.uuid="${this.authenticatedUserUuid}"`)}`
      : '';
    const res = await this.request(`/repositories/${repo.identity}/pullrequests?state=${state}${authorFilter}&pagelen=10`);
    const page = (await res.json()) as BitbucketPage<BitbucketPullRequest>;
    return page.values.map((pr) => ({
      repo,
      number: pr.id,
      title: pr.title,
      url: pr.links.html.href,
      authorLogin: loginOf(pr.author),
      isDraft: false,
      createdAt: pr.created_on,
      updatedAt: pr.updated_on,
      headSha: pr.source.commit.hash,
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
      closedAt: pr.updated_on,
      merged,
    }));
  }

  async closePullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/decline`, { method: 'POST' });
  }

  /** Bitbucket Cloud has no way to reopen a declined PR at all — not through this API, not even through its own web UI (a long-standing, still-open feature request on Bitbucket's own tracker) — so this throws a clear, actionable message rather than silently doing nothing or guessing at an endpoint that doesn't exist. */
  async reopenPullRequest(_repo: ForgeRepoRef, _number: number): Promise<void> {
    throw new Error('Bitbucket has no way to reopen a declined pull request — open a new pull request instead');
  }

  /** Bitbucket's `/diff` endpoint returns the whole PR's unified diff as plain text directly, already carrying real `diff --git a/x b/y` headers — no reconstruction needed, unlike GitLab. `/diffstat` supplies per-file insertion/deletion counts, paginated via body `next`. */
  async getPullRequestDiff(repo: ForgeRepoRef, number: number): Promise<PullRequestDiff> {
    const [diff, statEntries] = await Promise.all([
      (async () => (await this.request(`/repositories/${repo.identity}/pullrequests/${number}/diff`)).text())(),
      fetchAllPages<BitbucketDiffstatEntry>(
        `/repositories/${repo.identity}/pullrequests/${number}/diffstat`,
        async (url) => {
          const res = await this.request(url);
          const page = (await res.json()) as BitbucketPage<BitbucketDiffstatEntry>;
          return { items: page.values, next: page.next };
        },
      ),
    ]);
    const files: FileChange[] = statEntries.map((entry) => ({
      path: entry.new?.path ?? entry.old?.path ?? '',
      insertions: entry.lines_added,
      deletions: entry.lines_removed,
      binary: false,
    }));
    return { files, diff };
  }

  /**
   * Bitbucket uses the same participant-state endpoint for both approve and request-changes.
   * When `body` is provided, a comment is posted before the vote. Comment failure blocks the vote.
   */
  async submitReview(repo: ForgeRepoRef, number: number, decision: ReviewSubmission, body?: string): Promise<void> {
    if (body && body.trim().length > 0) {
      await this.request(`/repositories/${repo.identity}/pullrequests/${number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: { raw: body } }),
      });
    }
    const action = decision === 'approve' ? 'approve' : 'request-changes';
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/${action}`, { method: 'POST' });
  }

  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: { raw: body } }),
    });
  }

  /**
   * Paginates all comments (top-level and replies), groups replies by parent id, then returns a
   * `ConversationThread` per top-level comment with its full `comments` chain oldest-first.
   */
  async listConversationThreads(repo: ForgeRepoRef, number: number): Promise<ConversationThread[]> {
    const allComments = await fetchAllPages<BitbucketComment>(
      `/repositories/${repo.identity}/pullrequests/${number}/comments`,
      async (url) => {
        const res = await this.request(url);
        const page = (await res.json()) as BitbucketPage<BitbucketComment>;
        return { items: page.values, next: page.next };
      },
    );
    // Group replies (has parent) by their parent's id for O(n) grouping
    const repliesByParentId = new Map<number, BitbucketComment[]>();
    for (const c of allComments) {
      if (c.parent) {
        const existing = repliesByParentId.get(c.parent.id) ?? [];
        existing.push(c);
        repliesByParentId.set(c.parent.id, existing);
      }
    }
    const toThreadComment = (c: BitbucketComment): ThreadComment => ({
      authorLogin: loginOf(c.user),
      body: c.content.raw,
      ...(c.created_on ? { createdAt: c.created_on } : {}),
    });
    return allComments
      .filter((c) => !c.parent)
      .map((c) => {
        const line = c.inline?.to ?? c.inline?.from ?? undefined;
        const replies = repliesByParentId.get(c.id) ?? [];
        const comments: ThreadComment[] = [toThreadComment(c), ...replies.map(toThreadComment)];
        return {
          id: String(c.id),
          body: c.content.raw,
          authorLogin: loginOf(c.user),
          resolved: c.resolution !== undefined && c.resolution !== null,
          comments,
          ...(c.inline?.path !== undefined ? { file: c.inline.path } : {}),
          ...(line !== undefined ? { line } : {}),
        };
      });
  }

  async resolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void> {
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/comments/${threadId}/resolve`, { method: 'POST' });
  }

  /** Replies are posted as comments with a `parent.id` field pointing to the top-level comment. */
  async replyToThread(repo: ForgeRepoRef, number: number, threadId: string, body: string): Promise<void> {
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content: { raw: body }, parent: { id: Number(threadId) } }),
    });
  }

  /** Bitbucket uses DELETE on the resolve endpoint to unresolve a comment thread. */
  async unresolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void> {
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/comments/${threadId}/resolve`, { method: 'DELETE' });
  }

  /** Lists build statuses for the PR's source commit as check details, paginated via body `next`. */
  async listChecks(repo: ForgeRepoRef, number: number): Promise<CheckDetail[]> {
    const prRes = await this.request(`/repositories/${repo.identity}/pullrequests/${number}`);
    const pr = (await prRes.json()) as BitbucketPullRequest;
    const sha = pr.source.commit.hash;
    const statuses = await fetchAllPages<BitbucketBuildStatusDetail>(
      `/repositories/${repo.identity}/commit/${sha}/statuses`,
      async (url) => {
        const res = await this.request(url);
        const page = (await res.json()) as BitbucketPage<BitbucketBuildStatusDetail>;
        return { items: page.values ?? [], next: page.next };
      },
    );
    return statuses.map((s) => ({
      name: s.name ?? s.key,
      status: toBuildCheckStatus(s.state),
      ...(s.url ? { url: s.url } : {}),
    }));
  }

  /** Bitbucket's third merge strategy, `fast_forward`, only succeeds when the branch already fast-forwards cleanly — not the same guarantee as GitHub/Azure DevOps' true rebase-and-replay, so `'rebase'` isn't offered here (see `MERGE_STRATEGIES_BY_HOST`) and throws a clear message if requested anyway. */
  async mergePullRequest(repo: ForgeRepoRef, number: number, options: MergeOptions): Promise<void> {
    if (options.strategy === 'rebase') {
      throw new Error(
        'Bitbucket has no true rebase-and-merge — its closest option, fast-forward, only works when the branch already fast-forwards cleanly. Use "Merge" or "Squash and merge" instead',
      );
    }
    await this.request(`/repositories/${repo.identity}/pullrequests/${number}/merge`, {
      method: 'POST',
      body: JSON.stringify({
        merge_strategy: options.strategy === 'squash' ? 'squash' : 'merge_commit',
        close_source_branch: options.deleteSourceBranch,
      }),
    });
  }

  /** Bitbucket Cloud has no draft-PR concept at all — not through its API, not through its own web UI — so a draft request throws a clear platform-gap error rather than silently creating a regular PR (see `DRAFT_SUPPORTED_HOSTS`, which the caller uses to keep "Draft" off the create-PR flow for this host in the first place). No enrichment call afterward — a PR seconds old has no reviewers/build status yet. */
  async createPullRequest(repo: ForgeRepoRef, options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    if (options.draft) {
      throw new Error('Bitbucket Cloud has no draft pull requests — create it as a regular PR instead');
    }
    const res = await this.request(`/repositories/${repo.identity}/pullrequests`, {
      method: 'POST',
      body: JSON.stringify({
        title: options.title,
        source: { branch: { name: options.compare } },
        destination: { branch: { name: options.base } },
      }),
    });
    const data = (await res.json()) as BitbucketPullRequest;
    return {
      repo,
      number: data.id,
      title: data.title,
      url: data.links.html.href,
      authorLogin: loginOf(data.author),
      isDraft: false,
      createdAt: data.created_on,
      updatedAt: data.updated_on,
      headSha: data.source?.commit?.hash ?? '',
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
    };
  }

  /**
   * One page only — a commit is in very few PRs. `state: 'MERGED'` preferred over `'OPEN'` or
   * `'DECLINED'`. 404 means the commit is unknown to Bitbucket — treated as null.
   */
  async findPullRequestForCommit(repo: ForgeRepoRef, sha: string): Promise<{ number: number; title: string; url: string } | null> {
    try {
      const res = await this.request(`/repositories/${repo.identity}/commit/${sha}/pullrequests?pagelen=50`);
      const page = (await res.json()) as BitbucketPage<{ id: number; title: string; links: { html: { href: string } }; state: string }>;
      const prs = page.values;
      // Prefer MERGED over OPEN or DECLINED.
      const chosen = prs && (prs.find((pr) => pr.state === 'MERGED') ?? prs[0]);
      if (!chosen) {
        return null;
      }
      return { number: chosen.id, title: chosen.title, url: chosen.links.html.href };
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  private async enrich(repo: ForgeRepoRef, pr: BitbucketPullRequest): Promise<PullRequestSummary> {
    const statuses = await this.fetchBuildStatuses(repo, pr.source.commit.hash);
    const { requestedReviewers, reviewDecision } = reviewersInfo(pr);
    return {
      repo,
      number: pr.id,
      title: pr.title,
      url: pr.links.html.href,
      authorLogin: loginOf(pr.author),
      isDraft: pr.draft ?? false,
      createdAt: pr.created_on,
      updatedAt: pr.updated_on,
      headSha: pr.source.commit.hash,
      requestedReviewers,
      checkStatus: computeCheckStatus(statuses),
      reviewDecision,
      reviewedByMe: computeReviewedByMe(pr, this.authenticatedLogin),
      hasConflicts: false,
    };
  }

  private async fetchBuildStatuses(repo: ForgeRepoRef, revision: string): Promise<BitbucketBuildStatus[]> {
    try {
      return await fetchAllPages<BitbucketBuildStatus>(
        `/repositories/${repo.identity}/commit/${revision}/statuses`,
        async (url) => {
          const res = await this.request(url);
          const page = (await res.json()) as BitbucketPage<BitbucketBuildStatus>;
          return { items: page.values ?? [], next: page.next };
        },
      );
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return [];
      }
      throw err;
    }
  }

  /** Throws with the real reason (HTTP status or network failure) instead of swallowing it. */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = /^https?:\/\//.test(path) ? path : `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    return forgeFetch(url, { ...init, headers }, { fetchImpl: this.fetchImpl });
  }
}
