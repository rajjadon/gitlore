import type { ForgeClient } from './ForgeClient';
import type { CategorizedPullRequest, ForgeRepoRef, PullRequestSummary } from './types';
import { pullRequestKey } from './types';
import { isCredentialRejection, mapWithConcurrency } from './forgeFetch';
import { categorizePullRequests, categorizeClosedPullRequests } from './categorize';

/** `null` client means the caller could not resolve credentials for this repo → "Not signed in." error row. */
export interface BoardRepoInput {
  repo: ForgeRepoRef;
  client: ForgeClient | null;
  /** Human-readable host name (e.g. `"gitlab.com"`) for error messages. Comes from `DetectedForgeHost.displayHost`. */
  displayHost: string;
}

export interface BoardDeps {
  repos: BoardRepoInput[];
  isSnoozed: (pr: PullRequestSummary) => boolean;
  /** Caller clears the stored token — only invoked when `isCredentialRejection` is true. */
  onCredentialRejected: (repo: ForgeRepoRef) => Promise<void>;
  logError: (message: string, err: unknown) => void;
  /** Max parallel per-repo loads. Default 4. */
  concurrency?: number;
}

export interface BoardResult {
  categorized: CategorizedPullRequest[];
  errors: Array<{ repo: ForgeRepoRef; message: string }>;
  loginByRepoKey: Map<string, string>;
  rawByRepoKey: Map<string, { login: string; open: PullRequestSummary[]; closed: PullRequestSummary[] }>;
}

function repoKey(repo: ForgeRepoRef): string {
  return `${repo.host}:${repo.identity}`;
}

async function loadOne(
  { repo, client, displayHost }: BoardRepoInput,
  isSnoozed: BoardDeps['isSnoozed'],
  onCredentialRejected: BoardDeps['onCredentialRejected'],
  logError: BoardDeps['logError'],
): Promise<{ repo: ForgeRepoRef; login: string; open: PullRequestSummary[]; closed: PullRequestSummary[] } | { repo: ForgeRepoRef; error: string }> {
  if (!client) {
    return { repo, error: 'Not signed in.' };
  }

  // Login failures get a dedicated try/catch so the message names the host, not just the raw
  // HTTP status. List failures keep a rawer message (still useful) and the same credential-clear
  // logic for 401s.
  let login: string | null;
  try {
    login = await client.getAuthenticatedLogin();
  } catch (err) {
    if (isCredentialRejection(err)) {
      await onCredentialRejected(repo);
    }
    logError(`Launchpad failed to authenticate with ${displayHost}`, err);
    const reason = err instanceof Error ? err.message : String(err);
    return { repo, error: `Couldn't authenticate with ${displayHost}: ${reason}` };
  }
  if (!login) {
    await onCredentialRejected(repo);
    return { repo, error: `Couldn't authenticate with ${displayHost}.` };
  }

  try {
    const [open, closed] = await Promise.all([
      client.listOpenPullRequests(repo),
      client.listRecentlyClosedPullRequests(repo),
    ]);
    return { repo, login, open, closed };
  } catch (err) {
    if (isCredentialRejection(err)) {
      await onCredentialRejected(repo);
    }
    logError(`Launchpad failed to load ${repo.label}`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { repo, error: message };
  }
}

export async function loadBoard(deps: BoardDeps): Promise<BoardResult> {
  const { repos, isSnoozed, onCredentialRejected, logError, concurrency = 4 } = deps;

  const outcomes = await mapWithConcurrency(repos, concurrency, (repoInput) =>
    loadOne(repoInput, isSnoozed, onCredentialRejected, logError),
  );

  const categorized: CategorizedPullRequest[] = [];
  const errors: Array<{ repo: ForgeRepoRef; message: string }> = [];
  const loginByRepoKey = new Map<string, string>();
  const rawByRepoKey = new Map<string, { login: string; open: PullRequestSummary[]; closed: PullRequestSummary[] }>();

  for (const outcome of outcomes) {
    if ('error' in outcome) {
      errors.push({ repo: outcome.repo, message: outcome.error });
      continue;
    }
    const key = repoKey(outcome.repo);
    loginByRepoKey.set(key, outcome.login);
    rawByRepoKey.set(key, { login: outcome.login, open: outcome.open, closed: outcome.closed });
    categorized.push(
      ...categorizePullRequests(outcome.open, outcome.login, isSnoozed),
      ...categorizeClosedPullRequests(outcome.closed, outcome.login),
    );
  }

  return { categorized, errors, loginByRepoKey, rawByRepoKey };
}

/** Re-bucket the already-fetched PRs with a new `isSnoozed` function — no network calls. */
export function recategorize(
  rawByRepoKey: BoardResult['rawByRepoKey'],
  isSnoozed: BoardDeps['isSnoozed'],
): CategorizedPullRequest[] {
  const categorized: CategorizedPullRequest[] = [];
  for (const { login, open, closed } of rawByRepoKey.values()) {
    categorized.push(
      ...categorizePullRequests(open, login, isSnoozed),
      ...categorizeClosedPullRequests(closed, login),
    );
  }
  return categorized;
}

/** Drop snoozed keys that no longer match any live PR — keeps the globalState set tidy. Pure. */
export function pruneSnoozed(keys: string[], livePrKeys: Set<string>): string[] {
  return keys.filter((k) => livePrKeys.has(k));
}

/** Collect all PR keys from a rawByRepoKey map — used by the provider after each full load. */
export function collectLivePrKeys(rawByRepoKey: BoardResult['rawByRepoKey']): Set<string> {
  const keys = new Set<string>();
  for (const { open, closed } of rawByRepoKey.values()) {
    for (const pr of [...open, ...closed]) {
      keys.add(pullRequestKey(pr));
    }
  }
  return keys;
}
