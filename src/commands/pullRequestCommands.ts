import * as vscode from 'vscode';
import { COMMANDS, CONFIG } from '../constants';
import type { PullRequestDetailsViewProvider } from '../views/PullRequestDetails/PullRequestDetailsViewProvider';
import type { LaunchpadViewProvider } from '../views/Launchpad/LaunchpadViewProvider';
import type { GitService } from '../core/git/GitService';
import { parseRemoteUrl } from '../core/git/parsers';
import { detectForgeHost, type ForgeHostConfig } from '../core/forge/hostDetection';
import { resolveForgeRepoRef } from '../core/forge/resolveRepoRef';
import { resolveForgeTokenSilently, azureDevOpsCredentialScheme } from '../providers/forgeCredentials';
import type { CommitPullRequestResolver } from '../core/forge/CommitPullRequestResolver';

export function handleShowPullRequestCommand(
  detailsProvider: PullRequestDetailsViewProvider,
  launchpadProvider: LaunchpadViewProvider,
): vscode.Disposable {
  return vscode.commands.registerCommand(COMMANDS.showPullRequest, async (key?: string) => {
    if (!key) {
      void vscode.window.showInformationMessage('GitLore: open a PR from Launchpad to see its details.');
      return;
    }
    const resolved = launchpadProvider.resolvePullRequestForDetails(key);
    if (!resolved) {
      void vscode.window.showWarningMessage("GitLore: this PR isn't on the board anymore — try refreshing Launchpad.");
      return;
    }
    await detailsProvider.show(resolved.pr, resolved.client);
  });
}

/**
 * Opens the PR (if any) associated with a specific commit SHA. Invoked from the blame hover card's
 * "Open PR" link — never from the command palette (hidden: needs a sha argument). Shares the
 * `gitLore.launchpad.enabled` toggle; makes zero network calls when that setting is off.
 *
 * Resolution order: prefer the remote named `origin`; fall back to the first recognized forge
 * remote. Uses `resolveForgeTokenSilently` — never prompts; unsigned ⇒ one info message with an
 * "Open Launchpad" button. Found ⇒ open in PR Details panel if on the board, else in the browser.
 */
export function handleOpenPullRequestForCommitCommand(
  git: GitService,
  secrets: vscode.SecretStorage,
  resolver: CommitPullRequestResolver,
  launchpadProvider: LaunchpadViewProvider,
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    COMMANDS.openPullRequestForCommit,
    async (filePath?: string, sha?: string) => {
      if (typeof filePath !== 'string' || typeof sha !== 'string' || !sha) {
        return;
      }

      const config = vscode.workspace.getConfiguration(CONFIG.section);
      // Guard: this command shares the launchpad.enabled toggle (privacy contract).
      if (!config.get<boolean>(CONFIG.launchpadEnabled, false)) {
        return;
      }

      const repoRoot = await git.getRepoRoot(filePath);
      if (!repoRoot) {
        void vscode.window.showInformationMessage('GitLore: No repository found for this file.');
        return;
      }

      const customHosts = config.get<ForgeHostConfig[]>(CONFIG.launchpadCustomHosts, []);
      const remotes = await git.getRemotes(repoRoot);

      // Collect all recognized forge remotes for this repo.
      type RecognizedRemote = {
        detected: NonNullable<ReturnType<typeof detectForgeHost>>;
        repo: NonNullable<ReturnType<typeof resolveForgeRepoRef>>;
        remoteName: string;
      };
      const recognized: RecognizedRemote[] = [];
      for (const remote of remotes) {
        const parsed = parseRemoteUrl(remote.url);
        if (!parsed) {
          continue;
        }
        const detected = detectForgeHost(parsed.host, customHosts);
        if (!detected) {
          continue;
        }
        const repo = resolveForgeRepoRef(remote.url, customHosts);
        if (!repo) {
          continue;
        }
        recognized.push({ detected, repo, remoteName: remote.name });
      }

      if (recognized.length === 0) {
        void vscode.window.showInformationMessage('GitLore: No pull request host found for this repository.');
        return;
      }

      // Prefer origin; fall back to first recognized remote. Length is > 0 (guarded above).
      const chosen = recognized.find((r) => r.remoteName === 'origin') ?? recognized[0];
      if (!chosen) {
        // Unreachable: recognized.length > 0 is checked above, but satisfies TypeScript.
        return;
      }

      const token = await resolveForgeTokenSilently(secrets, chosen.detected);
      if (!token) {
        const choice = await vscode.window.showInformationMessage(
          'GitLore: Sign in via Launchpad to look up pull requests.',
          'Open Launchpad',
        );
        if (choice === 'Open Launchpad') {
          void vscode.commands.executeCommand(COMMANDS.openLaunchpad);
        }
        return;
      }

      const shortSha = sha.slice(0, 7);
      try {
        const pr = await resolver.resolve(chosen.repo, sha, chosen.detected, token);
        if (!pr) {
          void vscode.window.showInformationMessage(`GitLore: No pull request found for ${shortSha}.`);
          return;
        }

        // If the PR is on the Launchpad board, open it in PR Details.
        const prKey = `${chosen.repo.host}:${chosen.repo.identity}#${pr.number}`;
        const onBoard = launchpadProvider.resolvePullRequestForDetails(prKey);
        if (onBoard) {
          await vscode.commands.executeCommand(COMMANDS.showPullRequest, prKey);
          return;
        }

        // Otherwise open in the browser — validate http(s) scheme first.
        if (!/^https?:\/\//i.test(pr.url)) {
          output.appendLine(`[error] GitLore: openPullRequestForCommit: invalid PR URL scheme: ${pr.url}`);
          void vscode.window.showErrorMessage(`GitLore: PR URL is not a valid http/https address.`);
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(pr.url));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        output.appendLine(`[error] GitLore: openPullRequestForCommit: ${reason}`);
        void vscode.window.showErrorMessage(`GitLore: Could not look up pull request: ${reason}`);
      }
    },
  );
}
