import * as vscode from 'vscode';
import type { BlameLine } from '../core/git/types';
import { formatBlameEntry } from '../utils/blameFormat';
import { CONFIG, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';
import type { BlameSource } from './BlameSource';

/** `undefined` = no active file editor at all; `entry: null` = there's an editor but no blame for its current line. */
export interface ActiveLineBlame {
  editor: vscode.TextEditor;
  entry: BlameLine | null;
}

export class BlameDecorationProvider implements vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<ActiveLineBlame | undefined>();
  /** Lets other UI (the status bar) reuse this provider's active-line tracking instead of re-subscribing to the same events. */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;
  private lastLineByUri = new Map<string, number>();
  private lastLabelByUri = new Map<string, string | undefined>();
  private currentWatchedFile: string | undefined;
  private enabled: boolean;

  constructor(private readonly source: BlameSource) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        fontStyle: 'italic',
      },
    });
    this.enabled = this.getConfig<boolean>(CONFIG.blameEnabled, true);

    this.disposables.push(
      this.decorationType,
      this.onDidUpdateEmitter,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.onActiveEditorChanged(editor);
      }),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        void this.onSelectionChanged(e);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        this.onConfigChanged(e);
      }),
      this.source.onInvalidate(() => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          void this.updateForEditor(editor);
        }
      }),
    );

    if (vscode.window.activeTextEditor) {
      void this.onActiveEditorChanged(vscode.window.activeTextEditor);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    if (this.currentWatchedFile) {
      this.source.unwatchFile(this.currentWatchedFile);
    }
  }

  toggle(): void {
    this.enabled = !this.enabled;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.onDidUpdateEmitter.fire(undefined);
      return;
    }
    if (!this.enabled) {
      this.clearDecoration(editor);
      this.onDidUpdateEmitter.fire({ editor, entry: null });
    } else {
      void this.updateForEditor(editor);
    }
  }

  private async onActiveEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
    this.watchCurrentFile(editor);
    if (editor) {
      await this.updateForEditor(editor);
    } else {
      this.onDidUpdateEmitter.fire(undefined);
    }
  }

  private async onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    const uriKey = e.textEditor.document.uri.toString();
    const line = e.selections[0]?.active.line ?? 0;
    if (this.lastLineByUri.get(uriKey) === line) {
      return; // Horizontal cursor move on the same line — not a line change, ignore.
    }
    this.lastLineByUri.set(uriKey, line);
    await this.updateForEditor(e.textEditor);
  }

  private onConfigChanged(e: vscode.ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration(CONFIG.section)) {
      return;
    }
    this.enabled = this.getConfig<boolean>(CONFIG.blameEnabled, true);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.onDidUpdateEmitter.fire(undefined);
      return;
    }
    if (!this.enabled) {
      this.clearDecoration(editor);
      this.onDidUpdateEmitter.fire({ editor, entry: null });
    } else {
      void this.updateForEditor(editor);
    }
  }

  private async updateForEditor(editor: vscode.TextEditor): Promise<void> {
    if (!this.enabled || editor.document.uri.scheme !== 'file') {
      this.onDidUpdateEmitter.fire({ editor, entry: null });
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const line = editor.selection.active.line;
    const maxSize = this.getConfig<number>(CONFIG.maxBlameFileSize, DEFAULT_MAX_BLAME_FILE_SIZE);
    if (Buffer.byteLength(editor.document.getText(), 'utf8') > maxSize) {
      this.clearDecoration(editor);
      this.onDidUpdateEmitter.fire({ editor, entry: null });
      return;
    }

    const ignoreWhitespace = this.getConfig<boolean>(CONFIG.blameIgnoreWhitespace, true);
    const detectMoves = this.getConfig<boolean>(CONFIG.blameDetectMoves, false);
    const blameLines = await this.source.getBlameLines(filePath, { ignoreWhitespace, detectMoves });
    const entry = blameLines?.find((l: BlameLine) => l.line === line) ?? null;
    if (!entry) {
      this.clearDecoration(editor);
      this.onDidUpdateEmitter.fire({ editor, entry: null });
      return;
    }

    const range = new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER);
    const highlight = this.getConfig<boolean>(CONFIG.blameHighlightCurrentLine, true);
    const format = this.getConfig<string>(CONFIG.blameFormat, '{author}, {age}');
    const label = formatBlameEntry(entry, format);
    editor.setDecorations(this.decorationType, [
      {
        range,
        renderOptions: {
          after: {
            contentText: label,
            color: new vscode.ThemeColor(
              highlight ? 'editorCodeLens.foreground' : 'descriptionForeground',
            ),
          },
        },
      },
    ]);
    this.lastLabelByUri.set(editor.document.uri.toString(), label);
    this.onDidUpdateEmitter.fire({ editor, entry });
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose applied decorations. */
  getRenderedLabel(uri: vscode.Uri): string | undefined {
    return this.lastLabelByUri.get(uri.toString());
  }

  private clearDecoration(editor: vscode.TextEditor): void {
    editor.setDecorations(this.decorationType, []);
    this.lastLabelByUri.set(editor.document.uri.toString(), undefined);
  }

  /** Only the active editor's file needs a watcher — replaced whenever the active editor changes. */
  private watchCurrentFile(editor: vscode.TextEditor | undefined): void {
    if (this.currentWatchedFile) {
      this.source.unwatchFile(this.currentWatchedFile);
      this.currentWatchedFile = undefined;
    }
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }
    this.currentWatchedFile = editor.document.uri.fsPath;
    this.source.watchFile(this.currentWatchedFile);
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CONFIG.section).get<T>(key, fallback);
  }
}
