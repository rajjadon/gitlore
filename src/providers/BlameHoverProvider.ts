import * as vscode from 'vscode';
import { GitService } from '../core/git/GitService';
import type { BlameSource } from './BlameSource';
import { formatBlameHover, formatLineHistoryHover } from '../utils/format';
import { resolveIssueLinking } from './issueLinking';
import { CONFIG, COMMANDS, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';
import { buildLineExplanationKey, type LineExplanationState } from '../core/ai/lineExplanationKey';
import { buildCacheKey } from '../utils/path';
import type { LruCache } from '../core/cache/LruCache';

const HOVER_ENABLED_COMMANDS = [
  COMMANDS.explainLine,
  COMMANDS.stepLineHistory,
  COMMANDS.compareBranches,
  COMMANDS.showFileHistory,
  COMMANDS.copySha,
  COMMANDS.openPullRequestForCommit,
];

export class BlameHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly source: BlameSource,
    private readonly git: GitService,
    private readonly lineExplanationStore: LruCache<string, LineExplanationState>,
    private readonly lineHistoryNavStore: LruCache<string, number>,
  ) {}

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    token?: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (doc.uri.scheme !== 'file' || !this.getConfig<boolean>(CONFIG.blameEnabled, true)) {
      return undefined;
    }

    const maxSize = this.getConfig<number>(CONFIG.maxBlameFileSize, DEFAULT_MAX_BLAME_FILE_SIZE);
    if (Buffer.byteLength(doc.getText(), 'utf8') > maxSize) {
      return undefined;
    }

    try {
      const ignoreWhitespace = this.getConfig<boolean>(CONFIG.blameIgnoreWhitespace, true);
      const detectMoves = this.getConfig<boolean>(CONFIG.blameDetectMoves, false);
      const lines = await this.source.getBlameLines(doc.uri.fsPath, { ignoreWhitespace, detectMoves });
      if (token?.isCancellationRequested) {
        return undefined;
      }
      const entry = lines?.find((l) => l.line === pos.line);
      if (!entry) {
        return undefined;
      }

      const issueLinking = await resolveIssueLinking(this.git, doc.uri.fsPath);
      if (token?.isCancellationRequested) {
        return undefined;
      }

      if (!entry.isUncommitted) {
        const repoRoot = await this.git.getRepoRoot(doc.uri.fsPath);
        const navKey = buildCacheKey(repoRoot ?? doc.uri.fsPath, doc.uri.fsPath, String(pos.line));
        const navIndex = this.lineHistoryNavStore.get(navKey) ?? 0;

        if (navIndex > 0) {
          // Use the active editor's selection range when it spans the hover line — lets the user
          // step through the history of a block of lines rather than just a single line.
          const sel = vscode.window.activeTextEditor?.selection;
          const selEndLine =
            sel && !sel.isEmpty && sel.start.line !== sel.end.line &&
            sel.start.line <= pos.line && sel.end.line >= pos.line
              ? sel.end.line
              : undefined;
          const history = await this.git.getLineHistory(doc.uri.fsPath, pos.line, selEndLine);
          if (token?.isCancellationRequested) {
            return undefined;
          }
          const clampedIndex = Math.min(navIndex, history.length - 1);
          const commit = history[clampedIndex];
          // A history of only one entry (or none — e.g. the file changed on disk since the
          // stepper last ran) has nothing to step *to*; fall through to the live card instead.
          if (commit && history.length > 1) {
            const diffStat = await this.git.getFileDiffStat(doc.uri.fsPath, commit.sha);
            if (token?.isCancellationRequested) {
              return undefined;
            }
            const markdown = new vscode.MarkdownString(
              formatLineHistoryHover(commit, diffStat, doc.uri.fsPath, pos.line, clampedIndex, history.length, undefined, issueLinking),
            );
            markdown.isTrusted = { enabledCommands: HOVER_ENABLED_COMMANDS };
            markdown.supportThemeIcons = true;
            return new vscode.Hover(markdown);
          }
        }
      }

      const diffStat = entry.isUncommitted ? null : await this.git.getFileDiffStat(doc.uri.fsPath, entry.sha);
      if (token?.isCancellationRequested) {
        return undefined;
      }
      const lineContent = doc.lineAt(pos.line).text.slice(0, 500);

      let lineExplanation: LineExplanationState | undefined;
      if (!entry.isUncommitted) {
        const repoRoot = await this.git.getRepoRoot(doc.uri.fsPath);
        const key = buildLineExplanationKey(repoRoot, doc.uri.fsPath, entry.sha, lineContent);
        lineExplanation = this.lineExplanationStore.get(key);
      }

      const launchpadEnabled = this.getConfig<boolean>(CONFIG.launchpadEnabled, false);
      const markdown = new vscode.MarkdownString(
        formatBlameHover(entry, diffStat, doc.uri.fsPath, lineContent, lineExplanation, undefined, issueLinking, launchpadEnabled),
      );
      markdown.isTrusted = { enabledCommands: HOVER_ENABLED_COMMANDS };
      markdown.supportThemeIcons = true;
      return new vscode.Hover(markdown);
    } catch {
      // Blame failing on an unsaved/untracked file is expected — stay silent.
      return undefined;
    }
  }

  private getConfig<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration(CONFIG.section).get<T>(key, fallback);
  }
}
