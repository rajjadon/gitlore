import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setBoardSummary,
  getBoardSummary,
  markLoadStarted,
  markLoadFinished,
  isLoadInFlight,
  withBoardLoad,
  buildBoardSummary,
  onBoardSummaryChange,
  _resetForTest,
  type BoardSummary,
} from '../../../../src/core/forge/boardSummaryStore';
import type { BoardResult } from '../../../../src/core/forge/loadBoard';
import type { ForgeRepoRef, PullRequestSummary } from '../../../../src/core/forge/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSummary(overrides?: Partial<BoardSummary>): BoardSummary {
  return {
    needsReviewByRepo: {},
    total: 0,
    lastLoadedAt: 1_000_000,
    stale: false,
    ...overrides,
  };
}

const repo: ForgeRepoRef = { host: 'github', identity: 'org/repo', label: 'org/repo' };
const repoB: ForgeRepoRef = { host: 'gitlab', identity: 'org/repoB', label: 'org/repoB' };

function makePr(number: number, authorLogin = 'alice'): PullRequestSummary {
  return {
    repo,
    number,
    title: `PR ${number}`,
    url: `https://github.com/org/repo/pull/${number}`,
    authorLogin,
    isDraft: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    headSha: '',
    requestedReviewers: ['me'],
    checkStatus: 'none',
    reviewDecision: 'none',
    hasConflicts: false,
    reviewedByMe: false,
  };
}

function emptyResult(): BoardResult {
  return {
    categorized: [],
    errors: [],
    loginByRepoKey: new Map(),
    rawByRepoKey: new Map(),
  };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('boardSummaryStore', () => {
  beforeEach(() => {
    _resetForTest();
  });

  // ── existing: get/set ────────────────────────────────────────────────────

  describe('get/set', () => {
    it('returns null before any summary is set', () => {
      assert.strictEqual(getBoardSummary(), null);
    });

    it('returns the most recently set summary', () => {
      const s = makeSummary({ total: 3 });
      setBoardSummary(s);
      assert.deepEqual(getBoardSummary(), s);
    });

    it('returns null after being explicitly reset', () => {
      setBoardSummary(makeSummary());
      setBoardSummary(null);
      assert.strictEqual(getBoardSummary(), null);
    });
  });

  // ── existing: loadInFlight basic ─────────────────────────────────────────

  describe('loadInFlight basic', () => {
    it('is false initially', () => {
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('becomes true after markLoadStarted', () => {
      markLoadStarted();
      assert.strictEqual(isLoadInFlight(), true);
    });

    it('clears back to false when setBoardSummary is called', () => {
      markLoadStarted();
      setBoardSummary(makeSummary());
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('clears when setBoardSummary is called with null (failure path)', () => {
      markLoadStarted();
      setBoardSummary(null);
      assert.strictEqual(isLoadInFlight(), false);
    });
  });

  // ── Bug 1: markLoadFinished ───────────────────────────────────────────────

  describe('markLoadFinished', () => {
    it('clears the in-flight flag without touching the summary', () => {
      const s = makeSummary({ total: 2 });
      setBoardSummary(s);
      markLoadStarted();
      assert.strictEqual(isLoadInFlight(), true);

      markLoadFinished();

      assert.strictEqual(isLoadInFlight(), false);
      // Summary unchanged
      assert.deepEqual(getBoardSummary(), s);
    });

    it('does not notify listeners', () => {
      const received: Array<BoardSummary | null> = [];
      onBoardSummaryChange((s) => received.push(s));

      markLoadStarted();
      markLoadFinished();

      assert.strictEqual(received.length, 0);
    });

    it('is idempotent — calling when not started is a no-op and does not throw', () => {
      assert.strictEqual(isLoadInFlight(), false);
      assert.doesNotThrow(() => markLoadFinished());
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('double call is safe', () => {
      markLoadStarted();
      markLoadFinished();
      markLoadFinished(); // second call must not throw
      assert.strictEqual(isLoadInFlight(), false);
    });
  });

  // ── Bug 1: withBoardLoad ─────────────────────────────────────────────────

  describe('withBoardLoad', () => {
    it('sets in-flight before fn runs', async () => {
      let seenInFlight = false;
      await withBoardLoad(async () => {
        seenInFlight = isLoadInFlight();
      });
      assert.strictEqual(seenInFlight, true);
    });

    it('clears in-flight flag after fn resolves normally', async () => {
      await withBoardLoad(async () => { /* no-op */ });
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('clears in-flight flag when fn throws (bug 1 core contract)', async () => {
      await assert.rejects(
        () => withBoardLoad(async () => { throw new Error('boom'); }),
        /boom/,
      );
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('re-throws the exception from fn', async () => {
      await assert.rejects(
        () => withBoardLoad(async () => { throw new Error('expected'); }),
        /expected/,
      );
    });

    it('clears in-flight even when fn returns early without calling setBoardSummary', async () => {
      await withBoardLoad(async () => {
        // early return path — no setBoardSummary call
        return;
      });
      assert.strictEqual(isLoadInFlight(), false);
    });

    it('resolves to the fn return value', async () => {
      const result = await withBoardLoad(async () => 42);
      assert.strictEqual(result, 42);
    });

    it('clears in-flight flag only once when fn also calls setBoardSummary (idempotent)', async () => {
      await withBoardLoad(async () => {
        setBoardSummary(makeSummary()); // setBoardSummary clears _loadInFlight too
      });
      // No double-clear error — just stays false.
      assert.strictEqual(isLoadInFlight(), false);
    });
  });

  // ── existing: onBoardSummaryChange ───────────────────────────────────────

  describe('onBoardSummaryChange', () => {
    it('notifies listener when summary changes', () => {
      const received: Array<BoardSummary | null> = [];
      onBoardSummaryChange((s) => received.push(s));

      const s = makeSummary({ total: 5 });
      setBoardSummary(s);
      assert.strictEqual(received.length, 1);
      assert.deepEqual(received[0], s);
    });

    it('notifies listener when summary is set to null', () => {
      const received: Array<BoardSummary | null> = [];
      onBoardSummaryChange((s) => received.push(s));
      setBoardSummary(null);
      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], null);
    });

    it('unsubscribe stops future notifications', () => {
      const received: Array<BoardSummary | null> = [];
      const unsub = onBoardSummaryChange((s) => received.push(s));

      setBoardSummary(makeSummary({ total: 1 }));
      unsub();
      setBoardSummary(makeSummary({ total: 2 }));

      assert.strictEqual(received.length, 1);
    });

    it('double unsubscribe is safe (idempotent)', () => {
      const received: Array<BoardSummary | null> = [];
      const unsub = onBoardSummaryChange((s) => received.push(s));
      unsub();
      unsub(); // should not throw
      setBoardSummary(makeSummary());
      assert.strictEqual(received.length, 0);
    });

    it('multiple listeners each receive the update', () => {
      const a: Array<BoardSummary | null> = [];
      const b: Array<BoardSummary | null> = [];
      onBoardSummaryChange((s) => a.push(s));
      onBoardSummaryChange((s) => b.push(s));

      setBoardSummary(makeSummary({ total: 7 }));
      assert.strictEqual(a.length, 1);
      assert.strictEqual(b.length, 1);
    });

    it('removing a listener during notification does not crash', () => {
      const received: number[] = [];
      // Store unsubscribe in a wrapper so the closure can reference it before assignment.
      const wrapper = { unsub: () => {} };
      wrapper.unsub = onBoardSummaryChange(() => {
        received.push(1);
        wrapper.unsub(); // remove self during callback
      });

      setBoardSummary(makeSummary());
      setBoardSummary(makeSummary()); // second call must not invoke the removed listener
      assert.strictEqual(received.length, 1);
    });
  });

  // ── Bug 2: buildBoardSummary ──────────────────────────────────────────────

  describe('buildBoardSummary', () => {
    it('normal success: returns count, stale=false, lastLoadedAt=now', () => {
      const pr1 = makePr(1);
      const result: BoardResult = {
        categorized: [{ pr: pr1, bucket: 'needsReview' }],
        errors: [],
        loginByRepoKey: new Map([['github:org/repo', 'me']]),
        rawByRepoKey: new Map([['github:org/repo', { login: 'me', open: [pr1], closed: [] }]]),
      };

      const summary = buildBoardSummary(result, null, 2_000_000);
      assert.ok(summary !== null);
      assert.strictEqual(summary.total, 1);
      assert.strictEqual(summary.stale, false);
      assert.strictEqual(summary.lastLoadedAt, 2_000_000);
      assert.deepEqual(summary.needsReviewByRepo, { 'org/repo': 1 });
    });

    it('partial failure: stale=true, fresh timestamp, stale PRs included in count', () => {
      const stalePr = makePr(2);
      const result: BoardResult = {
        // stale PR from a failed repo (C3.2 keep-last-good-data path)
        categorized: [{ pr: stalePr, bucket: 'needsReview', stale: true }],
        errors: [{ repo, message: 'timeout' }],
        loginByRepoKey: new Map([['github:org/repoB', 'me']]),
        // at least one repo succeeded (repoB)
        rawByRepoKey: new Map([['github:org/repoB', { login: 'me', open: [], closed: [] }]]),
      };

      const summary = buildBoardSummary(result, null, 3_000_000);
      assert.ok(summary !== null);
      assert.strictEqual(summary.stale, true, 'partial failure must be marked stale');
      assert.strictEqual(summary.lastLoadedAt, 3_000_000, 'fresh timestamp even on partial failure');
      assert.strictEqual(summary.total, 1, 'stale needsReview PRs must be counted');
    });

    it('total failure with previous: returns previous with stale=true and OLD timestamp', () => {
      const previous = makeSummary({ total: 5, lastLoadedAt: 500_000, stale: false });
      const result: BoardResult = {
        categorized: [],
        errors: [{ repo, message: 'all failed' }],
        loginByRepoKey: new Map(),
        rawByRepoKey: new Map(), // size === 0 → total failure
      };

      const summary = buildBoardSummary(result, previous, 9_000_000);
      assert.ok(summary !== null, 'must not return null when previous data exists');
      assert.strictEqual(summary.stale, true);
      assert.strictEqual(summary.lastLoadedAt, 500_000, 'must keep old successful timestamp, not the failure time');
      assert.strictEqual(summary.total, 5, 'must preserve previous count');
    });

    it('total failure without previous: returns null (status bar hides)', () => {
      const result: BoardResult = {
        categorized: [],
        errors: [{ repo, message: 'all failed' }],
        loginByRepoKey: new Map(),
        rawByRepoKey: new Map(),
      };

      assert.strictEqual(buildBoardSummary(result, null, 9_000_000), null);
    });

    it('no repos at all (empty result): same rules as total failure', () => {
      assert.strictEqual(buildBoardSummary(emptyResult(), null, 1), null);
      const prev = makeSummary({ total: 3, lastLoadedAt: 100 });
      const s = buildBoardSummary(emptyResult(), prev, 200);
      assert.ok(s !== null);
      assert.strictEqual(s.stale, true);
      assert.strictEqual(s.lastLoadedAt, 100); // old timestamp preserved
    });

    it('per-repo breakdown keyed by repo label', () => {
      const pr1 = makePr(1);
      const pr2 = { ...makePr(2), repo: repoB };
      const result: BoardResult = {
        categorized: [
          { pr: pr1, bucket: 'needsReview' },
          { pr: pr2, bucket: 'needsReview' },
        ],
        errors: [],
        loginByRepoKey: new Map([['github:org/repo', 'me'], ['gitlab:org/repoB', 'me']]),
        rawByRepoKey: new Map([
          ['github:org/repo', { login: 'me', open: [pr1], closed: [] }],
          ['gitlab:org/repoB', { login: 'me', open: [pr2], closed: [] }],
        ]),
      };

      const summary = buildBoardSummary(result, null, 1);
      assert.ok(summary !== null);
      assert.deepEqual(summary.needsReviewByRepo, { 'org/repo': 1, 'org/repoB': 1 });
      assert.strictEqual(summary.total, 2);
    });

    it('non-needsReview buckets are not counted', () => {
      const pr1 = makePr(1);
      const pr2 = makePr(2);
      const result: BoardResult = {
        categorized: [
          { pr: pr1, bucket: 'needsReview' },
          { pr: pr2, bucket: 'waiting' },
        ],
        errors: [],
        loginByRepoKey: new Map([['github:org/repo', 'me']]),
        rawByRepoKey: new Map([['github:org/repo', { login: 'me', open: [pr1, pr2], closed: [] }]]),
      };

      const summary = buildBoardSummary(result, null, 1);
      assert.ok(summary !== null);
      assert.strictEqual(summary.total, 1);
    });
  });
});
