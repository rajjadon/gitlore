# Launchpad & PR Review Enhancement Roadmap

> **For agentic workers:** Executed via `/plan` Phase 4 (`plan-implementer`). **Only Phase A is task-level and approved for implementation by this document.** Phases B–F are scoped and sized but each gets its own design + task breakdown after the previous phase lands (CLAUDE.md §7: "do not start a phase until the previous phase is tested and merged"). Steps use checkbox syntax.

**Goal:** Make Launchpad and PR review trustworthy at real-world scale (correct, complete, resilient data), then deepen the review experience, then add the glanceable and AI layers.

**Architecture:** One shared transport layer (`forgeFetch`) under all four `ForgeClient`s gives timeouts, bounded retry, typed errors, pagination and a concurrency cap in a single place. Board loading moves out of the webview provider into a vscode-free `core/forge/loadBoard.ts` so it is unit-testable and reusable by a later status-bar item. PR write flows (close/reopen/merge/review) are extracted once and shared by Launchpad and PR Details.

**Tech Stack:** TypeScript strict, `node:test` via `tsx` (unit), `@vscode/test-electron` (integration). **No new runtime dependencies** — the concurrency limiter and paginator are ~20 lines each, hand-written.

**Spec:** none separate — the findings below *are* the spec (spike-class review). Decisions locked with Raj on 2026-10-16: webview-depth review (not native Comments API), reliability first, all five extra tracks included.

## Global Constraints

- CLAUDE.md §4/§20: 100% free, no backend, no telemetry, no new runtime dependency without asking Raj.
- `src/core/**` has zero `vscode` imports. `GitService` stays the only git entry point.
- Launchpad stays off by default: with `gitLore.launchpad.enabled = false` there is **no network call and no auth prompt**, from any new surface.
- Per-host asymmetries are respected, never faked: GitLab has no "request changes", Bitbucket Cloud has no reopen, Azure DevOps has no diff-text endpoint, Bitbucket has no drafts.
- No magic strings: new command IDs / config keys / state keys go in `src/constants.ts`.
- Strict TS: no `any`, no unjustified `!`, async/await only (no `.then()`).
- **Raj commits himself.** Steps end in a "Checkpoint", never `git commit`. No worktrees.
- Test runs (`npm run test:unit`, `npm run lint`, `npm run test`) are covered by the single approval at the `/plan` Phase 3 gate.

## Review Focus

Failure modes the tasks' happy paths would not catch, most likely first. Each has a pinning test in the owning task.

1. **Which errors clear a stored PAT.** Only a 401 may. 403, 404, 429, 5xx, timeout and network failure must keep the credential. (Task A3)
2. **Pagination boundaries:** exactly 100, 101, 250 items, and a repo with more items than the page cap. Silent truncation was the bug. (Task A4)
3. **`Retry-After` format:** seconds *or* an HTTP-date; and **never retry a non-GET** (a retried merge/approve/comment duplicates a write). (Task A1)
4. **One host down, others up:** the board shows the healthy repos plus an error row; two PAT hosts unsigned must not stack two simultaneous input boxes. (Task A3)
5. **Review verdict overwritten:** reviewer A requests changes, then leaves a plain comment — PR must still read `changesRequested`. (Task A5)

---

## Findings (what the plan is grounded in)

Verified by reading the code unless marked *(inferred)*.

### Launchpad / board

| # | Finding | Evidence |
|---|---|---|
| L1 | Any list-call failure **deletes the stored PAT** (429, 5xx, network blip included) and re-prompts | `LaunchpadViewProvider.ts:199`, also `:172` |
| L2 | Repos load sequentially (the 2026-08-19 audit's fix never shipped) | `LaunchpadViewProvider.ts:143` |
| L3 | **No pagination on any host.** GitHub/GitLab/Azure silently stop at ~100 PRs; Bitbucket/Azure use the host's small default page *(default sizes inferred)* | `GitHubClient.ts:176,196,236`; `GitLabClient.ts:123`; `BitbucketClient.ts:145`; `AzureDevOpsClient.ts:211` |
| L4 | Unbounded fan-out: GitHub = 3 requests/PR at once (300 PRs → 900 concurrent); Azure diff = 2 requests/file at once | `GitHubClient.ts:340`; `AzureDevOpsClient.ts:343,364` |
| L5 | No timeout, no `Retry-After`, no 429 handling, no ETag/caching anywhere. Enrichment failures are swallowed to "no reviews / checks none" — **wrong data rendered as right** | all four `request()`/`requestOrNull()`; `GitHubClient.ts:420` |
| L6 | Snooze/any action triggers a full network re-fetch of every repo | `LaunchpadViewProvider.ts:299` |
| L7 | Snooze is permanent and the key list in `globalState` is never pruned | `LaunchpadViewProvider.ts:265-273` |
| L8 | No refresh-on-focus, no staleness indicator, no glanceable count outside the tab | — |
| L9 | A PR where *you* are reviewer with failing CI lands in **Blocked**, not Needs Review (blocked check precedes needs-review) — semantic question for Raj | `categorize.ts:20-26` |
| L10 | GitHub team review requests are ignored (only `requested_reviewers`) | `GitHubClient.ts:345` |

### PR review

| # | Finding | Evidence |
|---|---|---|
| P1 | Threads show only the **first** comment; no reply, no unresolve | `types.ts:118`; interface has `resolve` only |
| P2 | Verdict carries no body; comments are top-level only; no inline comments | `ForgeClient.submitReview`, `addComment` |
| P3 | CI collapsed to one status — no failing-check names or log links (all four hosts expose URLs; clients drop them) | `types.ts:7` |
| P4 | Diff fetched 3× uncached (load, Explain, Draft Review); Azure makes 2 requests per file each time | `PullRequestDetailsViewProvider.ts:104,377,457` |
| P5 | AI explanation cache keyed by PR number, not head SHA → stale after a push (the old audit called PR diffs "immutable" — they are not) | `:366` |
| P6 | AI review sees only the first 8000 chars of the diff | `:447` + `buildPrReviewDraftPrompt` |

### Normalization / correctness bugs

| # | Finding | Evidence |
|---|---|---|
| N1 | GitHub: a later `COMMENTED`/`PENDING` review overwrites an earlier `CHANGES_REQUESTED`/`APPROVED` (**confirmed**) | `GitHubClient.ts:107-115` |
| N2 | GitHub: any entry in `requested_reviewers` forces `reviewRequired` even when others approved | `:118-130` |
| N3 | GitHub merge+delete branch: deletes `head.ref` on the **base** repo without checking `head.repo` — a fork PR whose branch name matches a base branch deletes the wrong branch | `:300` area (re-read before touching) |
| N4 | GitLab: unresolved discussions reported as `changesRequested`, overriding a real approval | `GitLabClient.ts:86` |
| N5 | Login comparison is exact-match on GitHub/GitLab/Bitbucket (GitHub logins are case-insensitive); Bitbucket uses non-unique `nickname`; Azure uses `uniqueName ?? displayName` | various |
| N6 | `GitHubClient.authenticatedLogin` is instance state set by a prior call; if absent, `reviewedByMe` is silently `false` | `:160` |
| N7 | `new URL(url).host` inside the catch can throw and mask the real error on a malformed `apiBaseUrl` | `:410` |

*Inferred, verify before acting:* GitLab list endpoint may omit `head_pipeline` (so `checkStatus` is always `none`); Azure `/statuses` returns PR status posts, not build-policy results; Azure bad-PAT responses may be a 203/302 HTML sign-in page rather than a 401 (which would defeat `isCredentialRejection`).

### Repo health

- `LaunchpadViewProvider.ts` (587) and `PullRequestDetailsViewProvider.ts` (518) duplicate close/reopen/merge/review flows, each with a `*ForTest` twin that **re-implements** the logic and skips the modal/self-review check — the tests exercise a copy, not production code.
- Four near-identical `request()` wrappers (one place to fix timeouts/retry/pagination, today four).
- `createNonce()` uses `Math.random` and is copy-pasted per view; the "AI disabled → open settings" `.then()` snippet is copy-pasted at 9 sites (violates §9 "no `.then`"); `ChatViewProvider.ts:110` hardcodes `'gitLore.ai.enabled'`.
- §14's 85% core coverage target has **no tooling** — unmeasured.
- CLAUDE.md §7/§8 are far behind (41 commands shipped vs 22 documented; Chat, co-change, reflog recovery, Explorer write actions, 2 settings absent); README omits 6 settings and says GitLore doesn't stash (it does).
- `.vsix` files are git-ignored (not an issue).

---

## Phase A — Reliability foundation (EXECUTABLE)

### File structure

| File | Change | Responsibility |
|---|---|---|
| `src/core/forge/forgeFetch.ts` | create | `ForgeHttpError`, `isCredentialRejection`, `forgeFetch`, `parseRetryAfterMs`, `mapWithConcurrency`, `fetchAllPages`, `nextLinkFromHeader`, `sameLogin` |
| `src/core/forge/loadBoard.ts` | create | vscode-free board loader: parallel per-repo load, per-repo error rows, cached summaries for network-free re-categorize |
| `src/views/pullRequestActions.ts` | create | UI-injected close/reopen/merge/review flows (no `vscode` import) |
| `src/views/pullRequestActionUi.ts` | create | the `vscode` adapter implementing `PullRequestActionUi` |
| `src/core/forge/{GitHub,GitLab,Bitbucket,AzureDevOps}Client.ts` | modify | delegate `request()` to `forgeFetch`; paginate lists; cap fan-out; normalization fixes |
| `src/views/Launchpad/LaunchpadViewProvider.ts` | modify | use `loadBoard`; snooze re-renders from cache |
| `src/views/PullRequestDetails/PullRequestDetailsViewProvider.ts` | modify | use shared action flows |
| `test/unit/core/forge/forgeFetch.test.ts` | create | transport tests |
| `test/unit/core/forge/loadBoard.test.ts` | create | board loader tests |
| `test/unit/views/pullRequestActions.test.ts` | create | action-flow tests with a fake UI |
| existing `test/unit/core/forge/*Client.test.ts` | modify | pagination, normalization, fan-out cap |

Order matters: A1 → A2 → A3 → A4 → A5 → A6. Each task leaves `npm run test:unit` and `npm run lint` green.

### Task A1: Shared transport — `forgeFetch`, typed errors, concurrency, pagination

**Files:**
- Create: `src/core/forge/forgeFetch.ts`
- Test: `test/unit/core/forge/forgeFetch.test.ts`

**Interfaces:**
- Produces (exact, later tasks rely on these):
```ts
export type ForgeErrorKind = 'unauthorized' | 'forbidden' | 'rateLimited' | 'timeout' | 'network' | 'http';
export class ForgeHttpError extends Error {
  constructor(message: string, readonly kind: ForgeErrorKind, readonly status?: number);
}
export function isCredentialRejection(err: unknown): boolean; // true ONLY for kind === 'unauthorized' (HTTP 401)
export interface ForgeFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs?: number;                       // default 30_000
  maxRetries?: number;                      // default 2
  sleep?: (ms: number) => Promise<void>;    // injectable clock boundary for tests
}
export function parseRetryAfterMs(value: string | null, now?: number): number | undefined;
export async function forgeFetch(url: string, init: RequestInit, opts: ForgeFetchOptions): Promise<Response>;
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export function nextLinkFromHeader(link: string | null): string | undefined;
export async function fetchAllPages<T>(firstUrl: string, getPage: (url: string) => Promise<{ items: T[]; next?: string }>, maxPages?: number): Promise<T[]>;
export function sameLogin(a: string | undefined, b: string | undefined): boolean; // case-insensitive, false if either is empty
export const MAX_PAGES = 10; // ponytail: 10 pages (~1000 items) ceiling; raise only if a real repo needs it
```

- [ ] **Step 1: Write the failing tests** in `forgeFetch.test.ts` (use real `new Response(body, { status, headers })` in fakes, and a recording `sleep`):
  - `401 → ForgeHttpError kind 'unauthorized'`, `isCredentialRejection` true; `403/404/500/429/timeout/network → isCredentialRejection false`.
  - `429` with `Retry-After: 2` on a GET: retries after `2000` ms (recorded by fake `sleep`), succeeds on 2nd attempt.
  - `Retry-After` as HTTP-date → `parseRetryAfterMs` returns the positive delta against an injected `now`; garbage → `undefined`.
  - GitHub-style `403` + `x-ratelimit-remaining: 0` is treated as `rateLimited` (retry if wait ≤ 10 s, else throw `rateLimited` immediately without sleeping).
  - **POST/PATCH/PUT/DELETE are never retried** even on 429/503 — fake fetch called exactly once.
  - 503 on GET retries up to `maxRetries` then throws `kind 'http'`, message `503 Service Unavailable from api.example.com`.
  - Error message format preserved exactly: `"<status> <statusText> from <host>: <detail>"` (existing client tests assert it) and `"couldn't reach <host>: <reason>"`.
  - Malformed URL does not throw a `TypeError` from the error path (N7): message still produced.
  - `mapWithConcurrency`: with limit 2 and 5 slow items, never more than 2 in flight (track a counter); results keep input order; one rejection rejects the whole call.
  - `nextLinkFromHeader('<https://x/p?page=2>; rel="next", <https://x/p?page=9>; rel="last"')` → `https://x/p?page=2`; no `next` → `undefined`.
  - `fetchAllPages`: 2 pages follow `next`; stops at `maxPages` (does not loop forever when `next` always returns).
  - `sameLogin('Amy','amy')` true; `sameLogin('', '')` false; `sameLogin(undefined,'a')` false.

- [ ] **Step 2: Run** `npx tsx --test test/unit/core/forge/forgeFetch.test.ts` → expect FAIL (module missing).

- [ ] **Step 3: Implement** `forgeFetch.ts`:
```ts
import { describeErrorBody } from './httpError';

export type ForgeErrorKind = 'unauthorized' | 'forbidden' | 'rateLimited' | 'timeout' | 'network' | 'http';

export class ForgeHttpError extends Error {
  constructor(message: string, readonly kind: ForgeErrorKind, readonly status?: number) {
    super(message);
    this.name = 'ForgeHttpError';
  }
}

/** Only a 401 proves the stored credential itself is bad. 403 (scope/rate limit), 404, 429, 5xx, timeouts and network failures all say nothing about the token — clearing it on those turned a transient blip into a forced re-prompt. */
export function isCredentialRejection(err: unknown): boolean {
  return err instanceof ForgeHttpError && err.kind === 'unauthorized';
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
export const MAX_PAGES = 10; // ponytail: ~1000 items ceiling; raise only if a real repo needs it

export interface ForgeFetchOptions {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url; // a malformed apiBaseUrl must not mask the real error with a TypeError
  }
}

export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'));
}

export async function forgeFetch(url: string, init: RequestInit, opts: ForgeFetchOptions): Promise<Response> {
  const { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, sleep = defaultSleep } = opts;
  // A retried merge/approve/comment would duplicate a write — only idempotent GETs are retried.
  const idempotent = (init.method ?? 'GET').toUpperCase() === 'GET';
  const host = hostOf(url);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      if (timedOut) {
        throw new ForgeHttpError(`timed out reaching ${host} after ${timeoutMs / 1000}s`, 'timeout');
      }
      if (idempotent && attempt < maxRetries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw new ForgeHttpError(`couldn't reach ${host}: ${err instanceof Error ? err.message : String(err)}`, 'network');
    }
    if (res.ok) return res;

    const rateLimited = isRateLimited(res);
    const retryable = idempotent && attempt < maxRetries && (rateLimited || res.status === 502 || res.status === 503 || res.status === 504);
    if (retryable) {
      const wait = rateLimited ? (parseRetryAfterMs(res.headers.get('retry-after')) ?? 1000 * (attempt + 1)) : 500 * (attempt + 1);
      if (wait <= MAX_RETRY_WAIT_MS) {
        await sleep(wait);
        continue;
      }
    }
    const detail = describeErrorBody(await res.text());
    const kind: ForgeErrorKind = rateLimited ? 'rateLimited' : res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : 'http';
    throw new ForgeHttpError(`${res.status} ${res.statusText} from ${host}${detail ? `: ${detail}` : ''}`, kind, res.status);
  }
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  // One shared iterator: each worker pulls the next unclaimed [index, item], so no index math or casts.
  const iterator = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of iterator) {
      results[index] = await fn(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function nextLinkFromHeader(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}

export async function fetchAllPages<T>(
  firstUrl: string,
  getPage: (url: string) => Promise<{ items: T[]; next?: string }>,
  maxPages: number = MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < maxPages; page++) {
    const { items, next } = await getPage(url);
    all.push(...items);
    url = next;
  }
  return all;
}

export function sameLogin(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
```

- [ ] **Step 4: Run** the same test file → expect PASS. Run `npm run lint`.
- [ ] **Step 5: Checkpoint** — stop; Raj reviews `git diff` and commits (`feat(forge): shared transport with timeout, bounded retry, typed errors`).

### Task A2: Delegate all four clients' `request()` to `forgeFetch`

**Files:**
- Modify: `GitHubClient.ts:392-417`, `GitLabClient.ts:~341`, `BitbucketClient.ts:~334`, `AzureDevOpsClient.ts:~569`
- Modify tests: `test/unit/core/forge/{GitHub,GitLab,Bitbucket,AzureDevOps}Client.test.ts`

**Interfaces:**
- Consumes: `forgeFetch(url, init, { fetchImpl })` from A1.
- Produces: each client's private `request()` keeps its **existing signature** (`(path, init?) => Promise<Response>`) and **existing error message format**, but now throws `ForgeHttpError`. `requestOrNull` is **removed** from GitHub (see Step 3) — enrichment failures must no longer vanish silently.

- [ ] **Step 1: Read** `fakeFetch` at `GitHubClient.test.ts:24`. If it returns a plain object rather than a real `Response`, change it (in all four test files) to build `new Response(JSON.stringify(body), { status, headers })` — `forgeFetch` reads `res.headers`. Run the four test files first to confirm they still pass **before** touching source (baseline).
- [ ] **Step 2: Write failing tests** (one per client, same shape): a 401 from the list endpoint throws an error where `isCredentialRejection(err) === true`; a 503 never does; a header-merge test (GitLab/Bitbucket/Azure currently *overwrite* `init.headers` — caller-supplied `Accept` must survive, as GitHub already does).
- [ ] **Step 3: Implement.** Replace each `request()` body with header-building + `return forgeFetch(url, { ...init, headers }, { fetchImpl: this.fetchImpl })`, merging `...init?.headers` last. In `GitHubClient`, replace `requestOrNull` with `requestOrNull` that **only swallows `kind === 'http'` 404s** (a PR with no reviews/check-runs endpoint) and rethrows everything else (`unauthorized`, `rateLimited`, `timeout`, `network`) — so a rate-limited enrichment surfaces as a board error row instead of "checks: none".
- [ ] **Step 4: Run** the four client test files + `npm run lint` → PASS. Update any existing assertion that relied on swallowed errors (expect the thrown `ForgeHttpError` instead).
- [ ] **Step 5: Checkpoint** (`refactor(forge): route every client through forgeFetch`).

### Task A3: Board loader — parallel, no credential wipe, network-free snooze

**Files:**
- Create: `src/core/forge/loadBoard.ts`; Test: `test/unit/core/forge/loadBoard.test.ts`
- Modify: `src/views/Launchpad/LaunchpadViewProvider.ts` (`refresh`, lines ~113-210, `toggleSnooze`)
- Modify: `src/constants.ts` only if a new key is needed (none expected)

**Interfaces:**
- Consumes: `mapWithConcurrency`, `isCredentialRejection` (A1); `categorizePullRequests`, `categorizeClosedPullRequests` (existing); `ForgeClient`.
- Produces:
```ts
export interface BoardRepoInput { repo: ForgeRepoRef; client: ForgeClient | null } // null = not signed in → "Not signed in." error row
export interface BoardDeps {
  repos: BoardRepoInput[];                                   // credentials/clients already resolved (sequentially) by the caller
  isSnoozed: (pr: PullRequestSummary) => boolean;
  onCredentialRejected: (repo: ForgeRepoRef) => Promise<void>; // caller clears the stored token
  logError: (message: string, err: unknown) => void;
  concurrency?: number;                                      // default 4
}
export interface BoardResult {
  categorized: CategorizedPullRequest[];
  errors: Array<{ repo: ForgeRepoRef; message: string }>;
  loginByRepoKey: Map<string, string>;
  rawByRepoKey: Map<string, { login: string; open: PullRequestSummary[]; closed: PullRequestSummary[] }>;
}
export async function loadBoard(deps: BoardDeps): Promise<BoardResult>;
export function recategorize(raw: BoardResult['rawByRepoKey'], isSnoozed: BoardDeps['isSnoozed']): CategorizedPullRequest[]; // pure, no network
```

- [ ] **Step 1: Write failing tests** (fake `ForgeClient` objects, no fetch):
  - Two repos load **concurrently** (second repo's `listOpenPullRequests` is invoked before the first resolves).
  - Repo 1 throws a `ForgeHttpError` `http`/503 → repo 2 still on the board, repo 1 in `errors`, `onCredentialRejected` **not** called.
  - Repo throws `unauthorized` → `onCredentialRejected` called exactly once for that repo.
  - `getAuthenticatedLogin` returning `null` → error row, no throw.
  - `recategorize` with a different `isSnoozed` moves a PR to `snoozed` **without** any client call (assert client call count unchanged).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `loadBoard` as `mapWithConcurrency(repos, concurrency, loadOne)` where `loadOne` mirrors current behavior (login → `Promise.all([open, closed])` → categorize) but catches per-repo and only calls `onCredentialRejected` when `isCredentialRejection(err)`.
- [ ] **Step 4: Wire the provider.** In `refresh()`: **resolve tokens sequentially first** (`for … await resolveForgeToken`) — it can show an input box, and parallelizing it would stack several at once — build clients, then call `loadBoard` with `onCredentialRejected: (repo) => clearForgeToken(...)`. Store `rawByRepoKey` on the provider; `toggleSnooze` then re-renders via `recategorize(...)` and **does not call `refresh()`** (fixes L6). Keep `Refresh` button and action-success paths calling the full `refresh(false)`.
- [ ] **Step 5: Snooze store pruning (L7):** after a successful full load, drop snoozed keys that match no PR in `rawByRepoKey`; test as a pure helper `pruneSnoozed(keys, livePrKeys): string[]` in `loadBoard.ts`.
- [ ] **Step 6: Run** unit tests + lint; **run** `npx tsx --test test/unit/views/launchpad.render.test.ts`. Integration (`test/integration/launchpad.test.ts`) runs in the final `/plan` verify step.
- [ ] **Step 7: Checkpoint** (`fix(launchpad): load repos in parallel, stop deleting credentials on transient errors`).

### Task A4: Pagination and bounded fan-out on every host

**Files:** Modify the four clients; extend the four client test files.

**Interfaces:** Consumes `fetchAllPages`, `nextLinkFromHeader`, `mapWithConcurrency`, `MAX_PAGES` (A1). `ForgeClient` interface is **unchanged**.

- [ ] **Step 1: Failing tests per client** (pin the boundaries from Review Focus #2): list endpoints with exactly 100, 101 and 250 items return all of them; a source that always returns a `next` stops at `MAX_PAGES`; comments/statuses/diffstat/threads (Bitbucket) and discussions/diffs (GitLab) and `reviews` (GitHub — newest reviews are last, so truncation loses the *newest*) are paginated.
- [ ] **Step 2: Implement per host:**
  - GitHub/GitLab: `fetchAllPages` with `nextLinkFromHeader(res.headers.get('link'))`. GitLab also honors `x-next-page`.
  - Bitbucket: set `pagelen=50`; follow body `next` URL.
  - Azure DevOps: `$top=100&$skip=n` loop until a short page; same for `iterations/{n}/changes` and threads.
- [ ] **Step 3: Cap the fan-out.** Replace every `Promise.all(raw.map(enrich…))` with `mapWithConcurrency(raw, 6, …)`. Azure `getPullRequestDiff` file-content fetches: `mapWithConcurrency(files, 6, …)`.
- [ ] **Step 4: GitHub enrichment tiering.** Before enriching, split the list: **candidates** = authored by `authenticatedLogin` or in `requested_reviewers` (both already in the list payload) get full `enrich` (reviews + check-runs + mergeable). Everything else gets **reviews only** (1 request) to detect `reviewedByMe`; if not reviewed by me it is dropped by `categorizePullRequests` anyway, so skip check-runs/mergeable for it. Test: a 50-PR repo where 2 are mine makes `2×3 + 48×1` requests (assert via counting fake fetch), not 150. `getAuthenticatedLogin` must have run — throw a clear `Error` from `listOpenPullRequests` if `authenticatedLogin` is unset (fixes N6).
- [ ] **Step 5: Run** client tests + lint → PASS.
- [ ] **Step 6: Checkpoint** (`fix(forge): paginate every list and cap request fan-out`).

### Task A5: Normalization and identity bugs

**Files:** `GitHubClient.ts` (`latestReviewPerUser`, `computeReviewDecision`, merge cleanup), `GitLabClient.ts:~86`, `BitbucketClient.ts` identity, `AzureDevOpsClient.ts` identity; their tests.

- [ ] **Step 1: Failing tests (N1):** `[{amy, CHANGES_REQUESTED}, {amy, COMMENTED}]` → `reviewDecision === 'changesRequested'`; `[{amy, APPROVED}, {amy, PENDING}]` → `approved`; `[{amy, CHANGES_REQUESTED}, {amy, APPROVED}]` → `approved` (a real later verdict still wins); `DISMISSED` clears a prior verdict.
- [ ] **Step 2: Implement N1:** in `latestReviewPerUser`, skip reviews whose `state` is `COMMENTED` or `PENDING`; treat `DISMISSED` as removing that user's entry.
- [ ] **Step 3 (N2):** `computeReviewDecision` — approvals from non-requested reviewers still count: return `approved` when at least one `APPROVED` exists **and** no `CHANGES_REQUESTED`, regardless of `requested_reviewers`; `reviewRequired` only when there is no approval. Test both orders.
- [ ] **Step 4 (N3):** **Re-read `GitHubClient.ts` ~285-337 first.** Only delete the head branch when `head.repo.full_name === base repo identity`; otherwise skip deletion and let the host's own setting decide. Test: fork PR with same-named branch → no DELETE request issued.
- [ ] **Step 5 (N4):** GitLab — stop mapping `blocking_discussions_resolved === false` to `changesRequested`; derive from approvals only. (Unresolved-thread count surfaces in Phase B.) Test: approved + unresolved discussion → `approved`.
- [ ] **Step 6 (N5):** Replace every `===` login comparison in the four clients and in `LaunchpadViewProvider.isOwnPullRequest` / `PullRequestDetailsViewProvider.submitReview` / `categorize.ts` with `sameLogin`. Bitbucket: compare on `uuid` where the client already reads it (`BitbucketClient.ts:~124`). Azure: normalise both sides via lower-cased `uniqueName`/`emailAddress`; **do not** fall back to `displayName` for identity matching.
- [ ] **Step 7: Run** all `test/unit/core/forge/*` + lint → PASS.
- [ ] **Step 8: Checkpoint** (`fix(forge): review-state and identity normalization`).

### Task A6: Shared PR action flows (prerequisite for Phase B)

**Files:**
- Create: `src/views/pullRequestActions.ts`, `src/views/pullRequestActionUi.ts`; Test: `test/unit/views/pullRequestActions.test.ts`
- Modify: `LaunchpadViewProvider.ts`, `PullRequestDetailsViewProvider.ts`

**Interfaces:**
- Produces:
```ts
export interface PullRequestActionUi {
  confirm(message: string, ...buttons: string[]): Promise<string | undefined>;
  pickMergeStrategy(pr: PullRequestSummary): Promise<MergeStrategy | undefined>;
  warn(message: string): void;
  error(message: string): void;
}
export interface ActionContext { pr: PullRequestSummary; client: ForgeClient; ui: PullRequestActionUi; logError: (m: string, e: unknown) => void; myLogin?: string }
/** Each resolves true only if the PR's state actually changed on the host. */
export async function closePullRequestFlow(ctx: ActionContext): Promise<boolean>;
export async function reopenPullRequestFlow(ctx: ActionContext): Promise<boolean>;
export async function mergePullRequestFlow(ctx: ActionContext): Promise<boolean>;
export async function submitReviewFlow(ctx: ActionContext, decision: ReviewSubmission): Promise<boolean>;
```
`pullRequestActions.ts` has **no `vscode` import**; `pullRequestActionUi.ts` is the `vscode.window` adapter (reusing `pickMergeStrategy`).

- [ ] **Step 1: Failing tests** with a fake UI + fake client: declining the confirm → no client call, returns `false`; accepting → exactly one call, returns `true`; client throws → `ui.error` called with `"GitLore: couldn't <verb> the PR — <reason>"`, returns `false`; own-PR review (`sameLogin(pr.authorLogin, myLogin)`) → `ui.warn("GitLore: you can't review your own pull request.")`, no confirm, no call; merge with "Merge & Delete Branch" passes `deleteSourceBranch: true`.
- [ ] **Step 2: Implement** the flows by moving the existing logic (messages, modal wording, button labels) **verbatim** from the two providers.
- [ ] **Step 3: Rewire** both providers to call the flows, then refresh (`Launchpad`: `refresh(false)`; PR Details: `getPullRequest` + `load`). Delete the duplicated private methods. Keep the `*ForTest` method names the integration suite uses, but implement each as the same flow with an auto-confirming fake UI — so integration tests now exercise production logic including the self-review guard instead of a copy that skipped it.
- [ ] **Step 4: Run** unit tests + lint; confirm no references to removed methods (`grep`).
- [ ] **Step 5: Checkpoint** (`refactor(pr): one shared close/reopen/merge/review flow`).

### Phase A verification (run by `plan-verifier` after Phase 4)

`npm run lint` → `npm run test:unit` → `npm run test` (integration, launches the Extension Host). Then manual F5 smoke by Raj: (1) open Launchpad with a PAT host, kill network mid-refresh → PAT survives, error row shown; (2) snooze a card → no network activity; (3) a repo with >100 open PRs shows all of them.

---

### Phase A carry-over (found while preparing the 1.2.6 release)

Phase A shipped as 1.2.6 with these gaps, verified by reading the code — **not** delivered despite Task A4 Step 2 listing them:

- **Still unpaginated, single request (first page only):** GitHub `/pulls/{n}/files` and GraphQL `reviewThreads(first: 100)` (no `pageInfo`); GitLab MR `/diffs` and `/discussions`; Bitbucket `/diffstat`, `/comments`, commit `/statuses`; Azure DevOps `iterations/{n}/changes` and `/threads`. Fold into **B2** (threads/comments get rewritten there anyway) and **B1** (diff fetch is being reworked and cached there). Add a pinning test per call (exactly 100 / 101 items).
- **Fixed in the release prep:** GitHub `listRecentlyClosedPullRequests` had been given the full `MAX_PAGES` walk (up to 10 requests per repo per refresh) — now pinned to one page, with a test. The closed lists on GitLab/Bitbucket/Azure were never paged and are untouched (they are documented as a bounded slice).
- **Process note:** the implementer's report described A4 as complete and the verifier did not check per-call pagination. For Phase B, the verifier brief must list each acceptance point from the plan explicitly instead of generic checks.

## Phase B — PR review depth (webview) · size L · needs its own design

| ID | Item | Size | Hosts | Notes |
|---|---|---|---|---|
| B1 | Add `headSha` to `PullRequestSummary`; one diff cache keyed `(prKey, headSha)` shared by load/Explain/Draft; AI cache keyed on headSha | S | all | fixes P4, P5; prerequisite for E |
| B2 | Full thread: `ConversationThread.comments[]`, `replyToThread`, `unresolveThread` | M | all four support both *(per API knowledge; verify per host)* | resolve is GitHub GraphQL, others REST |
| B3 | Verdict with a body: `submitReview(..., body?)` | S–M | GitHub native body; GitLab/Bitbucket/Azure post the body as a comment **then** vote — document the asymmetry in the UI copy | GitLab `requestChanges` still throws |
| B4 | Check detail: `listChecks(repo, number)` → `{name,status,url}[]`, fetched lazily in PR Details only (never on the board) | M | all four expose a URL | fixes P3 |
| B5 | Thread → "jump to file/line in this panel's diff" | S | all | `file`/`line` already on `ConversationThread` |
| B6 | Unresolved-thread count badge (replaces the dropped GitLab mapping from N4) | S | all | |

## Phase C — Launchpad polish · size M

- C1 Refresh when the window regains focus, throttled to ≥ 60 s, only while the Launchpad panel exists. (S) — focus event, not polling; consistent with §10.
- C2 Timed snooze (1 h / tomorrow / until the PR is updated) with auto-unsnooze on `updatedAt` change. (S–M)
- C3 "Updated N min ago" + keep last good data for a repo whose refresh failed, marked stale. (S)
- C4 Bucket semantics (see Open Question 1). (S, tiny diff, product decision)

## Phase D — Glanceable status · size M · opt-in

Status-bar item (`N need review`) fed by the same `loadBoard`, refreshed on window focus. New setting `gitLore.launchpad.statusBar.enabled` (default `false`), requires `launchpad.enabled`. **Hard rule:** it resolves credentials **silently** (`createIfNone: false`, never `showInputBox`) — a status bar item must never raise an auth prompt. Unsigned host → item hidden, not nagging.

## Phase E — AI review upgrade + housekeeping · size M

- E1 Per-file map-reduce review: summarise each file's diff within `maxDiffChars`, then one synthesis call; cap at 12 calls; show progress; cache by headSha (needs B1). Same `gitLore.ai.enabled` gate, checked **before** any diff fetch. (M–L)
- E2 Housekeeping bundle (S each): shared `createNonce` via `crypto.randomBytes`; one `showAiDisabledNotice()` replacing 9 `.then()` sites; `CONFIG`-ize `ChatViewProvider.ts:110`; coverage measurement for `src/core` using Node's built-in `--experimental-test-coverage` (no dependency); **update CLAUDE.md §7/§8 and README** (needs Raj's OK — see Open Question 5).

## Phase F — Local-history backlog (ranked; each needs a design before tasks)

| Rank | Idea | Why | Size | Verified |
|---|---|---|---|---|
| 1 | Blame move/copy detection (`git blame -M -C`) behind `gitLore.blame.detectMoves` | "who wrote this" is wrong after refactors that move code; blame currently passes only `-w` and ignore-revs | S | confirmed absent in `GitService.blameFile` |
| 2 | "Open the PR that introduced this commit" action in the hover (resolved **on click**, never on hover) | closes the "why" gap — the commit message is rarely the reason, the PR is | M | needs `launchpad.enabled` + auth; else hidden |
| 3 | "Find when this text appeared/disappeared" (`git log -S/-G`, pickaxe) | the classic "when did this string go away" question; nothing in GitLore does it | S–M | no `-S`/`-G` in `GitService` |
| 4 | Line **range** history from a selection (`git log -L start,end:file`) | `getLineHistory` handles one line only | S | confirmed single-line (`GitService.ts:210`) |
| 5 | Submodule fixture + tests (§10 lists submodules as handled; unproven) | correctness, not a feature | S | the 08-19 audit said untested — re-check before acting |

---

## What breaks at scale (after Phase A, and what Phase A does *not* fix)

- **~1000 PRs/repo:** `MAX_PAGES = 10` is a silent ceiling. Acceptable for "PRs I care about" but a monorepo with thousands of open PRs will still hide the tail. Real fix is a server-side filter (GitHub search `involves:@me`, 30 req/min limit) — deferred, not free.
- **GitHub secondary rate limits:** tiering cuts requests ~3×, `forgeFetch` backs off, but a 20-repo workspace still bursts. Next lever is ETag/`If-None-Match` conditional requests (304s don't count against the primary limit) — Phase C candidate if it bites.
- **Webview memory/DOM:** the board renders every card; at a few hundred PRs the full-HTML `webview.html` rewrite on each refresh (resets scroll/state) becomes the cost. Not addressed here.
- **Azure DevOps huge PRs:** diff is still 2 requests per file; capping concurrency protects the host but a 300-file PR takes a while. B1's cache means it is paid once per head SHA, not three times.
- **AI on big PRs:** 8000-char truncation stays until E1.

## Do-not-build list

| Idea | Why not |
|---|---|
| Native inline review via VS Code Comments API | Raj chose webview depth. Revisit after B ships; needs per-host line-position mapping and PR head ref fetching (XL). |
| Background polling / push notifications | Violates §10 and the local-first spirit; focus-refresh (C1) gets 90% of the value. |
| A notification/webhook backend | §4/§20: no GitLore backend, ever. |
| GitHub team review requests (L10) | Needs `read:org` scope — widens the OAuth grant for a niche case. Revisit only if asked. |
| Pending/batched reviews | GitHub + GitLab only; Azure/Bitbucket can't — breaks parity. B3's body-on-verdict covers the real need. |
| Faking GitLab "request changes" / Bitbucket reopen | Already ruled out; keep the clear platform-gap errors. |
| `p-limit` / Octokit / any HTTP dependency | §6: ask first; 20 hand-written lines do it. |
| Bisect UI | Stateful multi-step CLI flow; the terminal does it fine (from the 2026-08-19 audit; still stands). |
| Auto-merge / merge queue | GitHub-only GraphQL; breaks parity. |

## Open questions for Raj

1. **L9 — Blocked vs Needs Review.** A PR you're asked to review with failing CI currently shows in **Blocked**. Recommend: *Blocked* only for PRs you authored; for others, reviewer-requested wins → *Needs Review* (CI state still shown on the card). Do you agree?
2. **Truncation ceiling:** is ~1000 PRs/repo acceptable, or do you want the server-side filter in scope?
3. **Status bar default:** off (recommended, matches "Launchpad off by default") or on-when-Launchpad-enabled?
4. **Azure DevOps bad-PAT behavior** is unverified (may be 203/HTML, not 401). If you have an Azure org, a one-off check of what a revoked PAT returns would settle whether `isCredentialRejection` needs an Azure special case.
5. **Edit CLAUDE.md?** It's your project spec and far out of date (E2). OK for me to update §7/§8, or do you want to own that edit?
