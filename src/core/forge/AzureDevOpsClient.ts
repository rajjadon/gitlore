import { createTwoFilesPatch } from 'diff';
import type { FileChange } from '../git/types';
import type { ForgeClient } from './ForgeClient';
import { splitAzureDevOpsIdentity } from './azureDevOpsIdentity';
import { forgeFetch, ForgeHttpError, mapWithConcurrency, MAX_PAGES, sameLogin } from './forgeFetch';
import type {
  CheckStatus,
  ConversationThread,
  CreatePullRequestOptions,
  ForgeRepoRef,
  MergeOptions,
  MergeStrategy,
  PullRequestDiff,
  PullRequestSummary,
  ReviewDecision,
  ReviewSubmission,
} from './types';

interface AzureDevOpsIdentityRef {
  uniqueName?: string;
  displayName?: string;
}

interface AzureDevOpsReviewer extends AzureDevOpsIdentityRef {
  /** 10 = approved, 5 = approved with suggestions, 0 = no vote, -5 = waiting for author, -10 = rejected. */
  vote: number;
}

interface AzureDevOpsPullRequest {
  pullRequestId: number;
  title: string;
  createdBy: AzureDevOpsIdentityRef;
  isDraft?: boolean;
  creationDate: string;
  closedDate?: string;
  reviewers?: AzureDevOpsReviewer[];
  lastMergeSourceCommit?: { commitId: string };
  mergeStatus?: 'succeeded' | 'conflicts' | 'failure' | 'queued' | 'notSet';
}

interface AzureDevOpsListResponse<T> {
  value: T[];
}

interface AzureDevOpsStatus {
  state: 'succeeded' | 'error' | 'failed' | 'pending' | 'notApplicable' | 'notSet';
}

interface AzureDevOpsProfile {
  id?: string;
  emailAddress?: string;
  displayName?: string;
}

interface AzureDevOpsIteration {
  id: number;
  /** The PR-head commit as of this iteration. Absent on older self-hosted Azure DevOps Server versions — content-diffing falls back to the pre-existing file-list-only behavior when either commit id is missing. */
  sourceRefCommit?: { commitId: string };
  /** The merge-base commit — matches the `base...compare` convention `GitService.getDiffBetweenRefs` already uses for GitHub/GitLab, so a PR's diff only shows what the PR itself introduces. */
  commonRefCommit?: { commitId: string };
}

interface AzureDevOpsChangeEntry {
  /** Absent for some entries (folder-level changes, certain property-only changes) — not every entry represents an actual file. */
  item?: { path?: string };
  /** e.g. "add", "edit", "delete", or a comma-separated combination like "edit, rename" — checked by substring, not equality, since Azure DevOps has historically returned combined flag strings. */
  changeType?: string;
}

interface AzureDevOpsIterationChanges {
  changeEntries: AzureDevOpsChangeEntry[];
}

type AzureDevOpsThreadStatus = 'unknown' | 'active' | 'fixed' | 'wontFix' | 'closed' | 'byDesign' | 'pending';

interface AzureDevOpsThreadComment {
  content: string;
  author: AzureDevOpsIdentityRef;
  /** Vote-change notifications and similar auto-generated entries come through as their own threads with `commentType: 'system'` — not a genuine review conversation. */
  commentType?: 'text' | 'codeChange' | 'system' | 'unknown';
}

interface AzureDevOpsThread {
  id: number;
  status?: AzureDevOpsThreadStatus;
  comments: AzureDevOpsThreadComment[];
  isDeleted?: boolean;
  /** Only present on a thread attached to a specific diff line — absent (null) for a general PR thread. `rightFileStart` is the new side; `leftFileStart` is the old side, used when the thread is on a removed line. */
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; leftFileStart?: { line?: number } } | null;
}

const UNRESOLVED_STATUSES = new Set<AzureDevOpsThreadStatus | undefined>(['active', 'pending', 'unknown', undefined]);

/**
 * Internal safety valve, not a user-facing setting — there's no scenario where a different value
 * would be correct, only a size past which diffing two full files' content client-side in a
 * webview stops being worth the cost. A generated bundle or lockfile past this size still shows up
 * in the file list with 0/0 stats, same graceful degrade as a file Azure DevOps can't diff at all.
 */
const MAX_DIFFABLE_FILE_CHARS = 300_000;

/** Azure DevOps' own completion-option strategy names, one per `MergeStrategy` — `'merge'` maps to `noFastForward` (a real merge commit, its closest match to GitHub's plain "Merge"), and `'rebase'` maps to `rebase` (not `rebaseMerge`, which still leaves a merge commit — GitHub's "Rebase and merge" has none). */
const AZURE_MERGE_STRATEGY: Record<MergeStrategy, string> = {
  merge: 'noFastForward',
  squash: 'squash',
  rebase: 'rebase',
};

function loginOf(ref: AzureDevOpsIdentityRef): string {
  return ref.uniqueName ?? ref.displayName ?? '';
}

function computeCheckStatus(statuses: AzureDevOpsStatus[]): CheckStatus {
  if (statuses.length === 0) {
    return 'none';
  }
  if (statuses.some((s) => s.state === 'pending')) {
    return 'pending';
  }
  if (statuses.some((s) => s.state === 'error' || s.state === 'failed')) {
    return 'failing';
  }
  return 'passing';
}

/** Azure DevOps' numeric vote model, normalized: -10 (rejected) is the one unambiguous "changes requested" signal; anything <= 0 otherwise still counts as "hasn't approved yet". */
function reviewersInfo(reviewers: AzureDevOpsReviewer[]): { requestedReviewers: string[]; reviewDecision: ReviewDecision } {
  if (reviewers.some((r) => r.vote === -10)) {
    return { requestedReviewers: reviewers.filter((r) => r.vote <= 0).map(loginOf), reviewDecision: 'changesRequested' };
  }
  const stillOwed = reviewers.filter((r) => r.vote <= 0).map(loginOf);
  if (stillOwed.length > 0) {
    return { requestedReviewers: stillOwed, reviewDecision: 'reviewRequired' };
  }
  if (reviewers.length > 0) {
    return { requestedReviewers: [], reviewDecision: 'approved' };
  }
  return { requestedReviewers: [], reviewDecision: 'none' };
}

/** A vote of 0 ("no vote") or -5 ("waiting for author" — the reviewer punted, not a verdict) isn't a real review yet; anything else (10, 5, or -10) is — this is about whether *this specific person* has acted, independent of the PR's overall `reviewDecision`. */
function computeReviewedByMe(reviewers: AzureDevOpsReviewer[], myLogin: string | undefined): boolean {
  if (!myLogin) {
    return false;
  }
  return reviewers.some((r) => sameLogin(loginOf(r), myLogin) && r.vote !== 0 && r.vote !== -5);
}

/**
 * The only place that talks to Azure DevOps' REST API. Unlike the other three hosts, a repo here
 * has no two-part owner/repo identity — `repo.identity` is "organization/project/repository" (see
 * `azureDevOpsIdentity.ts`), and PR URLs are always built under `dev.azure.com`, even for orgs
 * whose remote uses the legacy `<org>.visualstudio.com` hostname (that hostname still resolves,
 * but `dev.azure.com` is the canonical modern one for every org).
 *
 * The identity ("who am I") check lives on a *different* host (`vssps.dev.azure.com`) than the
 * main API (`dev.azure.com`) — a genuine, well-documented Azure DevOps quirk, not a mistake here.
 * That profile check must be routed through the org (`vssps.dev.azure.com/{organization}/...`),
 * not the legacy global `app.vssps.visualstudio.com/...` host: a PAT scoped to one organization
 * (the default Azure DevOps offers when creating one) 401s against the global host even though
 * the exact same token works fine against every other endpoint here. PR authors/reviewers are
 * matched by `uniqueName` (their email/UPN), the same value the profile API returns as
 * `emailAddress`. That same profile response's `id` (a GUID) is cached and reused to scope the
 * closed-PR search server-side via `searchCriteria.creatorId`, so the current user's own older
 * merged/abandoned PRs aren't silently dropped by the `$top=10` window over a busy shared repo's
 * most-recently-closed PRs before `categorizeClosedPullRequests` ever filters by author.
 *
 * `credentialScheme` exists because `dev.azure.com` accepts two unrelated credential shapes: a
 * PAT (HTTP Basic) from `forgeCredentials.ts`'s manual-entry flow, or an AAD OAuth access token
 * (HTTP Bearer) from VS Code's built-in Microsoft session — the latter is the only thing that
 * works for organizations whose Conditional Access policy blocks PAT/Basic auth outright, no
 * matter how broad the PAT's own scope is.
 */
/** How `token` should be presented: a PAT (HTTP Basic, empty username) or an AAD OAuth access token from `vscode.authentication`'s built-in Microsoft session (HTTP Bearer — Basic doesn't apply to a JWT). */
export type AzureDevOpsCredentialScheme = 'pat' | 'oauth';

export class AzureDevOpsClient implements ForgeClient {
  /** Set by `getAuthenticatedLogin` (always called once before the closed-PR list, per `LaunchpadViewProvider`) — the GUID `searchCriteria.creatorId` needs, which the shared `ForgeClient` interface has no other way to hand `listRecentlyClosedPullRequests`. */
  private authenticatedUserId: string | undefined;
  /** Set alongside `authenticatedUserId` — used by `enrich` to compute `reviewedByMe` against each PR's own `reviewers` entries, which are keyed by `uniqueName`/`displayName`, not the profile GUID. */
  private authenticatedLogin: string | undefined;

  constructor(
    private readonly identity: string,
    private readonly token: string,
    private readonly credentialScheme: AzureDevOpsCredentialScheme = 'pat',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getAuthenticatedLogin(): Promise<string | null> {
    const id = splitAzureDevOpsIdentity(this.identity);
    const url = id
      ? `https://vssps.dev.azure.com/${id.organization}/_apis/profile/profiles/me?api-version=7.1`
      : 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1';
    const res = await this.request(url);
    const data = (await res.json()) as AzureDevOpsProfile;
    this.authenticatedUserId = data.id;
    this.authenticatedLogin = data.emailAddress ?? data.displayName ?? undefined;
    return data.emailAddress ?? data.displayName ?? null;
  }

  async listOpenPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      return [];
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    // Throws rather than soft-degrading to [] — a credential that's valid for the vssps profile
    // check but lacks "Code" scope for this endpoint (a real, easy-to-hit PAT-setup mistake) would
    // otherwise render as an indistinguishable-from-genuinely-empty board with zero signal.
    const raw = await this.fetchAllSkip<AzureDevOpsPullRequest>(`${base}/pullrequests?searchCriteria.status=active&api-version=7.1`);
    return mapWithConcurrency(raw, 6, (pr) => this.enrich(repo, id, base, pr));
  }

  /** Same shape as a `listOpenPullRequests` item — reuses `enrich` directly, no separate normalization path. */
  async getPullRequest(repo: ForgeRepoRef, number: number): Promise<PullRequestSummary> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    const res = await this.request(`${base}/pullrequests/${number}?api-version=7.1`);
    const pr = (await res.json()) as AzureDevOpsPullRequest;
    return this.enrich(repo, id, base, pr);
  }

  async listRecentlyClosedPullRequests(repo: ForgeRepoRef): Promise<PullRequestSummary[]> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      return [];
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    // Azure DevOps calls a closed-without-merging PR "abandoned" — completed/abandoned are
    // separate status values, same as GitLab's merged/closed split.
    const [completed, abandoned] = await Promise.all([
      this.fetchClosedList(repo, id, base, 'completed', true),
      this.fetchClosedList(repo, id, base, 'abandoned', false),
    ]);
    return [...completed, ...abandoned];
  }

  private async fetchClosedList(
    repo: ForgeRepoRef,
    id: { organization: string; project: string; repository: string },
    base: string,
    status: 'completed' | 'abandoned',
    merged: boolean,
  ): Promise<PullRequestSummary[]> {
    // Filtered server-side by creatorId, not fetched-then-filtered client-side: this repo's most
    // recently closed PRs project-wide would otherwise push the current user's own older ones
    // out of the $top window before `categorizeClosedPullRequests` ever gets to filter by author.
    const creatorFilter = this.authenticatedUserId ? `&searchCriteria.creatorId=${this.authenticatedUserId}` : '';
    // Throws rather than soft-degrading to [] — same reasoning as the open-PR list: a credential
    // problem here should never look identical to "you genuinely have no closed PRs".
    const res = await this.request(`${base}/pullrequests?searchCriteria.status=${status}${creatorFilter}&$top=10&api-version=7.1`);
    const data = (await res.json()) as AzureDevOpsListResponse<AzureDevOpsPullRequest>;
    return data.value.map((pr) => ({
      repo,
      number: pr.pullRequestId,
      title: pr.title,
      url: `https://dev.azure.com/${id.organization}/${id.project}/_git/${id.repository}/pullrequest/${pr.pullRequestId}`,
      authorLogin: loginOf(pr.createdBy),
      isDraft: false,
      createdAt: pr.creationDate,
      updatedAt: pr.closedDate ?? pr.creationDate,
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
      closedAt: pr.closedDate ?? pr.creationDate,
      merged,
    }));
  }

  async closePullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    await this.request(`${base}/pullrequests/${number}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    });
  }

  async reopenPullRequest(repo: ForgeRepoRef, number: number): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    await this.request(`${base}/pullrequests/${number}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'active' }),
    });
  }

  /**
   * Azure DevOps has no endpoint that returns diff text directly — only structured changed-item
   * lists (`iterations/{n}/changes`). When the latest iteration also carries `sourceRefCommit`/
   * `commonRefCommit` (present on dev.azure.com and modern Azure DevOps Server; absent on some
   * older self-hosted versions), this fetches each changed file's content at both commits via the
   * Items API and diffs them client-side with the `diff` package — the same "PR-introduced changes
   * only" `base...compare` convention `GitService.getDiffBetweenRefs` already uses for GitHub/
   * GitLab. When those commit ids are missing, or a file is binary/too large to reasonably diff in
   * a webview, this falls back to the file list alone with `insertions`/`deletions` at `0`
   * (unknown, not "no changes" — see `PullRequestDiff`) and no diff text for that file;
   * `renderFileSections` already shows "No textual diff for this file" when hunks are empty, so
   * every fallback path degrades honestly rather than fabricating numbers.
   */
  async getPullRequestDiff(repo: ForgeRepoRef, number: number): Promise<PullRequestDiff> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      return { files: [], diff: '' };
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    const iterationsRes = await this.request(`${base}/pullrequests/${number}/iterations?api-version=7.1`);
    const iterations = (await iterationsRes.json()) as AzureDevOpsListResponse<AzureDevOpsIteration>;
    const latest = iterations.value.at(-1);
    if (!latest) {
      return { files: [], diff: '' };
    }
    const changesRes = await this.request(`${base}/pullrequests/${number}/iterations/${latest.id}/changes?api-version=7.1`);
    const changes = (await changesRes.json()) as AzureDevOpsIterationChanges;
    const entries = changes.changeEntries.filter((entry): entry is AzureDevOpsChangeEntry & { item: { path: string } } => !!entry.item?.path);

    const targetCommit = latest.sourceRefCommit?.commitId;
    const baseCommit = latest.commonRefCommit?.commitId;
    if (!targetCommit || !baseCommit) {
      // Older Azure DevOps Server without these fields — same file-list-only behavior as before.
      const files: FileChange[] = entries.map((entry) => ({
        path: entry.item.path.replace(/^\//, ''),
        insertions: 0,
        deletions: 0,
        binary: false,
      }));
      return { files, diff: '' };
    }

    const diffed = await Promise.all(entries.map((entry) => this.diffOneFile(base, entry, baseCommit, targetCommit)));
    return {
      files: diffed.map(({ file }) => file),
      diff: diffed
        .map(({ file, patch }) => (patch ? `diff --git a/${file.path} b/${file.path}\n${patch}` : ''))
        .filter((part) => part !== '')
        .join('\n'),
    };
  }

  /** A single changed file's content is fetched at both commits (skipping the side that provably doesn't exist for an add/delete) and diffed client-side. Never throws — any failure to fetch or diff degrades to the same "no textual diff" fallback the file-list-only path already uses. */
  private async diffOneFile(
    base: string,
    entry: AzureDevOpsChangeEntry & { item: { path: string } },
    baseCommit: string,
    targetCommit: string,
  ): Promise<{ file: FileChange; patch: string | null }> {
    const path = entry.item.path.replace(/^\//, '');
    const changeType = entry.changeType ?? '';
    const isAdd = changeType.includes('add');
    const isDelete = changeType.includes('delete');
    const [oldContent, newContent] = await Promise.all([
      isAdd ? Promise.resolve(null) : this.fetchItemContent(base, entry.item.path, baseCommit),
      isDelete ? Promise.resolve(null) : this.fetchItemContent(base, entry.item.path, targetCommit),
    ]);

    const oldText = oldContent ?? '';
    const newText = newContent ?? '';
    // Git's own heuristic: a NUL byte anywhere in the content means binary, not text — no
    // Azure-specific "is this binary" field is reliable enough to depend on instead.
    const binary = oldText.includes('\0') || newText.includes('\0');
    if (binary || oldText.length > MAX_DIFFABLE_FILE_CHARS || newText.length > MAX_DIFFABLE_FILE_CHARS) {
      return { file: { path, insertions: 0, deletions: 0, binary }, patch: null };
    }

    const patch = createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, { context: 3 });
    // Same counting convention GitLabClient already uses for its own reconstructed diffs — the
    // negative lookaheads exclude the patch's own "+++"/"---" header lines from the count.
    const insertions = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
    const deletions = (patch.match(/^-(?!--)/gm) ?? []).length;
    const hasHunks = /^@@/m.test(patch);
    return { file: { path, insertions, deletions, binary: false }, patch: hasHunks ? patch : null };
  }

  /**
   * Fetches a file's raw content at a specific commit via the Items API. Null on any failure (file
   * doesn't exist at this version — the normal case for an added/deleted file — or any other fetch
   * error), never thrown — a single file's content being unreachable shouldn't fail the whole PR
   * diff.
   *
   * Reads the response as plain text, not JSON: without an explicit `$format=json`, this endpoint
   * returns the file's raw content directly as the response body (its primary, documented purpose
   * is "download this file's content") — not a `{ content: "..." }` JSON envelope. Calling
   * `res.json()` here throws on any real file whose content isn't itself valid JSON.
   */
  private async fetchItemContent(base: string, path: string, commitId: string): Promise<string | null> {
    const url = `${base}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${commitId}&versionDescriptor.versionType=commit&includeContent=true&api-version=7.1`;
    const res = await this.requestOrNull(url);
    return res ? await res.text() : null;
  }

  /** The reviewer being voted on is the authenticated user themselves — reuses the same `authenticatedUserId` `getAuthenticatedLogin` already caches for `searchCriteria.creatorId` (`AzureDevOpsClient.ts` constructor field), rather than a second profile lookup. */
  async submitReview(repo: ForgeRepoRef, number: number, decision: ReviewSubmission): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    if (!this.authenticatedUserId) {
      throw new Error('not signed in yet — refresh Launchpad and try again');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    await this.request(`${base}/pullrequests/${number}/reviewers/${this.authenticatedUserId}?api-version=7.1`, {
      method: 'PUT',
      body: JSON.stringify({ vote: decision === 'approve' ? 10 : -10 }),
    });
  }

  /** Azure DevOps models a standalone PR comment as a new single-comment thread — `parentCommentId: 0` and `commentType: 1` ("text") match the documented shape exactly, confirmed against the REST docs' own "Comment on the pull request" example. `status: 1` ("active") is required even for a thread with no file/line context. */
  async addComment(repo: ForgeRepoRef, number: number, body: string): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    await this.request(`${base}/pullrequests/${number}/threads?api-version=7.1`, {
      method: 'POST',
      body: JSON.stringify({ comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 1 }),
    });
  }

  /** Excludes deleted threads and system-generated ones (vote-change notifications, etc. — `commentType: 'system'`) so this only ever lists genuine review conversations. */
  async listConversationThreads(repo: ForgeRepoRef, number: number): Promise<ConversationThread[]> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      return [];
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    const res = await this.request(`${base}/pullrequests/${number}/threads?api-version=7.1`);
    const data = (await res.json()) as AzureDevOpsListResponse<AzureDevOpsThread>;
    return data.value
      .filter((t) => !t.isDeleted && t.comments[0]?.commentType !== 'system')
      .map((t) => {
        const line = t.threadContext?.rightFileStart?.line ?? t.threadContext?.leftFileStart?.line ?? undefined;
        return {
          id: String(t.id),
          body: t.comments[0]?.content ?? '',
          authorLogin: t.comments[0] ? loginOf(t.comments[0].author) : '',
          resolved: !UNRESOLVED_STATUSES.has(t.status),
          ...(t.threadContext?.filePath !== undefined ? { file: t.threadContext.filePath } : {}),
          ...(line !== undefined ? { line } : {}),
        };
      });
  }

  /** `"fixed"` is sent as its enum name, not a numeric ordinal — Azure DevOps' own docs and examples for this endpoint use the string form on write, matching what it always returns on read. */
  async resolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    await this.request(`${base}/pullrequests/${number}/threads/${threadId}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'fixed' }),
    });
  }

  /**
   * Azure DevOps requires the PR's current head commit in the completion request
   * (`lastMergeSourceCommit.commitId`) — not carried through `PullRequestSummary`, so this re-fetches
   * it fresh immediately before completing, the same "don't trust board-refresh-time data for a
   * mutating call" precedent as `getPullRequestDiff`.
   */
  async mergePullRequest(repo: ForgeRepoRef, number: number, options: MergeOptions): Promise<void> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const base = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    const prRes = await this.request(`${base}/pullrequests/${number}?api-version=7.1`);
    const pr = (await prRes.json()) as AzureDevOpsPullRequest;
    if (!pr.lastMergeSourceCommit?.commitId) {
      throw new Error("Azure DevOps hasn't finished computing this pull request's mergeability yet — try again in a moment");
    }
    await this.request(`${base}/pullrequests/${number}?api-version=7.1`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        lastMergeSourceCommit: { commitId: pr.lastMergeSourceCommit.commitId },
        completionOptions: {
          mergeStrategy: AZURE_MERGE_STRATEGY[options.strategy],
          deleteSourceBranch: options.deleteSourceBranch,
        },
      }),
    });
  }

  /** `isDraft` is a real boolean field on this endpoint, and ref names need the `refs/heads/` prefix Azure DevOps expects everywhere — `options.base`/`options.compare` are plain branch names, same as every other host's `createPullRequest`. No enrichment call afterward — a PR seconds old has no reviewers/checks yet. */
  async createPullRequest(repo: ForgeRepoRef, options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    const id = splitAzureDevOpsIdentity(repo.identity);
    if (!id) {
      throw new Error('could not resolve this repo\'s Azure DevOps organization/project/repository identity');
    }
    const apiBase = `https://dev.azure.com/${id.organization}/${id.project}/_apis/git/repositories/${id.repository}`;
    const res = await this.request(`${apiBase}/pullrequests?api-version=7.1`, {
      method: 'POST',
      body: JSON.stringify({
        sourceRefName: `refs/heads/${options.compare}`,
        targetRefName: `refs/heads/${options.base}`,
        title: options.title,
        isDraft: options.draft,
      }),
    });
    const data = (await res.json()) as AzureDevOpsPullRequest;
    return {
      repo,
      number: data.pullRequestId,
      title: data.title,
      url: `https://dev.azure.com/${id.organization}/${id.project}/_git/${id.repository}/pullrequest/${data.pullRequestId}`,
      authorLogin: loginOf(data.createdBy),
      isDraft: data.isDraft ?? options.draft,
      createdAt: data.creationDate,
      updatedAt: data.creationDate,
      requestedReviewers: [],
      checkStatus: 'none',
      reviewDecision: 'none',
      hasConflicts: false,
      reviewedByMe: false,
    };
  }

  private async enrich(
    repo: ForgeRepoRef,
    id: { organization: string; project: string; repository: string },
    base: string,
    pr: AzureDevOpsPullRequest,
  ): Promise<PullRequestSummary> {
    const statuses = pr.lastMergeSourceCommit ? await this.fetchStatuses(base, pr.pullRequestId) : [];
    const { requestedReviewers, reviewDecision } = reviewersInfo(pr.reviewers ?? []);
    return {
      repo,
      number: pr.pullRequestId,
      title: pr.title,
      url: `https://dev.azure.com/${id.organization}/${id.project}/_git/${id.repository}/pullrequest/${pr.pullRequestId}`,
      authorLogin: loginOf(pr.createdBy),
      isDraft: pr.isDraft ?? false,
      createdAt: pr.creationDate,
      updatedAt: pr.creationDate,
      requestedReviewers,
      checkStatus: computeCheckStatus(statuses),
      reviewDecision,
      reviewedByMe: computeReviewedByMe(pr.reviewers ?? [], this.authenticatedLogin),
      hasConflicts: pr.mergeStatus === 'conflicts',
    };
  }

  private async fetchStatuses(base: string, pullRequestId: number): Promise<AzureDevOpsStatus[]> {
    const res = await this.requestOrNull(`${base}/pullRequests/${pullRequestId}/statuses?api-version=7.1`);
    if (!res) {
      return [];
    }
    const data = (await res.json()) as AzureDevOpsListResponse<AzureDevOpsStatus>;
    return data.value ?? [];
  }

  /** Azure DevOps paginates with `$top` + `$skip` (no Link header, no body `next`). Stops at `MAX_PAGES` pages to match the ceiling in `forgeFetch`. A short page (< top) signals the last page. */
  private async fetchAllSkip<T>(baseUrl: string): Promise<T[]> {
    const top = 100;
    const all: T[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      const res = await this.request(`${baseUrl}${sep}$top=${top}&$skip=${page * top}`);
      const data = (await res.json()) as AzureDevOpsListResponse<T>;
      all.push(...(data.value ?? []));
      if ((data.value?.length ?? 0) < top) break;
    }
    return all;
  }

  /** Throws with the real reason (HTTP status or network failure) instead of swallowing it. Only `fetchStatuses` wraps this in `requestOrNull` — a single PR's check-status enrichment failing shouldn't take down the whole list the way a credential problem on the list call itself should be visible. */
  private async request(url: string, init?: RequestInit): Promise<Response> {
    // A PAT authenticates via HTTP Basic with an empty username — Bearer support for raw PATs
    // isn't consistently documented the way it is for GitHub/GitLab/Bitbucket tokens. An AAD OAuth
    // access token (from the built-in Microsoft session) is the opposite: it's a JWT, so it only
    // ever goes as a Bearer token — Basic doesn't apply to it at all.
    const authHeader =
      this.credentialScheme === 'oauth' ? `Bearer ${this.token}` : `Basic ${Buffer.from(`:${this.token}`).toString('base64')}`;
    const headers: Record<string, string> = {
      Authorization: authHeader,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    return forgeFetch(url, { ...init, headers }, { fetchImpl: this.fetchImpl });
  }

  /** Only swallows 404s — other errors (auth failures, network, rate limits) propagate so the board can surface them correctly. */
  private async requestOrNull(url: string): Promise<Response | null> {
    try {
      return await this.request(url);
    } catch (err) {
      if (err instanceof ForgeHttpError && err.kind === 'http' && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}
