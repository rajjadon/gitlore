# Phases B–F — Acceptance Contract

Single source of truth for implementers **and** verifiers of Phases B–F of `2026-10-16-launchpad-pr-review-roadmap.md`. Every numbered point (`B1.3`, `C2.2`, …) must be individually checkable by reading code or a named test. A phase is not done if any point is unmet — "optional" does not exist here (lesson from Phase A: a skipped step was reported as complete).

## Decisions locked with Raj (2026-10-16)

- Test policy: unit tests + `npm run lint` freely during a phase; **one** `npm run test:integration` per phase-end verification. Never `git commit/add/stash/checkout/reset`, never a worktree, never a "baseline" built by altering the working tree.
- Review-bucket rule (L9): a PR you did **not** author never goes to Blocked; a requested review wins → Needs Review. Blocked only for PRs you authored (failing CI / changes requested / conflicts).
- Status bar (Phase D): **on by default** once `gitLore.launchpad.enabled` is true; setting `gitLore.launchpad.statusBar.enabled` default `true`, but it still does nothing unless Launchpad is enabled.
- Raj authorised updating `CLAUDE.md` (§7/§8) and `README.md` to match shipped reality (done once, at the end — Phase E2).
- Webview depth for PR review; **no** native Comments-API review. No new runtime dependency. No `any`, no unjustified `!`, async/await only (no `.then`), no magic strings (constants in `src/constants.ts`), no `vscode` import in `src/core/**`, webviews keep nonce + strict CSP, no inline handlers, icon-only buttons get `aria-label`.
- Known pre-existing failures (do not "fix" as part of a phase, do not count as regressions): unit — 2 in `test/unit/skeleton.render.test.ts` (Playwright browser missing; fixed separately in E2); integration — the 6 AI "no-model hint" tests (Branch comparison summarizeComparison; Chat; Commit details explainCommit ×2; Launchpad explainPr; Launchpad draftReview).
- Every user-visible change gets a `CHANGELOG.md` entry under `## [Unreleased]`, written for a user of GitLore.

## Shared interface changes (exact)

```ts
// src/core/forge/types.ts
export interface ThreadComment { authorLogin: string; body: string; createdAt?: string }
export interface ConversationThread { /* existing fields kept */ comments: ThreadComment[] } // comments[0] mirrors body/authorLogin
export interface CheckDetail { name: string; status: CheckStatus; url?: string }
// PullRequestSummary gains:  headSha: string   // '' when a host doesn't expose it; never undefined
// src/core/forge/ForgeClient.ts gains:
replyToThread(repo: ForgeRepoRef, number: number, threadId: string, body: string): Promise<void>;
unresolveConversationThread(repo: ForgeRepoRef, number: number, threadId: string): Promise<void>;
listChecks(repo: ForgeRepoRef, number: number): Promise<CheckDetail[]>;
submitReview(repo: ForgeRepoRef, number: number, decision: ReviewSubmission, body?: string): Promise<void>; // body now optional param
findPullRequestForCommit(repo: ForgeRepoRef, sha: string): Promise<{ number: number; title: string; url: string } | null>; // Phase F only
```

Per-host mapping (from API knowledge — **verify against the existing client's conventions; if an endpoint is uncertain, implement the documented one and say so in the report**):

| Op | GitHub | GitLab | Bitbucket Cloud | Azure DevOps |
|---|---|---|---|---|
| reply | GraphQL `addPullRequestReviewThreadReply` | `POST …/discussions/:id/notes` | `POST …/comments` with `parent: {id}` | `POST …/threads/:id/comments` (`parentCommentId`) |
| unresolve | GraphQL `unresolveReviewThread` | `PUT …/discussions/:id` `resolved=false` | `DELETE …/comments/:id/resolve` | `PATCH …/threads/:id` `status: "active"` |
| review body | `body` on `/reviews` | post body as a note **then** approve | post comment **then** approve/request-changes | post thread comment **then** vote |
| checks | check-runs (+ name/status/conclusion/html_url) | head-pipeline jobs (name/status/web_url) | commit statuses (key|name/state/url) | PR statuses (context.name/state/targetUrl) |
| PR for commit | `GET /repos/{r}/commits/{sha}/pulls` | `GET /projects/:id/repository/commits/:sha/merge_requests` | `GET …/commit/{sha}/pullrequests` | `POST …/pullrequestquery` by commit |

Asymmetries stay honest: GitLab `requestChanges` still throws its platform-gap error even with a body; if the "comment first" step fails, **do not** cast the vote; Bitbucket thread = top-level comment, replies grouped by `parent.id`.

---

## Phase B — PR review depth

### B-I (core/forge, unit-tested, no UI)

- **B1.1** `PullRequestSummary.headSha` populated by all four clients in list, `getPullRequest`, closed-list and `createPullRequest` outputs (`''` where unavailable). Every test/fixture that builds a `PullRequestSummary` still compiles.
- **B1.2** Pagination carry-over, each pinned by a test at exactly 100 and 101 items and a page-cap test: GitHub `/pulls/{n}/files` and GraphQL `reviewThreads` (`pageInfo.hasNextPage`/`endCursor`); GitLab MR `/diffs` and `/discussions`; Bitbucket `/diffstat`, `/comments`, commit `/statuses`; Azure `iterations/{n}/changes` and `/threads`. Must use `fetchAllPages`/`fetchAllSkip`/`MAX_PAGES` from `forgeFetch.ts`; no per-call ad-hoc loops.
- **B2.1** `ConversationThread.comments` populated on all four hosts (full thread, oldest first; `comments[0]` equals `body`/`authorLogin`).
- **B2.2** `replyToThread` + `unresolveConversationThread` implemented on all four clients per the table, with tests asserting the exact request (method, URL, body) via the fake fetch.
- **B3.1** `submitReview(..., body?)`: GitHub sends `body`; others comment-then-vote; empty/whitespace body → no comment step; comment failure → no vote cast (test); GitLab `requestChanges` throws unchanged.
- **B4.1** `listChecks` on all four hosts per the table; returns `[]` (not throw) when a host has none; failing/pending/passing mapped to `CheckStatus`; `url` omitted when the host gives none. Test per host.
- **B4.2** `ForgeClient.ts` doc comments updated for every new/changed method, including platform asymmetries.

### B-II (PR Details panel, provider + render)

- **B1.3** One diff cache in `PullRequestDetailsViewProvider`: keyed `${pullRequestKey(pr)}@${pr.headSha}`, shared by `load`, `explainPr`, `draftReview` (the diff for one head SHA is fetched at most once; test via a counting fake client). AI explanation cache key includes `headSha` (a new push → no stale summary; test).
- **B2.3** Thread cards render **all** comments (author, body, relative time when `createdAt`), a Reply textarea + button (disabled while posting, cleared on success, error toast + re-enabled on failure), and an **Unresolve** button on resolved threads (Resolve stays on unresolved). New messages `replyToThread` / `unresolveThread` validated like the existing ones (typeof checks, current PR/client present). After success the panel refreshes threads.
- **B3.2** Approve / Request changes read an optional review-comment textarea in the panel and pass it as `body`; trimmed; empty → undefined. Existing confirm modal + self-review guard (shared `submitReviewFlow`) preserved; `submitReviewFlow` gains the `body?` parameter with a unit test.
- **B4.3** A Checks section lazily loads `listChecks` when the panel opens (not on the Launchpad board): failing first, then pending, then passing collapsed to a count; each check with a `url` is an external link (opened via the existing `openRemote`-style message with a validated `http(s)` URL only — reject others, with a test); skeleton while loading; a failed load shows a one-line inline error, never blocks the diff.
- **B5.1** A thread's `file`/`line` renders as a button that scrolls to that file's section in the panel's diff (anchor/`data-` attribute + scrollIntoView; no inline handler); if the file isn't in the diff, the button is disabled with a title explaining why.
- **B6.1** Header shows an unresolved-thread count badge (text + icon, not color alone) using the existing badge styles; hidden at 0.
- **B7.1** Render unit tests (`test/unit/views/pullRequestDetails.render.test.ts`) cover: multi-comment thread, reply box present, unresolve button on resolved only, checks section ordering, link scheme validation, unresolved badge, escaping of author/body/check names (XSS).
- **B7.2** CHANGELOG entries for B1–B6.

---

## Phase C — Launchpad polish

- **C1.1** Refresh when the window regains focus (`vscode.window.onDidChangeWindowState`), only while the Launchpad panel exists, throttled to ≥ 60 s since the last load, and never while a refresh is in flight. Disposed with the panel. Pure throttle helper in `src/core/forge/` with unit tests (injectable clock).
- **C2.1** Timed snooze: choices **1 hour / Tomorrow 9am / Until the PR changes** via QuickPick (replacing the plain toggle; un-snooze stays one click). Store format migrated from `string[]` to `Record<key, { until?: number; updatedAt?: string }>` with a pure `migrateSnoozeState` (old `string[]` entries become "until changed"). Pure `isSnoozedNow(entry, pr, now)` unit-tested: expired time → not snoozed; "until changed" auto-unsnoozes when `pr.updatedAt` differs from stored.
- **C2.2** `pruneSnoozed` works on the new format; the existing tests are updated, not deleted.
- **C3.1** Board shows "Updated N min ago" (re-rendered on focus-refresh; pure formatter in `src/utils`, unit-tested incl. just now / minutes / hours).
- **C3.2** When a repo's refresh fails but a previous good result exists, keep showing that repo's last PRs marked stale (visible text + icon) alongside its error row; first-ever failure behaves as today. Unit test in `loadBoard`.
- **C4.1** `categorize.ts` bucket rule (L9): for `pr.authorLogin` ≠ me, never `blocked`; order becomes: snoozed → drafts → reviewed → (authored-by-me ? blocked-check : skip) → needsReview → readyToMerge → waiting. Update `categorize.test.ts` (existing cases that encoded the old rule are changed deliberately and listed in the report) and add: reviewer + failing CI → needsReview; own PR + failing CI → blocked; reviewer-requested + changes requested by someone else → needsReview.
- **C5.1** Launchpad render/CSS for stale + "updated ago" + snooze picker keeps a11y (labels, keyboard, no color-only meaning). Render tests updated. CHANGELOG.

## Phase D — Glanceable status

- **D1.1** `src/providers/LaunchpadStatusBar.ts` (a `vscode.Disposable`): status-bar item `$(git-pull-request) N` with tooltip listing per-repo counts and "Open Launchpad"; click runs `COMMANDS.openLaunchpad`. Registered in `context.subscriptions`, created lazily after `activate()` via `setImmediate` (no activation-time work beyond constructing the object; activate() budget < 50 ms preserved).
- **D1.2** Active only when `gitLore.launchpad.enabled` **and** `gitLore.launchpad.statusBar.enabled` (new setting, default `true`, in `package.json`, `constants.ts`, described precisely). Reacts to config changes (`onDidChangeConfiguration`) by showing/hiding with no reload.
- **D1.3** **Never prompts.** New `resolveForgeTokenSilently(secrets, detected)` in `forgeCredentials.ts`: built-in sessions via `getSession(..., { createIfNone: false, silent: true })`, PAT hosts via `secrets.get` only; returns `null` rather than ever calling `showInputBox`/`createIfNone: true`. Unit/integration test proves no input box is invoked when unsigned. Unsigned/failed host ⇒ that repo is skipped; zero reachable repos ⇒ item hidden.
- **D1.4** Count = PRs in `needsReview` bucket (same `loadBoard`/`categorize` code path as the board — no second implementation of the rules). Refresh: on first enable (deferred), on window focus (shares the C1 throttle helper, ≥ 60 s), and whenever Launchpad itself finishes a refresh (single shared in-memory result; no duplicate network load when both are active).
- **D1.5** Network failure leaves the last count with a stale marker in the tooltip; never raises a toast. Logged to the output channel only.
- **D1.6** `launchpad.enabled = false` ⇒ zero network calls and the item is not created (integration/unit assertion with a counting fetch). CHANGELOG + settings description.

## Phase E — AI review upgrade + housekeeping

### E1 — per-file AI review
- **E1.1** Pure functions in `src/core/ai/` (no vscode): `splitDiffByFile(diff): FileDiff[]`, `buildFileReviewPrompt(...)`, `buildReviewSynthesisPrompt(...)`; unit-tested incl. binary/rename/empty diff, no-trailing-newline, single huge file (truncated per file at `maxDiffChars` with the existing truncation marker).
- **E1.2** `draftReview` flow: if the whole diff ≤ `maxDiffChars` → current single call (unchanged behavior). Else map each file (max **12** model calls total: files beyond the cap are listed by name in the synthesis prompt, not silently dropped), then one synthesis call that streams the review draft. Progress message to the webview ("Reviewing file 3 of 9…"); abortable via the existing `aiAbortController`.
- **E1.3** `gitLore.ai.enabled` checked **before** any diff/threads fetch and before any model call (test with counting client: disabled ⇒ zero fetches, zero model calls). Per-head-SHA cache (`B1.3` key) holds per-file summaries so re-drafting after a thread resolve doesn't re-pay the map step.
- **E1.4** `explainPr` uses the same splitter for oversized diffs. CHANGELOG.

### E2 — housekeeping
- **E2.1** `src/views/nonce.ts` exports `createNonce()` using `crypto.randomBytes`; every view's local `createNonce` (Launchpad, PR Details, all other providers — grep) replaced; unit test for length/charset/uniqueness.
- **E2.2** `showAiDisabledNotice()` in `src/ai/` (or `src/views/`) as an `async` function (no `.then`) replacing all 9 duplicated snippets; the hardcoded `'gitLore.ai.enabled'` in `ChatViewProvider.ts` replaced by `CONFIG`; zero `.then(` remaining in `src/` (grep must return nothing except documented exceptions with a comment).
- **E2.3** `npm run test:coverage` script using Node's built-in `--experimental-test-coverage` (no new dependency) scoped to `src/core/**`; report the current core coverage number in the report (do not add a failing threshold).
- **E2.4** `test/unit/skeleton.render.test.ts`: skip the test (with a clear message naming `npx playwright install chromium`) when `chromium.launch()` throws "Executable doesn't exist", and make the `after` hook tolerate an undefined browser; then run `npx playwright install chromium` so the real test also passes on this machine.
- **E2.5** `CLAUDE.md` §7 (add shipped Chat/co-change/reflog/Explorer-write/Launchpad-depth/status-bar/etc.), §8 (full, accurate commands, settings, views tables — read `package.json` `contributes`, don't guess), §16 stays; `README.md` commands + settings tables complete (all `gitLore.*` settings), stale "doesn't stash" claim fixed, privacy section mentions the opt-in AI path and Launchpad's opt-in network use. Counts verified against `package.json` by script, not by eye.

## Phase F — Local-history backlog

### F-a (git side)
- **F1.1** `gitLore.blame.detectMoves` boolean, default `false`, in `package.json`/`constants.ts`; when true `blameFile` adds `-M -C`; cache key includes the flag so toggling doesn't serve stale blame. Test for the arg builder (pure function extracted from `blameFile`) with/without the flag and with `ignoreWhitespace`/ignore-revs combinations.
- **F3.1** `GitService.searchHistory(repoRoot, query, mode: 'string' | 'regex', filePath?)` using `git log -S` / `-G` (`--pickaxe-regex` not needed for `-G`), bounded by `maxHistoryItems`, pure `parse` via the existing log parser; command `gitLore.findWhenTextChanged` ("GitLore: Find When Text Was Added or Removed") prefilled from the selection, QuickPick of results → opens Commit Details. Guards: empty query, no repo, untracked file, no matches (info message). Unit tests for arg building + parse; integration test against the fixture repo.
- **F4.1** Line-**range** history: `getLineHistory` accepts a start/end range (`-L start,end:file`); the existing single-line callers keep working; the "Explain/Step line history" command uses the active selection when non-empty. Tests for the arg builder and range clamping.
- **F5.1** Submodule fixture + integration/unit proof that blame and file history resolve inside a submodule working tree (`git -c protocol.file.allow=always submodule add` in the fixture builder). If git behaviour makes a case unsupported, document it in a code comment and a CHANGELOG "Known limitations" note instead of faking support.
- **F6.1** CHANGELOG entries; commands/settings added to `package.json` `contributes` and `constants.ts`.

### F-b (PR for this commit)
- **F2.1** `findPullRequestForCommit` on all four clients per the table (returns the merged/open PR that contains the commit, preferring merged; `null` when none; tests per host with the exact request).
- **F2.2** Command `gitLore.openPullRequestForCommit` + a hover-card action "Open PR". **Resolved on click, never on hover.** Hidden unless `gitLore.launchpad.enabled`; uses the silent token path (no prompt on click either — unsigned ⇒ one inline info message "Sign in via Launchpad to look up pull requests" with an Open Launchpad action). Result opens the PR in PR Details if it's on the board, else in the browser (validated URL).
- **F2.3** Per-(repo, sha) result cache (`LruCache`) incl. negative results, so repeated clicks don't re-hit the host.
- **F2.4** Unit tests for the resolver (cache hit/miss/negative, unsigned, no remote, unknown host); hover render test for button presence/absence by setting. CHANGELOG.

## Definition of done per phase (what the verifier checks)

1. `npm run lint` clean. 2. `npm run test:unit` — only the known pre-existing failures. 3. `npm run test:integration` once — only the known 6. 4. Every numbered acceptance point above for the phase(s) under verification confirmed by reading the code/test (report **per point**: ✔ file:line / ✘ reason). 5. grep checks: no `any`, `console.`, `.then(`, `vscode` import in `src/core/**`, new magic strings, `package.json` `dependencies` unchanged. 6. `git stash list` empty and no commits made.
