/**
 * Pure helper for resolveForgeTokenSilently — determines which credential path to take for a given
 * host without touching vscode. Extracted from forgeCredentials.ts so it can be unit-tested
 * without importing the vscode module.
 *
 * No vscode import here: core/ must remain host-free and testable in plain Node.
 */

import type { DetectedForgeHost } from './hostDetection';

/**
 * Returns `true` when VS Code ships a built-in authentication session that Launchpad can use
 * silently (without prompting the user): github.com's GitHub session, and Azure DevOps Services'
 * Microsoft/AAD session.
 *
 * Self-hosted instances of either (GitHub Enterprise Server, on-prem Azure DevOps Server
 * configured via `customHosts`) still need a PAT — neither ships the same built-in session.
 */
export function usesBuiltInSessionForHost(detected: DetectedForgeHost): boolean {
  return (
    (detected.flavor === 'github' && detected.displayHost === 'github.com') ||
    (detected.flavor === 'azureDevOps' && detected.displayHost === 'dev.azure.com')
  );
}
