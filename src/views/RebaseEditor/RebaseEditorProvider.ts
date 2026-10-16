import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRebaseTodo, serializeRebaseTodo, type RebaseEntry } from '../../core/git/rebaseTodo';
import { renderRebaseEditorHtml } from './render';
import { CONFIG, MEDIA } from '../../constants';
import { createNonce } from '../nonce';

/** `<repoRoot>/.git/{rebase-merge,rebase-apply}/git-rebase-todo` — three directories up from the file is the repo root. */
function repoRootForTodoFile(todoPath: string): string {
  return dirname(dirname(dirname(todoPath)));
}

/** True while git is still mid-rebase — used only to decide whether to show a conflict notice after the editor closes, never to drive any git command. */
function rebaseStillInProgress(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.git', 'rebase-merge')) || existsSync(join(repoRoot, '.git', 'rebase-apply'));
}

/**
 * Custom editor for `git-rebase-todo` — the file git itself opens (via whatever `sequence.editor`
 * is configured) when running `git rebase -i` and blocks on until it closes. This provider never
 * calls `git rebase` itself; it only ever reads, writes, and closes this one document. See
 * docs/superpowers/specs/2026-08-13-mockup-parity-design.md §2 for the full safety boundary.
 */
export class RebaseEditorProvider implements vscode.CustomTextEditorProvider {
  private lastPanel: vscode.WebviewPanel | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.lastPanel?.webview.html;
  }

  private mediaUri(webview: vscode.Webview, name: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString();
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const enabled = vscode.workspace.getConfiguration(CONFIG.section).get<boolean>(CONFIG.rebaseEditorEnabled, true);
    if (!enabled) {
      webviewPanel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }

    this.lastPanel = webviewPanel;
    webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };

    const render = (): void => {
      const entries = parseRebaseTodo(document.getText());
      webviewPanel.webview.html = renderRebaseEditorHtml(
        { entries },
        {
          nonce: createNonce(),
          cspSource: webviewPanel.webview.cspSource,
          styleUris: [this.mediaUri(webviewPanel.webview, MEDIA.shared), this.mediaUri(webviewPanel.webview, MEDIA.rebaseEditor)],
        },
      );
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) {
        render();
      }
    });
    webviewPanel.onDidDispose(() => changeSub.dispose());

    const writeEntries = async (entries: RebaseEntry[]): Promise<void> => {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      edit.replace(document.uri, fullRange, serializeRebaseTodo(entries));
      await vscode.workspace.applyEdit(edit);
    };

    /** Saves, then closes this tab — the closure is what unblocks git's waiting child process. */
    const finish = async (entries: RebaseEntry[]): Promise<void> => {
      await writeEntries(entries);
      await document.save();
      const repoRoot = repoRootForTodoFile(document.uri.fsPath);
      webviewPanel.dispose();
      // A conflict pauses the rebase right after the sequence editor closes — give it a moment,
      // then just point at Source Control rather than building a conflict-resolution UI of our own.
      setTimeout(() => {
        if (rebaseStillInProgress(repoRoot)) {
          void (async () => {
            const choice = await vscode.window.showInformationMessage(
              'GitLore: the rebase paused, likely on a conflict. Resolve it in Source Control.',
              'Open Source Control',
            );
            if (choice) {
              void vscode.commands.executeCommand('workbench.view.scm');
            }
          })();
        }
      }, 1500);
    };

    webviewPanel.webview.onDidReceiveMessage(async (message: unknown) => {
      if (typeof message !== 'object' || message === null) {
        return;
      }
      const { type, from, to, index, action } = message as {
        type?: unknown;
        from?: unknown;
        to?: unknown;
        index?: unknown;
        action?: unknown;
      };
      const entries = parseRebaseTodo(document.getText());

      if (type === 'reorder' && typeof from === 'number' && typeof to === 'number') {
        const [moved] = entries.splice(from, 1);
        if (moved) {
          entries.splice(to, 0, moved);
          await writeEntries(entries);
        }
        return;
      }
      if (type === 'setAction' && typeof index === 'number' && typeof action === 'string') {
        const entry = entries[index];
        if (entry?.editable) {
          entry.command = action;
          await writeEntries(entries);
        }
        return;
      }
      if (type === 'startRebase') {
        await finish(entries);
        return;
      }
      if (type === 'abortRebase') {
        // Empty sequence — git's own documented behavior is to stop cleanly with nothing rewritten.
        await finish([]);
      }
    });

    render();
  }
}
