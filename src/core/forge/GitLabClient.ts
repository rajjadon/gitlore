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

interface GitLabUser {
  username: string;
}

interface GitLabPipeline {
  id: number;
  status: 'success' | 'failed' | 'canceled' | 'skipped' | 'running' | 'pending' | 'created' | 'waiting_for_resource' | 'preparing' | string;
}

interface GitLabJob {
  name: string;
  status: string;
  web_url?: string;
}

interface GitLabMergeRequest {
  iid: number;
  title: string;
  web_url: string;
  author: GitLabUser | null;
  draft?: boolean;
  work_in_progress?: boolean;
  created_at: string;
  updated_at: string;
  reviewers?: GitLabUser[];
  has_conflicts?: boolean;
  blocking_discussions_resolved?: boolean;
  head_pipeline?: GitLabPipeline | null;
  sha?: string;
}

/** A GitLab "discussion" is the thread; `notes` are its comments. Only a `resolvable` discussion (a genuine review conversation, not a plain top-level comment) can be resolved at all. */
interface GitLabDiscussion {
  id: string;
  notes: Array<{
    id: number;
    body: string;
    author: GitLabUser | null;
    resolvable: boolean;
    resolved: boolean;
    created_at?: string;
    /** Only present on a note attached to a specific diff line — absent for a plain discussion note. */
    position?: { new_path?: string; old_path?: string; new_line?: number | null; old_line?: number | null };
  }>;
}

interface GitLabApprovals {
  approved: boolean;
  approved_by: Array<{ user: GitLabUser }>;
}

/** GitLab's per-file diff fragment — `diff` is just the hunk body, with no `diff --git a/x b/y` header line the way a real `git diff`/GitHub's raw-diff media type has one. */
interface GitLabDiffFile {
  old_path: string;
  new_path: string;
  diff: string;
}

const PASSING_STATUSES = new Set(['success', 'skipped']);
const FAILING_STATUSES = new Set(['failed', 'canceled']);

function toJobCheckStatus(status: string): CheckStatus {
  if (PASSING_STATUSES.has(status)) return 'passing';
  if (FAILING_STATUSES.has(status)) return 'failing';
  return 'pending';
}

function computeCheckStatus(pipeline: GitLabPipeline | null | undefined): CheckStatus {
  if (!pipeline) {
    return 'none';
  }
  if (PASSING_STATUSES.has(pipeline.status)) {
    return 'passing';
  }
  if (FAILING_STATUSES.has(pipeline.status)) {
    return 'failing';
  }
  return 'pending';
}

/**
 * N4: GitLab has no "changes requested" review state — we derive the verdict from approvals only.
 * Unresolved discussions are tracked separately (Phase B) and do not override a real approval.
 */
function computeReviewDecision(mr: GitLabMergeRequest, approved: boolean, reviewers: string[]): ReviewDecision {
  if (approved) {
    return 'approved';
  }
  if (reviewers.length > 0) {
    return 'reviewRequired';
  }
  return 'none';
}

/**
 * The only place that talks to GitLab's REST API v4. `apiBaseUrl` is a constructor parameter, not
 * hardcoded to `gitlab.com`, so a self-hosted GitLab CE/EE instance reuses this client unchanged,
 * just pointed at its own base URL via `gitLore.launchpad.customHosts`.
 */
export class GitLabClient implements ForgeClient {
  /** Set by `getAuthenticatedLogin` (always called once before the closed-MR list, per `LaunchpadViewProvider`) — used to scope `fetchClosedList`'s `author_username` filter server-side. */
  private authenticatedUsername: string | undefined;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAuthenticatedLogin(): Promise<string | null> {
    const res = await this.request('/user');
    const data = (await res.json()) as GitLabUser;
    this.authenticatedUsername = data.username;
    return data.username ?? null;
  }

  async listOpenPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    const projectPath = encodeURIComponent(repo.identity);
    const raw = await fetchAllPages<GitLabMergeRequest>(
      `/projects/${projectPath}/merge_requests?state=opened&per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitLabMergeRequest[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    return mapWithConcurrency(raw, 6, (mr) => this.enrich(repo, projectPath, mr));
  }

  /** Same shape as a `listOpenPullRequests` item — reuses `enrich` directly, no separate normalization path. */
  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<PullRequestSummary> {
    const projectPath = encodeURIComponent(repo.identity);
    const res = await this.request(`/projects/${projectPath}/merge_requests/${number}`);
    const mr = (await res.json()) as GitLabMergeRequest;
    return this.enrich(repo, projectPath, mr);
  }

  async listRecentlyClosedPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    // Unlike GitHub, GitLab's `state` distinguishes "merged" from "closed" (without merging) as
    // two separate values — no single call covers both.
    const projectPath = encodeURIComponent(repo.identity);
    const [merged, closed] = await Promise.all([
      this.fetchClosedList(repo, projectPath, 'merged', true),
      this.fetchClosedList(repo, projectPath, 'closed', false),
    ]);
    return [...merged, ...closed];
  }

  private async fetchClosedList(
    repo: ForgeRepoRef,
    projectPath: string,
    state: 'merged' | 'closed',
    merged: boolean,
  ): Promise<PullRequestSummary[]> {
    // Filtered server-side by author_username, not fetched-then-filtered client-side: this
    // project's most recently closed/merged MRs project-wide would otherwise push the current
    // user's own older ones out of the `per_page` window before `categorizeClosedPullRequests`
    // ever gets to filter by author.
    const authorFilter = this.authenticatedUsername ? `&author_username=${encodeURIComponent(this.authenticatedUsername)}` : '';
    const res = await this.request(`/projects/${projectPath}/merge_requests?state=${state}${authorFilter}&order_by=updated_at&per_page=10`);
    const raw = (await res.json()) as GitLabMergeRequest[];
    return raw.map((mr) => ({
      repo,
      number: mr.iid,
      title: mr.title,
      url: mr.web_url,
      authorLogin: mr.author?.username ?? '',
      isDraft: false,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      headSha: mr.sha ?? '',
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
      closedAt: mr.updated_at,
      merged,
    }));
  }

  async closePullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'close' }),
    });
  }

  async reopenPullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}`, {
      method: 'PUT',
      body: JSON.stringify({ state_event: 'reopen' }),
    });
  }

  /**
   * GitLab's `/diffs` endpoint returns one hunk-body fragment per file — no `diff --git a/x b/y`
   * header the way GitHub's raw-diff media type or a real `git diff` has, and no insertion/deletion
   * counts either. Synthesizing a minimal header per file (and counting `+`/`-` lines ourselves)
   * makes this combine into one string `splitDiffByFile`/`renderDiff` (`src/views/diffRender.ts`)
   * already know how to parse — that shared renderer only ever needed the header line to find each
   * file's boundary, nothing else about it.
   */
  async getPullRequestDiff(repo: ForgeRepoRef, number: number): Promise<PullRequestDiff> {
    const projectPath = encodeURIComponent(repo.identity);
    const rawFiles = await fetchAllPages<GitLabDiffFile>(
      `/projects/${projectPath}/merge_requests/${number}/diffs?per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitLabDiffFile[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    const files: FileChange[] = [];
    const diffParts: string[] = [];
    for (const f of rawFiles) {
      const insertions = (f.diff.match(/^\+(?!\+\+)/gm) ?? []).length;
      const deletions = (f.diff.match(/^-(?!--)/gm) ?? []).length;
      files.push({ path: f.new_path, insertions, deletions, binary: false });
      if (f.diff) {
        diffParts.push(`diff --git a/${f.old_path} b/${f.new_path}\n${f.diff}`);
      }
    }
    return { files, diff: diffParts.join('\n') };
  }

  /**
   * GitLab has no formal "request changes" review state the way GitHub does (see `computeReviewDecision`'s own comment on this) — there's no endpoint to call, so `'requestChanges'` throws a clear, actionable message rather than silently doing nothing or faking an approval-adjacent action GitLab doesn't have.
   * When `body` is provided, it is posted as a note before the vote. A note failure blocks the vote.
   */
  async submitReview(repo: ForgeRepoRef, number: number, decision: ReviewSubmission, body?: string): Promise<void> {
    if (decision === 'requestChanges') {
      throw new Error("GitLab has no \"Request Changes\" review state — leave a comment explaining what needs to change instead");
    }
    const projectPath = encodeURIComponent(repo.identity);
    if (body && body.trim().length > 0) {
      // Comment failure is intentional — it blocks the vote so the reviewer's words aren't silently lost.
      await this.request(`/projects/${projectPath}/merge_requests/${number}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
    }
    await this.request(`/projects/${projectPath}/merge_requests/${number}/approve`, { method: 'POST' });
  }

  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  /** Only resolvable discussions are genuine review conversations — a plain top-level comment (e.g. from `addComment`) is its own unresolvable discussion and would just be a dead "Resolve" button if included here. Paginated via Link headers. */
  async listConversationThreads(repo: ForgeRepoRef, number: number): Promise<ConversationThread[]> {
    const projectPath = encodeURIComponent(repo.identity);
    const discussions = await fetchAllPages<GitLabDiscussion>(
      `/projects/${projectPath}/merge_requests/${number}/discussions?per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitLabDiscussion[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    return discussions
      .filter((d) => d.notes[0]?.resolvable)
      .map((d) => {
        const position = d.notes[0]?.position;
        const file = position?.new_path ?? position?.old_path;
        const line = position?.new_line ?? position?.old_line ?? undefined;
        const comments: ThreadComment[] = d.notes.map((n) => ({
          authorLogin: n.author?.username ?? '',
          body: n.body,
          ...(n.created_at ? { createdAt: n.created_at } : {}),
        }));
        return {
          id: d.id,
          body: d.notes[0]?.body ?? '',
          authorLogin: d.notes[0]?.author?.username ?? '',
          resolved: d.notes[0]?.resolved ?? false,
          comments,
          ...(file !== undefined ? { file } : {}),
          ...(line !== undefined ? { line } : {}),
        };
      });
  }

  async resolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}/discussions/${threadId}?resolved=true`, { method: 'PUT' });
  }

  /** Adds a reply note to a discussion thread (`POST .../discussions/:id/notes`). */
  async replyToThread(repo: ForgeRepoRef, number: number, threadId: string, body: string): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}/discussions/${threadId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  /** Unresolves a discussion thread (`PUT .../discussions/:id?resolved=false`). */
  async unresolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void> {
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}/discussions/${threadId}?resolved=false`, { method: 'PUT' });
  }

  /** Lists pipeline jobs as checks. Fetches the MR for its head_pipeline.id, then paginates the jobs endpoint. Returns empty when no pipeline is associated. */
  async listChecks(repo: ForgeRepoRef, number: number): Promise<CheckDetail[]> {
    const projectPath = encodeURIComponent(repo.identity);
    const mrRes = await this.request(`/projects/${projectPath}/merge_requests/${number}`);
    const mr = (await mrRes.json()) as GitLabMergeRequest;
    if (!mr.head_pipeline) {
      return [];
    }
    const pipelineId = mr.head_pipeline.id;
    const jobs = await fetchAllPages<GitLabJob>(
      `/projects/${projectPath}/pipelines/${pipelineId}/jobs?per_page=100`,
      async (url) => {
        const res = await this.request(url);
        const items = (await res.json()) as GitLabJob[];
        return { items, next: nextLinkFromHeader(res.headers.get('link')) };
      },
    );
    return jobs.map((job) => ({
      name: job.name,
      status: toJobCheckStatus(job.status),
      ...(job.web_url ? { url: job.web_url } : {}),
    }));
  }

  /** GitLab's merge endpoint only exposes a `squash` boolean, not a distinct strategy field — there's no request that gives `'rebase'` a separate merge-commit-free history the way GitHub/Azure DevOps' rebase does, so it throws rather than silently merging with the wrong history shape (see `MERGE_STRATEGIES_BY_HOST`). */
  async mergePullRequest(repo: ForgeRepoRef, number: number, options: MergeOptions): Promise<void> {
    if (options.strategy === 'rebase') {
      throw new Error('GitLab has no separate "rebase and merge" request — use "Merge" or "Squash and merge" instead');
    }
    const projectPath = encodeURIComponent(repo.identity);
    await this.request(`/projects/${projectPath}/merge_requests/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ squash: options.strategy === 'squash', should_remove_source_branch: options.deleteSourceBranch }),
    });
  }

  /** GitLab's merge-request creation endpoint has no boolean draft field at all — prefixing the title with `Draft: ` is GitLab's own documented mechanism for marking one as a draft, still the only supported way as of GitLab's current API. No enrichment call afterward — a PR seconds old has no reviews/pipeline yet. */
  async createPullRequest(repo: ForgeRepoRef, options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    const projectPath = encodeURIComponent(repo.identity);
    const title = options.draft ? `Draft: ${options.title}` : options.title;
    const res = await this.request(`/projects/${projectPath}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({ source_branch: options.compare, target_branch: options.base, title }),
    });
    const data = (await res.json()) as GitLabMergeRequest;
    return {
      repo,
      number: data.iid,
      title: data.title,
      url: data.web_url,
      authorLogin: data.author?.username ?? '',
      isDraft: data.draft ?? data.work_in_progress ?? options.draft,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      headSha: data.sha ?? '',
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
    };
  }

  /**
   * One page only — a commit is in very few MRs. `state: 'merged'` is preferred over `'opened'`
   * or `'closed'`. 404 means the commit is unknown to this GitLab instance — treated as null.
   */
  async findPullRequestForCommit(repo: ForgeRepoRef, sha: string): Promise<{ number: number; title: string; url: string } | null> {
    const projectPath = encodeURIComponent(repo.identity);
    try {
      const res = await this.request(`/projects/${projectPath}/repository/commits/${sha}/merge_requests?per_page=100`);
      const mrs = (await res.json()) as Array<{ iid: number; title: string; web_url: string; state: string }>;
      // Prefer merged over opened/closed.
      const chosen = mrs.find((mr) => mr.state === 'merged') ?? mrs[0];
      if (!chosen) {
        return null;
      }
      return { number: chosen.iid, title: chosen.title, url: chosen.web_url };
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  private async enrich(repo: ForgeRepoRef, projectPath: string, mr: GitLabMergeRequest): Promise<PullRequestSummary> {
    const approvals = await this.fetchApprovals(projectPath, mr.iid);
    const approvedByUsernames = new Set(approvals.approved_by.map((a) => a.user.username));
    const reviewers = (mr.reviewers ?? []).map((u) => u.username);
    // Only a reviewer who has personally approved is removed from "still owed" — matches
    // GitHub's requested_reviewers semantics (per-person, not an all-or-nothing MR-level flag),
    // since someone else's approval satisfying the overall requirement doesn't mean *this*
    // reviewer weighed in.
    const stillOwed = reviewers.filter((username) => ![...approvedByUsernames].some((u) => sameLogin(u, username)));
    return {
      repo,
      number: mr.iid,
      title: mr.title,
      url: mr.web_url,
      authorLogin: mr.author?.username ?? '',
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      headSha: mr.sha ?? '',
      requestedReviewers: stillOwed,
      checkStatus: computeCheckStatus(mr.head_pipeline),
      reviewDecision: computeReviewDecision(mr, approvals.approved, stillOwed),
      // GitLab has no formal "request changes" state (see `submitReview`'s own comment on this) —
      // an approval is the only per-reviewer verdict its API exposes, so this shares the exact same
      // `approvedByUsernames` set `stillOwed` above already relies on, rather than a separate call.
      reviewedByMe: [...approvedByUsernames].some((u) => sameLogin(u, this.authenticatedUsername)),
      hasConflicts: mr.has_conflicts ?? false,
    };
  }

  private async fetchApprovals(projectPath: string, iid: number): Promise<GitLabApprovals> {
    const res = await this.requestOrNull(`/projects/${projectPath}/merge_requests/${iid}/approvals`);
    if (!res) {
      return { approved: false, approved_by: [] };
    }
    const data = (await res.json()) as GitLabApprovals;
    return { approved: data.approved ?? false, approved_by: data.approved_by ?? [] };
  }

  /** Throws with the real reason (HTTP status or network failure) instead of swallowing it. Only `fetchApprovals` wraps this in `requestOrNull` — one MR's approval data failing to load shouldn't take down the whole list the way a credential problem on the list call itself should be visible. */
  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = /^https?:\/\//.test(path) ? path : `${this.apiBaseUrl}${path}`;
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': this.token,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    return forgeFetch(url, { ...init, headers }, { fetchImpl: this.fetchImpl });
  }

  /** Only swallows 404s — other errors (auth failures, network, rate limits) propagate so the board can surface them correctly. */
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
}
