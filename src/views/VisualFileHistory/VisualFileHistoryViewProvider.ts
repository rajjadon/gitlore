import * as vscode from 'vscode';
import { GitService } from '../../core/git/GitService';
import { layoutFileHistory } from '../../core/graph/fileHistoryLayout';
import { renderFileHistoryHtml } from './render';
import { renderPlaceholderHtml } from '../placeholder';
import { waitForWebviewView } from '../waitForWebviewView';
import { COMMANDS, CONFIG, MEDIA, VIEWS } from '../../constants';
import { createNonce } from '../nonce';

const DEFAULT_MAX_HISTORY_ITEMS = 200;

/** Docks the Visual File History bubble timeline in the bottom panel, alongside Commit Graph/Details/Branch Comparison. */
export class VisualFileHistoryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private currentFilePath: string | undefined;
  private tracking = false;
  // Guards against a superseded load (rapid tab-switching) overwriting the panel with a stale
  // file's history once an earlier lookup resolves after a later one — same technique
  // FileHistoryProvider.loadForPath already uses for the same race.
  private loadGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly git: GitService,
  ) {}

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
    if (!this.currentFilePath) {
      webviewView.webview.html = renderPlaceholderHtml('Open a tracked file to see its Visual File History.', {
        nonce: createNonce(),
        cspSource: webviewView.webview.cspSource,
        styleUris: [this.mediaUri(MEDIA.shared)],
      });
    }
  }

  /** Called by the "Show Visual File History" command — reveals the panel tab, (re)loads from the given file, and starts following the active editor from then on (same pattern as FileHistoryProvider.show). */
  async show(filePath: string, maxCount: number): Promise<void> {
    await vscode.commands.executeCommand(`${VIEWS.visualFileHistory}.focus`);
    await waitForWebviewView(() => this.view);
    if (!this.tracking) {
      this.tracking = true;
      this.disposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
          void this.loadForEditor(editor);
        }),
      );
    }
    await this.load(filePath, maxCount);
  }

  /** Reacts to an editor switch once auto-follow is active — a no-op while the panel tab isn't visible, so flipping through unrelated tabs doesn't spawn a `git log` nobody's looking at. */
  private async loadForEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!this.view?.visible || !editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    const maxCount = vscode.workspace.getConfiguration(CONFIG.section).get<number>(CONFIG.maxHistoryItems, DEFAULT_MAX_HISTORY_ITEMS);
    await this.load(editor.document.uri.fsPath, maxCount);
  }

  private async load(filePath: string, maxCount: number): Promise<void> {
    if (!this.view) {
      return;
    }
    const generation = ++this.loadGeneration;
    this.currentFilePath = filePath;
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.visualFileHistory)];
    this.view.webview.html = renderPlaceholderHtml('Loading file history…', {
      nonce: createNonce(),
      cspSource: this.view.webview.cspSource,
      styleUris,
      variant: 'loading',
    });

    try {
      const entries = await this.git.getFileHistoryStats(filePath, maxCount);
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      const points = layoutFileHistory(entries, new Date());
      this.view.webview.html = renderFileHistoryHtml(
        { points },
        {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
        },
      );
    } catch (err) {
      if (generation !== this.loadGeneration || !this.view) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.html = renderPlaceholderHtml(`GitLore: failed to load file history — ${message}`, {
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
    const { type, sha } = message as { type?: unknown; sha?: unknown };
    if (type === 'openCommit' && typeof sha === 'string' && this.currentFilePath) {
      await vscode.commands.executeCommand(COMMANDS.showCommit, this.currentFilePath, sha);
    }
  }
}
