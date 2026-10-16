import * as vscode from 'vscode';
import type { AzureDevOpsCredentialScheme } from '../core/forge/AzureDevOpsClient';
import type { DetectedForgeHost } from '../core/forge/hostDetection';
import { usesBuiltInSessionForHost } from '../core/forge/silentCredentialPath';

/**
 * Azure DevOps' well-known AAD resource ID — stable across every organization, not a GitLore- or
 * tenant-specific value. `.default` requests whatever access the signed-in account already has;
 * `offline_access` lets VS Code silently refresh the token instead of re-prompting every session.
 */
const AZURE_DEVOPS_AAD_SCOPES = ['499b84ac-1321-427f-aa17-267ca6975798/.default', 'offline_access'];

function secretKeyFor(displayHost: string): string {
  return `gitLore.launchpad.pat.${displayHost}`;
}

/** True for the two hosts VS Code ships a built-in authentication session for — github.com's GitHub session, and Azure DevOps Services' Microsoft/AAD session. Self-hosted instances of either (GHE, on-prem Azure DevOps Server via `customHosts`) still need a PAT: neither ships (or necessarily *can* ship) the same built-in session. */
function usesBuiltInSession(detected: DetectedForgeHost): boolean {
  return usesBuiltInSessionForHost(detected);
}

/**
 * Which credential shape `AzureDevOpsClient` should present: `oauth` for the built-in Microsoft
 * session (a JWT, sent as Bearer), `pat` for everything else (sent as Basic). Meaningless for the
 * other three hosts, whose `ForgeClient`s only ever speak one credential shape.
 */
export function azureDevOpsCredentialScheme(detected: DetectedForgeHost): AzureDevOpsCredentialScheme {
  return detected.flavor === 'azureDevOps' && detected.displayHost === 'dev.azure.com' ? 'oauth' : 'pat';
}

/**
 * Resolves the credential Launchpad needs to call a host's API. GitHub's public `github.com` and
 * Azure DevOps Services' `dev.azure.com` both get a VS Code built-in authentication session — no
 * GitLore backend, no key ever handled by GitLore itself. This matters beyond convenience for
 * Azure DevOps specifically: some organizations' Conditional Access policies block PAT/Basic auth
 * entirely, so a PAT can 401 there no matter how broad its scope is, while an interactive AAD
 * sign-in (this session) still succeeds. Every other host (GitLab, Bitbucket, self-hosted Azure
 * DevOps Server, and GitHub Enterprise Server/Gitea/Forgejo via `customHosts`, none of which VS
 * Code ships a built-in session provider for) needs a Personal Access Token, entered once and
 * stored in VS Code's own encrypted `SecretStorage` — the user's token, on their machine, never
 * sent anywhere but that host itself.
 *
 * Returns null if the user declines to sign in / enter a token — the caller shows that repo as
 * "not signed in" rather than failing the whole board.
 */
export async function resolveForgeToken(
  secrets: vscode.SecretStorage,
  detected: DetectedForgeHost,
): Promise<string | null> {
  if (detected.flavor === 'github' && detected.displayHost === 'github.com') {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    return session?.accessToken ?? null;
  }
  if (detected.flavor === 'azureDevOps' && detected.displayHost === 'dev.azure.com') {
    const session = await vscode.authentication.getSession('microsoft', AZURE_DEVOPS_AAD_SCOPES, { createIfNone: true });
    return session?.accessToken ?? null;
  }

  const key = secretKeyFor(detected.displayHost);
  const existing = await secrets.get(key);
  if (existing) {
    return existing;
  }

  const entered = await vscode.window.showInputBox({
    title: `GitLore: Personal Access Token for ${detected.displayHost}`,
    prompt: `Needed to show pull requests from ${detected.displayHost} in Launchpad. Stored locally in VS Code's encrypted secret storage — never sent anywhere but ${detected.displayHost} itself.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!entered) {
    return null;
  }
  await secrets.store(key, entered);
  return entered;
}

/** Clears a stored token — used when a host rejects it, so the next refresh re-prompts instead of retrying the same bad credential forever. Never touches a built-in session (VS Code owns that lifecycle, not GitLore). */
export async function clearForgeToken(secrets: vscode.SecretStorage, detected: DetectedForgeHost): Promise<void> {
  if (usesBuiltInSession(detected)) {
    return;
  }
  await secrets.delete(secretKeyFor(detected.displayHost));
}

/**
 * Silent-only credential resolution used by LaunchpadStatusBar (Phase D). It NEVER calls
 * `showInputBox` or `createIfNone: true` — the status bar updates in the background and must not
 * prompt the user.
 *
 * - Built-in session hosts (github.com / dev.azure.com): `getSession(..., { createIfNone: false,
 *   silent: true })` — returns an existing session or null; never pops an auth UI.
 * - PAT hosts: `secrets.get(key)` only — returns the previously-stored token or null.
 *
 * Returns `null` for any host that hasn't been signed in yet; the status bar treats that repo as
 * unreachable and hides its count rather than prompting.
 */
export async function resolveForgeTokenSilently(
  secrets: vscode.SecretStorage,
  detected: DetectedForgeHost,
): Promise<string | null> {
  if (detected.flavor === 'github' && detected.displayHost === 'github.com') {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false, silent: true });
    return session?.accessToken ?? null;
  }
  if (detected.flavor === 'azureDevOps' && detected.displayHost === 'dev.azure.com') {
    const session = await vscode.authentication.getSession('microsoft', AZURE_DEVOPS_AAD_SCOPES, { createIfNone: false, silent: true });
    return session?.accessToken ?? null;
  }
  // PAT host — secrets.get only, never showInputBox
  return (await secrets.get(secretKeyFor(detected.displayHost))) ?? null;
}

/**
 * Lets the user proactively reset credentials for a host — e.g. after realizing Launchpad
 * authenticated as the wrong account — instead of only ever clearing on an API failure
 * (`clearForgeToken`, used internally when a request rejects). For a PAT host this deletes the
 * stored secret so the next refresh re-prompts for one. GitLore can't sign the user out of a
 * built-in session (that session belongs to VS Code, shared with every other extension) — instead
 * it clears *this extension's* remembered account preference via `clearSessionPreference`, so the
 * next `getSession(..., { createIfNone: true })` call in `resolveForgeToken` offers an account
 * picker (if more than one is signed into VS Code) or re-authenticates instead of silently reusing
 * whichever session/account was picked before.
 */
export async function signOutOfForgeHost(secrets: vscode.SecretStorage, detected: DetectedForgeHost): Promise<void> {
  if (usesBuiltInSession(detected)) {
    const providerId = detected.flavor === 'github' ? 'github' : 'microsoft';
    const scopes = detected.flavor === 'github' ? ['repo'] : AZURE_DEVOPS_AAD_SCOPES;
    await vscode.authentication.getSession(providerId, scopes, { clearSessionPreference: true, createIfNone: false });
    return;
  }
  await clearForgeToken(secrets, detected);
}
