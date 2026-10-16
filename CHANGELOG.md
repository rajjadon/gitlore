# Changelog

All notable changes to GitLore are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The VS Code Marketplace shows this file on GitLore's extension page, so entries describe what changed for someone *using* GitLore. Why a change was made the way it was belongs in the commit message and in code comments, next to the code it explains.

## [Unreleased]

## [1.3.0] - 2026-10-16

### Added

- **Blame: detect moved/copied lines** — a new setting **`gitLore.blame.detectMoves`** (off by default) passes `-M -C` to `git blame`, so lines moved or copied from another file are attributed to their original author rather than the person who moved them. Useful for refactored codebases; note that it makes blame slower on large files.
- **Find When Text Was Added or Removed** — a new command "GitLore: Find When Text Was Added or Removed" (`gitLore.findWhenTextChanged`) searches the git history for commits that introduced or removed a given string or regular expression. The input is pre-filled from the active single-line selection. Results appear in a QuickPick (SHA · subject · author · date); selecting one opens the Commit Details panel. Scope can be limited to the current file or the whole repository. An invalid regex is caught before any git process is started and surfaced as an error message.
- **Line-range history** — the "Step Through Line History" hover stepper and the underlying `git log -L` call now support a line *range* (`-L start,end:file`) rather than only a single line. When the active editor has a multi-line selection that spans the hovered line, the stepper walks through commits that changed any line in that range rather than just one.
- **Submodule support** — blame decorations and file history now correctly resolve the repository root to the submodule's own working tree (not the parent super-project) when the open file lives inside a git submodule. Both `git blame` and `git log` operate against the submodule's own object store, so output is accurate. **Known limitation:** `--follow` is not combined with `-L` (line history in a submodule still uses the submodule's own history without cross-rename tracking) — this matches existing behaviour in the non-submodule case.
- **Launchpad: status bar needs-review count** — a new status-bar item (`$(git-pull-request) N`) shows how many pull requests need your review at a glance, without opening the Launchpad board. The count updates whenever Launchpad refreshes, and also refreshes itself silently on window focus (at most once every 60 seconds). If a refresh fails, the last known count is kept with a "(stale)" note in the tooltip — no toast, no interruption. The item shows a per-repo breakdown in its tooltip and opens Launchpad when clicked. Controlled by the new setting **`gitLore.launchpad.statusBar.enabled`** (on by default, effective only when Launchpad is also enabled); the item is never created and makes zero network calls when Launchpad itself is disabled.
- **Launchpad: refresh on window focus** — Launchpad now silently refreshes whenever VS Code regains focus, as long as at least 60 seconds have passed since the last load and no refresh is already running. No loading flash — the board updates in place.
- **Launchpad: timed snooze** — the Snooze button now opens a quick-pick with three choices: "1 hour", "Tomorrow 9am", or "Until the PR changes". "Until the PR changes" automatically un-snoozes the next time the PR is updated on the host. Un-snoozing is still one click with no picker.
- **Launchpad: last-good-data on failure** — when a repo's refresh fails but a previous successful load exists, the board keeps showing that repo's last known PRs with a "⚠ stale" label, so a temporary network blip doesn't wipe your entire board.
- **Launchpad: "Updated N ago" header** — the toolbar now shows how long ago the board data was loaded ("Updated just now", "Updated 5 min ago", etc.), refreshed on every board render including silent focus refreshes.
- **Launchpad: reviewer + failing CI now goes to Needs Review** — a PR you didn't author now never lands in Blocked, even when its CI is failing or someone else requested changes. Blocked is reserved for PRs you authored yourself, since that's the only case where you're the one who needs to act. Requested-review PRs route to Needs Review so the action you can take (review it) is always visible.
- **PR Details: reply to a review thread** — each conversation thread in the Pull Request Details panel now has a Reply text area and button. Replies are posted directly to the thread on GitHub, GitLab, Bitbucket, or Azure DevOps without leaving the editor.
- **PR Details: unresolve a conversation thread** — resolved threads now show an Unresolve button alongside the existing Resolve button on unresolved threads, so you can reopen a discussion that was closed prematurely.
- **PR Details: full thread history** — the conversation panel now shows every comment in a thread (oldest first), including each commenter's name and when they posted, instead of only the opening comment.
- **PR Details: attach a comment to your review verdict** — the panel now has an optional "Review comment" box above the Approve and Request Changes buttons; whatever you type is sent together with your verdict. An empty or whitespace-only note is ignored. On GitHub it travels inside the review itself; on GitLab, Bitbucket, and Azure DevOps, whose approval votes can't carry text, it is posted as a comment first and the vote follows (if the comment fails, no vote is cast).
- **PR Details: CI checks list** — the panel now shows the individual CI check names and statuses for the PR's head commit (failing first, then pending, then a count of passing checks), each with a link to the check's log page. The list loads after the diff so it never delays the code you're reviewing.
- **PR Details: jump to a file from a thread** — clicking a thread's file-and-line location scrolls the diff to that file's section in the panel. When the file isn't in the diff the button is disabled with an explanation.
- **PR Details: unresolved thread count badge** — the Conversations section header now shows a badge with the count of unresolved threads when there are any, so you can see at a glance whether there is open feedback that needs addressing.
- **Blame hover: Open PR for commit** — the blame hover card now shows an **Open PR** link when Launchpad is enabled (`gitLore.launchpad.enabled`). Clicking it looks up the pull request that introduced the hovered commit — preferring a merged PR when multiple match — and opens it in the PR Details panel if it is already on your Launchpad board, or in the browser otherwise. The lookup happens on click (never on hover), uses the same silent credential path as Launchpad (no prompts, no pop-ups), and the result is cached per commit so repeated hovers over the same line are instant.

### Changed

- **PR Details: AI review draft and PR explanation now cover large PRs fully** — previously, both the "Explain" and "Draft Review" AI features silently cut off at the first 8,000 characters of the diff. For PRs too large to fit in one call, GitLore now reviews each changed file individually (up to 12 files per review, with the rest listed by name for the model to acknowledge), then synthesises the per-file notes into a single explanation or review comment. You can see per-file progress ("Reviewing file 3 of 9…") while the review is being drafted. Files whose model call fails are skipped and noted in the synthesis rather than silently dropped. Per-file summaries are cached by PR head SHA, so re-drafting after resolving a thread reuses already-computed notes.
- **PR Details: AI explanation stays fresh after a new push** — the AI summary is now keyed by the PR's head commit SHA, so force-pushing a new commit correctly triggers a fresh explanation instead of serving the stale one from before the push.

### Fixed

- **Launchpad: review thread lists, file/diff lists, comment lists, and CI status lists now page on every host** — previously any of these lists that ran over the first page would be silently truncated; they now follow all pages up to the standard limit on GitHub, GitLab, Bitbucket, and Azure DevOps.

## [1.2.6] - 2026-10-16

### Fixed

- **Launchpad: a temporary network or server error no longer deletes your saved access token** — previously any failed request while loading a repo (a rate limit, a 5xx, a dropped connection) cleared the stored Personal Access Token and re-prompted you for it. Now only a genuine "unauthorized" (HTTP 401) response clears it; every other failure shows an error on that repo's row and leaves your token alone.
- **Launchpad: repos with more than ~100 open PRs no longer silently drop the rest** — GitHub, GitLab, Bitbucket, and Azure DevOps all used to stop at the first page of open PRs with no warning. The open-PR list now pages through everything the host returns, up to about 1,000 per repo, and GitHub's per-PR review and check-run lookups page too (so a PR with more than 100 reviews no longer loses the newest ones).
- **Launchpad: a slow, hung, or rate-limited host now fails visibly instead of hanging or looking empty** — requests time out after 30 seconds, and read-only requests retry briefly on a rate limit or a temporary server error (honoring the host's own wait time). A rate-limited GitHub check-run or review lookup used to be swallowed into "no checks, no reviews" — it now shows as an error on that repo. Merge, approve, comment, and other writes are never retried automatically, so they can't be duplicated.
- **GitHub: a reviewer's later plain comment no longer hides their earlier "Changes requested" or approval** — only an actual approve, request-changes, or dismissal changes a reviewer's standing. An approval also now counts when other reviewers are merely still requested, instead of leaving the PR stuck on "review required".
- **GitLab: unresolved discussion threads no longer show a PR as "Changes requested"** — that overrode a real approval. GitLab has no such state, so the board now reflects approvals only.
- **GitHub: Merge & Delete Branch no longer risks deleting the wrong branch on a fork PR** — the branch is now deleted only when it lives in the same repo as the PR's target. For a PR from a fork, the branch is left for the host's own cleanup setting.
- **PR matching ignores letter case** — GitHub treats logins case-insensitively, so a PR you authored or were asked to review could be missed when the case differed between the API and your signed-in name.

### Changed

- **Launchpad loads all your repos at once** — the board used to fetch one repo at a time, so a workspace with several repos waited on the sum of every host's response time instead of the slowest one. A repo that fails no longer holds up or blanks the rest. Sign-in prompts still appear one at a time.
- **Launchpad: snoozing a card is instant** — it re-sorts the board from what's already loaded instead of re-fetching every repo over the network. Snoozed entries for PRs that no longer exist are now cleaned up automatically.
- **Launchpad: GitHub board refresh makes 3× fewer API requests for PRs you're not involved in** — previously every open PR fetched reviews, check-run status, and mergeable state (3 calls each). PRs where you're neither the author nor a requested reviewer now fetch only reviews (1 call); if you've never reviewed the PR it's omitted from the board entirely, since it can't appear in any category. PRs you authored or were asked to review still get the full 3-call enrichment.

## [1.2.5] - 2026-09-16

### Fixed

- **Multi-root workspaces: opening a terminal in another repo now switches GitLore's context to it** — previously, with no editor open, every GitLore feature (Sidebar Explorer, Commit Graph, status bar init, AI commands, etc.) fell straight through to the workspace's first folder regardless of which repo you were actually working in. GitLore now checks the active terminal's working directory before falling back to the first folder.
- **AI features on Cursor, Antigravity, and other VS Code forks now explain why, instead of telling you to install GitHub Copilot Chat** — that advice never worked there: `vscode.lm` is core API present in every fork, but forks have no way to register a provider under it (Copilot Chat won't activate outside real VS Code, and a fork's own AI isn't exposed through this API either). GitLore now detects the host editor and, on anything other than an official Microsoft VS Code build, shows a message naming the actual limitation instead of a dead-end suggestion. On real VS Code the message is unchanged.

## [1.2.4] - 2026-08-20

### Added

- **Commit Graph: newly-loaded rows fade/slide in** — "Load More" now animates only the newly-revealed rows (reusing the same entrance animation Launchpad and PR Details already use), instead of the whole list snapping in unchanged.
- **Visual File History: points fade/slide in** — each commit bubble now uses the same entrance animation already used elsewhere, instead of appearing instantly.
- **Visual File History follows the active editor** — once opened, the panel now reloads automatically as you switch files, instead of only updating when you re-run **GitLore: Show Visual File History**.
- **Interactive Rebase Editor: rows slide into place on reorder** — dragging a commit to a new position now animates the rows it displaced, instead of them snapping instantly. Respects `prefers-reduced-motion` (rows still reorder correctly, just without the animated slide).
- **Launchpad: per-bucket column accent** — Needs Review, Ready to Merge, Blocked, and Waiting each get a small colored left edge (VS Code's own semantic theme colors, so it's correct in light/dark/high-contrast), so the board scans faster at a glance. Purely supplementary to the existing column title — never the only signal.
- **Commit Graph and Launchpad now use GitLore's own design system** — dark-mode-first (with a designed light counterpart), IBM Plex Sans + JetBrains Mono, a teal-to-cyan signature accent, instead of deriving every color from your VS Code theme. Editor decorations, hover cards, tree views, and the status bar are unaffected — they still adapt to your theme exactly as before. The other five docked panels (Branch Comparison, Commit/PR Details, Rebase Editor, Visual File History, Chat) haven't been migrated yet — that's a separate follow-up.
- **Sidebar Explorer: rename and delete a local branch** — right-click a branch for **Rename Branch** (also available on the current branch) and **Delete Branch** (confirms first; git itself blocks deleting the branch you have checked out).
- **Sidebar Explorer: delete a tag** — right-click any tag for **Delete Tag** (confirms first).
- **Sidebar Explorer: create and remove worktrees** — an inline **+** on the Worktrees section header prompts for a path and branch; right-click any linked worktree (not the main checkout) for **Remove Worktree** (confirms first).
- **Sidebar Explorer: create a stash** — an inline **+** on the Stashes section header prompts for an optional message and stashes the working tree.
- **Recover Lost Commit or Branch** — a new command (`GitLore: Recover Lost Commit or Branch`) lists recent reflog entries and creates a branch at whichever one you pick, for recovering from a hard reset, force push, or accidental branch delete before git garbage-collects it.
- **Inline blame respects `.git-blame-ignore-revs`** — if your repo has one (git's own standard convention for mass-reformat/lint commits you don't want blame attributing to), GitLore's blame now skips those commits automatically. No setting — same as plain `git blame`, GitLore just detects the file.
- **Fetch button** — Commit Graph's toolbar and Launchpad's per-repo row now have a Fetch button next to Pull/Push, same shared Git Sync terminal.
- **Pull Request Details: status badges** — Draft, Merged/Closed, check status, review decision, merge conflicts, and age now show at the top of the panel, the same PR state Launchpad's board already tracks but that used to disappear once you opened a PR's own details. The author line also gets the same author icon Launchpad's cards already use.
- **Pull Request Details: act without leaving the panel** — Approve, Request Changes, Merge, Close, and Reopen are now buttons in the PR Details panel itself, the same actions Launchpad's board already offered per card. Merge only appears once a PR is actually ready (approved, checks not pending, no conflicts) — the same rule the board's own "Ready to Merge" column already uses, so it never bounces off a host-side rejection. The panel's status badges refresh immediately after a successful action instead of waiting for a manual Refresh.
- **Consistent hover tooltips on every icon-only button** — Launchpad already had its own reliable, JS-driven tooltip (native browser tooltips had proven unreliable on some icon-only buttons); every other panel now uses the same one, including Interactive Rebase Editor's row move-up/move-down buttons, which previously had no visible tooltip at all.

### Fixed

- **Pull Request Details: Azure DevOps PRs now show a real file diff** — previously every file showed "No textual diff for this file" with `0`/`0` stats, since Azure DevOps has no diff-text endpoint of its own. GitLore now fetches each changed file's content at the PR's merge-base and head commits and diffs them itself, matching the diff you already see for GitHub and GitLab PRs. A binary file, a file over an internal size cap, or a pure rename with no content change still falls back to the file list alone.

## [1.2.3] - 2026-08-18

### Fixed

- **Launchpad: sign out of a host** — each repo row now has a Sign Out action, so authenticating as the wrong account (or wanting to switch) no longer requires editing VS Code's secret storage by hand. For a Personal Access Token host this clears the stored token so the next refresh re-prompts for one; for a built-in session host (github.com, Azure DevOps Services) it clears GitLore's remembered account preference so the next sign-in offers an account picker instead of silently reusing the same session.
- **Pull Request Details: Explain and Draft Review no longer hang** — if fetching the PR's diff failed partway through (an expired credential, a rate limit, a network blip), the button stayed disabled and the loading skeleton spun forever with no error shown. Both actions now surface the failure the same way every other error in this panel already does.

## [1.2.2] - 2026-08-17

### Added

- **GitLore Chat** — a docked chat panel (**GitLore: Open Chat**) for asking free-form questions about a repo's history ("who touched this file last", "why did this get rewritten", "what changed between these two tags"). The model answers by calling git-backed tools GitLore runs locally against your own repo — no retrieval index, no guessed context — and every tool call is shown in the panel as it happens. Also reachable pre-seeded with a subject via **Ask GitLore About This File/Commit/Pull Request** from Commit Graph, Commit Details, and Pull Request Details. Same privacy contract as every other AI feature: nothing runs unless `gitLore.ai.enabled` is on, and every tool call is a local `git` read, never a network call.
- **Explain this PR** — an Explain button in Pull Request Details summarizes what a PR changes and calls out its riskiest area, the same way Commit Details' AI summary already does.
- **Branch Compare AI summary** — a Summarize button in Branch Comparison explains what the compare branch changes relative to the base, in plain English.
- **Generate Changelog with AI** — a new command picks two refs and streams a Markdown changelog (grouped into Added/Changed/Fixed) into a fresh editor tab.
- **AI PR review draft** — a Draft Review button in Pull Request Details drafts one review comment into the existing comment box, for you to edit and post yourself — the model never posts on its own.
- New setting: `gitLore.ai.maxToolIterations` (default `6`) caps how many tool-call round trips GitLore Chat makes per question before showing whatever answer the model has produced so far.
- **Commit graph: right-click actions** — Checkout, Reset Branch to Here (soft/mixed/hard, via QuickPick), Revert This Commit, Cherry-pick onto Current Branch, Create Branch from Commit, Tag This Commit, and Copy SHA, all from a right-click on any commit. Revert and cherry-pick run in the same shared **GitLore: Git Sync** terminal as Pull/Push, since either can hit a conflict you need to resolve yourself; Reset and Checkout confirm first and can't be undone once accepted.
- **Commit graph: scoped to your current branch by default** — the graph now opens showing just the branch you're on, instead of every branch at once, and keeps following you across any checkout (from GitLore, a terminal, or another tool) until you pick a specific branch or "All branches" from the ref picker yourself.
- **Commit graph: stash chip** — any stash shows as a small chip on the row of the commit it was made from; click it to Apply or Delete.
- **Sidebar Explorer: Merge and Rebase from a branch's right-click menu** — "Merge into Current Branch" and "Rebase Current Branch onto This" on any branch or remote-tracking branch row, so a merge or rebase no longer requires dropping into a terminal to type the command yourself. Runs in the shared **GitLore: Git Sync** terminal, since either can conflict.
- **Co-change detector** — a new CodeLens above the file naming other files that frequently change alongside it, computed from `git log` (no AI, no separate analysis service). Click for a QuickPick with the exact co-occurrence ratio; pick one to open it. New setting `gitLore.coChange.enabled` (default `true`).

## [1.2.0-1.2.1] - 2026-08-15

### Added

- **Launchpad: Merge PR** — a Merge action on every "Ready to Merge" card, across all four supported hosts. Prompts for a merge strategy (Merge / Squash and merge / Rebase and merge, filtered to what the PR's host actually supports) and lets you also delete the source branch, then confirms before merging. GitLab and Bitbucket have no true "rebase and merge" of their own, so that option simply doesn't appear for them.
- **Launchpad: a "Reviewed" column** — fixes a real gap: once you approved or requested changes on a PR you don't own, it used to vanish from the board entirely the moment the host stopped counting you as an owed reviewer, instead of showing up anywhere. It now lands in a new **Reviewed** column (right after Needs Review) and stays there — regardless of what happens to the PR afterward (CI turns red, a conflict appears, another reviewer requests changes) — unless the host puts you back in the requested-reviewers list, which still takes you back to Needs Review.
- **Branch Comparison: Create PR now actually creates the pull request** — the button used to just open your host's compare page in a browser for you to finish there; it now prompts for a title (and, on hosts that support it, whether to create it as a draft) and creates the PR directly via the host's API, across all four supported hosts — including Azure DevOps, which the old browser-only version couldn't recognize at all. Requires `gitLore.launchpad.enabled`, the same toggle every other remote-host call in GitLore shares — the button still shows either way, but explains that if clicked while it's off.

### Changed

- Commit Details now shows the repo's most recent commit as soon as the tab is revealed, instead of an empty "select a commit" placeholder, matching Commit Graph's existing behavior.
- Branch Comparison no longer guesses a default comparison to show as soon as its tab is revealed — it now stays on its placeholder until you run "Compare Branches" yourself. Pull Request Details and Visual File History already worked this way.

### Fixed

- Every panel's loading and error states (Commit Graph, Commit Details, Branch Comparison, Visual File History, Launchpad, Pull Request Details) now render themed to match VS Code's colors instead of a brief flash of unstyled, unthemed text on every panel open and refresh. Loading now shows a shimmering skeleton instead of "Loading X…" text (still announced to screen readers via `aria-label`), and load failures are announced as an alert. The same shimmer replaces Commit Details' "Generating…" text while an AI commit summary is in flight, and Pull Request Details' "Posting…" text while a comment is being posted.
- The Commit Details and Pull Request Details loading skeletons could get stuck visible even after the real content (an AI summary, a posted comment) had already loaded, since the skeleton's own CSS never actually hid when toggled off.

## [1.1.0] - 2026-08-14

### Changed

- **Visual polish across every panel** — hover states on rows, cards, and buttons now ease in instead of snapping; PR cards, review threads, and hover tooltips gently fade/slide in on load; and border-radius is now consistent everywhere instead of drifting between 2px and 4px per view. All motion respects your OS's reduced-motion setting.

## [1.0.0] - 2026-08-14

First stable release — closing out Phase 7 (Launchpad) of the roadmap.

### Added

- A one-time warning when GitLore can't find `git` on your `PATH`, with a button to open the git install page. Previously this failed silently everywhere instead of telling you why nothing was working.
- **Load more commits** — File History and the Commit Graph now offer a "Load more" row/button once a load hits `maxHistoryItems`/`maxGraphItems`, instead of silently hiding anything past the cap with no way to reach it.
- **AI commit message generation** — a sparkle button in the Source Control panel's title bar (**GitLore: Generate Commit Message with AI**) writes a message straight into the commit box, generated from your staged diff. Same opt-in gate and infrastructure as the existing AI commit summaries: off by default via `gitLore.ai.enabled`, degrades to an inline hint with no model registered, and nothing is sent anywhere unless you've turned AI on.
- **Launchpad: Merged and Closed columns** — two new columns show your own most-recently-completed PRs (merged separately from closed-without-merging), so the board also reflects what you've shipped, not just what's still open.
- **Launchpad: Close PR** — a close action on every open-PR card (with a confirmation dialog first) closes it on its host without merging, across all four supported hosts, without leaving GitLore.
- **Launchpad: sign in to Azure DevOps Services with your Microsoft account** — `dev.azure.com` now uses the same built-in VS Code authentication session as GitHub, instead of requiring a Personal Access Token. This also fixes organizations whose Conditional Access policy blocks PAT/Basic auth outright, where no PAT — regardless of scope — could ever work. Self-hosted Azure DevOps Server still uses a PAT.
- **Launchpad: per-repo Push/Pull** — a row per workspace repo Launchpad recognizes, with Pull/Push buttons, so you don't have to switch to Source Control per repo while triaging. Works even for a repo whose forge sign-in failed or was skipped, since push/pull is a local git operation with no host credential involved.
- **Pull Request Details** — a **View diff** button on every Launchpad card opens a docked panel (next to Commit Details) showing that PR's changed files and diff, without leaving the editor. Azure DevOps doesn't expose diff text through its API, so its panel shows the changed file list without inline diffs rather than a fabricated one.
- **Launchpad: Approve / Request changes** — two new actions on every open PR card (with a confirmation dialog first), across all four supported hosts. GitLab has no "Request Changes" review state of its own, so that action tells you so instead of silently doing nothing.
- **Pull Request Details: add a comment** — a comment box in the panel posts a top-level comment on the PR without leaving GitLore, across all four supported hosts.
- **Pull Request Details: resolve conversation threads** — the panel now lists review conversations with a Resolve button per unresolved one, across all four supported hosts.
- **Pull Request Details: a Refresh button** — picks up state that changed elsewhere (e.g. approving the same PR from a Launchpad card while its Details panel is open), across all four supported hosts.
- **Pull Request Details: conversations show which file/line they're on** — a review comment attached to a specific diff line now shows a `path:line` label above it, so you can tell which part of the diff a reviewer was actually commenting on instead of only seeing the comment text.
- **Launchpad: Reopen PR** — a Closed card (closed without merging) now offers a Reopen action, across GitHub, GitLab, and Azure DevOps. Bitbucket Cloud has no way to reopen a declined PR at all — not through its API, not even its own web UI — so that action tells you so instead of silently doing nothing.

### Fixed

- Removed `gitLore.dateFormat`, a setting that was documented but never actually wired into any date display and had no effect.
- Commit Graph, Branch Comparison, and File History could show stale data if a second load started (a fast ref-picker change, a quick tab switch, an auto-refresh) before an earlier one finished — whichever request happened to resolve last won, not whichever was requested last. Each now tracks its own request generation and discards results from a superseded load.
- The blame hover now honors VS Code's cancellation token instead of ignoring it, so a hover that's no longer needed (the mouse already moved on) stops doing further git lookups instead of finishing work nobody will see.
- Azure DevOps' identity check was routed through a legacy global endpoint that 401s for an organization-scoped PAT even though the same token works everywhere else — now routed through the org, the way Azure DevOps actually expects.
- Launchpad's Merged/Closed columns could render empty despite you having older merged PRs: the closed-PR search fetched the repo's most-recently-closed PRs project/repo-wide, so a busy shared repo could push your own older ones out of the window before the "authored by you" filter ever saw them. GitLab and Bitbucket now filter server-side to your own PRs from the start (Azure DevOps already did); GitHub's closed-PR page size was raised to its maximum, since its REST API has no author filter and its Search API's much tighter rate limit isn't worth the trade for a multi-repo board.
- A failed PR-list request on any host (bad credential, insufficient scope, etc.) was silently rendered as an empty board, indistinguishable from a repo with genuinely no PRs. Now surfaces as a visible error, and clears the bad credential so the next refresh re-prompts instead of repeating the same failure forever.
- Merged and Closed cards' **View diff** button silently did nothing — Launchpad only kept open PRs resolvable by their card key, so a click on a terminal card's button had no PR to look up. Merged/closed PRs are now resolvable too.
- Launchpad card buttons (view diff, snooze, approve, request changes, close) relied on the browser's native hover tooltip, which several of them weren't reliably showing. Every icon button in Launchpad now uses a tooltip GitLore renders and positions itself, so hovering any of them — including the snooze/unsnooze clock icon — reliably tells you what it does.
- Azure DevOps' **View diff** panel could crash with "Cannot read properties of null" instead of loading, because some real change entries (folder-level entries, property-only changes) have no file path at all. Those entries are now skipped instead of assumed to always have one.
- Approving or requesting changes on your own PR failed with a bare "422 Unprocessable Entity" and no explanation — every host rejects a self-review, so Launchpad now catches this before ever calling the API and tells you plainly instead. Any other review/close/comment failure now also surfaces the host's actual rejection reason (e.g. GitHub's real validation message), not just the HTTP status code.
- Approving, requesting changes on, closing, or snoozing a Launchpad card made the whole board flash back to a "Loading Launchpad…" screen before repainting. These actions now refresh in place instead of blanking the board first.

## [0.4.0] - 2026-08-14

### Added

**Visual File History** — a bubble timeline for the current file

- **GitLore: Show Visual File History** opens an author-swimlane view of the current file's commits: each commit is a bubble sized by how much it changed, positioned by author lane and by age, with additions/deletions bars beneath. Click a bubble to open that commit's details.
- Docked alongside Commit Graph, Commit Details, and Branch Comparison; also reachable from the Commit Graph panel's toolbar.
- Respects `gitLore.maxHistoryItems`, same as the tree-based File History view.

**Interactive Rebase Editor** — a GUI for `git rebase -i`

- **GitLore: Rebase Branch Interactively...** picks a target ref and starts an interactive rebase in an integrated terminal. Whenever git opens the rebase todo file, GitLore's own editor takes over automatically: reorder commits (drag or the move up/down buttons), change each one's action (pick/reword/edit/squash/fixup/drop), then Start Rebase or Abort.
- Works the same way even without the command above, for anyone who already has `code --wait` configured as their own git `sequence.editor`.
- GitLore never calls `git rebase`, `--abort`, `--continue`, or any reset/checkout command itself — it only ever reads, writes, and closes the one file git already opens for this. If a rebase pauses on a conflict, GitLore points at Source Control rather than building its own conflict-resolution UI.
- Turn it off with `gitLore.rebaseEditor.enabled: false` to use the plain text editor instead.

**Sidebar Explorer** — one tree for the whole repo, in its own activity bar container

- Branches, Remotes, Tags, Stashes, Worktrees, and Contributors, each as a collapsible section — always visible, no command needed to open it.
- Branches show ahead/behind counts and mark the checked-out one; right-click a branch to **Checkout** or **Compare with Current Branch** (opens in the existing Branch Comparison view).
- Right-click a remote to **Open Remote in Browser**; right-click a stash to **Apply** or **Drop** (drop asks for confirmation first — it can't be undone).
- Contributors are counted across every branch, not just the checked-out one, so the roster doesn't quietly drop anyone.

**Hover quick-actions and revision nav** — act on a blamed line without leaving the hover

- The blame hover card now has a **Compare** / **File History** / **Copy SHA** row, so acting on a line's commit no longer means opening a different panel first.
- An **Older** link starts stepping backward through that exact line's own history (via git's real per-line tracking, not just "commits that touched this file") — ◀ prev / next ▶ walk through every revision that changed the line, with a "N of M" position, all rendered in the same hover.
- The line-history cards skip the AI-explain section (it's tied to the *current* line content, which doesn't correspond to an older revision) but keep the same quick actions, scoped to that revision's own commit.

**Branch Compare: Create PR, and Open all changes with the common base**

- A **Create PR** button appears in the ref bar when the repo's remote is on a host GitLore recognizes (GitHub, GitLab, Bitbucket) — it opens that host's compare/create-PR page pre-filled with the two branches. Hidden on unrecognized hosts rather than guessing a URL shape that might 404.
- **Open all changes** opens every changed file's diff at once, each against the same common base the inline diff already uses — instead of clicking "Open changes" file by file. Asks for confirmation first when there are more than 20 files.

**Full-file blame heatmap** — a hot-to-cold recency gradient across the whole file

- **GitLore: Toggle Full-File Blame Heatmap** (`gitLore.fullFileBlame.enabled`, off by default) marks every line with a colored left edge, gradiented from hot (recently changed) to cold (long untouched) — relative to the file's own age range, so even an entirely old file still shows which of its lines are relatively newer.
- Distinct from the current-line inline blame decoration and the author-ownership ruler: this is a third, independent visual, not a mode of either.

**Commit Graph: pull/push buttons with ahead/behind counts**

- The toolbar now shows a pull and a push button for the checked-out branch, each badged with how many commits it's behind/ahead of its upstream — hidden entirely when the branch has no upstream to compare against. Both run in a real terminal (not silently in the background), since a pull or push can need interactive auth or land a merge conflict.
- The graph now also auto-refreshes whenever `.git/HEAD` or `refs/**` change on disk — a pull, a push, a checkout, from GitLore's own buttons, a terminal, or any other tool — instead of only updating on an explicit refresh click or a ref-picker change.

**Launchpad** — a cross-repo PR triage board (off by default)

- **GitLore: Open Launchpad** (`gitLore.launchpad.enabled`, off by default) opens a 6-column board — Needs Review, Ready to Merge, Waiting, Blocked, Drafts, Snoozed — pooling open PRs from every recognized git remote across your workspace's repos into one place. Off by default: it's the only GitLore feature that calls out to a remote host at all, unlike everything else, which works entirely from your local `.git`.
- Not GitHub-only: GitHub, GitLab, Bitbucket, and Azure DevOps are all supported out of the box, plus self-hosted/custom instances (GitHub Enterprise Server, Gitea, Forgejo, self-hosted GitLab) via `gitLore.launchpad.customHosts`.
- Scans every remote you've added per repo, not just `origin` — a fork's `upstream`, a second remote, anything — deduped when two remotes point at the same actual repo. Also reachable from the Commit Graph panel's toolbar, not just the Command Palette.
- GitHub uses VS Code's own built-in sign-in — no GitLore backend, no key GitLore ever handles. Every other host needs a Personal Access Token, entered once and stored in VS Code's encrypted secret storage.
- Snoozing a PR is a local-only override (there's no such concept on any of these hosts' APIs) — it hides a PR from its normal column until you unsnooze it.

### Changed

- **Diffstat bars** — Commit Details and Branch Comparison now show a proportional green/red bar next to each changed file, scaled to the largest file in the list, alongside the existing `+N -M` counts.
- **Commit Graph columns** are noticeably tighter, so more layouts (e.g. Commit Graph, Commit Details, and Branch Comparison open side by side) show Author/Changes/Date/SHA without needing to scroll the row grid horizontally.
- **A consistent accent** now marks every panel — the checked-out-branch pill, the "Summarize" action, each panel's header underline, file-section headers, and every hover card share one signature gradient (purple → blue) instead of the default button-blue every other extension uses. Both gradient stops are theme tokens (`--vscode-charts-purple`/`-blue`), so it stays correct across light, dark, and high-contrast themes — never a hardcoded color.
- **Summarize** (formerly "Summarize with AI") now sits in Commit Details' main action bar next to Copy SHA / Copy message / Open on remote, instead of its own separate section — the icon and accent color already say it's the AI action, so the button no longer needs its own heading to explain itself.
- **A visible edge between docked panels** — Commit Graph, Commit Details, Branch Comparison, and Visual File History each now draw their own left border, so opening several side by side no longer reads as one undifferentiated block.
- **Consistent secondary-text color** — dates, SHAs, author names, empty-state messages, and hint text across every panel now use the theme's own secondary-text color (`descriptionForeground`) instead of a dozen slightly different opacity values accumulated file-by-file. More consistent, and more reliably legible across themes than faking it with opacity.
- Unified the hover-card corner radius (Commit Graph and Visual File History previously used two different values for the same kind of element).
- **Denser inline diff view** — Commit Details and Branch Comparison's code diff now renders one notch below the editor's own font size with tighter line spacing, so a narrow docked panel shows more lines of actual code instead of a few oversized ones.
- **Sidebar Explorer** — each section now has its own icon (Branches, Remotes, Tags, Stashes, Worktrees, Contributors) so the tree scans at a glance instead of reading every label; a section with nothing in it starts collapsed instead of expanded-but-empty; a worktree row shows its folder name instead of the full absolute path (the full path is still there as a tooltip), and a remote-tracking branch gets the same cloud icon as the Remotes section so a long, mixed branch list separates into local vs. remote at a glance.

### Fixed

- **Visual File History**: a large bubble pushed to the far edge of its collision jitter could visually cross into the neighboring author's lane. The safety check only accounted for the jitter distance, not the bubble's own radius; fixed by accounting for both and giving lanes more vertical room.
- **Visual File History**: bubbles from commits made close together in time could still overlap each other after separation, especially for large, similarly-sized changes. Replaced the vertical-only jitter with genuine 2D circle-packing (an outward search plus a relaxation pass), so a dense burst of commits now renders as fully separate, individually legible bubbles instead of a partially-merged cluster.
- **Commit Details**: Copy SHA / Copy message / Open on remote had `border: none` and relied entirely on `--vscode-button-secondaryBackground` for contrast — in themes where that color is close to the panel background, they rendered with no visible button shape at all. Added a guaranteed-visible border so they read as buttons regardless of theme.
- **Branch Comparison**: the base/compare ref pickers had the same underlying bug — `border: 1px solid transparent` by default, only gaining a visible border on hover. In a low-contrast theme they read as plain colored text with no dropdown affordance until the mouse found them. Now visible by default.
- **Blame hover**: clicking the **Older** link appeared to do nothing when there was no earlier revision to step to, or when the mouse was hovering a line the text cursor wasn't actually on (the normal way to peek at blame without moving your cursor) — both cases silently updated internal state with no visible reaction. Both now show a message explaining what happened instead of looking broken.
- **Branch Comparison**: opening the panel for the first time in a session could show the wrong ref pair — focusing it for the first time triggers its own default-ref guess as an independent background step, which could finish *after* (and silently overwrite) an explicitly requested comparison, depending on timing. The explicit request now always wins.
- A repo's remote URL was cached forever after the first lookup, with nothing to invalidate it — adding or changing a remote while VS Code was running (e.g. via a terminal) was never picked up without a full reload. Removed the cache; a plain `git remote get-url` is cheap enough not to need one.
- **Launchpad**: an Azure DevOps repo cloned over SSH (`git@ssh.dev.azure.com:v3/{org}/{project}/{repo}`) was never recognized — GitLore only knew `dev.azure.com` and `<org>.visualstudio.com` as Azure DevOps hosts, not the distinct `ssh.dev.azure.com` hostname the SSH remote form actually uses, so it silently fell through to "no recognized git-forge remotes". Now recognized, and normalized to the same credential as the HTTPS form so it doesn't prompt for a token twice.
- **Launchpad**: a repo that failed to authenticate always showed the same generic "Couldn't authenticate with `<host>`" with no way to tell why — a bad/expired token, an out-of-scope one, and the host being unreachable all looked identical. Now shows the real reason (e.g. `401 Unauthorized from app.vssps.visualstudio.com`), so it's actually possible to tell whether to re-check the token or the network.

## [0.3.1] - 2026-08-13

### Changed

- Removed named comparisons to other extensions from the README, code comments, and docs. No functional change — GitLore's behavior, settings, and commands are unaffected.

## [0.3.0] - 2026-08-13

AI features, the stale-code detector, and the author ownership heatmap — closing out Phase 2 of the roadmap. All opt-in features stay off until you turn them on; nothing here changes what data leaves your machine.

### Added

**AI commit summaries** — opt-in, using your own model

- A **Summarize with AI** button in Commit Details streams a plain-English summary of the open commit.
- Off by default. Turn it on with `gitLore.ai.enabled` — nothing is sent anywhere until you do.
- Uses whatever language model you've already registered with VS Code (e.g. GitHub Copilot Chat) via the built-in Language Model API. No GitLore backend, no API key, no account.
- Needs a language model registered to produce anything — without one, the panel shows an inline hint instead of erroring.

**AI line explanations** — "why does this line exist?", from the blame hover

- The blame hover's **Explain this line with AI** link generates the explanation in the background — a small status-bar spinner shows while it runs, no panel opens. Re-hover the same line once it's done and the hover card shows the finished explanation directly.
- Reuses the exact same `gitLore.ai.enabled` gate and AI infrastructure as commit summaries: off by default, no model registered shows the same inline hint, and nothing is sent anywhere unless you've opted in.

**Stale-code detector**

- Functions and methods untouched for longer than `gitLore.staleThresholdDays` (default 180) get a subtle CodeLens — click it to open Commit Details for the commit that last changed them.
- On by default. Turn it off with `gitLore.staleCode.enabled`.
- Works for any language with a symbol provider installed (uses VS Code's built-in `executeDocumentSymbolProvider` — no new parser).
- Known limitation: an arrow function assigned to a top-level `const` (e.g. `export const foo = () => {}`) isn't flagged in v1 — TypeScript's language server reports these as `SymbolKind.Variable`, not `Function`, and flagging every Variable would also catch plain data constants as "stale." Named `function` declarations and class methods are unaffected.

**Commit Graph: row tooltip and icon headers**

- Hovering or keyboard-focusing a commit row shows a tooltip with the author, full commit message, age/date/SHA, and diffstat — no more waiting on native browser tooltips split across separate cells.
- The Author, Changes, Commit Date, and SHA column headers are now compact icons (each still announces its real name to screen readers via `title`/`aria-label`).

**Author ownership heatmap** — closes out Phase 2 of the roadmap

- Turn on `gitLore.ownership.enabled` for a colored mark in the overview ruler for every line, colored by that line's author (from a 7-color palette shared with the commit graph — with more than 7 authors, colors repeat), so you can see at a glance who owns which regions of a file.
- **GitLore: Show File Ownership** lists every author on the current file, weighted by recency (a line touched last week counts for more than one untouched for years) rather than raw line count, most-recently-active author first — with their share, line count, and last-active age.
- Off by default (the ruler marks); the command works regardless. Respects `gitLore.maxBlameFileSize` and `gitLore.blame.ignoreWhitespace` like the rest of blame.

### Changed

- Commit Details and Branch Comparison now start collapsed beside the commit graph instead of sitting open and empty. Clicking a commit row expands Commit Details; the compare-branches button expands Branch Comparison. (Only affects workspaces opening the GitLore panel for the first time — VS Code remembers your own manual layout choices after that.)

## [0.2.0] - 2026-08-11

First stable release — installs by default, with no need to opt into pre-releases. Same code as the `0.1.0` pre-release, promoted after verification.

Blame, history, the commit graph, commit details and branch comparison are all here and covered by tests. It is still `0.x`: expect breaking changes before `1.0`. AI features are not in this release — see Known limitations.

### Added

**Inline blame**

- The current line's author and age, shown as a muted, right-aligned editor decoration. Updates when you move to a different line, not on every keystroke. Toggle with **GitLore: Toggle Inline Blame**.
- Hover any line for a card with the author's avatar, the full commit message, relative and absolute dates, that commit's diff stat for the file, and the short SHA.
- The same author and age in the status bar. Click it to open the commit.
- Blame is skipped on files larger than `gitLore.maxBlameFileSize`, and stays silent on untracked files, unsaved files, and folders that aren't git repos.

**File history**

- **GitLore: Show File History** lists every commit that touched the current file, newest first, in the Explorer — following the active editor as you switch files. Click an entry to open its details; right-click to copy its SHA. Renames are followed.

**Commit graph** — in a "GitLore" tab in the bottom panel

- A repo-wide, branch-and-merge-aware graph of every commit, with curved merge lines, per-lane colors that follow your theme, and each author's avatar at their commit.
- Seven columns: Branch/Tag, Graph, Commit Message, Author, Changes, Commit Date, SHA. The header stays put while you scroll, and narrow panels scroll sideways instead of clipping.
- Local branches, the checked-out branch, remote-tracking branches and tags each get their own label style and icon.
- A toolbar to scope the graph to one branch, filter commits by message/author/SHA as you type, see a live commit count, and refresh.
- Uncommitted work is pinned above the newest commit as a **Working Changes** row with `+added ~modified −deleted` file counts. Click it to jump to Source Control.
- Arrow keys move the selection, Enter opens the commit, and your place survives a refresh.

**Commit details** — same panel

- The commit's subject, author, date and SHA in a compact header, plus **Copy SHA**, **Copy message**, and **Open on GitHub/GitLab/Bitbucket** when your remote is one of those.
- Every changed file as a collapsible section holding only that file's hunks, with a filter box, per-file counts and whole-commit totals. A single-file commit opens expanded.
- Diffs show old and new line numbers in a gutter, tint changed lines, and offer a **Wrap long lines** toggle. Line numbers stay out of your selection, so copying a diff gives you just the code.
- **Open changes** on any file row opens it in a real diff editor, with syntax highlighting and folding.

**Branch comparison** — same panel

- Two ref pickers with a swap button, colored by diff polarity: the base in the removed hue, the compare ref in the added hue, matching the `-`/`+` lines below.
- **Ahead**, **Behind** and **All Files** tabs with counts, opening on whichever has something to show. Diffs are taken against the merge-base, like a GitHub or GitLab pull-request diff.
- Click any commit to open its details.

**Issue and PR linking**

- References like `#123` in commit messages become links, in both the blame hover and commit details. Auto-detected from your GitHub or GitLab remote, or point it at any tracker with `gitLore.issueLinking.pattern` and `.urlTemplate`.

**Throughout**

- Every command is a button in a GitLore panel view's title bar, so nothing requires the command palette.
- All four views are keyboard-navigable, take their colors from your theme in both light and dark, and honour `prefers-reduced-motion`.
- Fully local and free. No account, no telemetry, no paid tier. The only network request is fetching author avatars from Gravatar; see the README's Privacy section.

### Known limitations

- No AI features yet. Commit summaries and line explanations are planned, using your own model via VS Code's Language Model API — no GitLore account or API key.
- No staging, stashing or committing. That's VS Code's Source Control view — the Working Changes row links you there.
- The graph doesn't refresh itself when the repo changes; use the toolbar's refresh button.
- The changed-file list is flat, with no tree view of paths.
- Commit details loads a whole commit's diff up front, so a very large commit takes a moment to open.
- Toggling inline blame from the panel button gives no on/off indicator; the editor shows the result immediately.
- File History appears in the Explorer, not in the GitLore panel.

## [0.1.0] - 2026-08-11

Pre-release alpha, published to the Marketplace's pre-release channel. Identical feature set to `0.2.0`; superseded by it. `0.1.x` remains the pre-release line.
