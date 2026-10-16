import * as vscode from 'vscode';
import type { ForgeClient } from '../../core/forge/ForgeClient';
import type { ConversationThread, MergeStrategy, PullRequestSummary, ReviewSubmission } from '../../core/forge/types';
import { renderPullRequestDetailsHtml, renderChecks } from './render';
import { PullRequestDiffCache } from '../../core/forge/PullRequestDiffCache';
import { renderPlaceholderHtml } from '../placeholder';
import { waitForWebviewView } from '../waitForWebviewView';
import { LruCache } from '../../core/cache/LruCache';
import type { LanguageModelClient } from '../../ai/LanguageModelClient';
import type { GitLogger } from '../../core/git/errors';
import { buildPrExplanationPrompt, buildPrReviewDraftPrompt } from '../../core/ai/prompts';
import { runReviewFlow } from '../../core/ai/reviewFlow';
import {
  buildFileReviewPrompt,
  buildReviewSynthesisPrompt,
  buildExplanationSynthesisPrompt,
} from '../../core/ai/fileReview';
import { describeNoModelReason } from '../../core/ai/modelAvailability';
import { CONFIG, MEDIA, VIEWS } from '../../constants';
import { closePullRequestFlow, mergePullRequestFlow, reopenPullRequestFlow, submitReviewFlow } from '../pullRequestActions';
import { vscodePullRequestActionUi } from '../pullRequestActionUi';
import { diffCacheKey } from '../../core/forge/PullRequestDiffCache';
import type { PullRequestDiff } from '../../core/forge/types';
import { createNonce } from '../nonce';
import { showAiDisabledNotice } from '../../ai/showAiDisabledNotice';

/** Docks a PR's diff/commits in the bottom panel (next to Commit Details), instead of opening a new editor tab per PR — same shape as `CommitDetailsViewProvider`, for a PR instead of a local commit. */
export class PullRequestDetailsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private currentPr: PullRequestSummary | undefined;
  private currentUrl: string | undefined;
  private currentClient: ForgeClient | undefined;
  private aiSummaryCache = new LruCache<string, string>(50);
  /**
   * Per-file summary cache for the map step in large-diff reviews and explanations (E1.3).
   *
   * Key: `diffCacheKey(pr) + ':file:' + filePath`. Using the same key prefix as the diff cache
   * means a new headSha automatically invalidates every per-file entry for that PR — no explicit
   * eviction needed. Sized generously (200) to hold all files across a typical large PR session.
   */
  private fileSummaryCache = new LruCache<string, string>(200);
  /**
   * Shared diff cache across load/explainPr/draftReview. Handles concurrent in-flight
   * deduplication, rejected-fetch-not-cached, force-push invalidation, and empty-headSha
   * keying on updatedAt (B1.3 a–d). See PullRequestDiffCache for the full guarantee set.
   */
  private diffCache = new PullRequestDiffCache();
  private aiAbortController: AbortController | undefined;
  private aiMessagesForTest: unknown[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly languageModelClient: LanguageModelClient,
    private readonly logger: GitLogger,
  ) {}

  /** Test-only introspection seam — VS Code's public API doesn't expose a webview's rendered HTML. */
  getCurrentHtmlForTest(): string | undefined {
    return this.view?.webview.html;
  }

  getAiSummaryMessagesForTest(): unknown[] {
    return this.aiMessagesForTest;
  }

  /**
   * Test-only seam — clears the diff cache so the next explainPr/draftReview truly fetches from
   * the network instead of being served the result already cached by load(). This lets integration
   * tests simulate a post-load credential expiry or rate-limit by counting diff calls.
   */
  clearDiffCacheForTest(): void {
    this.diffCache = new PullRequestDiffCache();
  }

  /** A short label for the chat's subject chip, e.g. when opened via "Ask about this PR". */
  getCurrentSubjectForChat(): string | undefined {
    return this.currentPr ? `PR #${this.currentPr.number} — ${this.currentPr.title}` : undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    if (!this.currentPr) {
      webviewView.webview.html = renderPlaceholderHtml('Open a PR from Launchpad to see its details.', {
        nonce: createNonce(),
        cspSource: webviewView.webview.cspSource,
        styleUris: [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.pullRequestDetails)],
      });
    }
  }

  /** Called by the "Show Pull Request Details" command — reveals the panel tab and loads the given PR's diff. */
  async show(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    await vscode.commands.executeCommand(`${VIEWS.pullRequestDetails}.focus`);
    await waitForWebviewView(() => this.view);
    await this.load(pr, client);
  }

  private mediaUri(name: string): string {
    return this.view?.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name)).toString() ?? '';
  }

  /**
   * Fetches (or returns cached) diff for the given PR. Delegates to PullRequestDiffCache which
   * satisfies B1.3 a–d: in-flight deduplication, rejected-fetch-not-cached, force-push
   * invalidation, and empty-headSha keying on updatedAt.
   */
  private async fetchDiff(pr: PullRequestSummary, client: ForgeClient): Promise<PullRequestDiff> {
    return this.diffCache.getOrFetch(pr, client);
  }

  private async load(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    if (!this.view) {
      return;
    }
    this.currentPr = pr;
    this.currentUrl = pr.url;
    this.currentClient = client;
    this.aiAbortController?.abort();
    this.aiMessagesForTest = [];
    this.view.title = `PR #${pr.number}`;
    const styleUris = [this.mediaUri(MEDIA.shared), this.mediaUri(MEDIA.pullRequestDetails)];
    this.view.webview.html = renderPlaceholderHtml('Loading pull request…', {
      nonce: createNonce(),
      cspSource: this.view.webview.cspSource,
      styleUris,
      variant: 'loading',
    });

    try {
      const [diffResult, threads] = await Promise.all([
        this.fetchDiff(pr, client),
        client.listConversationThreads(pr.repo, pr.number),
      ]);
      if (!this.view) {
        return;
      }
      this.view.webview.html = renderPullRequestDetailsHtml(
        { pr, files: diffResult.files, diff: diffResult.diff, threads },
        {
          nonce: createNonce(),
          cspSource: this.view.webview.cspSource,
          styleUris,
        },
      );
      // Load checks lazily after the initial render so they don't block the diff (B4.3).
      // Runs async — the checks skeleton in the HTML is replaced by the result.
      void this.loadChecks(pr, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.view.webview.html = renderPlaceholderHtml(`GitLore: failed to load this pull request's diff — ${message}`, {
        nonce: createNonce(),
        cspSource: this.view.webview.cspSource,
        styleUris,
        variant: 'error',
      });
    }
  }

  /**
   * Fetches checks and posts the rendered HTML to the webview's checks section. A load failure
   * posts an inline error message — it never throws out of load() or blocks the diff (B4.3).
   */
  private async loadChecks(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    try {
      const checks = await client.listChecks(pr.repo, pr.number);
      void this.view?.webview.postMessage({ type: 'checksLoaded', html: renderChecks(checks) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.view?.webview.postMessage({ type: 'checksFailed', message });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const msg = message as Record<string, unknown>;
    const type = msg['type'];
    const body = msg['body'];
    const threadId = msg['threadId'];
    const decision = msg['decision'];
    const url = msg['url'];

    if (type === 'openRemote' && this.currentUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(this.currentUrl));
      return;
    }
    if (type === 'addComment' && typeof body === 'string' && this.currentPr && this.currentClient) {
      await this.addComment(this.currentPr, this.currentClient, body);
      return;
    }
    if (type === 'resolveThread' && typeof threadId === 'string' && this.currentPr && this.currentClient) {
      await this.resolveThread(this.currentPr, this.currentClient, threadId);
      return;
    }
    if (type === 'unresolveThread' && typeof threadId === 'string' && this.currentPr && this.currentClient) {
      await this.unresolveThread(this.currentPr, this.currentClient, threadId);
      return;
    }
    if (type === 'replyToThread' && typeof threadId === 'string' && typeof body === 'string' && this.currentPr && this.currentClient) {
      await this.replyToThread(this.currentPr, this.currentClient, threadId, body);
      return;
    }
    if (type === 'openCheckUrl' && typeof url === 'string') {
      // Only http(s) URLs are opened — other schemes (javascript:, file:, …) are rejected silently.
      // The render layer already omits data-check-url for unsafe schemes; this is defense in depth.
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          this.logger.error(`PR Details: rejected check URL with unsafe scheme: ${parsed.protocol}`);
        }
      } catch {
        this.logger.error(`PR Details: rejected malformed check URL: ${url}`);
      }
      return;
    }
    if (type === 'explainPr') {
      await this.explainPr();
      return;
    }
    if (type === 'draftReview') {
      await this.draftReview();
      return;
    }
    if (type === 'closePr' && this.currentPr && this.currentClient) {
      await this.closePullRequest(this.currentPr, this.currentClient);
      return;
    }
    if (type === 'reopenPr' && this.currentPr && this.currentClient) {
      await this.reopenPullRequest(this.currentPr, this.currentClient);
      return;
    }
    if (type === 'mergePr' && this.currentPr && this.currentClient) {
      await this.mergePullRequest(this.currentPr, this.currentClient);
      return;
    }
    if (type === 'submitReview' && (decision === 'approve' || decision === 'requestChanges') && this.currentPr && this.currentClient) {
      const reviewBody = typeof body === 'string' ? body : undefined;
      await this.submitReview(this.currentPr, this.currentClient, decision, reviewBody);
      return;
    }
    if (type === 'refresh' && this.currentPr && this.currentClient) {
      // The panel doesn't know about actions taken elsewhere (e.g. approving this same PR from a
      // Launchpad card) — a manual refresh is the deliberately simple fix over wiring up
      // cross-webview notifications for what's a rare case.
      await this.load(this.currentPr, this.currentClient);
    }
  }

  private async resolveThread(pr: PullRequestSummary, client: ForgeClient, threadId: string): Promise<void> {
    try {
      await client.resolveConversationThread(pr.repo, pr.number, threadId);
      // Reloads the whole panel (diff included) rather than patching just the thread list in
      // place — same "confirm/act, then reload" shape every other write action in this feature
      // uses (Launchpad's close/approve/comment all do a full refresh too), and a PR's diff is
      // cheap enough to refetch that a separate partial-update path isn't worth the extra code.
      await this.load(pr, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`GitLore: couldn't resolve that conversation — ${message}`);
      // On success the whole panel reloads, which clears the button's disabled state along with
      // everything else — on failure nothing else re-renders, so the button needs telling explicitly.
      void this.view?.webview.postMessage({ type: 'resolveThreadFailed', threadId });
    }
  }

  /** Test-only introspection seam — a webview button click can't be driven from an integration test, so this calls the resolve flow directly. */
  async resolveThreadForTest(threadId: string): Promise<void> {
    if (!this.currentPr || !this.currentClient) {
      return;
    }
    await this.resolveThread(this.currentPr, this.currentClient, threadId);
  }

  private async unresolveThread(pr: PullRequestSummary, client: ForgeClient, threadId: string): Promise<void> {
    try {
      await client.unresolveConversationThread(pr.repo, pr.number, threadId);
      await this.load(pr, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`GitLore: couldn't unresolve that conversation — ${message}`);
      void this.view?.webview.postMessage({ type: 'unresolveThreadFailed', threadId });
    }
  }

  /** Test-only seam — unresolve a thread by ID without needing a webview click. */
  async unresolveThreadForTest(threadId: string): Promise<void> {
    if (!this.currentPr || !this.currentClient) { return; }
    await this.unresolveThread(this.currentPr, this.currentClient, threadId);
  }

  private async replyToThread(pr: PullRequestSummary, client: ForgeClient, threadId: string, body: string): Promise<void> {
    try {
      await client.replyToThread(pr.repo, pr.number, threadId, body);
      void this.view?.webview.postMessage({ type: 'replyPosted', threadId });
      // Reload threads so the new reply appears without a full page reload (the diff stays cached).
      await this.load(pr, client);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`GitLore: couldn't post that reply — ${message}`);
      void this.view?.webview.postMessage({ type: 'replyFailed', threadId });
    }
  }

  /** Test-only seam — reply to a thread directly. */
  async replyToThreadForTest(threadId: string, body: string): Promise<void> {
    if (!this.currentPr || !this.currentClient) { return; }
    await this.replyToThread(this.currentPr, this.currentClient, threadId, body);
  }

  /** After a successful action, refetch and re-render. On failure, posts `actionFailed` so the webview can reset its busy state. */
  private async reloadAfterAction(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    try {
      const refreshed = await client.getPullRequest(pr.repo, pr.number);
      await this.load(refreshed, client);
    } catch (err) {
      void this.view?.webview.postMessage({ type: 'actionFailed' });
      this.logger.error(`PR Details failed to refresh PR #${pr.number} after action`, err);
    }
  }

  private async closePullRequest(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    const changed = await closePullRequestFlow({
      pr, client, ui: vscodePullRequestActionUi,
      logError: (m, e) => { this.logger.error(`PR Details: ${m}`, e); void this.view?.webview.postMessage({ type: 'actionFailed' }); },
    });
    if (changed) await this.reloadAfterAction(pr, client);
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the close flow with an auto-confirming UI. Now also exercises real flow logic. */
  async closePullRequestForTest(): Promise<void> {
    if (!this.currentPr || !this.currentClient) return;
    const changed = await closePullRequestFlow({
      pr: this.currentPr, client: this.currentClient,
      ui: { async confirm(_m, ...b) { return b[0]; }, async pickMergeStrategy() { return undefined; }, warn() {}, error() {} },
      logError: () => undefined,
    });
    if (changed) {
      const refreshed = await this.currentClient.getPullRequest(this.currentPr.repo, this.currentPr.number);
      await this.load(refreshed, this.currentClient);
    }
  }

  private async reopenPullRequest(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    const changed = await reopenPullRequestFlow({
      pr, client, ui: vscodePullRequestActionUi,
      logError: (m, e) => { this.logger.error(`PR Details: ${m}`, e); void this.view?.webview.postMessage({ type: 'actionFailed' }); },
    });
    if (changed) await this.reloadAfterAction(pr, client);
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the reopen flow with an auto-confirming UI. */
  async reopenPullRequestForTest(): Promise<void> {
    if (!this.currentPr || !this.currentClient) return;
    const changed = await reopenPullRequestFlow({
      pr: this.currentPr, client: this.currentClient,
      ui: { async confirm(_m, ...b) { return b[0]; }, async pickMergeStrategy() { return undefined; }, warn() {}, error() {} },
      logError: () => undefined,
    });
    if (changed) {
      const refreshed = await this.currentClient.getPullRequest(this.currentPr.repo, this.currentPr.number);
      await this.load(refreshed, this.currentClient);
    }
  }

  /** A QuickPick for the strategy (filtered to what this PR's host actually supports), then one modal confirm with two buttons — "Merge" and "Merge & Delete Branch" — matching Launchpad's card Merge action exactly. */
  private async mergePullRequest(pr: PullRequestSummary, client: ForgeClient): Promise<void> {
    const changed = await mergePullRequestFlow({
      pr, client, ui: vscodePullRequestActionUi,
      logError: (m, e) => { this.logger.error(`PR Details: ${m}`, e); void this.view?.webview.postMessage({ type: 'actionFailed' }); },
    });
    if (changed) await this.reloadAfterAction(pr, client);
  }

  /** Test-only introspection seam — the merge QuickPick and confirmation modal can't be driven from an integration test, so this calls the merge flow with a fixed strategy/delete choice. */
  async mergePullRequestForTest(strategy: MergeStrategy, deleteSourceBranch: boolean): Promise<void> {
    if (!this.currentPr || !this.currentClient) return;
    const changed = await mergePullRequestFlow({
      pr: this.currentPr, client: this.currentClient,
      ui: {
        async confirm(_m, ...b) { return b.find((btn) => btn === (deleteSourceBranch ? 'Merge & Delete Branch' : 'Merge')); },
        async pickMergeStrategy() { return strategy; },
        warn() {}, error() {},
      },
      logError: () => undefined,
    });
    if (changed) {
      const refreshed = await this.currentClient.getPullRequest(this.currentPr.repo, this.currentPr.number);
      await this.load(refreshed, this.currentClient);
    }
  }

  /**
   * `getAuthenticatedLogin` is called live each time (not cached) — the panel only shows one PR at
   * a time, so the overhead is negligible, and it's more accurate than a stale cached value.
   */
  private async submitReview(pr: PullRequestSummary, client: ForgeClient, decision: ReviewSubmission, body?: string): Promise<void> {
    const login = await client.getAuthenticatedLogin();
    const changed = await submitReviewFlow({
      pr, client, ui: vscodePullRequestActionUi,
      logError: (m, e) => { this.logger.error(`PR Details: ${m}`, e); void this.view?.webview.postMessage({ type: 'actionFailed' }); },
      myLogin: login ?? undefined,
    }, decision, body);
    if (changed) await this.reloadAfterAction(pr, client);
  }

  /** Test-only introspection seam — a webview button click (and the real confirmation modal it triggers) can't be driven from an integration test, so this calls the review flow with an auto-confirming UI. Now also exercises the self-review guard. */
  async submitReviewForTest(decision: ReviewSubmission): Promise<void> {
    if (!this.currentPr || !this.currentClient) return;
    const login = await this.currentClient.getAuthenticatedLogin();
    const verb = decision === 'approve' ? 'Approve' : 'Request changes on';
    const changed = await submitReviewFlow({
      pr: this.currentPr, client: this.currentClient,
      ui: { async confirm(_m, ...b) { return b.find((btn) => btn === verb); }, async pickMergeStrategy() { return undefined; }, warn() {}, error() {} },
      logError: () => undefined,
      myLogin: login ?? undefined,
    }, decision);
    if (changed) {
      const refreshed = await this.currentClient.getPullRequest(this.currentPr.repo, this.currentPr.number);
      await this.load(refreshed, this.currentClient);
    }
  }

  private async addComment(pr: PullRequestSummary, client: ForgeClient, body: string): Promise<void> {
    try {
      await client.addComment(pr.repo, pr.number, body);
      void this.view?.webview.postMessage({ type: 'commentPosted' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`GitLore: couldn't post that comment — ${message}`);
      void this.view?.webview.postMessage({ type: 'commentFailed' });
    }
  }

  /** Test-only introspection seam — a webview form submit can't be driven from an integration test, so this calls the comment flow directly. */
  async addCommentForTest(body: string): Promise<void> {
    if (!this.currentPr || !this.currentClient) {
      return;
    }
    await this.addComment(this.currentPr, this.currentClient, body);
  }

  async explainPr(): Promise<void> {
    if (!this.view || !this.currentPr) {
      return;
    }
    this.aiAbortController?.abort();
    const controller = new AbortController();
    this.aiAbortController = controller;

    const pr = this.currentPr;
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.aiEnabled, false);
    const modelFamily = config.get<string>(CONFIG.aiModelFamily, 'gpt-4o');
    const maxDiffChars = config.get<number>(CONFIG.aiMaxDiffChars, 8000);

    // AI summary cache now keyed by diffCacheKey(pr) which includes headSha — a force-push
    // produces a different key and invalidates the stale explanation (fixes P5 from the roadmap).
    const cacheKey = diffCacheKey(pr);
    const cached = this.aiSummaryCache.get(cacheKey);

    if (!enabled) {
      // Check before any I/O — a disabled-AI click must not trigger a diff fetch.
      void showAiDisabledNotice();
      this.postAiMessage({ type: 'aiSummaryReset' });
      return;
    }

    if (cached) {
      this.postAiMessage({ type: 'aiSummaryCached', text: cached });
      return;
    }

    // Fetch diff before starting the model flow. Uses the shared diff cache — no extra network
    // call if load() already fetched this diff for the current PR head SHA.
    let diff = '';
    if (this.currentClient) {
      try {
        const diffResult = await this.fetchDiff(pr, this.currentClient);
        diff = diffResult.diff;
      } catch (err) {
        // A rejection here (expired credential, rate limit, network blip) throws out of explainPr()
        // before the flow starts, leaving the Explain button permanently disabled with no feedback.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('AI PR explanation failed to fetch the diff', err);
        this.postAiMessage({ type: 'aiSummaryError', message });
        return;
      }
    }

    // Per-file summary cache helpers: key = diffCacheKey(pr) + ':file:' + path.
    // A new headSha changes the prefix → automatic invalidation of all file entries (E1.3).
    const fileKeyPrefix = `${cacheKey}:file:`;
    const getCachedFileSummary = (path: string): string | undefined =>
      this.fileSummaryCache.get(`${fileKeyPrefix}${path}`);
    const setCachedFileSummary = (path: string, notes: string): void => {
      this.fileSummaryCache.set(`${fileKeyPrefix}${path}`, notes);
    };

    const flow = runReviewFlow({
      enabled: true, // already checked above
      diff,
      maxDiffChars,
      signal: controller.signal,
      selectModel: () => this.languageModelClient.selectModel(modelFamily),
      // Small diff: single call using the existing prompt (E1.4 "unchanged for small diffs").
      buildSingleCallPrompt: () => buildPrExplanationPrompt(pr, diff, maxDiffChars),
      // Large diff: per-file review prompt then explanation synthesis (E1.4).
      buildFilePrompt: (path, fileDiff) => buildFileReviewPrompt(path, fileDiff, maxDiffChars),
      buildSynthesisPrompt: (perFileNotes, overflowPaths, skippedPaths) =>
        buildExplanationSynthesisPrompt(pr, perFileNotes, overflowPaths, skippedPaths),
      getCachedFileSummary,
      setCachedFileSummary,
    });

    for await (const event of flow) {
      if (controller.signal.aborted) {
        return;
      }
      switch (event.type) {
        case 'disabled':
          // Won't fire: we pass enabled: true. Handled defensively in case the flow is called
          // directly in tests with enabled: false.
          this.postAiMessage({ type: 'aiSummaryReset' });
          break;
        case 'noModel':
          this.postAiMessage({ type: 'aiSummaryNoModel', message: describeNoModelReason(vscode.env.appName) });
          break;
        case 'progress':
          // Show per-file progress in the hint area during the map step (E1.4).
          this.postAiMessage({ type: 'aiSummaryProgress', message: event.message });
          break;
        case 'chunk':
          this.postAiMessage({ type: 'aiSummaryChunk', text: event.text });
          break;
        case 'done':
          this.aiSummaryCache.set(cacheKey, event.text);
          this.postAiMessage({ type: 'aiSummaryDone' });
          break;
        case 'error':
          this.logger.error('AI PR explanation failed', event.message);
          this.postAiMessage({ type: 'aiSummaryError', message: event.message });
          break;
      }
    }
  }

  async draftReview(): Promise<void> {
    if (!this.view || !this.currentPr || !this.currentClient) {
      return;
    }
    this.aiAbortController?.abort();
    const controller = new AbortController();
    this.aiAbortController = controller;

    const pr = this.currentPr;
    const client = this.currentClient;
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    const enabled = config.get<boolean>(CONFIG.aiEnabled, false);
    const modelFamily = config.get<string>(CONFIG.aiModelFamily, 'gpt-4o');
    const maxDiffChars = config.get<number>(CONFIG.aiMaxDiffChars, 8000);

    // Same guard as explainPr(): checking `enabled` before fetching anything keeps a disabled-AI
    // click from firing two real network calls to the forge host only to discard both results.
    // runReviewFlow's own 'disabled' branch fires too late to protect the fetch below it (E1.3).
    let diff = '';
    let threads: ConversationThread[] = [];
    if (enabled) {
      try {
        const [diffResult, threadsResult] = await Promise.all([
          // Uses the shared diff cache — no extra network call if load() already fetched this diff.
          this.fetchDiff(pr, client),
          client.listConversationThreads(pr.repo, pr.number),
        ]);
        diff = diffResult.diff;
        threads = threadsResult;
      } catch (err) {
        // A rejection here throws out of draftReview() before the flow starts, leaving Draft Review
        // disabled forever with no feedback.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('AI PR review draft failed to fetch the diff/threads', err);
        this.postAiMessage({ type: 'draftReviewError', message });
        return;
      }
    }

    // Per-file summary cache helpers shared with explainPr (same key prefix → same cache entries).
    // Re-drafting after resolving a thread reuses file summaries already computed (E1.3).
    const fileKeyPrefix = `${diffCacheKey(pr)}:file:`;
    const getCachedFileSummary = (path: string): string | undefined =>
      this.fileSummaryCache.get(`${fileKeyPrefix}${path}`);
    const setCachedFileSummary = (path: string, notes: string): void => {
      this.fileSummaryCache.set(`${fileKeyPrefix}${path}`, notes);
    };

    const flow = runReviewFlow({
      enabled,
      diff,
      maxDiffChars,
      signal: controller.signal,
      selectModel: () => this.languageModelClient.selectModel(modelFamily),
      // Small diff: single call using the existing prompt — behaviour unchanged (E1.2).
      buildSingleCallPrompt: () => buildPrReviewDraftPrompt(pr, diff, threads, maxDiffChars),
      // Large diff: per-file review prompt then synthesis (E1.2).
      buildFilePrompt: (path, fileDiff) => buildFileReviewPrompt(path, fileDiff, maxDiffChars),
      buildSynthesisPrompt: (perFileNotes, overflowPaths, skippedPaths) =>
        buildReviewSynthesisPrompt(pr, perFileNotes, overflowPaths, skippedPaths, threads),
      getCachedFileSummary,
      setCachedFileSummary,
    });

    for await (const event of flow) {
      if (controller.signal.aborted) {
        return;
      }
      switch (event.type) {
        case 'disabled':
          void showAiDisabledNotice();
          this.postAiMessage({ type: 'draftReviewReset' });
          break;
        case 'noModel':
          this.postAiMessage({ type: 'draftReviewNoModel', message: describeNoModelReason(vscode.env.appName) });
          break;
        case 'progress':
          // Per-file progress during the map step — shown as an aria-live status line (E1.2).
          this.postAiMessage({ type: 'draftReviewProgress', message: event.message });
          break;
        case 'chunk':
          this.postAiMessage({ type: 'draftReviewChunk', text: event.text });
          break;
        case 'done':
          this.postAiMessage({ type: 'draftReviewDone' });
          break;
        case 'error':
          this.logger.error('AI PR review draft failed', event.message);
          this.postAiMessage({ type: 'draftReviewError', message: event.message });
          break;
      }
    }
  }

  private postAiMessage(message: { type: string; text?: string; message?: string }): void {
    this.aiMessagesForTest.push(message);
    void this.view?.webview.postMessage(message);
  }
}
