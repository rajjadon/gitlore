/**
 * Snooze state management for the Launchpad — pure functions, no vscode imports, fully testable.
 *
 * Store format: `Record<prKey, SnoozeEntry>` where each entry is one of:
 *   - `{ until: number }` — timed snooze; snoozed while `now < until`.
 *   - `{ updatedAt: string }` — "until PR changes"; snoozed while PR's `updatedAt` matches.
 *     Auto-unsnoozed the moment the PR is updated on the host.
 *   - `{ legacy: true }` — migrated from the old `string[]` format. Treated as snoozed until
 *     `stampLegacySnoozes` converts it to a proper `{ updatedAt }` entry on the first successful
 *     board load that includes this PR. This preserves user intent across the upgrade.
 *
 * Migration: callers call `migrateSnoozeState` on whatever was stored and always get back a valid
 * `SnoozeStore`. Old format (`string[]`) entries become `{ legacy: true }` — snoozed, not expired.
 */

export interface SnoozeEntry {
  /** Unix timestamp (ms) after which the snooze expires. Absent for "until PR changes". */
  until?: number;
  /** The PR's `updatedAt` at snooze time. Absent when `until` is set. */
  updatedAt?: string;
  /**
   * Marks an entry migrated from the old `string[]` store format. `isSnoozedNow` treats this as
   * snoozed (preserving user intent). `stampLegacySnoozes` converts it to a proper
   * `{ updatedAt }` entry on the next successful board load that includes this PR.
   */
  legacy?: boolean;
}

export type SnoozeStore = Record<string, SnoozeEntry>;

export type SnoozeChoice = '1hour' | 'tomorrow9am' | 'untilChanged';

/**
 * Migrates any stored snooze state into the current `SnoozeStore` format.
 *
 * Old format (`string[]`): each key becomes `{ legacy: true }` — treated as snoozed until
 * `stampLegacySnoozes` converts it to a proper "until PR changes" entry on the first successful
 * board load that includes that PR. This preserves user intent: old snoozes stay snoozed.
 *
 * New format (Record) passes through unchanged. `null`/`undefined` returns an empty store.
 */
export function migrateSnoozeState(raw: unknown): SnoozeStore {
  if (!raw) {
    return {};
  }
  if (Array.isArray(raw)) {
    const store: SnoozeStore = {};
    for (const key of raw) {
      if (typeof key === 'string') {
        store[key] = { legacy: true };
      }
    }
    return store;
  }
  if (typeof raw === 'object') {
    return raw as SnoozeStore;
  }
  return {};
}

/**
 * Returns true if the given snooze entry still applies to `prUpdatedAt` at `now`.
 *
 * - Timed entry (`until` set): snoozed while `now < until`.
 * - Legacy entry (`legacy: true`): always snoozed — waits for `stampLegacySnoozes` to convert it.
 * - "Until changed" entry (`updatedAt` set): snoozed while `prUpdatedAt === entry.updatedAt`.
 * - Entry with only `updatedAt: undefined` (should not appear after migration): not snoozed.
 */
export function isSnoozedNow(entry: SnoozeEntry, prUpdatedAt: string, now: Date): boolean {
  if (entry.until !== undefined) {
    return now.getTime() < entry.until;
  }
  if (entry.legacy) {
    // Migrated from old format — treat as snoozed until stampLegacySnoozes converts it.
    return true;
  }
  if (entry.updatedAt === undefined) {
    return false;
  }
  return prUpdatedAt === entry.updatedAt;
}

/**
 * On the first successful board load after a migration from the old format, converts each
 * `{ legacy: true }` entry whose PR appears in `prsByKey` into a proper
 * `{ updatedAt: pr.updatedAt }` ("until PR changes") entry.
 *
 * Legacy entries for PRs NOT on the board are left untouched — they will either be pruned by
 * `pruneSnoozed` once that repo's next successful load confirms the PR is gone, or stamped on a
 * later load if the PR reappears. Either way, the snooze is preserved until we know the PR is gone.
 *
 * Pure — does not mutate the input store or the map. Returns the original store object if nothing
 * changed (no writes needed).
 */
export function stampLegacySnoozes(
  store: SnoozeStore,
  prsByKey: ReadonlyMap<string, { updatedAt: string }>,
): SnoozeStore {
  let result: SnoozeStore | undefined;
  for (const [key, entry] of Object.entries(store)) {
    if (!entry.legacy) {
      continue;
    }
    const pr = prsByKey.get(key);
    if (!pr) {
      continue; // PR not on this board load — leave legacy, prune later when confirmed gone
    }
    if (!result) {
      result = { ...store };
    }
    result[key] = { updatedAt: pr.updatedAt };
  }
  return result ?? store;
}

/**
 * Returns a new `SnoozeStore` with `key` added (or replaced) with the given snooze choice.
 * Does not mutate the input store.
 *
 * "Tomorrow 9am" is computed in the local timezone of the running process using `now` as the
 * reference date — the injectable `now` makes this deterministic in tests.
 */
export function snoozeUntil(store: SnoozeStore, key: string, choice: SnoozeChoice, prUpdatedAt: string, now: Date): SnoozeStore {
  let entry: SnoozeEntry;
  if (choice === '1hour') {
    entry = { until: now.getTime() + 3_600_000 };
  } else if (choice === 'tomorrow9am') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    entry = { until: tomorrow.getTime() };
  } else {
    // untilChanged
    entry = { updatedAt: prUpdatedAt };
  }
  return { ...store, [key]: entry };
}

/**
 * Returns a new `SnoozeStore` with `key` removed. Does not mutate the input store.
 */
export function unsnooze(store: SnoozeStore, key: string): SnoozeStore {
  const { [key]: _removed, ...rest } = store;
  return rest;
}

/**
 * Returns a new `SnoozeStore` containing only snooze entries that are still relevant.
 *
 * A key is pruned only when BOTH conditions hold:
 *   1. Its repo was successfully refreshed in this load (`refreshedRepoKeys` contains the
 *      `"host:identity"` prefix of the PR key), AND
 *   2. The PR is no longer live (`livePrKeys` does not contain the key).
 *
 * Keys for PRs from repos that FAILED to refresh are kept regardless — we don't know whether
 * those PRs still exist, so pruning them would silently discard a user's snooze.
 */
export function pruneSnoozed(store: SnoozeStore, livePrKeys: Set<string>, refreshedRepoKeys: Set<string>): SnoozeStore {
  const pruned: SnoozeStore = {};
  for (const [k, v] of Object.entries(store)) {
    // PR key format: "host:identity#number" — repo key is everything before the last '#'
    const repoKey = k.substring(0, k.lastIndexOf('#'));
    // Only prune if the repo was successfully refreshed AND the PR is gone from the live set.
    if (refreshedRepoKeys.has(repoKey) && !livePrKeys.has(k)) {
      continue; // prune: confirmed gone from a successful load
    }
    pruned[k] = v;
  }
  return pruned;
}
