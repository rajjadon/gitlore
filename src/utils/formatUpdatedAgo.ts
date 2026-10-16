/**
 * Board header "last updated" text — keeps it human-readable without date-fns' hedging ("about…").
 * Pure function, injectable `now` for deterministic tests.
 */
export function formatUpdatedAgo(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  if (diffMs < 60_000) {
    return 'Updated just now';
  }
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) {
    return `Updated ${diffMin} min ago`;
  }
  return `Updated ${Math.floor(diffMin / 60)} h ago`;
}
