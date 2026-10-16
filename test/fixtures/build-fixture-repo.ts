import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FixtureCommit {
  sha: string;
  message: string;
  author: string;
}

export interface FixtureManifest {
  repoRoot: string;
  trackedFile: string;
  untrackedFile: string;
  /** Newest first, matching `git log` order. */
  commits: FixtureCommit[];
}

/** Where runTests.ts writes the manifest so the suite running inside the Extension Development Host can read it back. */
export const MANIFEST_PATH = join(tmpdir(), 'gitlore-fixture-manifest.json');

/** Separate path for the submodule fixture manifest (F5.1). */
export const SUBMODULE_MANIFEST_PATH = join(tmpdir(), 'gitlore-submodule-manifest.json');

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
}

function commitEnv(name: string, email: string, isoDate: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
}

/**
 * Builds a small, deterministic git repo in a fresh temp directory by running real
 * git commands with pinned author/committer identity and dates. Avoids committing a
 * real `.git` fixture directory (repo-in-repo tooling friction) in favor of building
 * one on demand before the integration suite runs.
 */
export function buildFixtureRepo(): FixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'tracked.txt');

  writeFileSync(trackedFile, 'line one\nline two\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'first commit'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  writeFileSync(trackedFile, 'line one\nline two\nline three\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'add line three'], commitEnv('Amy Dev', 'amy@example.com', '2024-02-01T10:00:00'));

  const untrackedFile = join(repoRoot, 'untracked.txt');
  writeFileSync(untrackedFile, 'not tracked\n');

  const log = execFileSync('git', ['log', '--pretty=format:%H|%s|%an'], { cwd: repoRoot }).toString();
  const commits: FixtureCommit[] = log
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, message, author] = line.split('|');
      return { sha: sha ?? '', message: message ?? '', author: author ?? '' };
    });

  return { repoRoot, trackedFile, untrackedFile, commits };
}

export interface BranchFixtureManifest {
  repoRoot: string;
  trackedFile: string;
  baseBranch: string;
  featureBranch: string;
}

/**
 * A separate, isolated repo (its own temp dir, never touched by other tests) with a feature
 * branch that diverges from `main` — used for branch comparison, where `--all`-scoped commands
 * (like the commit graph) elsewhere must not see this extra branch/commit.
 */
export function buildBranchFixtureRepo(): BranchFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-branch-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'tracked.txt');
  writeFileSync(trackedFile, 'line one\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'base commit'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  git(repoRoot, ['checkout', '-q', '-b', 'feature-x']);
  writeFileSync(trackedFile, 'line one\nfeature line\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'add feature line'], commitEnv('Amy Dev', 'amy@example.com', '2024-01-02T10:00:00'));

  git(repoRoot, ['checkout', '-q', 'main']);

  return { repoRoot, trackedFile, baseBranch: 'main', featureBranch: 'feature-x' };
}

export interface StaleFixtureManifest {
  repoRoot: string;
  staleFile: string;
  /** SHA of the commit that last touched every symbol except `recentlyChangedFunction`. */
  staleSha: string;
}

const STALE_FILE_CONTENT_V1 = `export function longUnchangedFunction() {
  return 1;
}

export function recentlyChangedFunction() {
  return 2;
}

export class OldService {
  run() {
    return 1;
  }
}

export function outerFunction() {
  function innerHelper() {
    return 1;
  }
  return innerHelper();
}
`;

// Written out in full (not derived from V1 via string surgery) so the two versions stay easy to
// diff by eye and an edit to one can't silently desync from the other.
const STALE_FILE_CONTENT_V2 = `export function longUnchangedFunction() {
  return 1;
}

export function recentlyChangedFunction() {
  return 3;
}

export class OldService {
  run() {
    return 1;
  }
}

export function outerFunction() {
  function innerHelper() {
    return 1;
  }
  return innerHelper();
}
`;

/**
 * A `.ts` fixture (TypeScript's built-in language server provides real document symbols for it,
 * which the plain `tracked.txt` used elsewhere can't) with one old commit touching every symbol,
 * and a second, effectively-"just now" commit that touches only `recentlyChangedFunction` — giving
 * the stale-code-detector tests both a definitely-stale and a definitely-fresh function in one file.
 */
export function buildStaleFixtureRepo(): StaleFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-stale-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const staleFile = join(repoRoot, 'stale.ts');
  writeFileSync(staleFile, STALE_FILE_CONTENT_V1);
  git(repoRoot, ['add', 'stale.ts']);
  // Far enough in the past to stay well past any plausible staleThresholdDays for decades.
  git(repoRoot, ['commit', '-q', '-m', 'add stale.ts'], commitEnv('Raj Jadon', 'raj@example.com', '2015-01-01T10:00:00'));

  const staleSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).toString().trim();

  writeFileSync(staleFile, STALE_FILE_CONTENT_V2);
  git(repoRoot, ['add', 'stale.ts']);
  // Dated "now" (at fixture-build time, which happens immediately before the suite runs) so this
  // function is always fresh relative to the real wall-clock `now` the provider uses internally.
  git(repoRoot, ['commit', '-q', '-m', 'update recentlyChangedFunction'], commitEnv('Amy Dev', 'amy@example.com', new Date().toISOString()));

  return { repoRoot, staleFile, staleSha };
}

export interface CoChangeFixtureManifest {
  repoRoot: string;
  mainFile: string;
  coupledFile: string;
  uncoupledFile: string;
}

/**
 * `main.ts` and `coupled.ts` change together in 4 of 5 commits touching `main.ts` (80% —
 * above the detector's floor); `uncoupled.ts` rides along in only 1 of those 5 (20% — below
 * it), so the co-change tests have both a definite hit and a definite miss in one repo.
 */
export function buildCoChangeFixtureRepo(): CoChangeFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-cochange-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const mainFile = join(repoRoot, 'main.ts');
  const coupledFile = join(repoRoot, 'coupled.ts');
  const uncoupledFile = join(repoRoot, 'uncoupled.ts');

  writeFileSync(uncoupledFile, 'export const untouched = 0;\n');
  git(repoRoot, ['add', 'uncoupled.ts']);
  git(repoRoot, ['commit', '-q', '-m', 'add uncoupled.ts'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  for (let i = 0; i < 5; i++) {
    writeFileSync(mainFile, `export const main = ${i};\n`);
    git(repoRoot, ['add', 'main.ts']);
    const alsoTouchCoupled = i < 4;
    if (alsoTouchCoupled) {
      writeFileSync(coupledFile, `export const coupled = ${i};\n`);
      git(repoRoot, ['add', 'coupled.ts']);
    }
    if (i === 0) {
      writeFileSync(uncoupledFile, 'export const untouched = 1;\n');
      git(repoRoot, ['add', 'uncoupled.ts']);
    }
    git(
      repoRoot,
      ['commit', '-q', '-m', `update main.ts ${i}`],
      commitEnv('Raj Jadon', 'raj@example.com', `2024-01-0${2 + i}T10:00:00`),
    );
  }

  return { repoRoot, mainFile, coupledFile, uncoupledFile };
}

export interface OwnershipFixtureManifest {
  repoRoot: string;
  trackedFile: string;
}

/**
 * One file, two authors: Alice writes both lines first (older commit), Bob adds a third line
 * later (newer commit) — gives the ownership tests a real recency-vs-line-count tension (Alice
 * has more raw lines, Bob's line is more recent) without needing an injectable "now".
 */
export function buildOwnershipFixtureRepo(): OwnershipFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-ownership-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'ownership.txt');
  writeFileSync(trackedFile, 'alice line one\nalice line two\n');
  git(repoRoot, ['add', 'ownership.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'alice adds two lines'], commitEnv('Alice Dev', 'alice@example.com', '2024-01-01T10:00:00'));

  writeFileSync(trackedFile, 'alice line one\nalice line two\nbob line three\n');
  git(repoRoot, ['add', 'ownership.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'bob adds a line'], commitEnv('Bob Smith', 'bob@example.com', '2024-02-01T10:00:00'));

  return { repoRoot, trackedFile };
}

export interface ExplorerFixtureManifest {
  repoRoot: string;
  trackedFile: string;
  currentBranch: string;
  otherBranch: string;
  tagName: string;
  stashMessage: string;
}

/**
 * A fresh, isolated repo per call (mutating commands — checkout, stash apply/drop — must never
 * touch the one shared workspace repo every other integration suite runs against) with one of
 * everything the Sidebar Explorer lists: two local branches, a tag, and a stash entry.
 */
export function buildExplorerFixtureRepo(): ExplorerFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-explorer-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'tracked.txt');
  writeFileSync(trackedFile, 'line one\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'base commit'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  git(repoRoot, ['tag', 'v1.0.0']);

  git(repoRoot, ['checkout', '-q', '-b', 'feature-y']);
  writeFileSync(trackedFile, 'line one\nfeature line\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'add feature line'], commitEnv('Amy Dev', 'amy@example.com', '2024-01-02T10:00:00'));
  git(repoRoot, ['checkout', '-q', 'main']);

  const stashMessage = 'wip explorer test';
  writeFileSync(trackedFile, 'line one\nuncommitted change\n');
  git(repoRoot, ['stash', 'push', '-q', '-m', stashMessage]);

  return { repoRoot, trackedFile, currentBranch: 'main', otherBranch: 'feature-y', tagName: 'v1.0.0', stashMessage };
}

export interface LineHistoryFixtureManifest {
  repoRoot: string;
  trackedFile: string;
  /** 0-based — the line created by `commits[2]` and rewritten by `commits[1]` and `commits[0]`. */
  line: number;
  /**
   * Newest first, matching `git log -L` order. All three commits touched `line`: `-L` tracks a
   * line back to the commit that first wrote its content, so the file-creation commit legitimately
   * belongs at the oldest end of the line's own history, not just "commits that touched the file".
   */
  commits: FixtureCommit[];
}

/**
 * A file whose second line is rewritten twice by two different authors on top of the commit that
 * first created it — three real revisions of the same line, so the hover's `-L`-based line-history
 * stepper has a real multi-revision line to step through, plus an unrelated third line that's
 * never touched, so a naive "which commits touched this file" scan (as opposed to real per-line
 * tracking) would be provably wrong here (it would also count edits to the third line as history
 * for the second one, if there were any — there deliberately aren't).
 */
export function buildLineHistoryFixtureRepo(): LineHistoryFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-linehistory-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'tracked.txt');

  writeFileSync(trackedFile, 'line one\nline two\nline three\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'first commit'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  writeFileSync(trackedFile, 'line one\nline two v2\nline three\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'amy edits line two'], commitEnv('Amy Dev', 'amy@example.com', '2024-02-01T10:00:00'));

  writeFileSync(trackedFile, 'line one\nline two v3\nline three\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'raj edits line two again'], commitEnv('Raj Jadon', 'raj@example.com', '2024-03-01T10:00:00'));

  const log = execFileSync('git', ['log', '--pretty=format:%H|%s|%an'], { cwd: repoRoot }).toString();
  const commits: FixtureCommit[] = log
    .split('\n')
    .filter(Boolean)
    .map((entry) => {
      const [sha, message, author] = entry.split('|');
      return { sha: sha ?? '', message: message ?? '', author: author ?? '' };
    });

  return { repoRoot, trackedFile, line: 1, commits };
}

export interface SyncFixtureManifest {
  repoRoot: string;
  trackedFile: string;
  /** Commits `main` has that its upstream doesn't. */
  ahead: number;
  /** Commits the upstream has that `main` doesn't. */
  behind: number;
}

/**
 * A repo whose checked-out branch has a real, divergent upstream — for the commit graph's
 * pull/push ahead/behind badges. Uses a second *local* branch as the upstream (via
 * `git branch --set-upstream-to`) rather than a real or bare remote: git's ahead/behind
 * accounting (`%(upstream:track)`) works identically either way, and this avoids standing up an
 * actual remote just to exercise it.
 */
export function buildSyncFixtureRepo(): SyncFixtureManifest {
  const repoRoot = mkdtempSync(join(tmpdir(), 'gitlore-sync-fixture-'));
  git(repoRoot, ['init', '-q', '-b', 'main']);
  git(repoRoot, ['config', 'user.name', 'Raj Jadon']);
  git(repoRoot, ['config', 'user.email', 'raj@example.com']);

  const trackedFile = join(repoRoot, 'tracked.txt');
  writeFileSync(trackedFile, 'line one\n');
  git(repoRoot, ['add', 'tracked.txt']);
  git(repoRoot, ['commit', '-q', '-m', 'base commit'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  git(repoRoot, ['branch', 'pretend-origin-main']);
  git(repoRoot, ['branch', '--set-upstream-to=pretend-origin-main', 'main']);

  const ahead = 2;
  for (let i = 0; i < ahead; i++) {
    writeFileSync(trackedFile, `line one\nahead ${i}\n`);
    git(repoRoot, ['add', 'tracked.txt']);
    git(repoRoot, ['commit', '-q', '-m', `ahead commit ${i}`], commitEnv('Raj Jadon', 'raj@example.com', `2024-01-0${2 + i}T10:00:00`));
  }

  const behind = 3;
  git(repoRoot, ['checkout', '-q', 'pretend-origin-main']);
  const behindFile = join(repoRoot, 'behind.txt');
  for (let i = 0; i < behind; i++) {
    writeFileSync(behindFile, `behind ${i}\n`);
    git(repoRoot, ['add', 'behind.txt']);
    git(repoRoot, ['commit', '-q', '-m', `behind commit ${i}`], commitEnv('Amy Dev', 'amy@example.com', `2024-02-0${i + 1}T10:00:00`));
  }
  git(repoRoot, ['checkout', '-q', 'main']);

  return { repoRoot, trackedFile, ahead, behind };
}

export interface SubmoduleFixtureManifest {
  /** The parent (super-project) repo root. */
  parentRoot: string;
  /** Path to the submodule's working tree root inside the parent (parent/sub). */
  submoduleRoot: string;
  /** A tracked file inside the submodule working tree. */
  submoduleFile: string;
  /** SHA of the commit that last touched `submoduleFile`. */
  submoduleCommitSha: string;
}

/**
 * A parent repo with one real git submodule added via the `file://` protocol
 * (`git -c protocol.file.allow=always submodule add`).  The submodule itself has one
 * tracked file with one commit so blame and file-history can be exercised against it.
 *
 * The submodule is fully initialized: the sub-repo's working tree exists at `parentRoot/sub`
 * with a regular `.git` file (not a directory) pointing back into `parentRoot/.git/modules/sub`.
 *
 * Git's behaviour: `git rev-parse --show-toplevel` inside `parentRoot/sub` resolves to
 * `parentRoot/sub`, not `parentRoot` — so `GitService.getRepoRoot(submoduleFile)` returns the
 * submodule root, and all blame / history calls operate against the submodule's own object store.
 */
export function buildSubmoduleFixtureRepo(): SubmoduleFixtureManifest {
  // 1. Build a self-contained sub-repo that will become the submodule source.
  const subSrcRoot = mkdtempSync(join(tmpdir(), 'gitlore-submodule-src-'));
  git(subSrcRoot, ['init', '-q', '-b', 'main']);
  git(subSrcRoot, ['config', 'user.name', 'Raj Jadon']);
  git(subSrcRoot, ['config', 'user.email', 'raj@example.com']);

  const subSrcFile = join(subSrcRoot, 'sub.txt');
  writeFileSync(subSrcFile, 'submodule line one\n');
  git(subSrcRoot, ['add', 'sub.txt']);
  git(subSrcRoot, ['commit', '-q', '-m', 'sub: add sub.txt'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T10:00:00'));

  const submoduleCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: subSrcRoot }).toString().trim();

  // 2. Build the parent repo and add the sub-repo as a submodule.
  // Canonicalize immediately: on macOS os.tmpdir() returns a /var/... symlink but
  // `git rev-parse --show-toplevel` resolves to /private/var/..., causing assert.equal to
  // fail when comparing manifest.submoduleRoot with getRepoRoot()'s output.
  const parentRoot = realpathSync(mkdtempSync(join(tmpdir(), 'gitlore-submodule-parent-')));
  git(parentRoot, ['init', '-q', '-b', 'main']);
  git(parentRoot, ['config', 'user.name', 'Raj Jadon']);
  git(parentRoot, ['config', 'user.email', 'raj@example.com']);

  // Add a root commit so the parent has a valid HEAD before the submodule add.
  writeFileSync(join(parentRoot, 'README.txt'), 'parent repo\n');
  git(parentRoot, ['add', 'README.txt']);
  git(parentRoot, ['commit', '-q', '-m', 'parent: initial'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-01T09:00:00'));

  // `protocol.file.allow=always` is required on git ≥ 2.38.1 for local file:// submodule URLs.
  git(parentRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', `file://${subSrcRoot}`, 'sub']);
  git(parentRoot, ['commit', '-q', '-m', 'parent: add sub submodule'], commitEnv('Raj Jadon', 'raj@example.com', '2024-01-02T10:00:00'));

  const submoduleRoot = join(parentRoot, 'sub');
  const submoduleFile = join(submoduleRoot, 'sub.txt');

  return { parentRoot, submoduleRoot, submoduleFile, submoduleCommitSha };
}
