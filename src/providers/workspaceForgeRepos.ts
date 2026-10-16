import { parseRemoteUrl } from '../core/git/parsers';
import { detectForgeHost, type DetectedForgeHost, type ForgeHostConfig } from '../core/forge/hostDetection';
import { resolveForgeRepoRef } from '../core/forge/resolveRepoRef';
import type { ForgeRepoRef } from '../core/forge/types';
import type { GitService } from '../core/git/GitService';

export interface WorkspaceForgeRepo {
  repo: ForgeRepoRef;
  detected: DetectedForgeHost;
  repoRoot: string;
}

/**
 * Discovers all recognized forge repos in the given workspace folder paths.
 *
 * Every *named* remote in every folder is scanned — not just `origin`. Deduped by resolved
 * repo identity (two remotes or two workspace folders pointing at the same repo become one entry).
 * Credentials are NOT resolved here; that's the caller's job after receiving the list.
 *
 * `folderPaths` is injected (not read from vscode directly) so this function can be unit-tested
 * without a VS Code host. Callers pass `(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)`.
 */
export async function resolveWorkspaceForgeRepos(
  git: GitService,
  folderPaths: string[],
  customHosts: ForgeHostConfig[],
): Promise<WorkspaceForgeRepo[]> {
  const results: WorkspaceForgeRepo[] = [];
  const seen = new Set<string>();

  for (const folderPath of folderPaths) {
    const repoRoot = await git.getRepoRoot(folderPath);
    if (!repoRoot) {
      continue;
    }
    const remotes = await git.getRemotes(repoRoot);
    for (const remote of remotes) {
      const parsedHost = parseRemoteUrl(remote.url)?.host;
      if (!parsedHost) {
        continue;
      }
      const detected = detectForgeHost(parsedHost, customHosts);
      if (!detected) {
        continue;
      }
      const repo = resolveForgeRepoRef(remote.url, customHosts);
      if (!repo) {
        continue;
      }
      const key = `${repo.host}:${repo.identity}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({ repo, detected, repoRoot });
    }
  }
  return results;
}
