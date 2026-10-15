import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closePullRequestFlow,
  reopenPullRequestFlow,
  mergePullRequestFlow,
  submitReviewFlow,
  type PullRequestActionUi,
  type ActionContext,
} from '../../../src/views/pullRequestActions';
import type { ForgeRepoRef, MergeStrategy, PullRequestSummary, ReviewSubmission } from '../../../src/core/forge/types';
import type { ForgeClient } from '../../../src/core/forge/ForgeClient';

const REPO: ForgeRepoRef = { host: 'github', identity: 'acme/widgets', label: 'acme/widgets' };

function pr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    repo: REPO,
    number: 7,
    title: 'My PR',
    url: 'https://github.com/acme/widgets/pull/7',
    authorLogin: 'raj',
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    requestedReviewers: [],
    checkStatus: 'passing',
    reviewDecision: 'approved',
    hasConflicts: false,
    reviewedByMe: false,
    ...overrides,
  };
}

/** A fake client that records calls and can be configured to throw. */
function fakeClient(opts: {
  onClose?: () => void;
  onReopen?: () => void;
  onMerge?: (strategy: MergeStrategy, deleteSourceBranch: boolean) => void;
  onSubmitReview?: (decision: ReviewSubmission) => void;
  throws?: Error;
  loginToReturn?: string | null;
} = {}): ForgeClient {
  return {
    async closePullRequest() {
      if (opts.throws) throw opts.throws;
      opts.onClose?.();
    },
    async reopenPullRequest() {
      if (opts.throws) throw opts.throws;
      opts.onReopen?.();
    },
    async mergePullRequest(_repo: unknown, _num: unknown, options: { strategy: MergeStrategy; deleteSourceBranch?: boolean }) {
      if (opts.throws) throw opts.throws;
      opts.onMerge?.(options.strategy, options.deleteSourceBranch ?? false);
    },
    async submitReview(_repo: unknown, _num: unknown, decision: ReviewSubmission) {
      if (opts.throws) throw opts.throws;
      opts.onSubmitReview?.(decision);
    },
    async getAuthenticatedLogin() {
      return opts.loginToReturn ?? null;
    },
  } as unknown as ForgeClient;
}

/** A fake UI that records calls and can be configured to return specific answers. */
function fakeUi(opts: {
  confirmAnswer?: string;
  mergeStrategyAnswer?: MergeStrategy;
} = {}): PullRequestActionUi & { warnCalls: string[]; errorCalls: string[] } {
  const warnCalls: string[] = [];
  const errorCalls: string[] = [];
  return {
    warnCalls,
    errorCalls,
    async confirm(_message: string, ..._buttons: string[]): Promise<string | undefined> {
      return opts.confirmAnswer;
    },
    async pickMergeStrategy(_pr: PullRequestSummary): Promise<MergeStrategy | undefined> {
      return opts.mergeStrategyAnswer;
    },
    warn(message: string) { warnCalls.push(message); },
    error(message: string) { errorCalls.push(message); },
  };
}

function ctx(overrides: Partial<ActionContext> & { pr?: PullRequestSummary; client?: ForgeClient; ui?: ReturnType<typeof fakeUi> } = {}): ActionContext {
  return {
    pr: overrides.pr ?? pr(),
    client: overrides.client ?? fakeClient(),
    ui: overrides.ui ?? fakeUi({ confirmAnswer: 'Close PR' }),
    logError: () => undefined,
    myLogin: overrides.myLogin,
    ...overrides,
  };
}

// ─── closePullRequestFlow ────────────────────────────────────────────────────

test('closePullRequestFlow: declining the confirm → no client call, returns false', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: undefined });
  const client = fakeClient({ onClose: () => { called = true; } });
  const result = await closePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.equal(called, false);
});

test('closePullRequestFlow: confirming → client.closePullRequest called, returns true', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: 'Close PR' });
  const client = fakeClient({ onClose: () => { called = true; } });
  const result = await closePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('closePullRequestFlow: client throws → ui.error called, returns false', async () => {
  const ui = fakeUi({ confirmAnswer: 'Close PR' });
  const client = fakeClient({ throws: new Error('network down') });
  const result = await closePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.equal(ui.errorCalls.length, 1);
  assert.match(ui.errorCalls[0] ?? '', /couldn't close the PR/);
  assert.match(ui.errorCalls[0] ?? '', /network down/);
});

// ─── reopenPullRequestFlow ───────────────────────────────────────────────────

test('reopenPullRequestFlow: declining → no client call, returns false', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: undefined });
  const client = fakeClient({ onReopen: () => { called = true; } });
  const result = await reopenPullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.equal(called, false);
});

test('reopenPullRequestFlow: confirming → client.reopenPullRequest called, returns true', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: 'Reopen PR' });
  const client = fakeClient({ onReopen: () => { called = true; } });
  const result = await reopenPullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, true);
  assert.equal(called, true);
});

test('reopenPullRequestFlow: client throws → ui.error, returns false', async () => {
  const ui = fakeUi({ confirmAnswer: 'Reopen PR' });
  const client = fakeClient({ throws: new Error('gone') });
  const result = await reopenPullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.match(ui.errorCalls[0] ?? '', /couldn't reopen the PR/);
  assert.match(ui.errorCalls[0] ?? '', /gone/);
});

// ─── mergePullRequestFlow ────────────────────────────────────────────────────

test('mergePullRequestFlow: no strategy selected → no confirm, no client call, returns false', async () => {
  let confirmCalled = false;
  let clientCalled = false;
  const ui: PullRequestActionUi & { warnCalls: string[]; errorCalls: string[] } = {
    warnCalls: [],
    errorCalls: [],
    async confirm() { confirmCalled = true; return undefined; },
    async pickMergeStrategy() { return undefined; },
    warn() {},
    error() {},
  };
  const client = fakeClient({ onMerge: () => { clientCalled = true; } });
  const result = await mergePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.equal(confirmCalled, false);
  assert.equal(clientCalled, false);
});

test('mergePullRequestFlow: "Merge" confirm → client called with deleteSourceBranch: false', async () => {
  let receivedDelete: boolean | undefined;
  const ui = fakeUi({ mergeStrategyAnswer: 'merge', confirmAnswer: 'Merge' });
  const client = fakeClient({ onMerge: (_s, d) => { receivedDelete = d; } });
  const result = await mergePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, true);
  assert.equal(receivedDelete, false);
});

test('mergePullRequestFlow: "Merge & Delete Branch" → deleteSourceBranch: true', async () => {
  let receivedDelete: boolean | undefined;
  const ui = fakeUi({ mergeStrategyAnswer: 'squash', confirmAnswer: 'Merge & Delete Branch' });
  const client = fakeClient({ onMerge: (_s, d) => { receivedDelete = d; } });
  const result = await mergePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, true);
  assert.equal(receivedDelete, true);
});

test('mergePullRequestFlow: declining the confirm → no client call, returns false', async () => {
  let called = false;
  const ui = fakeUi({ mergeStrategyAnswer: 'merge', confirmAnswer: undefined });
  const client = fakeClient({ onMerge: () => { called = true; } });
  const result = await mergePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.equal(called, false);
});

test('mergePullRequestFlow: client throws → ui.error, returns false', async () => {
  const ui = fakeUi({ mergeStrategyAnswer: 'merge', confirmAnswer: 'Merge' });
  const client = fakeClient({ throws: new Error('conflict') });
  const result = await mergePullRequestFlow({ ...ctx(), ui, client });
  assert.equal(result, false);
  assert.match(ui.errorCalls[0] ?? '', /couldn't merge the PR/);
  assert.match(ui.errorCalls[0] ?? '', /conflict/);
});

// ─── submitReviewFlow ────────────────────────────────────────────────────────

test('submitReviewFlow: own PR (sameLogin match) → ui.warn, no confirm, no call, returns false', async () => {
  let confirmCalled = false;
  let clientCalled = false;
  const ui: PullRequestActionUi & { warnCalls: string[]; errorCalls: string[] } = {
    warnCalls: [],
    errorCalls: [],
    async confirm() { confirmCalled = true; return 'Approve'; },
    async pickMergeStrategy() { return undefined; },
    warn(m) { this.warnCalls.push(m); },
    error() {},
  };
  const client = fakeClient({ onSubmitReview: () => { clientCalled = true; } });
  // authorLogin matches myLogin (case-insensitive via sameLogin)
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'RAJ' }), myLogin: 'raj' }), ui, client }, 'approve');
  assert.equal(result, false);
  assert.equal(confirmCalled, false);
  assert.equal(clientCalled, false);
  assert.match(ui.warnCalls[0] ?? '', /can't review your own pull request/);
});

test('submitReviewFlow: different user, declining confirm → no call, returns false', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: undefined });
  const client = fakeClient({ onSubmitReview: () => { called = true; } });
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'alice' }), myLogin: 'raj' }), ui, client }, 'approve');
  assert.equal(result, false);
  assert.equal(called, false);
});

test('submitReviewFlow: different user, confirming approve → client.submitReview called', async () => {
  let receivedDecision: ReviewSubmission | undefined;
  const ui = fakeUi({ confirmAnswer: 'Approve' });
  const client = fakeClient({ onSubmitReview: (d) => { receivedDecision = d; } });
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'alice' }), myLogin: 'raj' }), ui, client }, 'approve');
  assert.equal(result, true);
  assert.equal(receivedDecision, 'approve');
});

test('submitReviewFlow: requestChanges confirm button matches verb', async () => {
  let receivedDecision: ReviewSubmission | undefined;
  // The confirm button for requestChanges is "Request changes on"
  const ui = fakeUi({ confirmAnswer: 'Request changes on' });
  const client = fakeClient({ onSubmitReview: (d) => { receivedDecision = d; } });
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'alice' }), myLogin: 'raj' }), ui, client }, 'requestChanges');
  assert.equal(result, true);
  assert.equal(receivedDecision, 'requestChanges');
});

test('submitReviewFlow: client throws → ui.error, returns false', async () => {
  const ui = fakeUi({ confirmAnswer: 'Approve' });
  const client = fakeClient({ throws: new Error('rate limited') });
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'alice' }), myLogin: 'raj' }), ui, client }, 'approve');
  assert.equal(result, false);
  assert.match(ui.errorCalls[0] ?? '', /couldn't submit that review/);
  assert.match(ui.errorCalls[0] ?? '', /rate limited/);
});

test('submitReviewFlow: myLogin undefined → no self-review block (no login to compare)', async () => {
  let called = false;
  const ui = fakeUi({ confirmAnswer: 'Approve' });
  const client = fakeClient({ onSubmitReview: () => { called = true; } });
  // myLogin is undefined — can't compare, so no block
  const result = await submitReviewFlow({ ...ctx({ pr: pr({ authorLogin: 'raj' }), myLogin: undefined }), ui, client }, 'approve');
  assert.equal(result, true);
  assert.equal(called, true);
});
