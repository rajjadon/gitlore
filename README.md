<div align="center">

<img src="media/icon.png" width="112" alt="" />

# GitLore

**The story behind every line.**

Free, local-first git insight inside VS Code — blame, history, an interactive commit graph,
branch comparison, a rebase editor, and a cross-repo PR triage board. No account, no paywall,
no telemetry, no backend.

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://buymeacoffee.com/rajpratapsinghjadon)

</div>

---

## What is this?

Open any file in any git repo and GitLore answers the question you actually have: **who wrote this line, when, why, and what else changed with it.**

It does that without leaving your editor, without signing in, and without sending your code anywhere. Everything runs against the `git` binary already on your machine.

If you've used similar VS Code git extensions, GitLore covers the same core ground — inline blame, a commit graph, commit details, branch comparison — with every feature free and a deliberately smaller surface area. See [How it compares](#how-it-compares).

> **Status: 1.2, stable.** Everything below works and is covered by tests — 743 unit tests and 164 integration tests against a real VS Code instance. Bug reports are very welcome.

## Install

**From the Marketplace** — search *GitLore* in the Extensions view (`⇧⌘X` / `Ctrl+Shift+X`) and click Install. Or from the command line:

```bash
code --install-extension RajpratapsinghJadon.gitlore
```

**From a `.vsix`** — grab one from [Releases](https://github.com/rajjadon/gitlore/releases), then:

```bash
code --install-extension gitlore-1.2.5.vsix
```

Requires **VS Code 1.85+** and `git` on your `PATH`. Works in Cursor and other VS Code-based editors.

## Getting started in 60 seconds

1. **Open a file in a git repo.** The current line's author and age appear at the end of the line, and in the status bar.
2. **Hover that line** for the full commit message, dates, and the diff stat.
3. **Open the panel** — `⌘J` / `Ctrl+J`, then pick the **GitLore** tab (next to Terminal and Output). The commit graph loads itself.
4. **Click any commit row.** Its details load in the pane beside the graph — every changed file, collapsible, with a real diff gutter.
5. **Everything else is a button** in each view's title bar. You never need the command palette.

## Features

### Inline blame, where you're already looking

<img src="media/screenshots/inline-blame.png" width="470" alt="Inline blame decoration at the end of the current line, with the hover card open showing author, message and dates" />

The current line's author and age, as a muted end-of-line decoration. It updates when you change lines — not on every cursor move — and the hover card adds the full message, relative *and* absolute dates, that commit's diff stat for this file, and the short SHA. Customise the text with `gitLore.blame.format`, or turn it off entirely. If the repo has a `.git-blame-ignore-revs` file (git's own convention for mass-reformat/lint commits you don't want blame attributing to), GitLore detects and respects it automatically — no setting, same as plain `git blame`.

The hover card also has **Compare** / **File History** / **Copy SHA** quick actions, an **Older** link that steps backward through that exact line's own history (real per-line tracking, not just "commits that touched this file") — ◀ prev / next ▶ through every revision that changed the line, without leaving the hover — and an **Open PR** link that looks up the pull request that shipped this line (appears only when `gitLore.launchpad.enabled` is on, resolved on click with no prompt).

By default blame uses `git blame` as-is. Turn on `gitLore.blame.detectMoves` to pass `-M -C`, which follows lines that were moved or copied between files — more accurate for refactored code but slower on large files.

### An interactive commit graph, in the panel

<img src="media/screenshots/commit-graph.png" alt="The GitLore panel showing the commit graph with branch labels, a working-changes row, a stash chip, pull/push badges, and commit details beside it" />

A repo-wide, branch-and-merge-aware graph — not a flat log. Branch, tag and remote-tracking labels are each styled distinctly, uncommitted work is pinned at the top as a **Working Changes** row, and the toolbar lets you scope to one branch, filter by message/author/SHA as you type, and refresh. Arrow keys move the selection; Enter opens the commit. It opens scoped to whatever branch you're currently on, not every branch at once, and keeps following you across any checkout — from GitLore, a terminal, or another tool — until you pick a specific branch or **All branches** from the ref picker yourself. Any stash shows as a small chip on the row of the commit it was made from; click it to **Apply** or **Delete**.

<img src="media/screenshots/commit-graph-context-menu.png" alt="Right-clicking a commit opens a menu with Checkout, Reset Branch to Here, Revert This Commit, Cherry-pick onto Current Branch, Create Branch from Commit, Tag This Commit, and Copy SHA" />

Right-click any commit for **Checkout**, **Reset Branch to Here** (soft/mixed/hard), **Revert This Commit**, **Cherry-pick onto Current Branch**, **Create Branch from Commit**, **Tag This Commit**, and **Copy SHA** — no terminal needed to reset, revert, cherry-pick, branch, or tag from history you're already looking at. Reset and Checkout confirm first and can't be undone once accepted; Revert and Cherry-pick run in a real terminal since either can land a conflict you resolve yourself.

Fetch, pull, and push buttons sit in the toolbar too — pull/push badged with how many commits you're behind/ahead of the upstream (hidden when there's no upstream to compare against) — all three run in a real terminal, so you see prompts and conflicts instead of them failing silently. The graph also auto-refreshes on any external `git pull`/push/checkout, not just its own buttons.

Commit Graph and Launchpad have their own visual identity — dark by default, a teal-to-cyan accent, and their own typeface — instead of just inheriting whatever your editor theme happens to be.

### Commit details you can act on

<img src="media/screenshots/commit-details.png" alt="Commit details showing the action bar and a per-file collapsible diff with old and new line numbers in a gutter" />

Each changed file is its own collapsible section holding only that file's hunks, with a filter box for large commits. Diffs show **old and new line numbers in a gutter** and tint changed lines, so you can see *which* line moved — and line numbers stay out of your text selection, so copying a diff gives you just the code.

**Copy SHA**, **Copy message**, and **Open on GitHub/GitLab/Bitbucket** sit in the action bar. **Open changes** on any file row hands off to a real diff editor when you want syntax highlighting and folding. Commit messages also linkify issue references (`#123` by default) straight to your tracker — see [Issue and PR links](#also) below.

### Branch comparison without modal prompts

<img src="media/screenshots/branch-comparison.png" alt="Branch comparison showing two ref pickers with a swap button, Ahead/Behind/All Files tabs with counts, and Create PR and Open all changes buttons" />

Two ref pickers with a swap button, and **Ahead / Behind / All Files** tabs with counts. It opens on your current branch versus its upstream, so it's useful immediately — retarget either side in place. Diffs are taken against the merge-base, matching what a GitHub or GitLab pull request shows you.

**Create PR** creates the pull request directly on the host — GitHub, GitLab, Bitbucket, or Azure DevOps (hidden on hosts GitLore doesn't recognize, rather than guessing at one). Prompts for a title and, on hosts that support it, whether to create it as a draft, then shows a link to open the new PR once it's live — no browser round-trip to finish the job. Needs `gitLore.launchpad.enabled` on, since it's the one action here that actually calls a host's API rather than just building a local URL; the button still shows either way and explains itself if you click it while that's off. **Open all changes** opens every changed file's diff at once instead of one at a time, all against the same common base.

### Launchpad — a cross-repo PR triage board (off by default)

<img src="media/screenshots/launchpad.png" alt="Launchpad showing an eight-column board: Needs Review, Ready to Merge, Waiting, Blocked, Drafts, Snoozed, Merged, and Closed, each with pull request cards, and a repo row above with Pull/Push buttons" />

The only GitLore feature that reaches beyond your local `.git` — everything else above works fully offline. **GitLore: Open Launchpad** opens a 9-column board (Needs Review, Reviewed, Ready to Merge, Waiting, Blocked, Drafts, Snoozed, Merged, Closed) pooling PRs across every recognized remote in your workspace, so triaging what needs your attention — and seeing what you've recently shipped — doesn't mean tab-switching between repos and a browser. Once you've approved or requested changes on a PR you don't own, it moves to **Reviewed** and stays there regardless of what happens to it afterward (CI turns red, a conflict appears, another reviewer requests changes) — unless the host puts you back in as a requested reviewer, which sends it back to **Needs Review**. **Merged** and **Closed** show your own most-recently-completed PRs; every card in an open column also gets **Approve**, **Request changes**, and **Close PR** actions (each with a confirmation first) — right from the board, no host website required. A **Ready to Merge** card also gets a **Merge PR** action — pick a strategy (Merge, Squash and merge, or Rebase and merge, filtered to what that PR's host actually supports) and optionally delete the source branch, then confirm. A **Closed** (not merged) card gets a **Reopen PR** action — Bitbucket Cloud is the one exception, since it has no way to reopen a declined PR at all, on its API or its own web UI. A row above the board lists every recognized repo with **Fetch**/**Pull**/**Push** buttons — a purely local git operation, so it works even for a repo whose forge sign-in was skipped or failed.

Every card's **View diff** button opens a docked **Pull Request Details** panel (next to Commit Details) with that PR's changed files and diff, status badges (draft, merged/closed, check status, review decision, merge conflicts, age), its review conversations — each showing the `path:line` it's anchored to when it's a code comment, plus a **Resolve** button — a comment box to post a top-level comment, and a **Refresh** button to pick up changes made elsewhere. **Approve**, **Request Changes**, **Merge**, **Close**, and **Reopen** are buttons right in the panel too, the same actions the card already had — no need to go back to the board just to act on the PR you're already reading. **Merge** only appears once the PR is actually ready (approved, checks not pending, no conflicts), so it never bounces off a rejection the board's own categorization would already have predicted.

<img src="media/screenshots/pull-request-details.png" width="480" alt="The Pull Request Details panel showing changed files with a diff gutter, review conversations with a path:line label and a Resolve button, and a comment box" />

Not GitHub-only: GitHub, GitLab, Bitbucket, and Azure DevOps are supported out of the box, plus self-hosted or custom instances (GitHub Enterprise Server, Gitea, Forgejo, self-hosted GitLab) via `gitLore.launchpad.customHosts`. GitHub and Azure DevOps Services (`dev.azure.com`) both use VS Code's own built-in sign-in (GitHub's session, and Azure DevOps' Microsoft/AAD session — the latter also works for organizations whose Conditional Access policy blocks Personal Access Tokens outright); every other host, including self-hosted Azure DevOps Server, needs a Personal Access Token, entered once and stored in VS Code's encrypted secret storage — never a GitLore backend, never a key GitLore itself handles.

Off by default (`gitLore.launchpad.enabled`) — it's opt-in, same as AI, since it's the one feature that calls out to a remote host at all. Scans every remote on every repo in the workspace, not just `origin` (a fork's `upstream` included), deduped when two remotes point at the same actual repo. Once enabled, it's also one click away from the Commit Graph panel's toolbar, not just the Command Palette.

### Sidebar Explorer — one tree for the whole repo

<img src="media/screenshots/sidebar-explorer.png" alt="The GitLore Explorer sidebar showing Branches, Remotes, Tags, Stashes, Worktrees, and Contributors sections" />

Branches, Remotes, Tags, Stashes, Worktrees, and Contributors, each a collapsible section, always visible in its own activity bar icon — no command needed to open it. Right-click a branch to **Checkout**, **Compare with Current Branch**, **Merge into Current Branch**, **Rebase Current Branch onto This** (the last two run in a real terminal, since either can land a conflict you resolve yourself), **Rename Branch**, or **Delete Branch** (confirms first; git itself blocks deleting the branch you have checked out); right-click a remote to **Open Remote in Browser**; right-click a tag for **Delete Tag** (confirms first); right-click a stash to **Apply** or **Drop** (with confirmation — it can't be undone); an inline **+** on the Worktrees and Stashes section headers adds a worktree (path + branch) or a new stash (optional message). **GitLore: Recover Lost Commit or Branch** (Command Palette) lists recent reflog entries and creates a branch at whichever one you pick — for recovering from a hard reset, force push, or accidental branch delete before git garbage-collects it.

### File History

<img src="media/screenshots/file-history.png" alt="The File History panel listing every commit that touched the current file, newest first, with author and age" />

Every commit that touched the current file, newest first, following renames, right in the Explorer sidebar — no separate view to open.

### Visual File History

<img src="media/screenshots/visual-file-history.png" alt="Visual File History showing an author-swimlane bubble timeline with additions and deletions bars beneath" />

An author-swimlane bubble timeline as an alternative to the tree above: each commit is a bubble sized by how much it changed, positioned by author lane and by age, with additions/deletions bars beneath. Click a bubble to open that commit's details.

### Interactive Rebase Editor

<img src="media/screenshots/rebase-editor.png" alt="The Interactive Rebase Editor listing commits with pick, squash, and reword actions, drag handles, and Start Rebase / Abort buttons" />

Reorder, reword, edit, squash, fixup, or drop commits with a real UI instead of hand-editing the `git rebase -i` todo file. **GitLore: Rebase Branch Interactively...** picks a target ref and starts one — or it just works if you already use `code --wait` as your own git `sequence.editor`. GitLore never runs `rebase`, `--abort`, `--continue`, or any reset/checkout command itself: it only ever reads, writes, and closes the one file git already opens for this.

### Stale-code detector

<img src="media/screenshots/stale-code.png" alt="A CodeLens reading 'Stale · last changed 1 year ago' above an untouched function, with no lens above a recently changed one" />

A CodeLens above functions, methods, and classes untouched for longer than `gitLore.staleThresholdDays` (180 by default), reading how long it's been and who last touched it — click through straight to that commit. Nothing shows above code that's actually been touched recently, so the signal stays legible even in a large file.

### Co-change detector

<img src="media/screenshots/co-change-detector.png" alt="A CodeLens reading '🔗 Often changes with: checkoutFlow.test.ts' above a source file" />

A CodeLens above the file naming other files that frequently change alongside it — "🔗 Often changes with: `auth.test.ts`, `session.ts`" — a "logical coupling" signal computed entirely from `git log`, no separate analysis service. Click it for a QuickPick with the exact ratio (e.g. "changed together in 4/5 commits · 80%") and pick one to open it. Nothing shows for a coincidental shared commit or two — only a real, consistent pattern. Toggle with `gitLore.coChange.enabled` (on by default).

### Author ownership heatmap

<img src="media/screenshots/ownership-heatmap.png" alt="The File Ownership quick pick showing each author's recency-weighted percentage and line count, with color marks in the editor's overview ruler" />

An overview-ruler color mark per line, by that line's author (`gitLore.ownership.enabled`, off by default). **GitLore: Show File Ownership** adds a recency-weighted breakdown — who owns the file, not just who has the most raw lines, so a large old contribution doesn't outrank a smaller recent one.

### Full-file blame heatmap

<img src="media/screenshots/full-file-blame.png" alt="A hot-to-cold recency gradient as a colored left edge on every line of the file" />

A hot-to-cold recency gradient as a left-edge mark per line, across the whole file (`gitLore.fullFileBlame.enabled`, off by default) — relative to the file's own age range, so even an entirely old file still shows which of its lines are relatively newer. Distinct from the current-line inline blame decoration and the ownership ruler above: a third, independent visual, not a mode of either.

### AI commit summaries, line explanations, and commit messages

Opt-in (`gitLore.ai.enabled`, off by default) — nothing is sent anywhere until you turn it on, and it uses whatever language model you've already registered with VS Code (e.g. GitHub Copilot Chat) via the built-in Language Model API. No GitLore backend, no API key, no account.

- **Summarize** in Commit Details streams a plain-English summary of the open commit.
- **Explain this line with AI**, from the blame hover, answers "why does this line exist?" using that line's blame and diff history.
- **Generate Commit Message with AI**, a sparkle button in the Source Control panel's title bar, drafts a message from your staged diff straight into the commit box — GitLore never stages or commits anything itself, it only fills in the text VS Code's own Source Control view already owns.

Each degrades to an inline hint rather than erroring when no model is registered.

### GitLore Chat — ask your repo's history questions directly

A docked chat panel (**GitLore: Open Chat**) for free-form questions about a repo's history — "who touched this file last", "why did this get rewritten", "what changed between these two tags." The model answers by calling a fixed set of git-backed tools GitLore runs locally against your own repo (file history, line history, a commit's diff, commits between two refs, branches) — no retrieval index, no pre-guessed context, and every tool call is shown in the panel as it happens. Also reachable pre-seeded with a subject via **Ask GitLore About This File/Commit/Line/Pull Request**, from Commit Graph, Commit Details, the blame hover, and Pull Request Details.

Same opt-in gate and privacy contract as every other AI feature: nothing runs unless `gitLore.ai.enabled` is on, and every tool call is a local `git` read — never a network call.

### More AI, reusing the same infrastructure

- **Explain this PR** — an Explain button in Pull Request Details summarizes what a PR changes and flags its riskiest area to review.
- **Branch Compare AI summary** — a Summarize button in Branch Comparison explains what the compare branch changes relative to the base.
- **Generate Changelog with AI** — pick two refs, get a Markdown changelog (Added/Changed/Fixed) streamed into a fresh editor tab.
- **AI PR review draft** — a Draft Review button in Pull Request Details drafts one review comment into the existing comment box, for you to edit and post — the model never posts on its own.

### Also

- **Issue and PR links** — `#123` in a commit message becomes a link, auto-detected from your remote or pointed at any tracker (Jira included) via a regex and URL template. Visible inline wherever a commit message renders — no separate view of its own.
- **Find When Text Was Added or Removed** — **GitLore: Find When Text Was Added or Removed** (Command Palette) searches git history for commits that introduced or removed the selected text using `git log -S`/`-G`; results appear in a QuickPick and open Commit Details on pick. Works with any string or regex.
- **Line-range history** — "Step Through This Line's History" and "Explain This Line's History" both use the editor's full selection when something is selected, so you can trace a block rather than just a single line's ancestry.

## Commands

Every command is also a title-bar button in the GitLore panel.

| Command | What it does |
|---|---|
| `GitLore: Open Commit Graph` | Reveal the panel and load the repo's graph |
| `GitLore: Show Commit Details` | Load a commit into the details pane |
| `GitLore: Compare Branches` | Compare two refs, ahead/behind/files |
| `GitLore: Show File History` | List commits touching the current file |
| `GitLore: Show Visual File History` | Open the bubble timeline for the current file |
| `GitLore: Toggle Inline Blame` | Turn the end-of-line decoration on or off |
| `GitLore: Load More File History` | Load the next page of commits in the File History tree (internal — triggered by the tree's Load More item, not the Command Palette) |
| `GitLore: Copy Commit SHA` | Copy a commit's full SHA (from a commit's context menu) |
| `GitLore: Show File Ownership` | See a file's authors ranked by recency-weighted ownership share (command palette only, no title-bar button) |
| `GitLore: Show Files That Often Change With This One` | Open the coupled-files QuickPick (from the co-change CodeLens) |
| `GitLore: Rebase Branch Interactively...` | Pick a target ref and start an interactive rebase, opened in GitLore's own editor |
| `GitLore: Checkout Branch` | Check out the selected branch (from the Explorer's context menu) |
| `GitLore: Compare with Current Branch` | Open Branch Comparison against the selected branch (from the Explorer's context menu) |
| `GitLore: Merge into Current Branch` | Merge the selected branch into the current one, in a real terminal (from the Explorer's context menu) |
| `GitLore: Rebase Current Branch onto This` | Rebase the current branch onto the selected one, in a real terminal (from the Explorer's context menu) |
| `GitLore: Open Remote in Browser` | Open the selected remote's repo page (from the Explorer's context menu) |
| `GitLore: Apply Stash` | Re-apply the selected stash without dropping it (from the Explorer's context menu) |
| `GitLore: Drop Stash` | Permanently delete the selected stash, after confirming (from the Explorer's context menu) |
| `GitLore: Step Through This Line's History` | Move the hover's line-history stepper (from the hover's Older/prev/next links) |
| `GitLore: Toggle Full-File Blame Heatmap` | Turn the whole-file recency gradient on or off |
| `GitLore: Open Launchpad` | Open the cross-repo PR triage board (needs `gitLore.launchpad.enabled`) |
| `GitLore: Show Pull Request Details` | Open a PR's changed files, diff, and review conversations in a docked panel (from a Launchpad card's View diff button) |
| `GitLore: Generate Commit Message with AI` | Draft a commit message from your staged diff, into the Source Control input box (also a title-bar button there; needs `gitLore.ai.enabled`) |
| `GitLore: Open Chat` | Open the GitLore Chat panel (also a title-bar button on Commit Graph; needs `gitLore.ai.enabled`) |
| `GitLore: Ask GitLore About This File` | Open the chat, pre-seeded with the current file |
| `GitLore: Ask GitLore About This Commit` | Open the chat, pre-seeded with the loaded commit (title-bar button on Commit Details) |
| `GitLore: Ask GitLore About This Line` | Open the chat, pre-seeded with the current line's blame context |
| `GitLore: Ask GitLore About This Pull Request` | Open the chat, pre-seeded with the loaded PR (title-bar button on Pull Request Details) |
| `GitLore: Explain Commit with AI` | Stream a plain-English summary of the open commit (button in Commit Details; needs `gitLore.ai.enabled`) |
| `GitLore: Explain This Line's History` | Answer "why does this line exist?" from the blame hover (needs `gitLore.ai.enabled`) |
| `GitLore: Explain Pull Request with AI` | Summarize the loaded PR and flag its riskiest area (button in Pull Request Details; needs `gitLore.ai.enabled`) |
| `GitLore: Summarize Branch Comparison with AI` | Summarize what the compare branch changes relative to the base (button in Branch Comparison; needs `gitLore.ai.enabled`) |
| `GitLore: Generate Changelog with AI` | Pick two refs and stream a Markdown changelog into a new editor tab (needs `gitLore.ai.enabled`) |
| `GitLore: Draft PR Review Comment with AI` | Draft a review comment into the existing comment box (button in Pull Request Details; needs `gitLore.ai.enabled`) |
| `GitLore: Rename Branch` | Rename the selected branch (from the Explorer's context menu) |
| `GitLore: Delete Branch` | Delete the selected branch, after confirming (from the Explorer's context menu) |
| `GitLore: Delete Tag` | Delete the selected tag, after confirming (from the Explorer's context menu) |
| `GitLore: Add Worktree` | Create a new worktree at a chosen path and branch (from the Explorer's Worktrees section header) |
| `GitLore: Remove Worktree` | Remove the selected worktree, after confirming (from the Explorer's context menu) |
| `GitLore: New Stash` | Create a new stash with an optional message (from the Explorer's Stashes section header) |
| `GitLore: Recover Lost Commit or Branch` | List recent reflog entries and create a branch at whichever one you pick (Command Palette) |
| `GitLore: Find When Text Was Added or Removed` | Search git history for when a string was introduced or removed (`git log -S`/`-G`), prefilled from selection (Command Palette) |
| `GitLore: Open Pull Request for Commit` | Look up the PR that contains the current commit and open it in Pull Request Details (from the blame hover; needs `gitLore.launchpad.enabled`) |

## Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `gitLore.blame.enabled` | boolean | `true` | Show inline blame decorations, hover cards, and the status bar item. |
| `gitLore.blame.format` | string | `"{author}, {age}"` | Template for the inline blame text. Tokens: `{author} {age} {date} {message} {sha}` |
| `gitLore.blame.highlightCurrentLine` | boolean | `true` | Highlight the current line's blame decoration. |
| `gitLore.blame.ignoreWhitespace` | boolean | `true` | Pass `-w` to git blame to ignore whitespace-only changes. |
| `gitLore.blame.detectMoves` | boolean | `false` | Pass `-M -C` to git blame to follow lines moved or copied between files. More accurate for refactored code, but slower on large files. |
| `gitLore.maxBlameFileSize` | number | `1048576` | Skip blame for files larger than this size, in bytes. |
| `gitLore.maxHistoryItems` | number | `200` | Max commits loaded per file history. |
| `gitLore.maxGraphItems` | number | `200` | Max commits loaded in the commit graph. |
| `gitLore.staleCode.enabled` | boolean | `true` | Show a CodeLens above functions and methods that haven't changed in longer than staleThresholdDays. |
| `gitLore.staleThresholdDays` | number | `180` | Days since a function's or method's last change before it's flagged as stale. |
| `gitLore.coChange.enabled` | boolean | `true` | Show a CodeLens above the file listing other files that frequently change alongside it (a logical-coupling signal from git history). |
| `gitLore.ownership.enabled` | boolean | `false` | Show a color mark per line in the editor's overview ruler for that line's author. |
| `gitLore.fullFileBlame.enabled` | boolean | `false` | Show a hot-to-cold recency gradient as a left-edge mark per line, across the whole file. |
| `gitLore.issueLinking.enabled` | boolean | `true` | Auto-link issue/PR references in commit messages. |
| `gitLore.issueLinking.pattern` | string | `"#(\\d+)"` | Regex matching issue references. The first capture group (or the whole match) fills `{issue}` in the URL template. |
| `gitLore.issueLinking.urlTemplate` | string | `""` | `{issue}`-templated issue URL. Empty = auto-detect from the repo's GitHub/GitLab remote. |
| `gitLore.ai.enabled` | boolean | `false` | Enable AI features (commit summaries, line explanations, chat). Uses your own model via `vscode.lm` — no key or diff leaves your machine unless this is on. |
| `gitLore.ai.modelFamily` | string | `"gpt-4o"` | Preferred language model family hint (e.g. `gpt-4o`, `claude-3.5-sonnet`). Falls back to any available model. |
| `gitLore.ai.maxDiffChars` | number | `8000` | Max diff size, in characters, sent to the model. Longer diffs are truncated. |
| `gitLore.ai.maxToolIterations` | number | `6` | Max tool-call round trips GitLore Chat makes per question before it stops and shows whatever answer the model has so far. |
| `gitLore.rebaseEditor.enabled` | boolean | `true` | Use GitLore's Interactive Rebase Editor for git-rebase-todo files. When disabled, they open in the default text editor. |
| `gitLore.launchpad.enabled` | boolean | `false` | Enable Launchpad, the cross-repo PR triage board. The only setting that makes GitLore call out to a remote host. |
| `gitLore.launchpad.statusBar.enabled` | boolean | `true` | Show a status-bar item with the number of PRs needing your review. Only active when `gitLore.launchpad.enabled` is also on; when Launchpad is disabled it is never created and makes no network calls. |
| `gitLore.launchpad.customHosts` | array | `[]` | Self-hosted/custom git-forge instances (GitHub Enterprise Server, Gitea, Forgejo, self-hosted GitLab) Launchpad can't recognize by hostname alone. Each entry: `{ hostname, flavor, apiBaseUrl }`. |

## Privacy

GitLore runs entirely locally. Your git data never leaves your machine — with two opt-in exceptions:

**1. Gravatar avatars** — GitLore fetches author avatars from `gravatar.com` keyed by an MD5 hash of the commit email. This is the only network request GitLore makes on its own, without any opt-in. A few things open your browser when you click them — **Open on GitHub/GitLab/Bitbucket**, **Open Remote in Browser**, issue links — but every URL is built from your local git remote; GitLore doesn't contact the host to construct them.

**2. Launchpad, its status-bar item, Branch Comparison's Create PR, and "Open PR for this commit"** — all off by default (`gitLore.launchpad.enabled: false`). When enabled, GitLore calls the git host you've explicitly authenticated with — VS Code's own built-in sign-in for GitHub and Azure DevOps Services, or a Personal Access Token you provide for anything else, stored in VS Code's encrypted secret storage. No GitLore backend ever sees your code, your token, or your PR data. The status-bar item (`gitLore.launchpad.statusBar.enabled`, default `true`) is only active when Launchpad is enabled. It loads the same pull-request data the board does, from the same host, once shortly after startup and again when the window regains focus (at most once a minute, and shared with the board so the two never fetch twice). It only uses a sign-in you already have — it never prompts you to sign in — and with Launchpad off it makes no network calls at all.

**3. AI features** — off by default (`gitLore.ai.enabled: false`). When enabled, diffs and git context are sent to whatever language model you've already registered with VS Code (e.g. GitHub Copilot Chat) via the built-in `vscode.lm` API. No GitLore backend, no API key, no account. Nothing is sent until you turn it on.

No telemetry. No analytics. No account.

## How it compares

GitLore is not trying to out-feature the bigger, paid alternatives — it's trying to be the free, fast, small part you actually use every day. Honest accounting:

**What GitLore does** — inline blame and hover, status bar, file history (tree and visual), a self-refreshing commit graph with pull/push, commit details with per-file diffs, an interactive rebase editor, branch comparison, a repo-wide sidebar explorer, a cross-repo PR triage board, AI commit summaries, AI line explanations, AI-drafted commit messages, stale-code detection, ownership and recency heatmaps, and issue linking. All free, forever.

**What it deliberately doesn't** — staging or committing itself (that's VS Code's own Source Control view; GitLore only helps draft the message that goes there, and the graph links to Source Control for everything else), and anything behind a sign-in. GitLore can create, apply, and drop stashes (from the sidebar explorer and Stashes section), but it never stages or commits on your behalf.

**What's missing for now** — a file-tree view of changed files (GitLore's diffs list files flat, not nested by folder). See the [changelog](CHANGELOG.md) for the current list.

## Contributing

```bash
npm install
npm run watch     # rebuild on change
npm run lint      # eslint + tsc --noEmit
npm run test      # unit + integration
```

Press `F5` to launch the Extension Development Host with GitLore loaded.

- `npm run test:unit` runs just the fast, VS Code-free tests over `src/core` and the renderers.
- `npm run package` builds a `.vsix`; `npm run package:pre` builds a pre-release one.
- `npm run icon` re-renders `media/icon.png` from `media/icon.svg` (needs `rsvg-convert`).

Architecture, conventions and the roadmap live in [`CLAUDE.md`](CLAUDE.md). The short version: `src/core/` is pure logic with zero `vscode` imports and is unit-tested in isolation; everything VS Code-facing sits in `providers/`, `views/` and `commands/`.

## License

[MIT](LICENSE) — free, forever, no exceptions.
