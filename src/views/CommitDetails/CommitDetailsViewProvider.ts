import * as vscode from 'vscode';
import { GitService } from '../../core/git/GitService';
import { renderCommitDetailsHtml, type RemoteTarget } from './render';
import { resolveRepoContextPath } from '../CommitGraph/CommitGraphViewProvider';
import { resolveIssueLinking } from '../../providers/issueLinking';
import { openFileDiff } from '../../providers/GitContentProvider';
import { buildCommitUrl, remoteHostLabel } from '../../utils/remoteLinks';
import { renderPlaceholderHtml } from '../placeholder';
import { waitForWebviewView } from '../waitForWebviewView';
import { LruCache } from '../../core/cache/LruCache';
import type { LanguageModelClient } from '../../ai/LanguageModelClient';
import type { GitLogger } from '../../core/git/errors';
import { runCommitSummaryFlow } from '../../core/ai/commitSummaryFlow';
import { buildCommitSummaryPrompt } from '../../core/ai/prompts';
import { describeNoModelReason } from '../../core/ai/modelAvailability';
import { COMMANDS, CONFIG, MEDIA, VIEWS } from '../../constants';
import type { CommitDetail } from '../../core/git/types';

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

/** Docks commit details in the bottom panel (next to Commit Graph), instead of opening a new editor tab per commit. */
export class CommitDetailsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private currentFilePath: string | undefined;
  private currentCommit: CommitDetail | undefined;
  private currentRemoteUrl: string | undefined;
  private currentDiff: string | undefined;
  private aiSummaryCache = new LruCache<string, string>(50);
  private aiAbortController: AbortController | undefined;
  private aiMessagesForTest: unknown[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
    private readonly languageModelClient: LanguageModelClient,
    private readonly logger: GitLogger,
  ) {}

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.view?.webview.html;
  }

  /** Test-only introspection seam, same spirit as `getCurrentHtmlForTest()` — the AI summary's state lives in postMessage traffic, not in the static webview HTML, so there's nothing else to assert against. */
  getAiSummaryMessagesForTest(): unknown[] {
    return this.aiMessagesForTest;
  }

  hasLoadedCommit(): boolean {
    return this.currentCommit !== undefined;
  }

  /** A short label for the chat's subject chip, e.g. when opened via "Ask about this commit". */
  getCurrentSubjectForChat(): string | undefined {
    return this.currentCommit ? `commit ${this.currentCommit.shortSha}` : undefined;
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
    // The view resolves the moment its tab is revealed, which is usually before any commit has
    // been picked explicitly — shows the repo's most recent commit instead of an empty rectangle,
    // the same "useful without running a command first" convention Commit Graph already follows.
    // Falls back to the placeholder only when there's no file/workspace to resolve a repo from.
    // Skipped entirely if `show()` already claimed a target (`currentFilePath`, set before
    // `.focus()` for exactly this reason) — that explicit request must win, not race this default.
    if (this.currentCommit || this.currentFilePath) {
      return;
    }
    const filePath = resolveRepoContextPath();
    if (!filePath) {
      webviewView.webview.html = renderPlaceholderHtml('Select a commit in the Commit Graph to see its details.', {
        nonce: createNonce(),
        cspSource: webviewView.webview.cspSource,
        styleUris: [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.commitDetails)],
      });
      return;
    }
    void this.load(filePath, 'HEAD');
  }

  /**
   * Called by the "Show Commit Details" command — reveals the panel tab and loads the given
   * commit. Claims `currentFilePath` *before* `.focus()`, not after: focusing the panel for the
   * first time in a session synchronously triggers `resolveWebviewView`, which would otherwise see
   * no commit requested yet and auto-load HEAD, racing this call's own explicit load.
   */
  async show(filePath: string, sha: string): Promise<void> {
    this.currentFilePath = filePath;
    await vscode.commands.executeCommand(`${VIEWS.commitDetails}.focus`);
    await waitForWebviewView(() => this.view);
    await this.load(filePath, sha);
  }

  private mediaUri(name: string): string {
    return this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  private async load(filePath: string, sha: string): Promise<void> {
    if (!this.view) {
      return;
    }
    this.currentFilePath = filePath;
    this.aiAbortController?.abort();
    this.aiMessagesForTest = [];
    this.view.title = `Commit ${sha.slice(0, 7)}`;
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.commitDetails)];
    this.view.webview.html = renderPlaceholderHtml('Loading commit…', {
      nonce: createNonce(),
      cspSource: this.view.webview.cspSource,
      styleUris,
      variant: 'loading',
    });

    try {
      const [commit, files, diff, issueLinking, remoteInfo] = await Promise.all([
        this.git.getCommit(filePath, sha),
        this.git.getCommitFiles(filePath, sha),
        this.git.getCommitDiff(filePath, sha),
        resolveIssueLinking(this.git, filePath),
        this.git.resolveRemoteInfo(filePath),
      ]);
      if (!commit) {
        this.view.webview.html = renderPlaceholderHtml('GitLore: commit not found.', {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
          variant: 'error',
        });
        return;
      }
      this.currentCommit = commit;
      this.currentDiff = diff;
      // The initial title above used the caller's own sha argument, which is 'HEAD' (not a real
      // short sha) for the auto-loaded-on-reveal case — replace it now that the commit's resolved.
      this.view.title = `Commit ${commit.shortSha}`;

      // Only offer "Open on <host>" when we know that host's commit-URL shape — a button that
      // reliably 404s is worse than no button.
      const url = remoteInfo ? buildCommitUrl(remoteInfo, commit.sha) : null;
      const remote: RemoteTarget | null = remoteInfo && url ? { label: remoteHostLabel(remoteInfo), url } : null;
      this.currentRemoteUrl = url ?? undefined;

      const editorFontFamily = vscode.workspace
        .getConfiguration('editor')
        .get<string>('fontFamily', 'Menlo, Monaco, monospace');

      this.view.webview.html = renderCommitDetailsHtml(
        { commit, files, diff },
        {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
          editorFontFamily,
          issueLinking,
          remote,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.html = renderPlaceholderHtml(`GitLore: failed to load commit — ${message}`, {
        nonce: createNonce(),
        cspSource: this.view.webview.cspSource,
        styleUris,
        variant: 'error',
      });
    }
  }

  async explainCommit(): Promise<void> {
    if (!this.view || !this.currentCommit || !this.currentFilePath) {
      return;
    }
    this.aiAbortController?.abort();
    const controller = new AbortController();
    this.aiAbortController = controller;

    const commit = this.currentCommit;
    const diff = this.currentDiff ?? '';
    const filePath = this.currentFilePath;
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.aiEnabled, false);
    const modelFamily = config.get<string>(CONFIG.aiModelFamily, 'gpt-4o');
    const maxDiffChars = config.get<number>(CONFIG.aiMaxDiffChars, 8000);

    const repoRoot = await this.git.getRepoRoot(filePath);
    const cacheKey = `${repoRoot ?? filePath}:${commit.sha}`;
    const cached = this.aiSummaryCache.get(cacheKey);

    const flow = runCommitSummaryFlow({
      enabled,
      cached,
      signal: controller.signal,
      selectModel: () => this.languageModelClient.selectModel(modelFamily),
      buildPrompt: () => buildCommitSummaryPrompt(commit, diff, maxDiffChars),
    });

    for await (const event of flow) {
      if (controller.signal.aborted) {
        return;
      }
      switch (event.type) {
        case 'disabled':
          void vscode.window.showInformationMessage('GitLore: AI features are disabled.', 'Open Settings').then((choice) => {
            if (choice) {
              void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG.section}.${CONFIG.aiEnabled}`);
            }
          });
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
          this.logger.error('AI commit summary failed', event.message);
          this.postAiMessage({ type: 'aiSummaryError', message: event.message });
          break;
      }
    }
  }

  private postAiMessage(message: { type: string; text?: string; message?: string }): void {
    this.aiMessagesForTest.push(message);
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const { type, path } = message as { type?: unknown; path?: unknown };
    const commit = this.currentCommit;

    if (type === 'copySha' && commit) {
      await vscode.commands.executeCommand(COMMANDS.copySha, commit.sha);
      return;
    }
    if (type === 'copyMessage' && commit) {
      await vscode.env.clipboard.writeText(commit.body);
      void vscode.window.setStatusBarMessage('GitLore: commit message copied', 2000);
      return;
    }
    if (type === 'openRemote' && this.currentRemoteUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(this.currentRemoteUrl));
      return;
    }
    if (type === 'explainCommit') {
      await this.explainCommit();
      return;
    }
    if (type === 'openFileDiff' && typeof path === 'string' && commit && this.currentFilePath) {
      // `<sha>^` doesn't resolve for a root commit; GitService returns an empty left-hand side
      // for that, which is exactly right — every line reads as added.
      await openFileDiff({
        repoPath: this.currentFilePath,
        path,
        beforeRef: `${commit.sha}^`,
        afterRef: commit.sha,
        label: commit.shortSha,
      });
    }
  }
}
