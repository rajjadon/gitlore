import * as vscode from 'vscode';
import { COMMANDS, CONFIG } from '../constants';
import type { CommitDetailsViewProvider } from '../views/CommitDetails/CommitDetailsViewProvider';
import type { PullRequestDetailsViewProvider } from '../views/PullRequestDetails/PullRequestDetailsViewProvider';
import type { BranchComparisonViewProvider } from '../views/BranchComparison/BranchComparisonViewProvider';
import type { LineExplanationService } from '../ai/LineExplanationService';
import type { CommitMessageService } from '../ai/CommitMessageService';
import type { ChangelogService } from '../ai/ChangelogService';
import type { GitService } from '../core/git/GitService';
import { resolveRepoContextPath } from '../views/CommitGraph/CommitGraphViewProvider';
import { describeNoModelReason } from '../core/ai/modelAvailability';

/** The subset of `vscode.git`'s exported API GitLore uses — not part of `@types/vscode`, so declared locally. */
interface GitExtensionApi {
  repositories: Array<{ rootUri: vscode.Uri; inputBox: { value: string } }>;
}

interface GitExtensionExports {
  getAPI(version: 1): GitExtensionApi;
}

export function handleExplainCommitCommand(provider: CommitDetailsViewProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.explainCommit, async () => {
    if (!provider.hasLoadedCommit()) {
      void vscode.window.showInformationMessage('GitLore: open a commit in Commit Details first.');
      return;
    }
    await provider.explainCommit();
  });
}

export function handleExplainPullRequestCommand(provider: PullRequestDetailsViewProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.explainPullRequest, async () => {
    if (!provider.getCurrentSubjectForChat()) {
      void vscode.window.showInformationMessage('GitLore: open a PR in Pull Request Details first.');
      return;
    }
    await provider.explainPr();
  });
}

export function handleSummarizeBranchComparisonCommand(provider: BranchComparisonViewProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.summarizeBranchComparison, async () => {
    await provider.summarizeComparison();
  });
}

export function handleDraftPrReviewCommand(provider: PullRequestDetailsViewProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.draftPrReview, async () => {
    if (!provider.getCurrentSubjectForChat()) {
      void vscode.window.showInformationMessage('GitLore: open a PR in Pull Request Details first.');
      return;
    }
    await provider.draftReview();
  });
}

export function handleExplainLineCommand(service: LineExplanationService): vscode.Disposable {
  return vscode.commands.registerCommand(
    COMMANDS.explainLine,
    async (filePath?: string, sha?: string, lineContent?: string) => {
      if (typeof filePath !== 'string' || typeof sha !== 'string' || typeof lineContent !== 'string') {
        void vscode.window.showInformationMessage('GitLore: pick a line with committed history to explain.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'GitLore: explaining line…' },
        async () => {
          const controller = new AbortController();
          await service.explain(filePath, sha, lineContent, controller.signal);
        },
      );

      const state = await service.getState(filePath, sha, lineContent);
      if (state === undefined) {
        // Disabled (already showed its own "AI features are disabled" prompt) or aborted
        // (silent by design) — nothing more to surface.
        return;
      }

      const editor = vscode.window.activeTextEditor;
      const stillOnSameLine =
        editor !== undefined &&
        editor.document.uri.fsPath === filePath &&
        editor.selection.active.line < editor.document.lineCount &&
        editor.document.lineAt(editor.selection.active.line).text.slice(0, 500) === lineContent;

      if (stillOnSameLine) {
        // Closest achievable approximation of "the hover updates" — a vscode.Hover cannot
        // actually be updated in place (no live-streaming API), so this forces a fresh one at
        // the current cursor position, which now reads the state explain() just wrote.
        await vscode.commands.executeCommand('editor.action.showHover');
      } else {
        // Cursor moved (different line, different file, or no active editor) — auto-reopening
        // would show a hover for the wrong position or surprise the user mid-something-else.
        void vscode.window.showInformationMessage('GitLore: line explanation finished — hover the line again to view it.');
      }
    },
  );
}

export function handleGenerateCommitMessageCommand(service: CommitMessageService, git: GitService): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.generateCommitMessage, async () => {
    const filePath = resolveRepoContextPath();
    if (!filePath) {
      void vscode.window.showInformationMessage('GitLore: open a repo first to generate a commit message.');
      return;
    }

    // Resolved lazily, only once there's actual text to write — AI-disabled and nothing-staged
    // (the two most common outcomes) never need the Git extension at all.
    let repository: { inputBox: { value: string } } | undefined;
    const resolveRepository = async (): Promise<{ inputBox: { value: string } } | undefined> => {
      if (repository) {
        return repository;
      }
      const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
      if (!gitExtension) {
        void vscode.window.showInformationMessage(
          "GitLore: needs VS Code's built-in Git extension, to write into its commit-message box.",
        );
        return undefined;
      }
      const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
      const api = exports.getAPI(1);
      const repoRoot = await git.getRepoRoot(filePath);
      const found = api.repositories.find((r) => r.rootUri.fsPath === repoRoot);
      if (!found) {
        void vscode.window.showInformationMessage('GitLore: could not find this repo in the Git extension.');
        return undefined;
      }
      repository = found;
      return found;
    };

    const controller = new AbortController();
    let fullText = '';
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'GitLore: generating commit message…' },
      async () => {
        for await (const event of service.generate(filePath, controller.signal)) {
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
              break;
            case 'noStagedChanges':
              void vscode.window.showInformationMessage('GitLore: stage some changes first.');
              break;
            case 'noModel':
              void vscode.window.showInformationMessage(describeNoModelReason(vscode.env.appName));
              break;
            case 'chunk': {
              const repo = await resolveRepository();
              if (!repo) {
                return;
              }
              fullText += event.text;
              repo.inputBox.value = fullText;
              break;
            }
            case 'done': {
              const repo = await resolveRepository();
              if (!repo) {
                return;
              }
              repo.inputBox.value = event.text;
              break;
            }
            case 'error':
              void vscode.window.showErrorMessage(`GitLore: failed to generate a commit message — ${event.message}`);
              break;
          }
        }
      },
    );
  });
}

export function handleGenerateChangelogCommand(service: ChangelogService, git: GitService): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.generateChangelog, async () => {
    const filePath = resolveRepoContextPath();
    if (!filePath) {
      void vscode.window.showInformationMessage('GitLore: open a repo first to generate a changelog.');
      return;
    }

    const [branches, tags] = await Promise.all([git.getBranches(filePath), git.getTags(filePath)]);
    const refItems = [...branches.map((b) => b.name), ...tags.map((t) => t.name)];

    const from = await vscode.window.showQuickPick(refItems, { placeHolder: 'Changelog since which ref? (e.g. last release tag)' });
    if (!from) {
      return;
    }
    const to = (await vscode.window.showQuickPick(refItems, { placeHolder: 'Changelog up to which ref?' })) ?? undefined;
    if (!to) {
      return;
    }

    const controller = new AbortController();
    let fullText = '';
    let doc: vscode.TextDocument | undefined;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'GitLore: generating changelog…' },
      async () => {
        for await (const event of service.generate(filePath, from, to, controller.signal)) {
          switch (event.type) {
            case 'disabled':
              void vscode.window.showInformationMessage('GitLore: AI features are disabled.', 'Open Settings').then((choice) => {
                if (choice) {
                  void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG.section}.${CONFIG.aiEnabled}`);
                }
              });
              break;
            case 'noCommits':
              void vscode.window.showInformationMessage(`GitLore: no commits between ${from} and ${to}.`);
              break;
            case 'noModel':
              void vscode.window.showInformationMessage(describeNoModelReason(vscode.env.appName));
              break;
            case 'chunk':
              fullText += event.text;
              if (!doc) {
                doc = await vscode.workspace.openTextDocument({ content: fullText, language: 'markdown' });
                await vscode.window.showTextDocument(doc);
              } else {
                // Local const so TS keeps the non-undefined narrowing inside the closure below
                // (the outer `doc` is reassignable, so its narrowing wouldn't otherwise survive).
                const openDoc = doc;
                const editor = await vscode.window.showTextDocument(openDoc);
                await editor.edit((builder) => {
                  const lastLine = openDoc.lineAt(openDoc.lineCount - 1);
                  builder.replace(new vscode.Range(new vscode.Position(0, 0), lastLine.range.end), fullText);
                });
              }
              break;
            case 'error':
              void vscode.window.showErrorMessage(`GitLore: failed to generate a changelog — ${event.message}`);
              break;
          }
        }
      },
    );
  });
}
