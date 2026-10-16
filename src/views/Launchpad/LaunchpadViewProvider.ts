import * as vscode from 'vscode';
import { GitService } from '../../core/git/GitService';
import type { GitLogger } from '../../core/git/errors';
import { buildForgeClient } from '../../core/forge/buildForgeClient';
import { loadBoard, recategorize, collectLivePrKeys, type BoardRepoInput } from '../../core/forge/loadBoard';
import { type DetectedForgeHost, type ForgeHostConfig } from '../../core/forge/hostDetection';
import type { ForgeClient } from '../../core/forge/ForgeClient';
import {
  pullRequestKey,
  type ForgeRepoRef,
  type MergeStrategy,
  type PullRequestSummary,
  type ReviewSubmission,
} from '../../core/forge/types';
import { azureDevOpsCredentialScheme, clearForgeToken, resolveForgeToken, signOutOfForgeHost } from '../../providers/forgeCredentials';
import { renderLaunchpadHtml, type LaunchpadRepoError, type LaunchpadRepoRow } from './render';
import { renderPlaceholderHtml } from '../placeholder';
import { COMMANDS, CONFIG, MEDIA, SNOOZE_STATE_KEY, VIEWS } from '../../constants';
import { runInGitSyncTerminal } from '../gitSyncTerminal';
import { closePullRequestFlow, mergePullRequestFlow, reopenPullRequestFlow, submitReviewFlow, type PullRequestActionUi } from '../pullRequestActions';
import { vscodePullRequestActionUi } from '../pullRequestActionUi';
import {
  migrateSnoozeState,
  isSnoozedNow,
  snoozeUntil,
  unsnooze,
  pruneSnoozed,
  stampLegacySnoozes,
  type SnoozeStore,
  type SnoozeChoice,
} from '../../core/forge/snoozeStore';
import { createRefreshThrottle } from '../../core/forge/refreshThrottle';
import { setBoardSummary, getBoardSummary, buildBoardSummary, withBoardLoad } from '../../core/forge/boardSummaryStore';
import { resolveWorkspaceForgeRepos } from '../../providers/workspaceForgeRepos';

/** 60 s minimum between focus-triggered refreshes — matches the contract's ≥ 60 s requirement. */
const FOCUS_REFRESH_MIN_INTERVAL_MS = 60_000;

/** Returns a PullRequestActionUi that auto-confirms the first matching button — used by ForTest methods so integration tests exercise real flow logic without driving an interactive modal. */
function autoConfirmUi(confirmButton: string): PullRequestActionUi {
  return {
    async confirm(_message, ...buttons) { return buttons.find((b) => b === confirmButton); },
    async pickMergeStrategy() { return undefined; },
    warn() {},
    error() {},
  };
}

/** Returns a PullRequestActionUi for the merge ForTest path — auto-picks a fixed strategy and confirm button. */
function autoMergeUi(strategy: MergeStrategy, deleteSourceBranch: boolean): PullRequestActionUi {
  return {
    async confirm(_message, ...buttons) { return buttons.find((b) => b === (deleteSourceBranch ? 'Merge & Delete Branch' : 'Merge')); },
    async pickMergeStrategy() { return strategy; },
    warn() {},
    error() {},
  };
}

import { createNonce } from '../nonce';

/**
 * A cross-repo PR triage board, in a full editor tab (like Rebase Editor — a 6-column board needs
 * real width, not a narrow docked-panel sliver). Not GitHub-only: resolves every workspace
 * folder's git remote to whichever forge it's on (GitHub, GitLab, Bitbucket, Azure DevOps, or a
 * configured self-hosted/custom instance) and pools their open PRs into one board.
 */
export class LaunchpadViewProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;

  /** Overridable only for tests — a real network call has no place in an automated suite. Defaults to the real global `fetch`. */
  private fetchImpl: typeof fetch;

  /** Rebuilt on every refresh — lets the "Close PR" action find the right host's client and the PR's `repo`/`number` from just the card's stable key, without re-parsing that key's opaque `identity`. */
  private clientsByRepoKey = new Map<string, ForgeClient>();
  private prsByKey = new Map<string, PullRequestSummary>();
  /** Rebuilt on every refresh — lets Push/Pull find the right local working copy from a repo row's stable key. Populated regardless of forge auth outcome: push/pull is a local git operation that doesn't need a host credential at all. */
  private repoRootByKey = new Map<string, string>();
  /** Rebuilt on every refresh — lets "Sign Out" reset the right host's credential from just a repo row's stable key, regardless of whether that repo's auth currently succeeds or is broken. */
  private detectedByRepoKey = new Map<string, DetectedForgeHost>();
  private repoLabelByKey = new Map<string, string>();
  /** Rebuilt on every refresh — the signed-in login per repo, so `submitReview` can catch "you're reviewing your own PR" before ever calling the host's API. Every host we support rejects a self-review one way or another; catching it here turns that into one clear message instead of a different opaque API error per host. */
  private loginByRepoKey = new Map<string, string>();
  /** The last full-load raw PR data per repo — lets `recategorize` re-bucket without a network call (e.g. after toggling snooze). Also passed to `loadBoard` as `previousByRepoKey` so a repo that fails during a refresh still shows its last known PRs as stale. */
  private rawByRepoKey: Map<string, { login: string; open: PullRequestSummary[]; closed: PullRequestSummary[] }> = new Map();
  private cachedErrors: Array<{ repo: ForgeRepoRef; message: string }> = [];
  private cachedRepoRows: LaunchpadRepoRow[] = [];

  /** When the last successful full-board load completed — used for focus-refresh throttling and the "Updated N ago" header. */
  private lastLoadedAt: Date | undefined;
  /** True while a refresh is in-flight — prevents concurrent focus-triggered refreshes. */
  private refreshInFlight = false;

  /** Throttle for focus-triggered refreshes — shared so it's consistent even if the panel is replaced. */
  private readonly focusThrottle = createRefreshThrottle(FOCUS_REFRESH_MIN_INTERVAL_MS);

  /** Disposable for the window-focus listener — created when the panel opens, disposed when the panel closes. */
  private focusListenerDisposable: vscode.Disposable | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitService,
    private readonly logger?: GitLogger,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  dispose(): void {
    this.panel?.dispose();
    this.focusListenerDisposable?.dispose();
    this.focusListenerDisposable = undefined;
  }

  /** Test-only injection seam, since the extension host constructs one long-lived instance with the real `fetch` — a test needs to swap it after the fact, not at construction. */
  setFetchImplForTest(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.panel?.webview.html;
  }

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(VIEWS.launchpad, 'GitLore Launchpad', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        // Dispose the focus listener when the panel closes — it only makes sense while the panel is open.
        this.focusListenerDisposable?.dispose();
        this.focusListenerDisposable = undefined;
      });
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      });

      // C1.1: Refresh on window focus, throttled to ≥ 60 s and never while in-flight.
      // Panel-scoped (not in context.subscriptions) because refreshing when no panel is open would
      // be wasted work; disposing it with the panel keeps it tightly coupled to panel lifetime.
      // Defensive: dispose any existing listener first so opening the panel twice never leaks one.
      this.focusListenerDisposable?.dispose();
      this.focusListenerDisposable = vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) {
          return;
        }
        if (!this.focusThrottle.shouldRefresh(this.refreshInFlight, this.lastLoadedAt?.getTime())) {
          return;
        }
        // Focus refresh: no loading flash (showLoadingPlaceholder = false)
        void this.refresh(false);
      });
    }
    await this.refresh();
  }

  private mediaUri(name: string): string {
    return this.panel?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  /**
   * `showLoadingPlaceholder` defaults to true for the initial open and an explicit "Refresh"
   * click, where a brief loading state is expected. A refresh that follows a card action
   * (snooze/close/approve) passes `false` — setting `webview.html` at all forces VS Code to fully
   * reset the webview's DOM, so blanking it out first (as this always used to do) made every
   * successful action visibly flash back to a loading screen before repainting the board.
   */
  private async refresh(showLoadingPlaceholder = true): Promise<void> {
    if (!this.panel) {
      return;
    }
    // Capture panel into a local const so TypeScript narrows it to non-undefined inside async
    // callbacks (the class field can be reset to undefined by onDidDispose at any await point).
    const panel = this.panel;
    this.refreshInFlight = true;
    try {
      // withBoardLoad: signals in-flight to LaunchpadStatusBar (prevents duplicate loads) and
      // guarantees markLoadFinished() runs in its finally — even on early return or thrown error,
      // so _loadInFlight never gets stuck (Bug 1 fix).
      await withBoardLoad(async () => {
      const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.launchpad)];
      const renderOpts = { nonce: createNonce(), cspSource: panel.webview.cspSource, styleUris };
      if (showLoadingPlaceholder) {
        panel.webview.html = renderPlaceholderHtml('Loading Launchpad…', { ...renderOpts, variant: 'loading' });
      }

      const customHosts = this.readCustomHosts();
      const folderPaths = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      const repos = await resolveWorkspaceForgeRepos(this.git, folderPaths, customHosts);
      if (repos.length === 0) {
        panel.webview.html = renderPlaceholderHtml(
          'No recognized git-forge remotes found in this workspace — GitHub, GitLab, Bitbucket, and Azure DevOps are supported out of the box; anything else needs an entry in gitLore.launchpad.customHosts.',
          renderOpts,
        );
        return;
      }

      // Resolve tokens sequentially — resolveForgeToken may show an input box, and parallelizing
      // it would stack several prompts at once on a multi-root workspace.
      const newClientsByRepoKey = new Map<string, ForgeClient>();
      const newRepoRootByKey = new Map<string, string>();
      const newDetectedByRepoKey = new Map<string, DetectedForgeHost>();
      const newRepoLabelByKey = new Map<string, string>();
      const repoRows: LaunchpadRepoRow[] = [];
      const boardInputs: BoardRepoInput[] = [];

      for (const { repo, detected, repoRoot } of repos) {
        const key = `${repo.host}:${repo.identity}`;
        newRepoRootByKey.set(key, repoRoot);
        newDetectedByRepoKey.set(key, detected);
        newRepoLabelByKey.set(key, repo.label);
        repoRows.push({ key, label: repo.label });

        const token = await resolveForgeToken(this.context.secrets, detected);
        if (!token) {
          boardInputs.push({ repo, client: null, displayHost: detected.displayHost });
          continue;
        }
        const client = buildForgeClient(
          detected.flavor,
          detected.apiBaseUrl,
          repo.identity,
          token,
          azureDevOpsCredentialScheme(detected),
          this.fetchImpl,
        );
        newClientsByRepoKey.set(key, client);
        boardInputs.push({ repo, client, displayHost: detected.displayHost });
      }

      const result = await loadBoard({
        repos: boardInputs,
        isSnoozed: (pr) => this.isSnoozed(pr),
        onCredentialRejected: async (repo) => {
          const detected = newDetectedByRepoKey.get(`${repo.host}:${repo.identity}`);
          if (detected) {
            await clearForgeToken(this.context.secrets, detected);
          }
        },
        logError: (msg, err) => this.logger?.error(msg, err),
        // Pass previous data so failed repos still show their last known PRs as stale
        previousByRepoKey: this.rawByRepoKey,
      });

      // Swap out all instance state atomically so actions that look up a PR or client
      // always see a consistent snapshot.
      this.clientsByRepoKey = newClientsByRepoKey;
      this.loginByRepoKey = result.loginByRepoKey;
      this.repoRootByKey = newRepoRootByKey;
      this.detectedByRepoKey = newDetectedByRepoKey;
      this.repoLabelByKey = newRepoLabelByKey;
      this.rawByRepoKey = result.rawByRepoKey;
      this.cachedErrors = result.errors;
      this.cachedRepoRows = repoRows;
      this.lastLoadedAt = new Date();

      // D1.4: Push needsReview summary to boardSummaryStore so LaunchpadStatusBar can update
      // without a second network call. buildBoardSummary is the single shared implementation of
      // the counting/stale rules (Bug 2 fix: partial failures are now marked stale; total failure
      // preserves previous data rather than reporting a false "0").
      setBoardSummary(buildBoardSummary(result, getBoardSummary(), this.lastLoadedAt.getTime()));

      // Populate prsByKey from the raw data — merged/closed PRs need it too (View diff, Reopen).
      this.prsByKey = new Map();
      for (const { open, closed } of result.rawByRepoKey.values()) {
        for (const pr of [...open, ...closed]) {
          this.prsByKey.set(pullRequestKey(pr), pr);
        }
      }

      // Build prsByKey for legacy snooze stamping — all PRs from this load's raw data.
      const prsByKeyForStamp = new Map<string, { updatedAt: string }>();
      for (const { open, closed } of result.rawByRepoKey.values()) {
        for (const pr of [...open, ...closed]) {
          prsByKeyForStamp.set(pullRequestKey(pr), { updatedAt: pr.updatedAt });
        }
      }

      // Stamp legacy snoozes (migrated from old string[] format) with the current PR updatedAt —
      // converts { legacy: true } → { updatedAt } "until changed" entries for known PRs.
      // Then prune keys for PRs that are confirmed gone from a successfully-refreshed repo.
      // Snoozes from repos that FAILED to refresh are never pruned — we don't know if those PRs
      // still exist.
      const refreshedRepoKeys = new Set(result.rawByRepoKey.keys());
      const livePrKeys = collectLivePrKeys(result.rawByRepoKey);
      const stampedStore = stampLegacySnoozes(this.readSnoozeStore(), prsByKeyForStamp);
      const prunedStore = pruneSnoozed(stampedStore, livePrKeys, refreshedRepoKeys);
      await this.context.globalState.update(SNOOZE_STATE_KEY, prunedStore);

      if (!this.panel) {
        return;
      }
      panel.webview.html = renderLaunchpadHtml(
        { categorized: result.categorized, errors: result.errors, repoRows, lastLoadedAt: this.lastLoadedAt },
        renderOpts,
      );
      }); // end withBoardLoad
    } finally {
      this.refreshInFlight = false;
    }
  }

  /** Re-renders the board from cached raw data — no network call. Used after snooze toggling (L6). */
  private renderFromCache(): void {
    if (!this.panel) {
      return;
    }
    const categorized = recategorize(this.rawByRepoKey, (pr) => this.isSnoozed(pr));
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.launchpad)];
    const renderOpts = { nonce: createNonce(), cspSource: this.panel.webview.cspSource, styleUris };
    this.panel.webview.html = renderLaunchpadHtml({
      categorized,
      errors: this.cachedErrors,
      repoRows: this.cachedRepoRows,
      lastLoadedAt: this.lastLoadedAt,
    }, renderOpts);
  }

  private readCustomHosts(): ForgeHostConfig[] {
    return vscode.workspace.getConfiguration(CONFIG.section).get<ForgeHostConfig[]>(CONFIG.launchpadCustomHosts, []);
  }

  private isSnoozed(pr: PullRequestSummary): boolean {
    const store = this.readSnoozeStore();
    const entry = store[pullRequestKey(pr)];
    if (!entry) {
      return false;
    }
    return isSnoozedNow(entry, pr.updatedAt, new Date());
  }

  private readSnoozeStore(): SnoozeStore {
    const raw = this.context.globalState.get<unknown>(SNOOZE_STATE_KEY);
    return migrateSnoozeState(raw);
  }

  /**
   * Handles snooze/unsnooze for a card key.
   *
   * Un-snooze: one click, no picker.
   * Snooze: shows a QuickPick with three time choices, then stores the selection.
   */
  private async handleSnooze(key: string): Promise<void> {
    const store = this.readSnoozeStore();
    const entry = store[key];

    if (entry) {
      // Already snoozed → unsnooze immediately (one click, no picker per spec)
      const newStore = unsnooze(store, key);
      await this.context.globalState.update(SNOOZE_STATE_KEY, newStore);
      this.renderFromCache();
      return;
    }

    // Not snoozed → show QuickPick
    const CHOICES: { label: string; choice: SnoozeChoice }[] = [
      { label: '1 hour', choice: '1hour' },
      { label: 'Tomorrow 9am', choice: 'tomorrow9am' },
      { label: 'Until the PR changes', choice: 'untilChanged' },
    ];
    const picked = await vscode.window.showQuickPick(
      CHOICES.map((c) => c.label),
      { title: 'Snooze until…', placeHolder: 'Choose how long to snooze this PR' },
    );
    if (!picked) {
      return; // user cancelled the picker
    }
    const found = CHOICES.find((c) => c.label === picked);
    if (!found) {
      return; // should never happen: picked is always one of the CHOICES labels
    }
    const { choice } = found;
    const pr = this.prsByKey.get(key);
    const prUpdatedAt = pr?.updatedAt ?? '';
    const newStore = snoozeUntil(store, key, choice, prUpdatedAt, new Date());
    await this.context.globalState.update(SNOOZE_STATE_KEY, newStore);
    this.renderFromCache();
  }

  /** Test-only introspection seam — a webview button click can't be simulated in an integration test, so this drives the same toggle-then-render-from-cache flow the snooze button's message handler does. Snoozes as "until changed" when not snoozed; un-snoozes when already snoozed. */
  async toggleSnoozeForTest(key: string): Promise<void> {
    const store = this.readSnoozeStore();
    const entry = store[key];
    let newStore: SnoozeStore;
    if (entry) {
      newStore = unsnooze(store, key);
    } else {
      const pr = this.prsByKey.get(key);
      newStore = snoozeUntil(store, key, 'untilChanged', pr?.updatedAt ?? '', new Date());
    }
    await this.context.globalState.update(SNOOZE_STATE_KEY, newStore);
    this.renderFromCache();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { type, url, key, decision } = message as {
      type?: unknown;
      url?: unknown;
      key?: unknown;
      decision?: unknown;
    };

    if (type === 'openPr' && typeof url === 'string') {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (type === 'toggleSnooze' && typeof key === 'string') {
      await this.handleSnooze(key);
      return;
    }
    if (type === 'closePr' && typeof key === 'string') {
      await this.closePullRequest(key);
      return;
    }
    if (type === 'reopenPr' && typeof key === 'string') {
      await this.reopenPullRequest(key);
      return;
    }
    if (type === 'mergePr' && typeof key === 'string') {
      await this.mergePullRequest(key);
      return;
    }
    if (type === 'submitReview' && typeof key === 'string' && (decision === 'approve' || decision === 'requestChanges')) {
      await this.submitReview(key, decision);
      return;
    }
    if (type === 'showPullRequestDetails' && typeof key === 'string') {
      await vscode.commands.executeCommand(COMMANDS.showPullRequest, key);
      return;
    }
    if ((type === 'pull' || type === 'push' || type === 'fetch') && typeof key === 'string') {
      this.syncRepo(key, type);
      return;
    }
    if (type === 'signOut' && typeof key === 'string') {
      await this.signOut(key);
      return;
    }
    if (type === 'refresh') {
      await this.refresh();
    }
  }

  /**
   * Resets the credential for one repo's host — the fix for "I signed in as the wrong account and
   * there's no way to change it": before this, a bad credential only ever got cleared internally
   * on an API failure, and never at all for a built-in session (github.com/dev.azure.com), which
   * `clearForgeToken` deliberately never touches. `signOutOfForgeHost` handles both cases; the
   * refresh right after immediately re-triggers `resolveForgeToken`'s prompt, same as any other
   * "not signed in" repo.
   */
  private async signOut(key: string): Promise<void> {
    const detected = this.detectedByRepoKey.get(key);
    if (!detected) {
      return;
    }
    const label = this.repoLabelByKey.get(key) ?? detected.displayHost;
    const confirmed = await vscode.window.showWarningMessage(
      `Sign out of ${label}? Launchpad will ask you to sign in again on the next refresh.`,
      { modal: true },
      'Sign Out',
    );
    if (confirmed !== 'Sign Out') {
      return;
    }
    try {
      await signOutOfForgeHost(this.context.secrets, detected);
      await this.refresh(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`Launchpad failed to sign out of ${detected.displayHost}`, err);
      void vscode.window.showErrorMessage(`GitLore: couldn't sign out — ${message}`);
    }
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the sign-out flow directly, skipping only the modal. */
  async signOutForTest(key: string): Promise<void> {
    const detected = this.detectedByRepoKey.get(key);
    if (!detected) {
      return;
    }
    await signOutOfForgeHost(this.context.secrets, detected);
    await this.refresh(false);
  }

  /**
   * Runs in a real terminal, not via simple-git — pull/push can need interactive auth (an SSH
   * passphrase, a credential-manager prompt) or land a merge conflict on pull, and a terminal is
   * where the user can actually see and handle either. Same pattern and shared terminal as Commit
   * Graph's sync buttons (`CommitGraphViewProvider.ts`) — Launchpad doesn't track "did it finish"
   * either; the user sees the result in the terminal and can refresh the board themselves.
   */
  private syncRepo(repoKey: string, direction: 'pull' | 'push' | 'fetch'): void {
    const repoRoot = this.repoRootByKey.get(repoKey);
    if (!repoRoot) {
      return;
    }
    const command = direction === 'pull' ? 'git pull' : direction === 'push' ? 'git push' : 'git fetch';
    runInGitSyncTerminal(repoRoot, command);
  }

  /** Test-only introspection seam — a webview button click can't be simulated in an integration test, so this drives the same lookup-then-terminal flow the push/pull/fetch message handler does. */
  syncRepoForTest(repoKey: string, direction: 'pull' | 'push' | 'fetch'): void {
    this.syncRepo(repoKey, direction);
  }

  /** Resolves a card's key back to its `PullRequestSummary` and the `ForgeClient` that owns it — used by the "Show Pull Request Details" command, same lookup `closePullRequest` already does. `undefined` if the board has since refreshed and this PR is no longer on it. */
  resolvePullRequestForDetails(key: string): { pr: PullRequestSummary; client: ForgeClient } | undefined {
    const pr = this.prsByKey.get(key);
    if (!pr) {
      return undefined;
    }
    const client = this.clientsByRepoKey.get(`${pr.repo.host}:${pr.repo.identity}`);
    if (!client) {
      return undefined;
    }
    return { pr, client };
  }

  /** Resolves a card key to a PR and client pair. Returns undefined if the card is no longer on the board. */
  private resolveActionCtx(key: string): { pr: PullRequestSummary; client: ForgeClient } | undefined {
    const pr = this.prsByKey.get(key);
    if (!pr) return undefined;
    const client = this.clientsByRepoKey.get(`${pr.repo.host}:${pr.repo.identity}`);
    if (!client) return undefined;
    return { pr, client };
  }

  private async runFlow(key: string, flow: (pr: PullRequestSummary, client: ForgeClient, ui: PullRequestActionUi) => Promise<boolean>, ui: PullRequestActionUi = vscodePullRequestActionUi): Promise<void> {
    const resolved = this.resolveActionCtx(key);
    if (!resolved) return;
    const changed = await flow(resolved.pr, resolved.client, ui);
    if (changed) await this.refresh(false);
  }

  private async closePullRequest(key: string): Promise<void> {
    await this.runFlow(key, (pr, client, ui) => closePullRequestFlow({
      pr, client, ui, logError: (m, e) => this.logger?.error(`Launchpad: ${m}`, e),
    }));
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the close flow with an auto-confirming UI. */
  async closePullRequestForTest(key: string): Promise<void> {
    await this.runFlow(key, (pr, client, ui) => closePullRequestFlow({ pr, client, ui, logError: () => undefined }), autoConfirmUi('Close PR'));
  }

  private async reopenPullRequest(key: string): Promise<void> {
    await this.runFlow(key, (pr, client, ui) => reopenPullRequestFlow({
      pr, client, ui, logError: (m, e) => this.logger?.error(`Launchpad: ${m}`, e),
    }));
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the reopen flow with an auto-confirming UI. */
  async reopenPullRequestForTest(key: string): Promise<void> {
    await this.runFlow(key, (pr, client, ui) => reopenPullRequestFlow({ pr, client, ui, logError: () => undefined }), autoConfirmUi('Reopen PR'));
  }

  private async mergePullRequest(key: string): Promise<void> {
    await this.runFlow(key, (pr, client, ui) => mergePullRequestFlow({
      pr, client, ui, logError: (m, e) => this.logger?.error(`Launchpad: ${m}`, e),
    }));
  }

  /** Test-only introspection seam — the merge QuickPick and confirmation modal can't be driven from an integration test, so this calls the merge flow with a fixed strategy/delete choice. */
  async mergePullRequestForTest(key: string, strategy: MergeStrategy, deleteSourceBranch: boolean): Promise<void> {
    await this.runFlow(
      key,
      (pr, client, ui) => mergePullRequestFlow({ pr, client, ui, logError: () => undefined }),
      autoMergeUi(strategy, deleteSourceBranch),
    );
  }

  private async submitReview(key: string, decision: ReviewSubmission): Promise<void> {
    const resolved = this.resolveActionCtx(key);
    if (!resolved) return;
    const myLogin = this.loginByRepoKey.get(`${resolved.pr.repo.host}:${resolved.pr.repo.identity}`);
    const changed = await submitReviewFlow({ pr: resolved.pr, client: resolved.client, ui: vscodePullRequestActionUi, logError: (m, e) => this.logger?.error(`Launchpad: ${m}`, e), myLogin }, decision);
    if (changed) await this.refresh(false);
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the review flow with an auto-confirming UI. Now also exercises the self-review guard. */
  async submitReviewForTest(key: string, decision: ReviewSubmission): Promise<void> {
    const resolved = this.resolveActionCtx(key);
    if (!resolved) return;
    const myLogin = this.loginByRepoKey.get(`${resolved.pr.repo.host}:${resolved.pr.repo.identity}`);
    const verb = decision === 'approve' ? 'Approve' : 'Request changes on';
    const changed = await submitReviewFlow({ pr: resolved.pr, client: resolved.client, ui: autoConfirmUi(verb), logError: () => undefined, myLogin }, decision);
    if (changed) await this.refresh(false);
  }
}
