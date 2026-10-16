import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { COMMANDS, CONFIG, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';
import { computeOwnership } from '../core/git/ownership';
import { formatAge } from '../utils/date';
import type { BlameSource } from '../providers/BlameSource';

/**
 * Builds the QuickPick items for a file's ownership breakdown, or `null` when there's no blame
 * data at all (not a git repo, no commits, or the file exceeds `gitLore.maxBlameFileSize`) — the
 * caller shows an informational message in that case rather than an empty picker. Exported
 * standalone so it's directly testable without driving the real interactive picker UI.
 */
export async function buildOwnershipQuickPickItems(
  source: BlameSource,
  filePath: string,
  now: Date = new Date(),
): Promise<vscode.QuickPickItem[] | null> {
  const config = vscode.workspace.getConfiguration(CONFIG.section);
  const maxSize = config.get<number>(CONFIG.maxBlameFileSize, DEFAULT_MAX_BLAME_FILE_SIZE);

  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxSize) {
      return null;
    }
  } catch {
    return null;
  }

  const ignoreWhitespace = config.get<boolean>(CONFIG.blameIgnoreWhitespace, true);
  const detectMoves = config.get<boolean>(CONFIG.blameDetectMoves, false);
  const blameLines = await source.getBlameLines(filePath, { ignoreWhitespace, detectMoves });
  if (!blameLines || blameLines.length === 0) {
    return null;
  }

  const ownership = computeOwnership(blameLines, now);
  if (ownership.length === 0) {
    return null;
  }

  return ownership.map((entry) => ({
    label: entry.author,
    description: `${Math.round(entry.percentage)}%`,
    detail: `${entry.lineCount} ${entry.lineCount === 1 ? 'line' : 'lines'} · last active ${formatAge(entry.lastActive, now)}`,
  }));
}

export function handleShowFileOwnershipCommand(source: BlameSource): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.showFileOwnership, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('GitLore: open a file to see its ownership breakdown.');
      return;
    }
    const items = await buildOwnershipQuickPickItems(source, editor.document.uri.fsPath);
    if (!items) {
      void vscode.window.showInformationMessage('GitLore: no blame data for this file.');
      return;
    }
    await vscode.window.showQuickPick(items, {
      placeHolder: 'File ownership, weighted by recency',
    });
  });
}
