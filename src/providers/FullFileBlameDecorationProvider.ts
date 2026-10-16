import * as vscode from 'vscode';
import { CONFIG, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';
import { computeRecencyBuckets } from '../core/git/recencyHeatmap';
import { RECENCY_GRADIENT_COLOR_IDS, recencyGradientColorIdForBucket } from '../utils/colors';
import { coalesceLineRanges } from '../utils/ranges';
import type { BlameSource } from './BlameSource';

/**
 * Paints a hot→cold recency gradient as a left-edge border per line, across the whole file —
 * distinct from `BlameDecorationProvider` (an `after:` text label on only the current line) and
 * `OwnershipDecorationProvider` (an overview-ruler mark colored by author identity, not age). One
 * decoration type per bucket is required, same reason as the ownership ruler: a decoration type's
 * border color is fixed per *type*, not settable per-range.
 *
 * Off by default (`gitLore.fullFileBlame.enabled`), same as the ownership heatmap — an opinionated
 * whole-file visual, not something every user wants on by default.
 */
export class FullFileBlameDecorationProvider implements vscode.Disposable {
  private readonly decorationTypes: vscode.TextEditorDecorationType[];
  private readonly disposables: vscode.Disposable[] = [];
  private lastRanges: { uri: string; ranges: number[][] } | undefined;
  private enabled: boolean;

  constructor(private readonly source: BlameSource) {
    this.decorationTypes = RECENCY_GRADIENT_COLOR_IDS.map((_, index) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderStyle: 'solid',
        borderWidth: '0 0 0 3px',
        borderColor: new vscode.ThemeColor(recencyGradientColorIdForBucket(index)),
      }),
    );
    this.enabled = this.getConfig<boolean>(CONFIG.fullFileBlameEnabled, false);

    this.disposables.push(
      ...this.decorationTypes,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.updateForEditor(editor);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG.section)) {
          return;
        }
        this.enabled = this.getConfig<boolean>(CONFIG.fullFileBlameEnabled, false);
        void this.updateForEditor(vscode.window.activeTextEditor);
      }),
      this.source.onInvalidate(() => {
        void this.updateForEditor(vscode.window.activeTextEditor);
      }),
    );

    void this.updateForEditor(vscode.window.activeTextEditor);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** Backs the "GitLore: Toggle Full-File Blame Heatmap" command. */
  toggle(): void {
    this.enabled = !this.enabled;
    void this.updateForEditor(vscode.window.activeTextEditor);
  }

  private async updateForEditor(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) {
      return;
    }
    if (!this.enabled || editor.document.uri.scheme !== 'file') {
      this.clearDecorations(editor);
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const maxSize = this.getConfig<number>(CONFIG.maxBlameFileSize, DEFAULT_MAX_BLAME_FILE_SIZE);
    if (Buffer.byteLength(editor.document.getText(), 'utf8') > maxSize) {
      this.clearDecorations(editor);
      return;
    }

    const ignoreWhitespace = this.getConfig<boolean>(CONFIG.blameIgnoreWhitespace, true);
    const detectMoves = this.getConfig<boolean>(CONFIG.blameDetectMoves, false);
    const blameLines = await this.source.getBlameLines(filePath, { ignoreWhitespace, detectMoves });
    if (!this.enabled) {
      return;
    }
    if (!blameLines) {
      this.clearDecorations(editor);
      return;
    }

    const linesByBucket: number[][] = this.decorationTypes.map(() => []);
    for (const { line, bucketIndex } of computeRecencyBuckets(blameLines, new Date(), this.decorationTypes.length)) {
      linesByBucket[bucketIndex]?.push(line);
    }

    this.decorationTypes.forEach((type, index) => {
      const ranges = coalesceLineRanges(linesByBucket[index] ?? []).map((r) => new vscode.Range(r.start, 0, r.end, 0));
      editor.setDecorations(type, ranges);
    });
    this.lastRanges = { uri: editor.document.uri.toString(), ranges: linesByBucket };
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    for (const type of this.decorationTypes) {
      editor.setDecorations(type, []);
    }
    this.lastRanges = { uri: editor.document.uri.toString(), ranges: this.decorationTypes.map(() => []) };
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose applied decorations. Index = bucket index (0 = hottest); value = the 0-based line numbers marked with that bucket. */
  getRecencyRangesForTest(uri: vscode.Uri): number[][] {
    return this.lastRanges?.uri === uri.toString() ? this.lastRanges.ranges : [];
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CONFIG.section).get<T>(key, fallback);
  }
}
