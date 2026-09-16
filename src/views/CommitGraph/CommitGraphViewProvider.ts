import * as vscode from 'vscode';
import { GitService } from '../../core/git/GitService';
import { layoutGraph } from '../../core/graph/layout';
import { renderGraphHtml } from './render';
import { renderPlaceholderHtml } from '../placeholder';
import { waitForWebviewView } from '../waitForWebviewView';
import { runInGitSyncTerminal } from '../gitSyncTerminal';
import { COMMANDS, CONFIG, MEDIA, VIEWS } from '../../constants';
import type { BlameSource } from '../../providers/BlameSource';
import { GitCommandError } from '../../core/git/errors';
import type { GraphCommit } from '../../core/git/types';

const DEFAULT_MAX_GRAPH_ITEMS = 200;

function errorMessage(err: unknown): string {
  return err instanceof GitCommandError ? err.stderr : err instanceof Error ? err.message : String(err);
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/**
 * Any path inside the repo will do — every `GitService` call resolves the repo root from it. The
 * active editor is preferred (correct repo in a multi-root workspace); when no editor is open, the
 * active terminal's cwd is tried next, so switching context by opening a terminal scoped to a repo
 * (rather than clicking a file in it) still resolves to that repo instead of silently falling
 * through to the first workspace folder. The first workspace folder remains the last resort so the
 * graph still opens when neither signal is available.
 */
export function resolveRepoContextPath(): string | undefined {
  return (
    vscode.window.activeTextEditor?.document.uri.fsPath ??
    activeTerminalCwd() ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
}

/** Shell integration's live cwd (tracks `cd`) wins when available; the terminal's launch-time cwd otherwise. */
function activeTerminalCwd(): string | undefined {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    return undefined;
  }
  const shellCwd = terminal.shellIntegration?.cwd;
  if (shellCwd) {
    return shellCwd.fsPath;
  }
  const cwd = 'cwd' in terminal.creationOptions ? terminal.creationOptions.cwd : undefined;
  if (!cwd) {
    return undefined;
  }
  return typeof cwd === 'string' ? cwd : cwd.fsPath;
}

export function readMaxGraphItems(): number {
  return vscode.workspace
    .getConfiguration(CONFIG.section)
    .get<number>(CONFIG.maxGraphItems, DEFAULT_MAX_GRAPH_ITEMS);
}

/** Docks the commit graph in the bottom panel (next to Terminal/Debug Console/Output), instead of taking over an editor tab. */
export class CommitGraphViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private currentFilePath: string | undefined;
  private currentRepoRoot: string | undefined;
  /** Ref the graph is scoped to; empty string means every ref (`--all`). */
  private currentRef = '';
  // True until the ref picker's dropdown is touched — while true, `currentRef` re-resolves to
  // whatever branch is actually checked out on every load, so a checkout from a terminal, another
  // tool, or the graph's own future actions keeps the graph following HEAD. An explicit dropdown
  // pick (including re-picking the same branch, or "All branches") turns this off for good.
  private refIsAutoTracking = true;
  private selectedSha: string | undefined;
  // The last load's commits, kept for the context menu's server-side lookups (e.g. "is this sha a
  // branch tip") — cheaper than round-tripping ref data through the DOM on every right-click.
  private currentCommits: GraphCommit[] = [];
  // The cap actually used by the last load — starts at `gitLore.maxGraphItems` and grows each
  // time "Load more" is clicked. A plain refresh (or the HEAD/refs auto-refresh) re-asks with
  // this same cap rather than snapping back to the configured default.
  private currentMaxCount = 0;
  // Guards against a superseded `load()` (e.g. a fast ref-picker change, or an auto-refresh
  // landing mid-flight) overwriting a newer one's rendered HTML with stale data once it resolves.
  private loadGeneration = 0;
  // Set by `loadMore()` right before re-asking, so `load()` knows how many rows were already on
  // screen and can animate in only the newly-revealed ones. Every other caller (initial open, ref
  // switch, refresh, HEAD-watcher auto-refresh) leaves this undefined for a full "first paint".
  private previousRowCount: number | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly blameSource: BlameSource,
  ) {
    // Reuses BlameSource's existing `.git/{HEAD,refs/**}` watcher rather than standing up a
    // second one — a pull, push, checkout, or merge (from this graph's own buttons, a terminal,
    // or any other tool) all show up here the same way blame invalidation already does.
    this.disposables.push(
      this.blameSource.onInvalidate((repoRoot) => {
        if (repoRoot === this.currentRepoRoot) {
          void this.reload();
        }
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.view?.webview.html;
  }

  private mediaUri(name: string): string {
    return this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    void this.loadForActiveEditor();
  }

  /** Called by the "Open Commit Graph" command — reveals the panel tab and (re)loads from the given file. */
  async show(filePath: string, maxCount: number): Promise<void> {
    await vscode.commands.executeCommand(`${VIEWS.commitGraph}.focus`);
    await waitForWebviewView(() => this.view);
    await this.load(filePath, maxCount);
  }

  private async loadForActiveEditor(): Promise<void> {
    const filePath = resolveRepoContextPath();
    if (!filePath) {
      return;
    }
    await this.load(filePath, readMaxGraphItems());
  }

  private async load(filePath: string, maxCount: number): Promise<void> {
    if (!this.view) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.currentFilePath = filePath;
    this.currentMaxCount = maxCount;
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.commitGraph)];
    this.view.webview.html = renderPlaceholderHtml('Loading commit graph…', {
      nonce: createNonce(),
      cspSource: this.view.webview.cspSource,
      styleUris,
      variant: 'loading',
    });

    try {
      const repoRoot = await this.git.getRepoRoot(filePath);
      this.currentRepoRoot = repoRoot ?? undefined;
      if (repoRoot) {
        this.blameSource.watchHeadFor(repoRoot);
      }

      if (this.refIsAutoTracking) {
        // Detached HEAD or an empty repo leaves this null — falls back to "all branches" rather
        // than scoping to a branch that doesn't exist.
        this.currentRef = (await this.git.getCurrentBranch(filePath)) ?? '';
      }

      // One round of parallel git calls, not a waterfall — the graph log dominates, so the
      // branch list and working-tree status ride alongside it for free.
      const [commits, branches, workingChanges, stashes] = await Promise.all([
        this.git.getGraphCommits(filePath, maxCount, this.currentRef || undefined),
        this.git.getBranches(filePath),
        this.git.getWorkingChanges(filePath),
        this.git.getStashes(filePath),
      ]);
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      this.currentCommits = commits;
      const nodes = layoutGraph(commits);
      // A signal, not a guarantee: `git log -n <cap>` can't distinguish "exactly cap commits
      // total" from "more than cap". "Load more" re-asking with a higher cap resolves either way.
      const hasMore = commits.length > 0 && commits.length === maxCount;
      this.view.webview.html = renderGraphHtml(
        {
          nodes,
          branches,
          workingChanges,
          stashes,
          currentRef: this.currentRef,
          selectedSha: this.selectedSha,
          hasMore,
          newRowsFrom: this.previousRowCount,
        },
        {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
        },
      );
      this.previousRowCount = undefined;
    } catch (err) {
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.html = renderPlaceholderHtml(`GitLore: failed to load the commit graph — ${message}`, {
        nonce: createNonce(),
        cspSource: this.view.webview.cspSource,
        styleUris,
        variant: 'error',
      });
    }
  }

  /** Called by the "Load more commits" button — re-asks with a higher cap, same file and ref. */
  async loadMore(): Promise<void> {
    if (!this.currentFilePath) {
      return;
    }
    this.previousRowCount = this.currentCommits.length;
    await this.load(this.currentFilePath, this.currentMaxCount + readMaxGraphItems());
  }

  /** Re-asks with whatever cap is currently in effect — preserves a "Load more" expansion instead of snapping back to the configured default. */
  private async reload(): Promise<void> {
    const filePath = this.currentFilePath ?? resolveRepoContextPath();
    if (filePath) {
      await this.load(filePath, this.currentMaxCount || readMaxGraphItems());
    }
  }

  /** Test-only introspection seam — a right-click + menu-item click can't be simulated in an integration test. */
  async handleCommitActionForTest(action: string, sha: string): Promise<void> {
    await this.handleCommitAction(action, sha);
  }

  private async handleCommitAction(action: string, sha: string): Promise<void> {
    const filePath = this.currentFilePath;
    const repoRoot = this.currentRepoRoot;
    if (!filePath || !repoRoot) {
      return;
    }

    if (action === 'copySha') {
      await vscode.commands.executeCommand(COMMANDS.copySha, sha);
      return;
    }

    if (action === 'checkout') {
      const commit = this.currentCommits.find((c) => c.sha === sha);
      const branchRef = commit?.refs.find((r) => r.type === 'branch');
      const target = branchRef?.name ?? sha;
      if (!branchRef) {
        const confirmed = await vscode.window.showWarningMessage(
          `Checkout commit ${sha.slice(0, 7)}? This detaches HEAD — you won't be on a branch.`,
          { modal: true },
          'Checkout',
        );
        if (confirmed !== 'Checkout') {
          return;
        }
      }
      try {
        await this.git.checkoutBranch(filePath, target);
      } catch (err) {
        void vscode.window.showErrorMessage(`GitLore: couldn't checkout — ${errorMessage(err)}`);
      }
      return;
    }

    if (action === 'reset') {
      const modes = [
        { label: 'Soft', description: 'Keep changes staged', mode: 'soft' as const },
        { label: 'Mixed', description: 'Keep changes, unstaged', mode: 'mixed' as const },
        { label: 'Hard', description: "Discard all changes — can't be undone", mode: 'hard' as const },
      ];
      const picked = await vscode.window.showQuickPick(modes, { placeHolder: 'How should the branch be reset to this commit?' });
      if (!picked) {
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        picked.mode === 'hard'
          ? `Hard reset the current branch to ${sha.slice(0, 7)}? This discards uncommitted changes and can't be undone.`
          : `Reset the current branch to ${sha.slice(0, 7)} (--${picked.mode})?`,
        { modal: true },
        'Reset',
      );
      if (confirmed !== 'Reset') {
        return;
      }
      try {
        await this.git.resetTo(filePath, sha, picked.mode);
      } catch (err) {
        void vscode.window.showErrorMessage(`GitLore: couldn't reset — ${errorMessage(err)}`);
      }
      return;
    }

    if (action === 'revert') {
      const confirmed = await vscode.window.showWarningMessage(
        `Revert commit ${sha.slice(0, 7)}? A conflict, if there is one, opens in the terminal for you to resolve.`,
        { modal: true },
        'Revert',
      );
      if (confirmed !== 'Revert') {
        return;
      }
      runInGitSyncTerminal(repoRoot, `git revert ${sha}`);
      return;
    }

    if (action === 'cherryPick') {
      const confirmed = await vscode.window.showWarningMessage(
        `Cherry-pick commit ${sha.slice(0, 7)} onto the current branch? A conflict, if there is one, opens in the terminal for you to resolve.`,
        { modal: true },
        'Cherry-pick',
      );
      if (confirmed !== 'Cherry-pick') {
        return;
      }
      runInGitSyncTerminal(repoRoot, `git cherry-pick ${sha}`);
      return;
    }

    if (action === 'createBranch') {
      const name = await vscode.window.showInputBox({ prompt: 'New branch name', placeHolder: 'feature/my-branch' });
      if (!name) {
        return;
      }
      try {
        await this.git.createBranch(filePath, name, sha);
      } catch (err) {
        void vscode.window.showErrorMessage(`GitLore: couldn't create branch — ${errorMessage(err)}`);
      }
      return;
    }

    if (action === 'tag') {
      const name = await vscode.window.showInputBox({ prompt: 'New tag name', placeHolder: 'v1.2.0' });
      if (!name) {
        return;
      }
      try {
        await this.git.createTag(filePath, name, sha);
      } catch (err) {
        void vscode.window.showErrorMessage(`GitLore: couldn't create tag — ${errorMessage(err)}`);
      }
      return;
    }
  }

  /** Test-only introspection seam — a stash chip's click-then-QuickPick can't be simulated in an integration test. */
  async handleStashActionForTest(action: 'apply' | 'drop', index: number): Promise<void> {
    await this.handleStashAction(action, index);
  }

  private async handleStashAction(action: 'apply' | 'drop', index: number): Promise<void> {
    const filePath = this.currentFilePath;
    if (!filePath) {
      return;
    }
    if (action === 'apply') {
      try {
        await this.git.applyStash(filePath, index);
        await this.reload();
      } catch (err) {
        void vscode.window.showErrorMessage(`GitLore: couldn't apply stash — ${errorMessage(err)}`);
      }
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(`Delete stash@{${index}}? This can't be undone.`, { modal: true }, 'Delete');
    if (confirmed !== 'Delete') {
      return;
    }
    try {
      await this.git.dropStash(filePath, index);
      await this.reload();
    } catch (err) {
      void vscode.window.showErrorMessage(`GitLore: couldn't drop stash — ${errorMessage(err)}`);
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { type, sha, ref, action, index } = message as {
      type?: unknown;
      sha?: unknown;
      ref?: unknown;
      action?: unknown;
      index?: unknown;
    };

    if (type === 'commitAction' && typeof action === 'string' && typeof sha === 'string') {
      await this.handleCommitAction(action, sha);
      return;
    }

    if (type === 'stashClick' && typeof index === 'number') {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Apply Stash', action: 'apply' as const },
          { label: 'Delete Stash', action: 'drop' as const },
        ],
        { placeHolder: `stash@{${index}}` },
      );
      if (picked) {
        await this.handleStashAction(picked.action, index);
      }
      return;
    }

    if (type === 'openCommit' && typeof sha === 'string' && this.currentFilePath) {
      // Remembered so a later refresh re-renders with the same row still selected.
      this.selectedSha = sha;
      await vscode.commands.executeCommand(COMMANDS.showCommit, this.currentFilePath, sha);
      return;
    }
    if (type === 'openWorkingChanges') {
      // Staging, stashing and committing already have a first-class home in VS Code — hand off
      // rather than rebuilding the SCM view inside a webview.
      await vscode.commands.executeCommand('workbench.view.scm');
      return;
    }
    if (type === 'setRef' && typeof ref === 'string') {
      this.refIsAutoTracking = false;
      this.currentRef = ref;
      // A different scope is a fresh view — starts back at the configured cap rather than
      // carrying over a "Load more" expansion made under the previous ref.
      this.currentMaxCount = readMaxGraphItems();
      await this.reload();
      return;
    }
    if (type === 'refresh') {
      await this.reload();
      return;
    }
    if (type === 'loadMore') {
      await this.loadMore();
      return;
    }
    if ((type === 'pull' || type === 'push' || type === 'fetch') && this.currentRepoRoot) {
      // Runs in a real terminal, not via simple-git — pull/push can need interactive auth (an SSH
      // passphrase, a credential-manager prompt) or land a merge conflict on pull, and a terminal
      // is where the user can actually see and handle either. The graph doesn't need its own
      // "did it finish" tracking either: the HEAD/refs watcher wired in the constructor picks up
      // the result the moment the command actually changes something.
      const command = type === 'pull' ? 'git pull' : type === 'push' ? 'git push' : 'git fetch';
      runInGitSyncTerminal(this.currentRepoRoot, command);
    }
  }
}
