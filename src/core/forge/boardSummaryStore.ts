/**
 * Shared in-memory store for the board's needsReview summary.
 *
 * Vscode-free singleton that LaunchpadViewProvider writes to after every successful full refresh,
 * and LaunchpadStatusBar reads from. Both ends share the same `lastLoadedAt` timestamp so the
 * focus-refresh throttle operates on the most recent load from EITHER source — a Launchpad refresh
 * at T means the status bar won't trigger another network hit until T + 60s, and vice versa.
 *
 * The `loadInFlight` flag lets the status bar skip a focus-triggered refresh while Launchpad is
 * already mid-refresh, preventing a second parallel network load.
 *
 * No vscode import here — core/ must stay host-free and unit-testable without a VS Code process.
 */

import type { BoardResult } from './loadBoard';

export interface BoardSummary {
  /** PRs in the needsReview bucket per human-readable repo label. */
  needsReviewByRepo: Record<string, number>;
  /** Total across all repos. */
  total: number;
  /**
   * `Date.now()` value when this summary was last successfully produced.
   * NOT updated on a total failure — preserved from the previous successful load so
   * the focus-refresh throttle measures from the last GOOD data, not from a failure.
   */
  lastLoadedAt: number;
  /** True when the most recent load attempt failed (last count kept, tooltip gets a stale note). */
  stale: boolean;
}

type Listener = (summary: BoardSummary | null) => void;

/** Module-level singleton — safe in a VS Code extension process (single JS realm). */
let _summary: BoardSummary | null = null;
let _loadInFlight = false;
const _listeners: Listener[] = [];

/** Overwrite the current summary and notify listeners. Also clears the in-flight flag. */
export function setBoardSummary(summary: BoardSummary | null): void {
  _summary = summary;
  _loadInFlight = false;
  for (const l of [..._listeners]) {
    l(summary);
  }
}

export function getBoardSummary(): BoardSummary | null {
  return _summary;
}

/**
 * Marks that a board load has started. Used by `withBoardLoad` — call that instead of this
 * directly wherever possible.
 */
export function markLoadStarted(): void {
  _loadInFlight = true;
}

/**
 * Clears the in-flight flag WITHOUT touching the summary or notifying listeners.
 * Used by `withBoardLoad`'s finally block to recover from early returns and thrown errors that
 * don't reach a `setBoardSummary` call (which also clears the flag). Idempotent — safe to call
 * when the flag is already false (e.g., because `setBoardSummary` already cleared it).
 */
export function markLoadFinished(): void {
  _loadInFlight = false;
}

export function isLoadInFlight(): boolean {
  return _loadInFlight;
}

/**
 * Convenience wrapper: marks a load started, awaits `fn`, then ALWAYS marks it finished in the
 * finally block — even when `fn` returns early without calling `setBoardSummary`, or when it
 * throws. Prevents the in-flight flag from getting stuck (Bug 1). Re-throws any exception from fn.
 *
 * `setBoardSummary` also clears the flag on its own, so the `markLoadFinished()` here is idempotent
 * when the happy path calls `setBoardSummary` — the double-clear is safe.
 */
export async function withBoardLoad<T>(fn: () => Promise<T>): Promise<T> {
  markLoadStarted();
  try {
    return await fn();
  } finally {
    markLoadFinished();
  }
}

/**
 * Subscribes to summary changes. Returns an unsubscribe function.
 * Calling unsubscribe more than once is safe (idempotent).
 */
export function onBoardSummaryChange(listener: Listener): () => void {
  _listeners.push(listener);
  let removed = false;
  return () => {
    if (removed) {
      return;
    }
    removed = true;
    const idx = _listeners.indexOf(listener);
    if (idx !== -1) {
      _listeners.splice(idx, 1);
    }
  };
}

/**
 * Builds the `BoardSummary` to store after a `loadBoard` call, applying the correct rules for
 * partial failures, total failures, and stale data. Use this in BOTH LaunchpadViewProvider and
 * LaunchpadStatusBar so the same logic governs what the status bar shows — no duplicate rule
 * implementations.
 *
 * Rules:
 * - `stale = result.errors.length > 0` (any failed repo marks the whole summary stale).
 * - `needsReview` count includes PRs from repos that previously succeeded but failed this time
 *   (`stale: true` entries in `result.categorized`, kept by `loadBoard`'s C3.2 logic).
 * - Total failure (`result.rawByRepoKey.size === 0`, meaning not a single repo succeeded):
 *   → return `{ ...previous, stale: true }` — preserving the old count AND the old `lastLoadedAt`
 *     so the focus-refresh throttle measures from the last SUCCESSFUL load, not from the failure.
 *   → return `null` when there is no previous (first-ever failure: status bar hides).
 * - Partial or full success: fresh `lastLoadedAt = now`.
 */
export function buildBoardSummary(
  result: BoardResult,
  previous: BoardSummary | null,
  now: number,
): BoardSummary | null {
  const hasAnySuccess = result.rawByRepoKey.size > 0;

  if (!hasAnySuccess) {
    // Total failure — do not report a confident "0".
    if (previous !== null) {
      // Keep last good data: same count, same old timestamp (throttle measures from last SUCCESS).
      return { ...previous, stale: true };
    }
    // First-ever failure — status bar hides per contract.
    return null;
  }

  // At least one repo loaded successfully — count needsReview including stale entries.
  const needsReviewByRepo: Record<string, number> = {};
  let total = 0;
  for (const { pr, bucket } of result.categorized) {
    if (bucket === 'needsReview') {
      const label = pr.repo.label;
      needsReviewByRepo[label] = (needsReviewByRepo[label] ?? 0) + 1;
      total++;
    }
  }

  return {
    needsReviewByRepo,
    total,
    lastLoadedAt: now,
    stale: result.errors.length > 0,
  };
}

/** Resets all module state — for use in tests only. */
export function _resetForTest(): void {
  _summary = null;
  _loadInFlight = false;
  _listeners.length = 0;
}
