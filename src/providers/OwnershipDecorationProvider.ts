import * as vscode from 'vscode';
import { CONFIG, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';
import { computeLineColors } from '../core/git/ownership';
import { CHART_THEME_COLOR_IDS, chartThemeColorIdForIndex } from '../utils/colors';
import { coalesceLineRanges } from '../utils/ranges';
import type { BlameSource } from './BlameSource';

/**
 * Paints a color mark per line in the editor's overview ruler, colored by that line's blame
 * author — the "heatmap" from GitLore's roadmap. One decoration type per palette color is
 * required: `overviewRulerColor` is fixed per decoration *type*, not settable per-range, so
 * showing N colors needs N types, each given its own subset of line ranges.
 *
 * Does not set up its own file-system watcher for the active file (unlike
 * `BlameDecorationProvider`) — it relies on `BlameSource`'s `onInvalidate` broadcast, which
 * `BlameDecorationProvider` already arranges to fire on file save (via its own `watchFile` call)
 * whenever it exists, which it unconditionally does in `extension.ts`. This is an explicit,
 * documented reliance, not an accidental one.
 */
export class OwnershipDecorationProvider implements vscode.Disposable {
  private readonly decorationTypes: vscode.TextEditorDecorationType[];
  private readonly disposables: vscode.Disposable[] = [];
  private lastRanges: { uri: string; ranges: number[][] } | undefined;
  private enabled: boolean;

  constructor(private readonly source: BlameSource) {
    this.decorationTypes = CHART_THEME_COLOR_IDS.map((_, index) =>
      vscode.window.createTextEditorDecorationType({
        overviewRulerColor: new vscode.ThemeColor(chartThemeColorIdForIndex(index)),
        overviewRulerLane: vscode.OverviewRulerLane.Full,
      }),
    );
    this.enabled = this.getConfig<boolean>(CONFIG.ownershipEnabled, false);

    this.disposables.push(
      ...this.decorationTypes,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.updateForEditor(editor);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CONFIG.section)) {
          return;
        }
        this.enabled = this.getConfig<boolean>(CONFIG.ownershipEnabled, false);
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

    const linesByColorIndex: number[][] = this.decorationTypes.map(() => []);
    for (const { line, colorIndex } of computeLineColors(blameLines)) {
      linesByColorIndex[colorIndex]?.push(line);
    }

    this.decorationTypes.forEach((type, index) => {
      const ranges = coalesceLineRanges(linesByColorIndex[index] ?? []).map((r) => new vscode.Range(r.start, 0, r.end, 0));
      editor.setDecorations(type, ranges);
    });
    this.lastRanges = { uri: editor.document.uri.toString(), ranges: linesByColorIndex };
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    for (const type of this.decorationTypes) {
      editor.setDecorations(type, []);
    }
    this.lastRanges = { uri: editor.document.uri.toString(), ranges: this.decorationTypes.map(() => []) };
  }

  /** Test-only introspection seam — VS Code's public API doesn't expose applied decorations. Index = color index into `CHART_THEME_COLOR_IDS`; value = the 0-based line numbers marked with that color. */
  getOwnershipRangesForTest(uri: vscode.Uri): number[][] {
    return this.lastRanges?.uri === uri.toString() ? this.lastRanges.ranges : [];
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CONFIG.section).get<T>(key, fallback);
  }
}
