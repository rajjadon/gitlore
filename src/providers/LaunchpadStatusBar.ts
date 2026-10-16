import * as vscode from 'vscode';
import { COMMANDS, CONFIG } from '../constants';
import type { GitLogger } from '../core/git/errors';
import { GitService } from '../core/git/GitService';
import { type ForgeHostConfig } from '../core/forge/hostDetection';
import { resolveWorkspaceForgeRepos, type WorkspaceForgeRepo } from './workspaceForgeRepos';
import { buildForgeClient } from '../core/forge/buildForgeClient';
import { loadBoard } from '../core/forge/loadBoard';
import { azureDevOpsCredentialScheme, resolveForgeTokenSilently } from './forgeCredentials';
import {
  getBoardSummary,
  setBoardSummary,
  buildBoardSummary,
  isLoadInFlight,
  withBoardLoad,
  onBoardSummaryChange,
  type BoardSummary,
} from '../core/forge/boardSummaryStore';
import { createRefreshThrottle } from '../core/forge/refreshThrottle';

/** 60 s minimum between focus-triggered refreshes — matches C1 and Launchpad's own interval. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * Minimum gap before retrying after a failure — shorter than the normal interval so a transient
 * outage is recovered within half a minute rather than waiting the full 60 s.
 * ponytail: 30 s is a pragmatic balance; reduce to 10 s if users report slow recovery.
 */
const FAILURE_RETRY_INTERVAL_MS = 30_000;

/**
 * Phase D status-bar item: shows `$(git-pull-request) N` where N is the number of pull requests
 * in the `needsReview` bucket across all signed-in repos.
 *
 * Lifecycle: constructed lazily (via setImmediate in extension.ts); only activated when BOTH
 * `gitLore.launchpad.enabled` AND `gitLore.launchpad.statusBar.enabled` are true. Reacts to
 * config changes without a reload.
 *
 * Network-load strategy:
 * - LaunchpadViewProvider writes to `boardSummaryStore` after every full refresh via `buildBoardSummary`.
 *   The status bar subscribes and re-renders immediately — no extra network call.
 * - When the Launchpad panel is not open, the status bar fetches on its own (first enable + window
 *   focus) using `resolveForgeTokenSilently` (never prompts) and the shared `loadBoard`/`buildBoardSummary`
 *   path — same rules, no duplicate logic.
 * - Normal throttle (60 s) uses `summary.lastLoadedAt` from the LAST SUCCESSFUL load (preserved by
 *   `buildBoardSummary` even on failure). After a failure the retry throttle (30 s) is used instead,
 *   allowing faster recovery without hammering the host.
 *
 * D1.1: `$(git-pull-request) N` — shown whenever at least one repo loaded successfully, including
 * when that count is 0 ("0 PRs need review" is useful info; hiding at 0 would mask a board that
 * works but genuinely has nothing to review). Hidden only when no repo could be reached at all (all
 * auth failures or no forge remotes in the workspace).
 */
export class LaunchpadStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private active = false;
  /**
   * The last summary we've rendered — null means "no successful load data, hide the item".
   * Updated by both the store listener (when Launchpad pushes) and by runRefresh (own load).
   */
  private lastRenderedSummary: BoardSummary | null = null;

  private focusListenerDisposable: vscode.Disposable | undefined;
  /** Normal 60 s throttle — checked against the last SUCCESSFUL load time. */
  private readonly normalThrottle = createRefreshThrottle(FOCUS_REFRESH_MIN_INTERVAL_MS);
  /** Shorter 30 s retry throttle — used when the last result was stale (failed). */
  private readonly retryThrottle = createRefreshThrottle(FAILURE_RETRY_INTERVAL_MS);
  /** When the last failure was observed (own refresh OR stale push from Launchpad). */
  private lastFailedAt: number | undefined;
  private ownRefreshInFlight = false;

  private unsubscribeBoardSummary: (() => void) | undefined;

  constructor(
    private readonly git: GitService,
    private readonly secrets: vscode.SecretStorage,
    private readonly logger: GitLogger,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.item.command = COMMANDS.openLaunchpad;
    this.item.tooltip = 'Open GitLore Launchpad';
    this.disposables.push(this.item);

    // React to config changes: show/hide, start/stop refreshing — no reload needed.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(`${CONFIG.section}.${CONFIG.launchpadEnabled}`) ||
          e.affectsConfiguration(`${CONFIG.section}.${CONFIG.launchpadStatusBarEnabled}`)
        ) {
          this.syncToConfig();
        }
      }),
    );

    this.syncToConfig();
  }

  dispose(): void {
    this.deactivate();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** Test-only introspection — returns the item's current text or undefined when hidden. */
  getTextForTest(): string | undefined {
    // VS Code's public StatusBarItem doesn't expose visibility; we track it ourselves.
    return this.active && this.lastRenderedSummary !== null ? this.item.text : undefined;
  }

  /**
   * Test-only trampoline — calls the extension bundle's own `setBoardSummary` so the status bar's
   * subscription (registered against the bundle's module instance) actually fires. Integration
   * tests must never import `boardSummaryStore` directly: esbuild bundles the module into
   * `out/extension.js`, giving it separate `_summary`/`_listeners` state from the `out-test/`
   * copy the test imports. A direct call from the test reaches the wrong instance and the
   * subscription never fires.
   */
  setSummaryForTest(summary: BoardSummary | null): void {
    setBoardSummary(summary);
  }

  private cfg<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CONFIG.section).get<T>(key, fallback);
  }

  private bothEnabled(): boolean {
    return (
      this.cfg<boolean>(CONFIG.launchpadEnabled, false) &&
      this.cfg<boolean>(CONFIG.launchpadStatusBarEnabled, true)
    );
  }

  private syncToConfig(): void {
    if (this.bothEnabled()) {
      this.activate();
    } else {
      this.deactivate();
    }
  }

  private activate(): void {
    if (this.active) {
      return;
    }
    this.active = true;

    // Subscribe to board summary changes pushed by LaunchpadViewProvider.
    this.unsubscribeBoardSummary = onBoardSummaryChange((summary) => {
      if (summary !== null) {
        this.lastRenderedSummary = summary;
        if (summary.stale) {
          // Record when we learned the data is stale so the retry throttle can measure from here.
          this.lastFailedAt = Date.now();
        } else {
          this.lastFailedAt = undefined;
        }
      } else {
        // null = no data at all (first-ever load with all failures, or no forge remotes).
        this.lastRenderedSummary = null;
        this.lastFailedAt = Date.now();
      }
      this.render();
    });

    // If there's already a summary in the store (from a Launchpad load before this was enabled),
    // pick it up immediately without waiting for the next change.
    const existing = getBoardSummary();
    if (existing) {
      this.lastRenderedSummary = existing;
      if (existing.stale) {
        this.lastFailedAt = Date.now();
      }
      this.render();
    }

    // Wire up focus-triggered refresh.
    this.focusListenerDisposable = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused || !this.active) {
        return;
      }
      if (!this.shouldTriggerRefresh()) {
        return;
      }
      void this.runRefresh();
    });

    // Initial refresh — deferred so activate() returns < 50 ms.
    setImmediate(() => void this.runRefresh());
  }

  private deactivate(): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.item.hide();

    this.unsubscribeBoardSummary?.();
    this.unsubscribeBoardSummary = undefined;

    this.focusListenerDisposable?.dispose();
    this.focusListenerDisposable = undefined;
  }

  /**
   * Decides whether a focus-triggered refresh should fire. Uses the NORMAL throttle (60 s from
   * last successful `lastLoadedAt`) when the last summary was good, and the RETRY throttle (30 s
   * from `lastFailedAt`) when the last result was stale — so a failed refresh can be retried within
   * 30 s rather than being blocked for the full 60 s, but can't be hammered on every focus event.
   */
  private shouldTriggerRefresh(): boolean {
    const inFlight = this.ownRefreshInFlight || isLoadInFlight();
    const summary = getBoardSummary();
    const isStale = summary?.stale ?? true; // no summary at all = treat as needing retry

    if (isStale) {
      return this.retryThrottle.shouldRefresh(inFlight, this.lastFailedAt);
    }
    return this.normalThrottle.shouldRefresh(inFlight, summary?.lastLoadedAt);
  }

  /**
   * Runs a full board load using `resolveForgeTokenSilently` (never prompts), then writes the
   * result into `boardSummaryStore` via `buildBoardSummary`. Both LaunchpadViewProvider and this
   * class write there; whichever ran most recently wins, and the throttle uses that timestamp to
   * gate both. `withBoardLoad` guarantees `_loadInFlight` is always cleared (Bug 1 fix).
   */
  private async runRefresh(): Promise<void> {
    if (this.ownRefreshInFlight || isLoadInFlight()) {
      return;
    }
    this.ownRefreshInFlight = true;
    try {
      await withBoardLoad(async () => {
        const folderPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
        const repos = await resolveWorkspaceForgeRepos(this.git, folderPaths, this.readCustomHosts());
        const previous = getBoardSummary();

        if (repos.length === 0) {
          // No recognized forge remotes — use buildBoardSummary with empty result so stale/null
          // rules are applied consistently (same as total failure path).
          setBoardSummary(buildBoardSummary(
            { categorized: [], errors: [], loginByRepoKey: new Map(), rawByRepoKey: new Map() },
            previous,
            Date.now(),
          ));
          return;
        }

        const boardInputs = await this.buildBoardInputs(repos);
        const result = await loadBoard({
          repos: boardInputs,
          // Status bar doesn't know snooze state — D1.4: count = needsReview bucket as-is.
          isSnoozed: () => false,
          onCredentialRejected: async () => { /* silent; no token to clear that we prompted for */ },
          logError: (msg, err) => this.logger.error(msg, err),
        });

        // buildBoardSummary: single shared implementation of counting/stale rules (Bug 2 fix).
        const summary = buildBoardSummary(result, previous, Date.now());
        if (summary?.stale === true) {
          this.lastFailedAt = Date.now();
        } else if (summary !== null) {
          this.lastFailedAt = undefined;
        }
        setBoardSummary(summary); // notifies listeners (including self via subscription)
      });
    } catch (err) {
      // withBoardLoad already cleared _loadInFlight; the catch here handles logging and keeping
      // the last count visible with a stale marker.
      this.logger.error('LaunchpadStatusBar refresh failed', err);
      this.lastFailedAt = Date.now();
      const prev = getBoardSummary();
      setBoardSummary(prev !== null ? { ...prev, stale: true } : null);
    } finally {
      this.ownRefreshInFlight = false;
    }
  }

  private render(): void {
    if (!this.active) {
      return;
    }
    const summary = this.lastRenderedSummary;
    if (summary === null) {
      // No successful load yet or all repos unreachable — hide.
      this.item.hide();
      return;
    }

    this.item.text = `$(git-pull-request) ${summary.total}`;

    const tooltipLines: string[] = [];
    for (const [repo, count] of Object.entries(summary.needsReviewByRepo)) {
      tooltipLines.push(`${repo}: ${count} to review`);
    }
    if (tooltipLines.length === 0) {
      tooltipLines.push('No pull requests need review');
    }
    tooltipLines.push('');
    tooltipLines.push('Click to open GitLore Launchpad');
    if (summary.stale) {
      tooltipLines.push('(last refresh failed — count may be out of date)');
    }

    const md = new vscode.MarkdownString(tooltipLines.join('\n\n'));
    md.isTrusted = false;
    this.item.tooltip = md;
    this.item.show();
  }

  private readCustomHosts(): ForgeHostConfig[] {
    return vscode.workspace.getConfiguration(CONFIG.section).get<ForgeHostConfig[]>(CONFIG.launchpadCustomHosts, []);
  }

  private async buildBoardInputs(
    repos: WorkspaceForgeRepo[],
  ): Promise<Parameters<typeof loadBoard>[0]['repos']> {
    const inputs: Parameters<typeof loadBoard>[0]['repos'] = [];
    for (const { repo, detected } of repos) {
      const token = await resolveForgeTokenSilently(this.secrets, detected);
      if (!token) {
        // No token available — treat as "not signed in". The repo won't contribute to the count,
        // but a signed-in repo in the same workspace still can. When ALL fail, the item is hidden.
        inputs.push({ repo, client: null, displayHost: detected.displayHost });
        continue;
      }
      const client = buildForgeClient(
        detected.flavor,
        detected.apiBaseUrl,
        repo.identity,
        token,
        azureDevOpsCredentialScheme(detected),
        fetch,
      );
      inputs.push({ repo, client, displayHost: detected.displayHost });
    }
    return inputs;
  }
}
