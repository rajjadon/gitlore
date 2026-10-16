import * as vscode from 'vscode';
import { CONFIG } from '../constants';

/**
 * Shows a one-time "AI features are disabled → Open Settings" notice.
 * Fire-and-forget: callers that don't care about the outcome use `void showAiDisabledNotice()`.
 */
export async function showAiDisabledNotice(): Promise<void> {
  const choice = await vscode.window.showInformationMessage('GitLore: AI features are disabled.', 'Open Settings');
  if (choice) {
    void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG.section}.${CONFIG.aiEnabled}`);
  }
}
