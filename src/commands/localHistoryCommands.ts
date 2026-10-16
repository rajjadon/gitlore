import * as vscode from 'vscode';
import { COMMANDS, CONFIG } from '../constants';
import type { GitService } from '../core/git/GitService';
import { GitCommandError } from '../core/git/errors';

/**
 * "GitLore: Find When Text Was Added or Removed" — searches the repo (or the current file)
 * for the commits that added or removed a given string or regex pattern.
 *
 * Pre-fills the input box from the active single-line selection (trimmed). Offers 'string'
 * vs 'regex' via QuickPick. When an active tracked file is open, also offers "this file" vs
 * "whole repo" scope. Results appear in a QuickPick; selecting one opens Commit Details via
 * the existing `gitLore.showCommit` command.
 *
 * Silent no-ops: no repo, untracked file, empty query (§13). One information message for zero
 * matches. A clear error message for an invalid regex.
 */
export function handleFindWhenTextChangedCommand(git: GitService): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.findWhenTextChanged, async () => {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.scheme === 'file' ? editor.document.uri.fsPath : undefined;

    const repoRoot = filePath ? await git.getRepoRoot(filePath) : null;
    if (!repoRoot) {
      // No repo — silent no-op per §13.
      return;
    }
    if (filePath && !(await git.isTracked(filePath))) {
      // Untracked file — silent no-op per §13.
      return;
    }

    // Prefill from a single-line selection only — a multi-line selection doesn't map to
    // a meaningful search term.
    const sel = editor?.selection;
    const prefill =
      sel && !sel.isEmpty && sel.start.line === sel.end.line
        ? editor.document.lineAt(sel.start.line).text.slice(sel.start.character, sel.end.character).trim()
        : undefined;

    const query = await vscode.window.showInputBox({
      title: 'GitLore: Find When Text Was Added or Removed',
      placeHolder: 'Text to search in git history',
      value: prefill ?? '',
      validateInput: (v) => (v.trim() ? undefined : 'Enter a non-empty search term'),
    });
    if (!query?.trim()) {
      return;
    }

    const modeItem = await vscode.window.showQuickPick(
      [
        { label: '$(symbol-string) String', description: 'Exact string match (-S)', value: 'string' as const },
        { label: '$(regex) Regex', description: 'Regular expression match (-G)', value: 'regex' as const },
      ],
      { title: 'GitLore: Search mode', placeHolder: 'How should the query be matched?' },
    );
    if (!modeItem) {
      return;
    }

    // Only offer scope when there is a tracked file in the editor.
    let scopeFilePath: string | undefined;
    if (filePath) {
      const scopeItems = [
        { label: '$(file) This file', description: filePath, value: 'file' as const },
        { label: '$(repo) Whole repo', description: repoRoot, value: 'repo' as const },
      ];
      const scopeItem = await vscode.window.showQuickPick(scopeItems, {
        title: 'GitLore: Scope',
        placeHolder: 'Search this file or the whole repository?',
      });
      if (!scopeItem) {
        return;
      }
      scopeFilePath = scopeItem.value === 'file' ? filePath : undefined;
    }

    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const maxCount = config.get<number>(CONFIG.maxHistoryItems, 200);

    let commits: Awaited<ReturnType<typeof git.searchHistory>>;
    try {
      commits = await git.searchHistory(repoRoot, query.trim(), modeItem.value, maxCount, scopeFilePath);
    } catch (err) {
      if (err instanceof GitCommandError) {
        void vscode.window.showErrorMessage(`GitLore: ${err.message}`);
      }
      return;
    }

    if (commits.length === 0) {
      void vscode.window.showInformationMessage('GitLore: no commits found containing that text.');
      return;
    }

    const items = commits.map((c) => ({
      label: `$(git-commit) ${c.shortSha}`,
      description: c.message,
      detail: `${c.author} · ${c.date}`,
      commit: c,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: `GitLore: ${commits.length} commit${commits.length === 1 ? '' : 's'} found`,
      placeHolder: 'Select a commit to view its details',
    });
    if (!selected) {
      return;
    }

    // Open in Commit Details via the existing command — pass the active file path so the
    // provider can resolve the correct repo. Fall back to repoRoot when no file is open.
    await vscode.commands.executeCommand(COMMANDS.showCommit, filePath ?? repoRoot, selected.commit.sha);
  });
}
