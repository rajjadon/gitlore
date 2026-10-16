import * as vscode from 'vscode';
import { COMMANDS } from '../constants';
import type { BlameDecorationProvider } from '../providers/BlameDecorationProvider';
import type { FullFileBlameDecorationProvider } from '../providers/FullFileBlameDecorationProvider';
import type { GitService } from '../core/git/GitService';
import { buildCacheKey } from '../utils/path';
import type { LruCache } from '../core/cache/LruCache';

export function handleToggleBlameCommand(provider: BlameDecorationProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.toggleBlame, () => {
    provider.toggle();
  });
}

export function handleToggleFullFileBlameCommand(provider: FullFileBlameDecorationProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.toggleFullFileBlame, () => {
    provider.toggle();
  });
}

/**
 * Moves the blame hover's line-history stepper one step and re-opens the hover to show it.
 * Fetches the line's full `-L` history on every step (not just the first) — the total count can
 * shift between clicks if the file is edited, and this is a rare, deliberate click rather than
 * something worth caching against that risk.
 */
export function handleStepLineHistoryCommand(git: GitService, navStore: LruCache<string, number>): vscode.Disposable {
  return vscode.commands.registerCommand(
    COMMANDS.stepLineHistory,
    async (filePath?: string, line?: number, direction?: 'prev' | 'next') => {
      if (typeof filePath !== 'string' || typeof line !== 'number' || (direction !== 'prev' && direction !== 'next')) {
        return;
      }
      // Extend to the active selection's end line when the selection is multi-line and spans the
      // target line — lets the hover stepper walk through range history, not just single-line history.
      const activeEditor = vscode.window.activeTextEditor;
      const sel = activeEditor?.selection;
      const endLine =
        sel && !sel.isEmpty && sel.start.line !== sel.end.line &&
        sel.start.line <= line && sel.end.line >= line
          ? sel.end.line
          : undefined;
      const history = await git.getLineHistory(filePath, line, endLine);
      if (history.length === 0) {
        return;
      }

      const repoRoot = await git.getRepoRoot(filePath);
      const key = buildCacheKey(repoRoot ?? filePath, filePath, String(line));
      const current = navStore.get(key) ?? 0;
      const proposed = direction === 'prev' ? current + 1 : current - 1;
      const clamped = Math.max(0, Math.min(history.length - 1, proposed));

      // Already at the edge (only revision, or back at the live one) — say so instead of a click
      // that silently does nothing, which reads as "this button is broken".
      if (clamped === current) {
        void vscode.window.showInformationMessage(
          direction === 'prev' ? 'GitLore: this is the only revision of this line.' : 'GitLore: already at the current revision.',
        );
        return;
      }
      navStore.set(key, clamped);

      const editor = vscode.window.activeTextEditor;
      const stillOnSameLine =
        editor !== undefined && editor.document.uri.fsPath === filePath && editor.selection.active.line === line;
      if (stillOnSameLine) {
        // Closest achievable approximation of "the hover updates in place" — see the identical
        // note on gitLore.explainLine, which established this pattern first.
        await vscode.commands.executeCommand('editor.action.showHover');
      } else {
        // The common case: a hover link click doesn't move the text cursor, so if the user was
        // just mousing over a line their cursor isn't on (the normal way to peek at blame), there
        // is no cursor position VS Code will reopen a hover at that matches what was clicked.
        void vscode.window.showInformationMessage('GitLore: line history updated — hover the line again to view it.');
      }
    },
  );
}
