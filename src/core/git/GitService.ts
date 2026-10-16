import { dirname, join } from 'node:path';
import { realpathSync, statSync, existsSync } from 'node:fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  parseBlamePorcelain,
  parseNumstat,
  parseNumstatAll,
  parseLog,
  parseCommitDetail,
  parseGraphLog,
  parseFileHistoryLog,
  parseBranches,
  parseRemotes,
  parseTags,
  parseStashes,
  parseWorktrees,
  parseReflog,
  parseContributors,
  parseRemoteUrl,
  parseStatusPorcelain,
  parseLineHistoryLog,
  parseCoChangeLog,
  LOG_FORMAT,
  COMMIT_DETAIL_FORMAT,
  GRAPH_LOG_FORMAT,
  BRANCH_FORMAT,
  LINE_HISTORY_FORMAT,
  CO_CHANGE_LOG_FORMAT,
} from './parsers';
import type {
  BlameLine,
  BranchInfo,
  Commit,
  CommitDetail,
  CommitFileList,
  ContributorInfo,
  FileChange,
  FileHistoryEntry,
  GitRemote,
  GraphCommit,
  ReflogEntry,
  RemoteInfo,
  StashInfo,
  TagInfo,
  WorkingChanges,
  WorktreeInfo,
} from './types';
import { GitCommandError, type GitLogger } from './errors';
import { toRepoRelativePath } from '../../utils/path';
import { buildDefaultUrlTemplate } from '../../utils/issueLinks';

export interface BlameOptions {
  ignoreWhitespace?: boolean;
  /** When true, adds `-M -C` so git follows lines moved or copied between files. Slower on large files. */
  detectMoves?: boolean;
}

/**
 * Pure function — builds the `git blame` argument array from options.
 * Extracted so unit tests can verify every flag combination without spawning git.
 */
export function buildBlameArgs(opts: {
  ignoreWhitespace?: boolean;
  detectMoves?: boolean;
  ignoreRevsFile?: string;
  rel: string;
}): string[] {
  const args = ['blame', '--line-porcelain'];
  if (opts.ignoreWhitespace) args.push('-w');
  if (opts.detectMoves) args.push('-M', '-C');
  if (opts.ignoreRevsFile) args.push('--ignore-revs-file', opts.ignoreRevsFile);
  args.push('--', opts.rel);
  return args;
}

/**
 * Pure function — builds the `git log -S` / `-G` argument array for history search.
 * Extracted for unit testing without spawning git.
 */
export function buildSearchHistoryArgs(opts: {
  query: string;
  mode: 'string' | 'regex';
  maxCount: number;
  rel?: string;
}): string[] {
  const flag = opts.mode === 'string' ? `-S${opts.query}` : `-G${opts.query}`;
  const args = ['log', flag, '-n', String(opts.maxCount), `--pretty=tformat:${LOG_FORMAT}`];
  if (opts.rel) args.push('--', opts.rel);
  return args;
}

/**
 * Pure function — builds the `git log -L` argument array for line-range history.
 * Both `startLine` and `endLine` are 0-based (matching `BlameLine.line`); converted to git's
 * 1-based internally. Reversed or negative ranges are normalised: `(9, 4)` → same as `(4, 9)`,
 * negative values are clamped to 0.
 */
export function buildLineHistoryArgs(rel: string, startLine: number, endLine?: number): string[] {
  const clampedStart = Math.max(0, startLine);
  const clampedEnd = endLine !== undefined ? Math.max(0, endLine) : clampedStart;
  const lo = Math.min(clampedStart, clampedEnd);
  const hi = Math.max(clampedStart, clampedEnd);
  return ['log', `--format=${LINE_HISTORY_FORMAT}`, '-L', `${lo + 1},${hi + 1}:${rel}`];
}

/**
 * The only place that touches `simple-git`. Zero `vscode` imports — diagnostics
 * go through the injected `GitLogger` instead, so callers decide how to surface them.
 */
export class GitService {
  private readonly gitByRoot = new Map<string, SimpleGit>();
  // A directory's repo root never changes for the lifetime of the process — safe to memoize
  // indefinitely, and worth it since decoration updates call getRepoRoot on every line move.
  private readonly repoRootByDir = new Map<string, string | null>();

  constructor(private readonly logger?: GitLogger) {}

  async isGitAvailable(): Promise<boolean> {
    try {
      const version = await simpleGit().version();
      return Boolean(version.installed);
    } catch (err) {
      this.logger?.warn(`git availability check failed: ${String(err)}`);
      return false;
    }
  }

  /** Resolves the repo root for a file *or* a directory, searching upward. Null if not in a repo. */
  async getRepoRoot(filePath: string): Promise<string | null> {
    const dir = this.toSearchDir(filePath);
    if (this.repoRootByDir.has(dir)) {
      return this.repoRootByDir.get(dir) ?? null;
    }
    let root: string | null;
    try {
      const git = simpleGit({ baseDir: dir });
      root = (await git.revparse(['--show-toplevel'])).trim();
    } catch {
      // Expected for files outside any git repo — silent, not an error.
      root = null;
    }
    this.repoRootByDir.set(dir, root);
    return root;
  }

  async isTracked(filePath: string): Promise<boolean> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return false;
    }
    try {
      const git = this.gitFor(repoRoot);
      const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
      const out = await git.raw(['ls-files', '--', rel]);
      return out.trim().length > 0;
    } catch (err) {
      this.logger?.warn(`ls-files failed for ${filePath}: ${String(err)}`);
      return false;
    }
  }

  /** Blames the whole file in one call — never shell out per line. */
  async blameFile(filePath: string, opts: BlameOptions = {}): Promise<BlameLine[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    if (!(await this.isTracked(filePath))) {
      return [];
    }

    const git = this.gitFor(repoRoot);
    const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
    // git's own convention (supported since 2.23) for skipping mass-reformat/lint commits in
    // blame — auto-detected by filename, no setting needed, opt-in by simply having the file.
    const ignoreRevsFilePath = join(repoRoot, '.git-blame-ignore-revs');
    const args = buildBlameArgs({
      ignoreWhitespace: opts.ignoreWhitespace,
      detectMoves: opts.detectMoves,
      ignoreRevsFile: existsSync(ignoreRevsFilePath) ? ignoreRevsFilePath : undefined,
      rel,
    });

    try {
      const raw = await git.raw(args);
      return parseBlamePorcelain(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git blame failed for ${filePath}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Convenience accessor over `blameFile` for a single line — callers should cache `blameFile` results. */
  async blameLine(filePath: string, line: number, opts: BlameOptions = {}): Promise<BlameLine | null> {
    const lines = await this.blameFile(filePath, opts);
    return lines.find((l) => l.line === line) ?? null;
  }

  /** How much a single file changed in a specific commit — used by the blame hover's diff stat. */
  async getFileDiffStat(filePath: string, sha: string): Promise<FileChange | null> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    const git = this.gitFor(repoRoot);
    const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
    try {
      const raw = await git.raw(['show', '--numstat', '--format=', sha, '--', rel]);
      return parseNumstat(raw);
    } catch (err) {
      // Non-critical to the hover card — log and omit the stat rather than fail the whole hover.
      this.logger?.warn(`diff stat failed for ${filePath}@${sha}: ${String(err)}`);
      return null;
    }
  }

  /** Every commit that touched this file, newest first. `--follow` tracks the file across renames. */
  async getFileHistory(filePath: string, maxCount: number): Promise<Commit[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    if (!(await this.isTracked(filePath))) {
      return [];
    }

    const git = this.gitFor(repoRoot);
    const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
    const args = ['log', '--follow', '-n', String(maxCount), `--pretty=tformat:${LOG_FORMAT}`, '--', rel];

    try {
      const raw = await git.raw(args);
      return parseLog(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git log failed for ${filePath}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /**
   * Every commit that changed this line (or line range), newest first, via git's own line-tracking
   * (`-L`) rather than a naive "which commits touched this file" scan — the blame hover's prev/next
   * stepper walks this list. `line` and `endLine` are 0-based (matching `BlameLine.line`); git's
   * `-L` is 1-based. When `endLine` is provided the history covers all commits that touched any
   * line in the range; a reversed or negative range is clamped automatically by `buildLineHistoryArgs`.
   *
   * Doesn't pass `--follow`: combining it with `-L` has been unreliable across git versions, and
   * stepping through one file's own history is enough for this feature.
   */
  async getLineHistory(filePath: string, line: number, endLine?: number): Promise<Commit[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
    const args = buildLineHistoryArgs(rel, line, endLine);
    try {
      const raw = await git.raw(args);
      return parseLineHistoryLog(raw);
    } catch {
      // Line out of range, file deleted, or an unborn HEAD — nothing to step through, not an error.
      return [];
    }
  }

  /**
   * Commits across the repo (or scoped to one file) that added or removed a specific string or
   * regex pattern, newest first. Uses `git log -S` (string presence) or `-G` (regex match in diff).
   * An invalid regex throws a `GitCommandError` before spawning git — the caller should surface
   * the message. An empty query returns an empty array silently (guards at the command layer should
   * already prevent this, but belt-and-suspenders here).
   */
  async searchHistory(repoRoot: string, query: string, mode: 'string' | 'regex', maxCount: number, filePath?: string): Promise<Commit[]> {
    if (!query.trim()) {
      return [];
    }
    if (mode === 'regex') {
      try {
        new RegExp(query);
      } catch (err) {
        throw new GitCommandError(`git log -G${query}`, `Invalid regular expression: ${String(err)}`);
      }
    }
    const git = this.gitFor(repoRoot);
    const rel = filePath ? toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath)) : undefined;
    const args = buildSearchHistoryArgs({ query, mode, maxCount, rel });
    try {
      const raw = await git.raw(args);
      return parseLog(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git log -S/-G search failed in ${repoRoot}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Every commit that touched this file, newest first, each with its own insertions/deletions — used by the Visual File History timeline. One call: `--numstat` scoped to `filePath` rides along with the same `git log` that fetches history. */
  async getFileHistoryStats(filePath: string, maxCount: number): Promise<FileHistoryEntry[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    if (!(await this.isTracked(filePath))) {
      return [];
    }

    const git = this.gitFor(repoRoot);
    const rel = toRepoRelativePath(repoRoot, this.toCanonicalPath(filePath));
    const args = [
      'log',
      '--follow',
      '--numstat',
      '-n',
      String(maxCount),
      `--pretty=tformat:${LOG_FORMAT}`,
      '--',
      rel,
    ];

    try {
      const raw = await git.raw(args);
      return parseFileHistoryLog(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git log --numstat failed for ${filePath}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Full metadata (including the full message body) for one commit — used by the commit details view. */
  async getCommit(filePath: string, sha: string): Promise<CommitDetail | null> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    const git = this.gitFor(repoRoot);
    const args = ['show', '-s', `--pretty=tformat:${COMMIT_DETAIL_FORMAT}`, sha];
    try {
      const raw = await git.raw(args);
      return parseCommitDetail(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git show failed for ${sha}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** The whole commit's unified diff, across every file it touched (not scoped to `filePath`). */
  async getCommitDiff(filePath: string, sha: string): Promise<string> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return '';
    }
    const git = this.gitFor(repoRoot);
    const args = ['show', '--format=', sha];
    try {
      return await git.raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git show diff failed for ${sha}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Every file the commit touched, with insertion/deletion counts — not scoped to `filePath`. */
  async getCommitFiles(filePath: string, sha: string): Promise<FileChange[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['show', '--numstat', '--format=', sha];
    try {
      const raw = await git.raw(args);
      return parseNumstatAll(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git show --numstat failed for ${sha}`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /**
   * Repo-wide commit graph, not scoped to `filePath` — that's only used to resolve which repo to
   * query. Walks every ref by default; pass `ref` to walk a single branch instead (the graph
   * view's branch picker).
   */
  async getGraphCommits(filePath: string, maxCount: number, ref?: string): Promise<GraphCommit[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    // --topo-order guarantees a commit's parents are never listed before it — the graph
    // layout algorithm processes newest-first and needs children resolved before parents.
    // `--exclude` must precede the `--all` it filters — refs/stash is a bare ref under refs/,
    // so --all walks it too, cluttering the graph with the stash's own commit + its "index"
    // parent (and a stray "refs/stash" badge). GitHub keeps stashes out of the main graph.
    const revs = ref ? [ref] : ['--exclude=refs/stash', '--all'];
    // --numstat rides along on this one call so the Changes column costs no extra process;
    // ponytail: output grows with total files touched across maxCount commits, which the
    // maxGraphItems cap bounds. Move to a lazy per-row stat fetch only if that cap has to rise.
    const args = [
      'log',
      ...revs,
      '--topo-order',
      '--numstat',
      '--decorate=full',
      '-n',
      String(maxCount),
      `--pretty=tformat:${GRAPH_LOG_FORMAT}`,
    ];
    try {
      const raw = await git.raw(args);
      return parseGraphLog(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git log ${revs.join(' ')} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Per-status file counts for the working tree, including untracked files. Never throws — a dirty-state badge isn't worth failing the whole graph over. */
  async getWorkingChanges(filePath: string): Promise<WorkingChanges> {
    const empty: WorkingChanges = { added: 0, modified: 0, deleted: 0, total: 0 };
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return empty;
    }
    try {
      const raw = await this.gitFor(repoRoot).raw(['status', '--porcelain']);
      return parseStatusPorcelain(raw);
    } catch (err) {
      this.logger?.warn(`git status failed for ${repoRoot}: ${String(err)}`);
      return empty;
    }
  }

  /** The staged diff (`git diff --staged`), for AI commit-message generation. Empty string if nothing is staged, the path isn't in a repo, or the diff can't be read. */
  async getStagedDiff(filePath: string): Promise<string> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return '';
    }
    try {
      return await this.gitFor(repoRoot).raw(['diff', '--staged']);
    } catch (err) {
      this.logger?.warn(`git diff --staged failed for ${repoRoot}: ${String(err)}`);
      return '';
    }
  }

  /**
   * One file's full contents at a given ref, for the "before"/"after" sides of a diff editor.
   * Returns '' when the path doesn't exist at that ref — which is the correct left-hand side for
   * a file the commit added, and also what `<sha>^` resolves to for a root commit.
   */
  async getFileAtRef(filePath: string, ref: string, repoRelativePath: string): Promise<string> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return '';
    }
    try {
      return await this.gitFor(repoRoot).raw(['show', `${ref}:${repoRelativePath}`]);
    } catch {
      // Expected whenever the file is absent at that ref — an empty side, not an error.
      return '';
    }
  }

  /** The `origin` remote parsed into host/owner/repo, or null when there's no recognizable remote. */
  async resolveRemoteInfo(filePath: string): Promise<RemoteInfo | null> {
    const remoteUrl = await this.getRemoteUrl(filePath);
    return remoteUrl ? parseRemoteUrl(remoteUrl) : null;
  }

  /** The name of the currently checked-out branch, or null on a detached HEAD / empty repo. */
  async getCurrentBranch(filePath: string): Promise<string | null> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    try {
      const name = (await this.gitFor(repoRoot).raw(['symbolic-ref', '--short', 'HEAD'])).trim();
      return name.length > 0 ? name : null;
    } catch {
      // Detached HEAD or an empty repo with no commits — expected, not an error.
      return null;
    }
  }

  /** Every local and remote branch, not scoped to `filePath` — used to resolve which repo to query. */
  async getBranches(filePath: string): Promise<BranchInfo[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['for-each-ref', 'refs/heads', 'refs/remotes', `--format=${BRANCH_FORMAT}`];
    try {
      const raw = await git.raw(args);
      return parseBranches(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error('git for-each-ref failed', err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Every configured remote's name and URL, for the Sidebar Explorer. Not scoped to `filePath` beyond resolving which repo. */
  async getRemotes(filePath: string): Promise<GitRemote[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    try {
      const raw = await this.gitFor(repoRoot).raw(['config', '--get-regexp', String.raw`remote\..*\.url`]);
      return parseRemotes(raw);
    } catch {
      // No remotes configured at all is the expected shape for `git config --get-regexp` — not an error.
      return [];
    }
  }

  /** Every tag, for the Sidebar Explorer. */
  async getTags(filePath: string): Promise<TagInfo[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['for-each-ref', 'refs/tags', '--format=%(refname:short)'];
    try {
      const raw = await git.raw(args);
      return parseTags(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error('git for-each-ref refs/tags failed', err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Every stash entry, newest first (git's own default order), for the Sidebar Explorer. */
  async getStashes(filePath: string): Promise<StashInfo[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    try {
      const raw = await this.gitFor(repoRoot).raw(['stash', 'list', '--format=%gd\x1f%s\x1f%P']);
      return parseStashes(raw);
    } catch {
      // An empty stash list exits non-zero in some git versions — no stashes, not an error.
      return [];
    }
  }

  /** Every worktree (the main checkout plus any linked ones), for the Sidebar Explorer. */
  async getWorktrees(filePath: string): Promise<WorktreeInfo[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['worktree', 'list', '--porcelain'];
    try {
      const raw = await git.raw(args);
      return parseWorktrees(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error('git worktree list failed', err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Creates a new linked worktree at `worktreePath`, checking out `branch` there. */
  async addWorktree(filePath: string, worktreePath: string, branch: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['worktree', 'add', worktreePath, branch];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git worktree add ${worktreePath} ${branch} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Removes a linked worktree. Never the main checkout — the caller filters that out before calling this. */
  async removeWorktree(filePath: string, worktreePath: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['worktree', 'remove', worktreePath];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git worktree remove ${worktreePath} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** The last `maxCount` reflog entries for HEAD — the raw material for recovering a lost commit or branch. */
  async getReflog(filePath: string, maxCount: number): Promise<ReflogEntry[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const args = ['reflog', 'show', '-n', String(maxCount), '--date=iso-strict', `--format=%H${'\x1f'}%gd${'\x1f'}%gs${'\x1f'}%cd`];
    try {
      const raw = await this.gitFor(repoRoot).raw(args);
      return parseReflog(raw);
    } catch {
      // An empty repo (no commits yet, so no reflog) — no entries, not an error.
      return [];
    }
  }

  /**
   * Every contributor across every branch, ranked by commit count, for the Sidebar Explorer.
   * Scoped to `--all` rather than `HEAD` — a repo-wide roster is what "Contributors" promises,
   * and scoping to just the checked-out branch would silently drop anyone whose commits only
   * live on a branch that isn't currently checked out.
   */
  async getContributors(filePath: string): Promise<ContributorInfo[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    try {
      const raw = await this.gitFor(repoRoot).raw(['shortlog', '-sne', '--all']);
      return parseContributors(raw);
    } catch {
      // An empty repo (no commits yet) fails `shortlog --all` — no contributors, not an error.
      return [];
    }
  }

  /**
   * Every commit's changed-file list within the last `maxCount` commits repo-wide (not scoped to
   * any one file) — the raw material for co-change detection. One bounded call regardless of which
   * file is asking, so a caller computing this for several files in a session doesn't re-fetch it.
   */
  async getCoChangeCommits(filePath: string, maxCount: number): Promise<CommitFileList[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    try {
      const raw = await this.gitFor(repoRoot).raw(['log', '-n', String(maxCount), '--name-only', `--pretty=${CO_CHANGE_LOG_FORMAT}`]);
      return parseCoChangeLog(raw);
    } catch {
      // An empty repo (no commits yet) — no history to analyze, not an error.
      return [];
    }
  }

  /** Commits reachable from `to` but not from `from` — e.g. what `compare` has that `base` doesn't. */
  async getCommitsBetween(filePath: string, from: string, to: string): Promise<Commit[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['log', `${from}..${to}`, `--pretty=tformat:${LOG_FORMAT}`];
    try {
      const raw = await git.raw(args);
      return parseLog(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git log ${from}..${to} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /**
   * The common ancestor of two refs, or null when they share no history. Needed to open a
   * per-file diff editor that agrees with the `base...compare` diff shown inline: on diverged
   * branches, diffing against `base` itself would also surface base's own commits as differences.
   */
  async getMergeBase(filePath: string, a: string, b: string): Promise<string | null> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    try {
      const sha = (await this.gitFor(repoRoot).raw(['merge-base', a, b])).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      // Unrelated histories have no merge base — expected, not an error.
      return null;
    }
  }

  /** Unified diff between two refs, against their merge-base (`...`) — matches GitHub/GitLab PR-diff semantics. */
  async getDiffBetweenRefs(filePath: string, base: string, compare: string): Promise<string> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return '';
    }
    const git = this.gitFor(repoRoot);
    const args = ['diff', `${base}...${compare}`];
    try {
      return await git.raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git diff ${base}...${compare} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Files that differ between two refs, against their merge-base (`...`) — matches GitHub/GitLab PR-diff semantics. */
  async getFilesBetweenRefs(filePath: string, base: string, compare: string): Promise<FileChange[]> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return [];
    }
    const git = this.gitFor(repoRoot);
    const args = ['diff', '--numstat', `${base}...${compare}`];
    try {
      const raw = await git.raw(args);
      return parseNumstatAll(raw);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git diff --numstat ${base}...${compare} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** The URL of `remoteName`, e.g. for auto-detecting a GitHub/GitLab host for issue linking. Null if there is none. */
  async getRemoteUrl(filePath: string, remoteName = 'origin'): Promise<string | null> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }
    try {
      const git = this.gitFor(repoRoot);
      return (await git.raw(['remote', 'get-url', remoteName])).trim() || null;
    } catch {
      // Expected when there's no such remote — silent, not an error.
      return null;
    }
  }

  /** Checks out a local branch, for the Sidebar Explorer's "Checkout" action. Throws on conflicts (e.g. dirty working tree) — the caller surfaces the message, GitLore doesn't force or stash on the user's behalf. */
  async checkoutBranch(filePath: string, branchName: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['checkout', branchName];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git checkout ${branchName} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Moves the current branch's HEAD to `sha`, for the commit graph's "Reset Branch to Here" action. `mode` controls the index/working tree — caller confirms first, `mixed`/`hard` discard changes. */
  async resetTo(filePath: string, sha: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['reset', `--${mode}`, sha];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git reset --${mode} ${sha} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Creates a new local branch named `name` pointing at `sha`, for the commit graph's "Create Branch from Commit" action. Does not check it out. */
  async createBranch(filePath: string, name: string, sha: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['branch', name, sha];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git branch ${name} ${sha} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /**
   * Deletes a local branch. `force: false` uses `-d` (git refuses if the branch has unmerged
   * commits); `force: true` uses `-D`. Never targets a remote-tracking ref — deleting one of
   * those is a push operation (`git push origin --delete`), out of scope here. Caller confirms
   * first; git itself refuses to delete the currently checked-out branch.
   */
  async deleteBranch(filePath: string, name: string, force: boolean): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['branch', force ? '-D' : '-d', name];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git branch ${force ? '-D' : '-d'} ${name} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Renames a local branch, including the currently checked-out one — `git branch -m` supports both. */
  async renameBranch(filePath: string, oldName: string, newName: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['branch', '-m', oldName, newName];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git branch -m ${oldName} ${newName} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Deletes a local tag. Never touches a remote — deleting there is a separate push operation. */
  async deleteTag(filePath: string, name: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['tag', '-d', name];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git tag -d ${name} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Creates a lightweight tag named `name` pointing at `sha`, for the commit graph's "Tag This Commit" action. */
  async createTag(filePath: string, name: string, sha: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['tag', name, sha];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git tag ${name} ${sha} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Applies `stash@{index}` without dropping it, for the Sidebar Explorer's "Apply" action. Throws on conflicts. */
  async applyStash(filePath: string, index: number): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['stash', 'apply', `stash@{${index}}`];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git stash apply stash@{${index}} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Permanently deletes `stash@{index}`, for the Sidebar Explorer's "Drop" action. Caller confirms first — this is destructive and irreversible. */
  async dropStash(filePath: string, index: number): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = ['stash', 'drop', `stash@{${index}}`];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git stash drop stash@{${index}} failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /** Stashes the working tree (and index) with an optional message, for the Sidebar Explorer's "New Stash" action. Throws if there's nothing to stash. */
  async createStash(filePath: string, message?: string): Promise<void> {
    const repoRoot = await this.getRepoRoot(filePath);
    if (!repoRoot) {
      return;
    }
    const args = message ? ['stash', 'push', '-m', message] : ['stash', 'push'];
    try {
      await this.gitFor(repoRoot).raw(args);
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      this.logger?.error(`git stash push failed`, err);
      throw new GitCommandError(args.join(' '), stderr);
    }
  }

  /**
   * The `{issue}`-templated URL to use for issue linking: the user's configured template if
   * they set one, otherwise an auto-detected GitHub/GitLab template from the `origin` remote.
   * Null when linking isn't possible (no configured template and no recognizable remote).
   */
  async resolveIssueUrlTemplate(filePath: string, configuredTemplate: string): Promise<string | null> {
    if (configuredTemplate) {
      return configuredTemplate;
    }
    const remoteUrl = await this.getRemoteUrl(filePath);
    if (!remoteUrl) {
      return null;
    }
    const remote = parseRemoteUrl(remoteUrl);
    return remote ? buildDefaultUrlTemplate(remote) : null;
  }

  private gitFor(repoRoot: string): SimpleGit {
    let git = this.gitByRoot.get(repoRoot);
    if (!git) {
      git = simpleGit({ baseDir: repoRoot });
      this.gitByRoot.set(repoRoot, git);
    }
    return git;
  }

  /**
   * The directory to begin the upward repo search from.
   *
   * Callers pass either a file (the active editor) or a directory (the workspace folder, used when
   * no editor is open). Taking `dirname` unconditionally breaks the second case: handed a repo
   * *root*, it searches from the root's parent, so a repo that isn't nested inside another repo
   * resolves to null — and every view silently renders empty instead of erroring.
   */
  private toSearchDir(filePath: string): string {
    const canonical = this.toCanonicalPath(filePath);
    try {
      return statSync(canonical).isDirectory() ? canonical : dirname(canonical);
    } catch {
      // Nonexistent path (unsaved buffer, deleted file) — its parent is still where to look.
      return dirname(canonical);
    }
  }

  /**
   * `git rev-parse --show-toplevel` resolves symlinks in the path it's given (e.g. macOS's
   * `/var/folders` → `/private/var/folders`), but editor-supplied paths often don't. Without
   * canonicalizing here, `path.relative(repoRoot, filePath)` silently produces a bogus path
   * and every git call on that file fails as if it were untracked.
   */
  private toCanonicalPath(filePath: string): string {
    try {
      return realpathSync(filePath);
    } catch {
      return filePath;
    }
  }
}
