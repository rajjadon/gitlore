import * as vscode from 'vscode';
import { GitService } from '../core/git/GitService';
import type { LanguageModelClient } from './LanguageModelClient';
import type { GitLogger } from '../core/git/errors';
import type { LruCache } from '../core/cache/LruCache';
import { runCommitSummaryFlow } from '../core/ai/commitSummaryFlow';
import { buildLineExplanationPrompt } from '../core/ai/prompts';
import { buildLineExplanationKey, type LineExplanationState } from '../core/ai/lineExplanationKey';
import { describeNoModelReason } from '../core/ai/modelAvailability';
import { CONFIG } from '../constants';

/**
 * Runs "Explain This Line's History" headlessly — no webview, no panel. Writes its outcome into
 * a shared store that `BlameHoverProvider` reads on the next hover, since a native VS Code Hover
 * can't be updated after it's returned (there is no live-streaming API for hovers).
 */
export class LineExplanationService {
  constructor(
    private readonly git: GitService,
    private readonly languageModelClient: LanguageModelClient,
    private readonly logger: GitLogger,
    private readonly store: LruCache<string, LineExplanationState>,
  ) {}

  /** Reads the current line-explanation state. Used by tests (via `GitLoreTestApi`'s `getLineExplanationStateForTest`) and by `handleExplainLineCommand` itself, to decide whether it's safe to auto-reopen the hover after `explain()` completes. */
  async getState(filePath: string, sha: string, lineContent: string): Promise<LineExplanationState | undefined> {
    const repoRoot = await this.git.getRepoRoot(filePath);
    return this.store.get(buildLineExplanationKey(repoRoot, filePath, sha, lineContent));
  }

  async explain(filePath: string, sha: string, lineContent: string, signal: AbortSignal): Promise<void> {
    const repoRoot = await this.git.getRepoRoot(filePath);
    const key = buildLineExplanationKey(repoRoot, filePath, sha, lineContent);

    const existing = this.store.get(key);
    if (existing?.status === 'pending') {
      return;
    }
    // Captured before the store is overwritten below — this is what lets a repeat request for an
    // already-answered line resolve via runCommitSummaryFlow's own 'cached' short-circuit instead
    // of re-calling the model.
    const cached = existing?.status === 'done' ? existing.text : undefined;

    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.aiEnabled, false);
    const modelFamily = config.get<string>(CONFIG.aiModelFamily, 'gpt-4o');
    const maxDiffChars = config.get<number>(CONFIG.aiMaxDiffChars, 8000);

    // Checked before any git call: git.getCommit/getCommitDiff spawn real git subprocesses whose
    // output would otherwise be thrown away when AI is off, and the hover would show a transient
    // "Generating explanation…" for no reason.
    if (!enabled) {
      void vscode.window.showInformationMessage('GitLore: AI features are disabled.', 'Open Settings').then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.action.openSettings', `${CONFIG.section}.${CONFIG.aiEnabled}`);
        }
      });
      this.store.delete(key);
      return;
    }

    this.store.set(key, { status: 'pending' });

    try {
      const [commit, diff] = await Promise.all([this.git.getCommit(filePath, sha), this.git.getCommitDiff(filePath, sha)]);
      if (!commit) {
        this.store.delete(key);
        return;
      }

      const flow = runCommitSummaryFlow({
        enabled,
        cached,
        signal,
        selectModel: () => this.languageModelClient.selectModel(modelFamily),
        buildPrompt: () => buildLineExplanationPrompt(commit, diff, lineContent, maxDiffChars),
      });

      for await (const event of flow) {
        if (signal.aborted) {
          this.store.delete(key);
          return;
        }
        switch (event.type) {
          case 'disabled':
            // Unreachable: `enabled` is checked above before the store is ever set to 'pending',
            // so runCommitSummaryFlow always runs with enabled=true at this call site. Kept only
            // because SummaryEvent's 'disabled' variant must stay handled for type-exhaustiveness.
            break;
          case 'cached':
            this.store.set(key, { status: 'done', text: event.text });
            break;
          case 'chunk':
            // No live surface to update here — discarded. The full text arrives via 'done' below.
            break;
          case 'done':
            this.store.set(key, { status: 'done', text: event.text });
            break;
          case 'noModel':
            this.store.set(key, { status: 'noModel', message: describeNoModelReason(vscode.env.appName) });
            break;
          case 'error':
            this.logger.error('Line explanation failed', event.message);
            this.store.set(key, { status: 'error', message: event.message });
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Line explanation failed', err);
      this.store.set(key, { status: 'error', message });
    } finally {
      // Safety net: if nothing above resolved the pending state (a zero-yield abort during
      // selectModel(), or any other unexpected fall-through), don't leave the entry stuck at
      // 'pending' forever with no retry link ever shown.
      if (this.store.get(key)?.status === 'pending') {
        this.store.delete(key);
      }
    }
  }
}
