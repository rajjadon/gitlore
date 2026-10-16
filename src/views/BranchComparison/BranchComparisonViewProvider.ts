import * as vscode from 'vscode';
import { GitService } from '../../core/git/GitService';
import type { GitLogger } from '../../core/git/errors';
import { parseRemoteUrl } from '../../core/git/parsers';
import { renderBranchComparisonHtml, type PrTarget } from './render';
import { openFileDiff } from '../../providers/GitContentProvider';
import { renderPlaceholderHtml } from '../placeholder';
import { waitForWebviewView } from '../waitForWebviewView';
import { COMMANDS, CONFIG, MEDIA, VIEWS } from '../../constants';
import { describeNoModelReason } from '../../core/ai/modelAvailability';
import { buildForgeClient } from '../../core/forge/buildForgeClient';
import { detectForgeHost, type DetectedForgeHost, type ForgeHostConfig } from '../../core/forge/hostDetection';
import { resolveForgeRepoRef } from '../../core/forge/resolveRepoRef';
import { DRAFT_SUPPORTED_HOSTS, type ForgeRepoRef } from '../../core/forge/types';
import { azureDevOpsCredentialScheme, resolveForgeToken } from '../../providers/forgeCredentials';
import { remoteHostLabel } from '../../utils/remoteLinks';
import type { FileChange, RemoteInfo } from '../../core/git/types';
import { LruCache } from '../../core/cache/LruCache';
import type { LanguageModelClient } from '../../ai/LanguageModelClient';
import { runCommitSummaryFlow } from '../../core/ai/commitSummaryFlow';
import { buildBranchCompareSummaryPrompt } from '../../core/ai/prompts';
import { createNonce } from '../nonce';
import { showAiDisabledNotice } from '../../ai/showAiDisabledNotice';

/** Above this, "Open all changes" confirms first — opening dozens of diff editors in one click is more likely a misclick than the intent. */
const OPEN_ALL_CONFIRM_THRESHOLD = 20;

/** Docks branch comparison in the bottom panel (next to Commit Graph/Commit Details), instead of opening a new editor tab per comparison. */
export class BranchComparisonViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private currentFilePath: string | undefined;
  private currentBase: string | undefined;
  private currentCompare: string | undefined;
  private currentFiles: FileChange[] = [];
  /** Resolved alongside every comparison, purely from local git/URL parsing — no network call. `remoteInfo` is kept alongside `repo`/`detected` only for `remoteHostLabel`'s nicer cosmetic host name ("GitHub", not "github.com"); `detected`/`repo` are what actually drive host resolution (and, unlike `remoteHostLabel`'s host sniffing, already cover Azure DevOps). */
  private currentForgeInfo: { repo: ForgeRepoRef; detected: DetectedForgeHost; remoteInfo: RemoteInfo } | undefined;
  // Guards against a superseded `load()` (e.g. a fast ref-picker change) overwriting a newer
  // one's rendered HTML with stale data once it resolves — same idiom as CommitGraphViewProvider.
  private loadGeneration = 0;
  private aiSummaryCache = new LruCache<string, string>(50);
  private aiAbortController: AbortController | undefined;
  private aiMessagesForTest: unknown[] = [];

  /** Overridable only for tests — a real network call has no place in an automated suite. Defaults to the real global `fetch`. */
  private fetchImpl: typeof fetch;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitService,
    private readonly languageModelClient: LanguageModelClient,
    private readonly logger?: GitLogger,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  /** Test-only injection seam, since the extension host constructs one long-lived instance with the real `fetch` — a test needs to swap it after the fact, not at construction. */
  setFetchImplForTest(fetchImpl: typeof fetch): void {
    this.fetchImpl = fetchImpl;
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.view?.webview.html;
  }

  getAiSummaryMessagesForTest(): unknown[] {
    return this.aiMessagesForTest;
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
    // The view resolves the moment its tab is revealed, which can happen before "Compare Branches"
    // has ever been run — say what to do instead of showing an empty rectangle. Stays closed until
    // that command actually runs, rather than guessing a default comparison to show.
    if (!this.currentBase) {
      webviewView.webview.html = renderPlaceholderHtml('Compare two branches to see their diff here.', {
        nonce: createNonce(),
        cspSource: webviewView.webview.cspSource,
        styleUris: [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.branchComparison)],
      });
    }
  }

  /**
   * Called by the "Compare Branches" command — reveals the panel tab and loads the given
   * comparison. Claims `currentBase`/`currentCompare` *before* `.focus()`, not after: focusing the
   * panel for the first time in a session synchronously triggers `resolveWebviewView`, which would
   * otherwise see no comparison claimed yet and flash the placeholder for a moment before `load()`
   * replaces it.
   */
  async show(filePath: string, base: string, compare: string): Promise<void> {
    this.currentBase = base;
    this.currentCompare = compare;
    await vscode.commands.executeCommand(`${VIEWS.branchComparison}.focus`);
    await waitForWebviewView(() => this.view);
    await this.load(filePath, base, compare);
  }

  private mediaUri(name: string): string {
    return this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  private async load(filePath: string, base: string, compare: string): Promise<void> {
    if (!this.view) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.currentFilePath = filePath;
    this.currentBase = base;
    this.currentCompare = compare;
    this.aiAbortController?.abort();
    this.aiMessagesForTest = [];
    this.view.title = `${base}...${compare}`;
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.branchComparison)];
    this.view.webview.html = renderPlaceholderHtml('Loading comparison…', {
      nonce: createNonce(),
      cspSource: this.view.webview.cspSource,
      styleUris,
      variant: 'loading',
    });

    try {
      const [aheadCommits, behindCommits, files, diff, branches] = await Promise.all([
        this.git.getCommitsBetween(filePath, base, compare),
        this.git.getCommitsBetween(filePath, compare, base),
        this.git.getFilesBetweenRefs(filePath, base, compare),
        this.git.getDiffBetweenRefs(filePath, base, compare),
        this.git.getBranches(filePath),
      ]);
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      this.currentFiles = files;

      // Resolving which host this repo is on is pure local parsing — no network call — so the
      // button shows whenever a host is recognized, same as before. The actual network call
      // (creating the PR) is what's gated behind `gitLore.launchpad.enabled`, in
      // `createPullRequestFlow` — the button stays visible either way, and explains itself if
      // clicked while that's off, rather than disappearing with no explanation.
      this.currentForgeInfo = (await this.resolveForgeInfo(filePath)) ?? undefined;
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      const createPr: PrTarget | null = this.currentForgeInfo ? { label: remoteHostLabel(this.currentForgeInfo.remoteInfo) } : null;

      const editorFontFamily = vscode.workspace
        .getConfiguration('editor')
        .get<string>('fontFamily', 'Menlo, Monaco, monospace');

      this.view.webview.html = renderBranchComparisonHtml(
        { base, compare, aheadCommits, behindCommits, files, diff, branches },
        {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
          editorFontFamily,
          createPr,
        },
      );
    } catch (err) {
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.html = renderPlaceholderHtml(`GitLore: failed to load the comparison — ${message}`, {
        nonce: createNonce(),
        cspSource: this.view.webview.cspSource,
        styleUris,
        variant: 'error',
      });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { type, sha, base, compare, path } = message as {
      type?: unknown;
      sha?: unknown;
      base?: unknown;
      compare?: unknown;
      path?: unknown;
    };
    const filePath = this.currentFilePath;

    if (type === 'openCommit' && typeof sha === 'string' && filePath) {
      await vscode.commands.executeCommand(COMMANDS.showCommit, filePath, sha);
      return;
    }
    if (type === 'setRefs' && typeof base === 'string' && typeof compare === 'string' && filePath) {
      await this.load(filePath, base, compare);
      return;
    }
    if (type === 'refresh' && filePath && this.currentBase && this.currentCompare) {
      await this.load(filePath, this.currentBase, this.currentCompare);
      return;
    }
    if (type === 'openFileDiff' && typeof path === 'string' && filePath && this.currentBase && this.currentCompare) {
      // Diff against the merge base, not against `base` itself, so the editor agrees with the
      // `base...compare` diff rendered inline — on diverged branches those differ.
      const mergeBase = await this.git.getMergeBase(filePath, this.currentBase, this.currentCompare);
      await openFileDiff({
        repoPath: filePath,
        path,
        beforeRef: mergeBase ?? this.currentBase,
        afterRef: this.currentCompare,
        label: `${this.currentBase}...${this.currentCompare}`,
      });
      return;
    }
    if (type === 'createPr') {
      await this.createPullRequestFlow();
      return;
    }
    if (type === 'openAllChanges' && filePath && this.currentBase && this.currentCompare) {
      await this.openAllChanges(filePath, this.currentBase, this.currentCompare);
      return;
    }
    if (type === 'summarizeComparison') {
      await this.summarizeComparison();
      return;
    }
  }

  /** This repo's remote, resolved to a forge repo — single repo, single remote (prefers `origin`), unlike Launchpad's multi-repo scan. Pure local parsing, no network call. */
  private async resolveForgeInfo(filePath: string): Promise<{ repo: ForgeRepoRef; detected: DetectedForgeHost; remoteInfo: RemoteInfo } | null> {
    const repoRoot = await this.git.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    const remotes = await this.git.getRemotes(repoRoot);
    const remote = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    if (!remote) {
      return null;
    }
    const remoteInfo = parseRemoteUrl(remote.url);
    if (!remoteInfo) {
      return null;
    }
    const customHosts = vscode.workspace.getConfiguration(CONFIG.section).get<ForgeHostConfig[]>(CONFIG.launchpadCustomHosts, []);
    const detected = detectForgeHost(remoteInfo.host, customHosts);
    if (!detected) {
      return null;
    }
    const repo = resolveForgeRepoRef(remote.url, customHosts);
    if (!repo) {
      return null;
    }
    return { repo, detected, remoteInfo };
  }

  /**
   * Prompts for a title (required) and, on a host that supports it, whether to create as a draft —
   * then calls the host's API directly. No pre-flight check that `compare` has actually been
   * pushed; a host rejection (e.g. "no commits between these branches") surfaces as-is, same
   * philosophy as every other write action in GitLore's forge layer.
   */
  private async createPullRequestFlow(): Promise<void> {
    if (!this.currentBase || !this.currentCompare || !this.currentForgeInfo) {
      return;
    }
    // The button itself doesn't check this (resolving the host is pure local parsing, not a
    // network call — see `currentForgeInfo`'s own comment), so this is where GitLore's "one toggle
    // gates every remote-host call" contract actually gets enforced for Create PR.
    const launchpadEnabled = vscode.workspace.getConfiguration(CONFIG.section).get<boolean>(CONFIG.launchpadEnabled, false);
    if (!launchpadEnabled) {
      void vscode.window.showInformationMessage('GitLore: enable gitLore.launchpad.enabled to create pull requests from GitLore.');
      return;
    }
    const { repo, detected } = this.currentForgeInfo;
    const token = await resolveForgeToken(this.context.secrets, detected);
    if (!token) {
      return;
    }

    const title = await vscode.window.showInputBox({
      title: `GitLore: New Pull Request on ${detected.displayHost}`,
      prompt: `${this.currentCompare} into ${this.currentBase}`,
      placeHolder: 'Pull request title',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === '' ? 'A title is required.' : undefined),
    });
    if (!title) {
      return;
    }

    let draft = false;
    if (DRAFT_SUPPORTED_HOSTS.has(repo.host)) {
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'Create Pull Request', draft: false },
          { label: 'Create as Draft', draft: true },
        ],
        { placeHolder: 'How should this be created?' },
      );
      if (!picked) {
        return;
      }
      draft = picked.draft;
    }

    const client = buildForgeClient(detected.flavor, detected.apiBaseUrl, repo.identity, token, azureDevOpsCredentialScheme(detected), this.fetchImpl);
    try {
      const pr = await client.createPullRequest(repo, { title, base: this.currentBase, compare: this.currentCompare, draft });
      const action = await vscode.window.showInformationMessage(`GitLore: created "${pr.title}" (#${pr.number}) on ${repo.label}.`, 'Open in Browser');
      if (action === 'Open in Browser') {
        await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`Branch Comparison failed to create a PR on ${repo.label}`, err);
      void vscode.window.showErrorMessage(`GitLore: couldn't create the pull request — ${message}`);
    }
  }

  /** Test-only introspection seam — a webview button click, the real title/draft prompts, and their inputs can't be driven from an integration test, so this calls the create flow directly with a fixed title/draft choice, skipping every prompt. Still honors the `gitLore.launchpad.enabled` gate, same as the real flow — it's a business rule, not just a prompt to skip. */
  async createPullRequestForTest(title: string, draft: boolean): Promise<void> {
    if (!this.currentBase || !this.currentCompare || !this.currentForgeInfo) {
      return;
    }
    const launchpadEnabled = vscode.workspace.getConfiguration(CONFIG.section).get<boolean>(CONFIG.launchpadEnabled, false);
    if (!launchpadEnabled) {
      return;
    }
    const { repo, detected } = this.currentForgeInfo;
    const token = await resolveForgeToken(this.context.secrets, detected);
    if (!token) {
      return;
    }
    const client = buildForgeClient(detected.flavor, detected.apiBaseUrl, repo.identity, token, azureDevOpsCredentialScheme(detected), this.fetchImpl);
    await client.createPullRequest(repo, { title, base: this.currentBase, compare: this.currentCompare, draft });
  }

  async summarizeComparison(): Promise<void> {
    if (!this.view || !this.currentFilePath || !this.currentBase || !this.currentCompare) {
      return;
    }
    this.aiAbortController?.abort();
    const controller = new AbortController();
    this.aiAbortController = controller;

    const filePath = this.currentFilePath;
    const base = this.currentBase;
    const compare = this.currentCompare;
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.aiEnabled, false);
    const modelFamily = config.get<string>(CONFIG.aiModelFamily, 'gpt-4o');
    const maxDiffChars = config.get<number>(CONFIG.aiMaxDiffChars, 8000);

    const repoRoot = await this.git.getRepoRoot(filePath);
    const cacheKey = `${repoRoot ?? filePath}:${base}...${compare}`;
    const cached = this.aiSummaryCache.get(cacheKey);

    // Same guard as PullRequestDetailsViewProvider.explainPr(): `enabled` must be checked before
    // any git call, not just before the model call. runCommitSummaryFlow's own 'disabled' branch
    // fires too late to stop the diff fetch below — a real `git diff` subprocess spawn — from
    // running on every disabled-AI click.
    const diff = enabled && cached === undefined ? await this.git.getDiffBetweenRefs(filePath, base, compare) : '';

    const flow = runCommitSummaryFlow({
      enabled,
      cached,
      signal: controller.signal,
      selectModel: () => this.languageModelClient.selectModel(modelFamily),
      buildPrompt: () => buildBranchCompareSummaryPrompt(base, compare, diff, maxDiffChars),
    });

    for await (const event of flow) {
      if (controller.signal.aborted) {
        return;
      }
      switch (event.type) {
        case 'disabled':
          void showAiDisabledNotice();
          this.postAiMessage({ type: 'aiSummaryReset' });
          break;
        case 'cached':
          this.postAiMessage({ type: 'aiSummaryCached', text: event.text });
          break;
        case 'noModel':
          this.postAiMessage({ type: 'aiSummaryNoModel', message: describeNoModelReason(vscode.env.appName) });
          break;
        case 'chunk':
          this.postAiMessage({ type: 'aiSummaryChunk', text: event.text });
          break;
        case 'done':
          this.aiSummaryCache.set(cacheKey, event.text);
          this.postAiMessage({ type: 'aiSummaryDone' });
          break;
        case 'error':
          this.logger?.error('AI branch comparison summary failed', event.message);
          this.postAiMessage({ type: 'aiSummaryError', message: event.message });
          break;
      }
    }
  }

  private postAiMessage(message: { type: string; text?: string; message?: string }): void {
    this.aiMessagesForTest.push(message);
    void this.view?.webview.postMessage(message);
  }

  private async openAllChanges(filePath: string, base: string, compare: string): Promise<void> {
    const files = this.currentFiles.filter((f) => !f.binary);
    if (files.length === 0) {
      return;
    }
    if (files.length > OPEN_ALL_CONFIRM_THRESHOLD) {
      const confirmed = await vscode.window.showWarningMessage(
        `Open ${files.length} diff editors? This opens one tab per changed file.`,
        { modal: true },
        'Open All',
      );
      if (confirmed !== 'Open All') {
        return;
      }
    }
    // Same merge-base rule as a single "Open changes" click — diffs against `base` itself would
    // also surface base's own commits as differences on diverged branches.
    const mergeBase = await this.git.getMergeBase(filePath, base, compare);
    for (const file of files) {
      await openFileDiff({
        repoPath: filePath,
        path: file.path,
        beforeRef: mergeBase ?? base,
        afterRef: compare,
        label: `${base}...${compare}`,
      });
    }
  }
}
