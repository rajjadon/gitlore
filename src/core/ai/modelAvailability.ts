const KNOWN_VSCODE_APP_NAMES = new Set([
  'Visual Studio Code',
  'Visual Studio Code - Insiders',
  'Visual Studio Code - Exploration',
]);

/**
 * `vscode.lm` is core API, not something Copilot Chat adds — it exists in every VS Code fork
 * (Cursor, Antigravity, etc.), but those forks have no way to register a provider under it (Copilot
 * Chat won't activate there, and the fork's own AI isn't exposed through this API either). Telling
 * a fork user to "enable a language model" sends them chasing a fix that doesn't exist, so this
 * distinguishes "no model on real VS Code" (actionable) from "no model on a fork" (a platform gap).
 */
export function describeNoModelReason(appName: string): string {
  if (KNOWN_VSCODE_APP_NAMES.has(appName)) {
    return 'No language model available. Enable a language model (e.g. GitHub Copilot Chat) to use this feature.';
  }
  return `${appName} doesn't expose a language model through VS Code's provider API, so GitLore's AI features can't run here. This isn't something an extension can fix — try GitLore in standard VS Code, or use ${appName}'s own built-in AI instead.`;
}
