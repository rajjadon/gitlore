# GitLore — Codex System Prompt

> **Read this file fully at the start of every session.** It is the single source of truth for how GitLore is built. If anything here conflicts with a request, surface the conflict before proceeding.

---

## 1. Mission

You are building **GitLore**, an open-source VS Code extension that makes deep sense of any Git repository — its history, authors, blame, branches, and commit patterns — directly inside the editor. It is leaner, faster, and smarter — with every feature free.

**One-line pitch:** *GitLore makes sense of your repo.*

The success metric is simple: a developer opens any file in any repo and instantly understands **who wrote this, when, why, and what changed** — without leaving their editor, without a paywall, and without waiting.

---

## 2. Who you are working with

Raj — full-stack developer, based in India. Works primarily in TypeScript and React, on a MacBook Pro (M3 Pro), in VS Code / Cursor. Experienced with monorepos, SDK architecture, ports/adapters patterns, and cross-platform tooling. Prefers concise, direct answers and clean, well-typed code. Assume a high level of competence — don't over-explain basics, do explain non-obvious tradeoffs.

---

## 3. Project identity

| Field         | Value                                              |
|---------------|----------------------------------------------------|
| Name          | GitLore                                           |
| Tagline       | *The story behind every line.*                        |
| Type          | VS Code Extension (open source)                    |
| Language      | TypeScript (strict)                                |
| License       | MIT                                                |
| Target        | VS Code 1.85+ and VS Code-based editors (Cursor)   |
| Package name  | `gitlore`                                          |
| Bundler       | esbuild (never webpack)                             |
| Node runtime  | Node 20 LTS                                         |

---

## 4. Core philosophy — never compromise on these

1. **100% free, always.** No paywalled features, no "Pro" tier, no account, no sign-in gate. Ever.
2. **Fast first.** `activate()` returns in < 50ms. Every heavy feature loads lazily. The extension never blocks editor startup.
3. **Minimal surface area.** A UI element must earn its place. No sidebars full of empty sections. If a feature can be a hover instead of a panel, make it a hover.
4. **AI-native, not AI-bolted-on.** AI is a first-class citizen via the VS Code Language Model API (`vscode.lm`), so users bring their own model (Copilot, Ollama, Codex, etc.). No GitLore backend, no proxied keys.
5. **Respect the editor.** Use native VS Code APIs — CodeLens, Decorations, TreeView, Webview, Hover — not reinvented primitives.
6. **Local-first & private.** Zero telemetry by default. Git data never leaves the machine unless the user explicitly enables an AI feature that sends a diff to *their own* model.

When a request violates one of these, say so and propose an alternative that doesn't.

---

## 5. Repository structure

```
/
├── src/
│   ├── extension.ts          # Entry — activate() / deactivate() ONLY. Wires everything, owns nothing.
│   ├── core/                 # Pure logic. ZERO vscode imports. Unit-testable in isolation.
│   │   ├── git/
│   │   │   ├── GitService.ts     # simple-git wrapper, the only place that touches git
│   │   │   ├── parsers.ts        # parseBlame, parseLog, parseDiff — pure functions
│   │   │   └── types.ts          # Commit, BlameLine, FileChange, Ref
│   │   ├── cache/
│   │   │   └── LruCache.ts       # generic LRU, key: `${repoRoot}:${filePath}:${ref}`
│   │   └── ai/
│   │       ├── prompts.ts        # prompt builders (pure string functions)
│   │       └── parseResponse.ts  # LLM response → structured data
│   ├── providers/            # VS Code provider-interface implementations
│   │   ├── BlameDecorationProvider.ts
│   │   ├── BlameHoverProvider.ts
│   │   ├── FileHistoryProvider.ts   # TreeDataProvider
│   │   └── CodeLensProvider.ts
│   ├── views/                # Webview panels (rich UI, vanilla TS + CSS)
│   │   ├── CommitGraph/
│   │   └── CommitDetails/
│   ├── commands/             # one file per command group; thin handlers that call core + providers
│   ├── ai/                   # VS Code-facing AI layer (talks to vscode.lm, uses core/ai for logic)
│   │   └── LanguageModelClient.ts
│   ├── utils/                # date, string, gravatar, path — pure helpers
│   └── constants.ts          # command IDs, config keys, view IDs — single source, no magic strings
├── test/
│   ├── unit/                 # core/ logic, no VS Code host
│   ├── integration/          # @vscode/test-electron, real extension host
│   └── fixtures/             # committed sample repos for deterministic tests
├── media/                    # webview assets (css, icons, gallery banner)
├── esbuild.js                # build script
├── package.json              # extension manifest
├── tsconfig.json
├── .vscode/launch.json       # F5 → Extension Development Host
├── CHANGELOG.md
├── README.md
└── AGENTS.md                 # ← this file
```

**The dependency rule (enforce strictly):**
`core/` → knows nothing about VS Code.
`providers/`, `views/`, `commands/`, `ai/` → may import from `core/` and `vscode`.
`extension.ts` → imports from everywhere, wires disposables, holds no logic.
Never let a `vscode` import leak into `core/`. If you're tempted, the logic belongs in a provider, not core.

---

## 6. Dependencies — keep node_modules lean

| Package | Purpose | Notes |
|---|---|---|
| `simple-git` | Git CLI wrapper | The ONLY way to touch git |
| `date-fns` | Date formatting | Tree-shakeable; import per-function |
| `diff` | Client-side unified diffs | Only for Azure DevOps PR diffs (`AzureDevOpsClient.getPullRequestDiff`) — the one host with no diff-text endpoint of its own |
| `esbuild` | Bundler | dev dep |
| `@vscode/test-electron` | Integration tests | dev dep |
| `@types/vscode`, `@types/node` | Types | dev dep |
| `eslint`, `@typescript-eslint/*` | Linting | dev dep |

**Ask Raj before adding any runtime dependency.** No React/Vue/Svelte in the extension host. Webviews are vanilla TS + CSS unless a view grows complex enough to justify a framework, and then it stays isolated inside its own `views/` subfolder with its own build step.

`media/fonts/` bundles IBM Plex Sans and JetBrains Mono (both SIL Open Font License) as static assets — not an npm dependency, but worth noting as a new bundled-asset category.

---

## 7. Feature roadmap (build in this order)

### Phase 1 — Core (MVP, ship first) — shipped 0.1.0
- [x] **Inline blame** — current-line blame as a muted, right-aligned editor decoration
- [x] **Blame hover card** — hover → rich card: author (Gravatar), full message, relative + absolute date, diff stat, "Open commit" link
- [x] **File history** — TreeView of every commit touching the current file, newest first
- [x] **Commit details** — Webview: message, author, full diff, files changed, copy-SHA button
- [x] **Status bar** — current line's last author + age (e.g. `Raj, 3 days ago`), click → commit details

### Phase 2 — Intelligence (the "Sense" in GitLore) — shipped 0.3.0
- [x] **AI commit summary** — `vscode.lm` turns a commit + diff into a plain-English summary
- [x] **AI line explanation** — "Why does this line exist?" → LLM answers using the line's blame + diff history
- [x] **Stale-code detector** — flag files/functions untouched for > `staleThresholdDays`, shown as a subtle CodeLens
- [x] **Author ownership** — per-file heatmap: who owns which regions, by line count and recency
- [x] **AI commit message generation** — drafts a message from the staged diff straight into the Source Control input box, via a title-bar button there; same opt-in gate and infrastructure as commit summary/line explanation

### Phase 3 — Graph & collaboration — shipped 0.1.0–0.2.0 (built ahead of Phase 2)
- [x] **Commit graph** — interactive DAG in a Webview
- [x] **Branch comparison** — two branches side-by-side
- [x] **Issue/PR linking** — auto-link commit messages to GitHub/GitLab issues via configurable regex

### Phase 4 — Editor surface depth
Extends existing hover/decoration/webview code already in the repo — no new view containers.
- [x] **Hover quick-actions + revision nav** — Compare / File History / Copy SHA buttons in the blame hover card, plus ◀ prev/next ▶ stepping through a line's blame history without leaving the hover
- [x] **Branch Compare polish** — per-file diffstat bars, "Create PR" button, "Open all changes with common base". Create PR now creates the PR directly via `ForgeClient.createPullRequest` (prompting for a title and, where the host supports it, a draft choice via `DRAFT_SUPPORTED_HOSTS`) rather than only opening the host's pre-filled compare page in a browser — the button itself still resolves via pure local URL/host parsing (so it shows for any recognized host, including Azure DevOps, which the original browser-URL builder in `utils/remoteLinks.ts` couldn't recognize), but requires `gitLore.launchpad.enabled` for the actual API call, sharing that toggle's "the only thing that calls out to a remote host" contract instead of being a second, independent path
- [x] **Full-file gutter blame + heatmap toggle** — whole-file blame overlay in the gutter (distinct from the current-line decoration and the ownership ruler), with a hot→cold recency gradient edge

### Phase 5 — Repository views
- [x] **Sidebar explorer tree** — one view container: Branches, Remotes, Tags, Stashes, Worktrees, Contributors, with ahead/behind status and right-click actions

### Phase 6 — Visual history & rebase
- [x] **Visual File History** — author-swimlane bubble timeline (additions/deletions over time), as an alternative to the existing tree-based File History
- [x] **Interactive rebase editor** — custom editor webview replacing the `git rebase -i` todo file: drag-reorder, pick/squash/fixup/drop/reword/edit, Start/Abort (conflict list deferred — points at Source Control instead, per the design spec's scope cut)

### Phase 7 — Launchpad (optional, last)
The only feature that reaches beyond the local repo — needs PR/CI status, not just `git`. Not GitHub-only: GitHub, GitLab, Bitbucket, and Azure DevOps are all supported (each via its own `core/forge/*Client.ts`, the only place that touches that host's API), plus self-hosted/custom instances via `gitLore.launchpad.customHosts`. GitHub and Azure DevOps Services (`dev.azure.com`) both use a VS Code built-in authentication session (`vscode.authentication.getSession('github', …)` / `getSession('microsoft', …)` — the latter also covers organizations whose Conditional Access policy blocks PAT/Basic auth outright, which no PAT scope can work around); every other host, including self-hosted Azure DevOps Server, needs a Personal Access Token stored in `context.secrets`. Never a GitLore backend or proxied key, for any host. Off by default (`gitLore.launchpad.enabled`) — the only setting that lets GitLore call out to a remote host at all. Branch Comparison's Create PR (Phase 4) is the one feature outside this phase that also does, and it shares this exact toggle rather than getting its own.
- [x] **PR triage board** — Needs Review / Reviewed / Ready to Merge / Waiting / Blocked / Drafts / Snoozed / Merged / Closed, across the workspace's repos. Reviewed exists because a PR you don't own used to vanish from the board entirely once the host stopped counting you as an owed reviewer — it's derived from each host's own per-reviewer data (`PullRequestSummary.reviewedByMe`), not a local marker, so it's correct even for a review submitted on the host's own website. Wins over blocked/ready-to-merge/waiting once set (your job as reviewer is done, regardless of what happens to the PR afterward), unless the host re-requests your review, which routes back through Needs Review instead
- [x] **Close PR** — a per-card action (with a confirm dialog) that closes an open PR/MR on its host without merging, via each `ForgeClient`'s own write endpoint
- [x] **Reopen PR** — a per-card action on a Closed (not merged) card only — no host lets a merge be undone this way. Bitbucket Cloud has no reopen capability at all, on its API or its own web UI, so that call throws a clear platform-gap error instead of pretending it's possible
- [x] **Merge PR** — a per-card action on a Ready to Merge card only, so it never bounces off a host-side rejection the board's own categorization already ruled out. Prompts for a merge strategy via QuickPick (filtered per host through `MERGE_STRATEGIES_BY_HOST`, since GitLab's merge endpoint only exposes a `squash` boolean and Bitbucket's third strategy, fast-forward, isn't equivalent to a true rebase), then one confirm dialog with a "Merge & Delete Branch" option instead of a third prompt
- [x] **Per-repo push/pull** — a row per workspace repo with Pull/Push buttons, independent of forge auth (it's a local git operation). Reuses Commit Graph's terminal-based pattern (`git pull`/`git push` sent to a shared `GitLore: Git Sync` terminal, not simple-git) rather than a new `GitService` method, since push/pull can need interactive auth or land a merge conflict a terminal is where the user handles either
- [x] **PR Details: view diff/commits** — a docked panel (next to Commit Details) showing a PR's changed files and diff, reusing `diffRender.ts`'s file-section renderer as-is. Azure DevOps has no diff-text endpoint at all — `AzureDevOpsClient.getPullRequestDiff` fetches each changed file's content at the PR's merge-base and head commits (from the latest iteration's `commonRefCommit`/`sourceRefCommit`) and diffs them client-side with the `diff` package, the one exception to "no runtime dependency without asking Raj first." Falls back to the changed file list with `0`/`0` stats — no diff text, not a fabricated guess — for a binary file, a file over the internal size cap, a pure rename with no content change, or on an older self-hosted Azure DevOps Server that doesn't expose those commit ids yet
- [x] **PR review actions: Approve / Request changes** — two card actions on every open Launchpad PR (confirm dialog, then `ForgeClient.submitReview`). GitLab has no formal "request changes" review state — that decision throws a clear platform-gap error there instead of faking one
- [x] **PR review actions: add a comment** — a comment box in the Pull Request Details panel posts a top-level PR comment via `ForgeClient.addComment`, all four hosts REST
- [x] **PR review actions: resolve conversation threads** — the Pull Request Details panel lists review conversations with a Resolve button per unresolved one. GitHub has no REST endpoint for this at all — `GitHubClient` gained a second request path (`graphql()`, alongside its normal REST `request()`) purely for the `reviewThreads` query and `resolveReviewThread` mutation; the other three hosts are plain REST

Do not start a phase until the previous phase is tested and merged.

**Naming:** whatever inspires a phase, GitLore ships under its own name only — no competitor product or company names in code, comments, settings, commands, or docs.

---

## 8. Public contributions (define in `package.json`)

### Commands
| Command ID (use `constants.ts`) | Title |
|---|---|
| `gitLore.toggleBlame` | GitLore: Toggle Inline Blame |
| `gitLore.showFileHistory` | GitLore: Show File History |
| `gitLore.loadMoreFileHistory` | GitLore: Load More File History |
| `gitLore.showCommit` | GitLore: Show Commit Details |
| `gitLore.explainCommit` | GitLore: Explain Commit with AI |
| `gitLore.explainLine` | GitLore: Explain This Line's History |
| `gitLore.generateCommitMessage` | GitLore: Generate Commit Message with AI |
| `gitLore.copySha` | GitLore: Copy Commit SHA |
| `gitLore.openGraph` | GitLore: Open Commit Graph |
| `gitLore.showVisualFileHistory` | GitLore: Show Visual File History |
| `gitLore.compareBranches` | GitLore: Compare Branches |
| `gitLore.showFileOwnership` | GitLore: Show File Ownership |
| `gitLore.rebaseInteractively` | GitLore: Rebase Branch Interactively... |
| `gitLore.checkoutBranch` | GitLore: Checkout Branch |
| `gitLore.compareBranchFromExplorer` | GitLore: Compare with Current Branch |
| `gitLore.openRemote` | GitLore: Open Remote in Browser |
| `gitLore.applyStash` | GitLore: Apply Stash |
| `gitLore.dropStash` | GitLore: Drop Stash |
| `gitLore.stepLineHistory` | GitLore: Step Through This Line's History |
| `gitLore.toggleFullFileBlame` | GitLore: Toggle Full-File Blame Heatmap |
| `gitLore.openLaunchpad` | GitLore: Open Launchpad |
| `gitLore.showPullRequest` | GitLore: Show Pull Request Details |

### Settings (all under `gitLore.*`)
| Setting | Type | Default | Description |
|---|---|---|---|
| `gitLore.blame.enabled` | boolean | `true` | Show inline blame decorations |
| `gitLore.blame.format` | string | `"{author}, {age}"` | Blame text template. Tokens: `{author} {age} {date} {message} {sha}` |
| `gitLore.blame.highlightCurrentLine` | boolean | `true` | Highlight the current line's blame |
| `gitLore.blame.ignoreWhitespace` | boolean | `true` | Pass `-w` to git blame |
| `gitLore.ai.enabled` | boolean | `false` | Enable AI features (uses your own model via vscode.lm) |
| `gitLore.ai.modelFamily` | string | `"gpt-4o"` | Preferred LM family hint |
| `gitLore.ai.maxDiffChars` | number | `8000` | Max diff size sent to the model |
| `gitLore.staleCode.enabled` | boolean | `true` | Show the stale-code CodeLens above untouched functions/methods |
| `gitLore.staleThresholdDays` | number | `180` | Days before a function is considered stale |
| `gitLore.maxHistoryItems` | number | `200` | Max commits loaded per file history |
| `gitLore.maxGraphItems` | number | `200` | Max commits loaded in the commit graph |
| `gitLore.maxBlameFileSize` | number | `1048576` | Skip blame for files larger than this (bytes) |
| `gitLore.ownership.enabled` | boolean | `false` | Show a per-line author color mark in the overview ruler |
| `gitLore.fullFileBlame.enabled` | boolean | `false` | Show a hot-to-cold recency gradient as a left-edge mark per line, across the whole file |
| `gitLore.issueLinking.enabled` | boolean | `true` | Auto-link issue/PR references (e.g. `#123`) in commit messages |
| `gitLore.issueLinking.pattern` | string | `"#(\\d+)"` | Regex matching issue/PR references; first capture group fills `{issue}` |
| `gitLore.issueLinking.urlTemplate` | string | `""` | `{issue}`-templated URL for issue links; empty auto-detects from the GitHub/GitLab remote |
| `gitLore.rebaseEditor.enabled` | boolean | `true` | Use GitLore's Interactive Rebase Editor for `git-rebase-todo` files |
| `gitLore.launchpad.enabled` | boolean | `false` | Enable Launchpad, the cross-repo PR triage board — the only setting that makes GitLore call out to a remote host |
| `gitLore.launchpad.customHosts` | array | `[]` | Self-hosted/custom forge instances Launchpad can't recognize by hostname alone: `{ hostname, flavor, apiBaseUrl }[]` |

### Views
Register a TreeView **only when it has content**. Contributed view: `gitLore.fileHistory` in the SCM or Explorer container (decide via config, default Explorer).

### Activation events
Prefer `onStartupFinished` over `*`. Never use `*`. Better still, activate on the specific commands and `workspaceContains:.git` where possible.

---

## 9. Code conventions

- **TypeScript strict.** No `any`. No non-null `!` without an inline comment justifying it. Prefer `unknown` + narrowing.
- **Async/await only.** No raw `.then()` chains.
- **No magic strings.** Command IDs, config keys, and view IDs come from `constants.ts`.
- **Naming:**
  - Providers implement a VS Code interface → `XProvider`
  - Command handlers → `handleXCommand`
  - Git parsers → `parseX` (pure, no side effects, no I/O)
  - Types → `PascalCase` interfaces in a `types.ts` near their domain
- **Functions over classes** for stateless utilities. Use classes only when there's genuine instance state (providers, services, cache).
- **Every `Disposable` goes into `context.subscriptions`.** No exceptions — this is how we avoid leaks.
- **Barrel exports** (`index.ts`) only at module boundaries, not everywhere.
- **Comments explain *why*, not *what*.** The code says what; a comment says why it's non-obvious.

### Expected pattern — a provider

```typescript
// providers/BlameHoverProvider.ts
import * as vscode from 'vscode';
import { GitService } from '../core/git/GitService';
import { formatBlameHover } from '../utils/format';

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly git: GitService) {}

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    try {
      const line = await this.git.blameLine(doc.uri.fsPath, pos.line);
      if (!line) return undefined;
      return new vscode.Hover(formatBlameHover(line));
    } catch {
      // Blame failing on an unsaved/untracked file is expected — stay silent.
      return undefined;
    }
  }
}
```

### Expected pattern — a git parser (pure, testable)

```typescript
// core/git/parsers.ts
import type { BlameLine } from './types';

/** Parses `git blame --line-porcelain` output. Pure — no I/O. */
export function parseBlamePorcelain(raw: string): BlameLine[] {
  // ...deterministic parsing, fully unit-tested
}
```

### Expected pattern — extension.ts wiring

```typescript
// extension.ts
import * as vscode from 'vscode';
import { GitService } from './core/git/GitService';
import { registerBlame } from './providers/BlameDecorationProvider';
import { registerCommands } from './commands';

export function activate(ctx: vscode.ExtensionContext): void {
  const git = new GitService();

  // Defer everything heavy so activate() returns fast.
  setImmediate(() => {
    ctx.subscriptions.push(
      ...registerBlame(git),
      ...registerCommands(git),
    );
  });
}

export function deactivate(): void {
  // Disposables are handled by ctx.subscriptions — nothing to do here.
}
```

---

## 10. Git interaction rules

- All git access goes through `GitService` (which wraps `simple-git`). Nothing else imports `simple-git`.
- Never `child_process.exec` git directly.
- Parse with pure functions in `parsers.ts` — keep parsing out of `GitService` and providers.
- **Cache aggressively.** LRU key `${repoRoot}:${filePath}:${ref}`. Invalidate via `createFileSystemWatcher`, never poll.
- **Debounce** document-change-driven git calls by 500ms.
- Recompute inline blame only on **line change**, not on every cursor move.
- Always handle: no repo open, detached HEAD, untracked file, empty repo, submodules, and huge files (skip blame over `maxBlameFileSize`).
- Support multi-root workspaces — resolve the correct repo root per file.

---

## 11. AI layer rules

- Use `vscode.lm.selectChatModels()` — never hardcode a provider, never store an API key.
- If no model is available, features degrade gracefully with a one-line "Enable a language model to use this" message. Do not error-spam.
- Prompt building lives in `core/ai/prompts.ts` as pure functions (so they're testable without a model).
- Cap the diff size sent to the model (`gitLore.ai.maxDiffChars`). Truncate with a clear marker.
- Stream responses into the hover/panel where the API supports it.
- **Never** send a diff to any model unless `gitLore.ai.enabled` is `true`. This is a privacy contract — treat it as inviolable.

---

## 12. Performance budget (hard limits)

| Metric | Budget |
|---|---|
| `activate()` return time | < 50ms |
| Inline blame update latency | < 100ms (cached), < 400ms (cold) |
| File history load (200 commits) | < 800ms |
| Idle memory footprint | < 40MB |

Rules: defer git in `activate()` via `setImmediate`; never load the full log on activation (per-file, on demand); Webviews use `retainContextWhenHidden: false` unless state is genuinely expensive to rebuild; no decoration animations/transitions (they flicker).

---

## 13. Error handling taxonomy

| Situation | Response |
|---|---|
| Not a git repo | Silent no-op; feature simply doesn't show |
| Untracked / unsaved file | Silent no-op |
| Git binary missing | One-time `showWarningMessage` with a link to install git |
| Git command failed unexpectedly | `showErrorMessage`, log full error to the GitLore output channel |
| No language model available | Inline hint in the relevant UI, not a popup |
| Parse failure | Log to output channel, return empty result, never crash |

Create a dedicated `OutputChannel` named `GitLore` for diagnostics. Never `console.log` in shipped code.

---

## 14. Testing strategy

- **Unit tests** (`test/unit/`) cover `core/` — parsers, cache, prompt builders. Target **85%** coverage here. They run without a VS Code host, so they're fast; run them on every change.
- **Integration tests** (`test/integration/`) use `@vscode/test-electron` against a fixture repo committed under `test/fixtures/`. Cover: activation, command registration, blame decoration appears, hover returns content.
- Each parser gets a golden-file test: real `git blame`/`git log` output in, expected struct out.
- A feature is **not done** until it has tests. See §16.

---

## 15. Commit & branch conventions (for the GitLore repo itself)

- **Conventional Commits:** `feat:`, `fix:`, `perf:`, `refactor:`, `test:`, `docs:`, `chore:`. Scope optional, e.g. `feat(blame): add hover card`.
- One logical change per commit. No "wip" or "misc fixes" on main.
- Branch names: `feat/inline-blame`, `fix/blame-empty-repo`, `phase-2/ai-summary`.
- Keep `CHANGELOG.md` updated under an `## [Unreleased]` heading as you go.
- Never commit secrets, `.vsix` artifacts, or `out/`/`dist/`.

---

## 16. Definition of Done (every feature)

- [ ] Behaves correctly in: normal repo, empty repo, no repo, untracked file, multi-root workspace
- [ ] Respects its relevant `gitLore.*` settings
- [ ] All disposables registered in `context.subscriptions`
- [ ] Errors handled per §13 — no unhandled rejections, no console output
- [ ] Within the performance budget (§12)
- [ ] Unit tests for any `core/` logic; integration test for the user-facing behavior
- [ ] `README.md` feature list + `CHANGELOG.md` updated
- [ ] Command titles/settings match §8 exactly
- [ ] `npm run lint` and `npm run test` pass clean

---

## 17. Build & dev commands

```bash
npm install           # install deps
npm run compile       # type-check + esbuild bundle → out/
npm run watch         # esbuild watch for development
npm run test          # unit + integration
npm run test:unit     # fast core-only tests
npm run lint          # eslint + tsc --noEmit
npm run package       # vsce package → gitlore-x.x.x.vsix
```

Press **F5** to launch the Extension Development Host with the extension loaded.

---

## 18. Accessibility & UX

- Blame decorations must meet contrast in both light and dark themes — derive colors from `ThemeColor`, never hardcode hex.
- This rule governs editor decorations, hover cards, tree items, and the status bar (native VS Code UI GitLore doesn't control the rendering of). It does **not** govern the eight webview panels (Commit Graph, Commit Details, Branch Comparison, PR Details, Rebase Editor, Visual File History, Launchpad, Chat) — those use GitLore's own fixed design-token palette (`media/shared.css`'s `:root`), not `ThemeColor`, as of the 2026-08-20 design system change. See `docs/superpowers/specs/2026-08-20-gitlore-webview-design-system.md`.
- All Webviews: proper heading structure, `aria-label` on icon-only buttons, keyboard-navigable, respect `prefers-reduced-motion`.
- Never rely on color alone to convey meaning (staleness, ownership) — pair with text or icon.
- Honor the user's `editor.fontFamily` inside webviews where it reads as editor content.
- "Reads as editor content" is the operative scope: a diff hunk, a file path, a commit's full patch — literal file/diff content — still honors `editor.fontFamily`/`editor.fontSize`. UI chrome and code-*shaped identifiers* (a SHA, a branch/tag/repo name) use GitLore's own `--gl-font-ui`/`--gl-font-mono` instead, regardless of the user's editor font.
- Enforce a strict Content Security Policy on every Webview; use a nonce for scripts, no inline event handlers, no remote script loads.

---

## 19. Publishing (when Phase 1 is stable)

- Publish to both the VS Code Marketplace and Open VSX (so Cursor / VSCodium users get it).
- `README.md` needs animated GIFs of the core features above the fold.
- Semantic versioning. Pre-1.0 = expect breaking changes; document them in `CHANGELOG.md`.
- The extension icon and gallery banner live in `media/`.

---

## 20. What NOT to do

- ❌ No feature behind a sign-in, account, or "Pro" upsell — free means free.
- ❌ No API key routed through any GitLore backend — the user's model, the user's key, local only.
- ❌ No sidebar with empty/placeholder sections.
- ❌ No webpack — esbuild only.
- ❌ No telemetry enabled by default; if ever added, opt-in with explicit consent.
- ❌ No decoration animations/transitions — they flicker and feel janky.
- ❌ No loading the entire git log on activation.
- ❌ No `vscode` imports inside `core/`.
- ❌ No `console.log` in shipped code — use the output channel.
- ❌ No magic strings — everything through `constants.ts`.

---

## 21. When you're unsure

1. Check the [VS Code Extension API docs](https://code.visualstudio.com/api) before guessing.
2. Prefer the simplest implementation that works; profile before optimizing.
3. Ask Raj before adding a runtime dependency or a backend requirement — GitLore runs fully locally.
4. If a request conflicts with §4 (philosophy) or §20 (anti-patterns), flag it and propose an alternative.
5. When scaffolding, build the smallest vertical slice that runs end-to-end (F5 → see it work), then iterate.