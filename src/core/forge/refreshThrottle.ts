/**
 * Pure throttle helper for Launchpad (and Phase D's status bar) refresh logic.
 * No vscode dependency — reusable by any consumer, injectable clock for tests.
 */

export interface RefreshThrottle {
  /**
   * Returns true only when all conditions are met:
   *  - no refresh is currently in-flight, AND
   *  - enough time has passed since the last successful load (or no load has happened yet).
   */
  shouldRefresh(inFlight: boolean, lastLoadedAt: number | undefined): boolean;
}

/**
 * Creates a throttle checker for refresh decisions.
 *
 * @param minIntervalMs Minimum milliseconds between refreshes (default 60 s → 60_000).
 * @param now Injectable clock — defaults to `Date.now`. Override in tests to control time.
 */
export function createRefreshThrottle(minIntervalMs: number, now: () => number = Date.now): RefreshThrottle {
  return {
    shouldRefresh(inFlight: boolean, lastLoadedAt: number | undefined): boolean {
      if (inFlight) {
        return false;
      }
      if (lastLoadedAt === undefined) {
        return true;
      }
      return now() - lastLoadedAt >= minIntervalMs;
    },
  };
}
