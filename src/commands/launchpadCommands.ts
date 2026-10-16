import * as vscode from 'vscode';
import { COMMANDS, CONFIG } from '../constants';
import type { LaunchpadViewProvider } from '../views/Launchpad/LaunchpadViewProvider';

export function handleOpenLaunchpadCommand(provider: LaunchpadViewProvider): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.openLaunchpad, async () => {
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.launchpadEnabled, false);
    // Checked before anything else: Launchpad is the one feature that calls out to a remote host
    // at all, so it stays off until asked for, same as AI — no surprise network calls.
    if (!enabled) {
      const choice = await vscode.window.showInformationMessage('GitLore: Launchpad is disabled.', 'Open Settings');
      if (choice) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG.section}.${CONFIG.launchpadEnabled}`);
      }
      return;
    }
    await provider.show();
  });
}
