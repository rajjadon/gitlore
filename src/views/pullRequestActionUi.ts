/**
 * VS Code adapter implementing PullRequestActionUi — the only file in the shared PR action flow
 * that imports vscode. Both LaunchpadViewProvider and PullRequestDetailsViewProvider use this.
 */
import * as vscode from 'vscode';
import { pickMergeStrategy } from './mergeStrategyPicker';
import type { PullRequestActionUi } from './pullRequestActions';

export const vscodePullRequestActionUi: PullRequestActionUi = {
  async confirm(message: string, ...buttons: string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true }, ...buttons);
  },
  async pickMergeStrategy(pr) {
    return pickMergeStrategy(pr);
  },
  warn(message: string) {
    void vscode.window.showWarningMessage(message);
  },
  error(message: string) {
    void vscode.window.showErrorMessage(message);
  },
};
