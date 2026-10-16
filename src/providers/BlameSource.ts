import * as vscode from 'vscode';
import { GitService, type BlameOptions } from '../core/git/GitService';
import { LruCache } from '../core/cache/LruCache';
import type { BlameLine } from '../core/git/types';
import type { GitLogger } from '../core/git/errors';
import { buildCacheKey } from '../utils/path';

const DEBOUNCE_MS = 500;
const DEFAULT_CACHE_SIZE = 200;
/** Blame is always read against the on-disk (saved) file, so the ref side of the cache key is fixed. */
const REF = 'HEAD';

/**
 * Single shared blame cache + invalidation-watcher, used by both the decoration provider
 * (which proactively re-renders) and the hover provider (which is pulled on demand by
 * VS Code and just needs a warm cache) — so a file is only ever blamed once per change.
 */
export class BlameSource implements vscode.Disposable {
  private readonly cache = new LruCache<string, BlameLine[]>(DEFAULT_CACHE_SIZE);
  private readonly headWatchersByRoot = new Map<string, vscode.Disposable[]>();
  private readonly fileWatchersByPath = new Map<string, vscode.Disposable[]>();
  private readonly invalidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly invalidateListeners = new Set<(repoRoot: string) => void>();

  constructor(
    private readonly git: GitService,
    private readonly logger?: GitLogger,
  ) {}

  dispose(): void {
    for (const list of this.fileWatchersByPath.values()) {
      for (const d of list) {
        d.dispose();
      }
    }
    for (const list of this.headWatchersByRoot.values()) {
      for (const d of list) {
        d.dispose();
      }
    }
    for (const timer of this.invalidateTimers.values()) {
      clearTimeout(timer);
    }
  }

  /** Fires after a repo's cache entries are invalidated — proactive consumers (decorations) re-render from this. */
  onInvalidate(listener: (repoRoot: string) => void): vscode.Disposable {
    this.invalidateListeners.add(listener);
    return new vscode.Disposable(() => this.invalidateListeners.delete(listener));
  }

  async getBlameLines(filePath: string, opts: BlameOptions): Promise<BlameLine[] | null> {
    const repoRoot = await this.git.getRepoRoot(filePath);
    if (!repoRoot) {
      return null;
    }

    // Encode blame flags in the ref segment so toggling ignoreWhitespace or detectMoves
    // produces a different key and avoids serving stale blame from before the toggle.
    const optsKey = `${opts.ignoreWhitespace ? 'w' : ''}${opts.detectMoves ? 'm' : ''}`;
    const key = buildCacheKey(repoRoot, filePath, `${REF}:${optsKey}`);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const lines = await this.git.blameFile(filePath, opts);
      this.cache.set(key, lines);
      this.watchHeadFor(repoRoot);
      return lines;
    } catch (err) {
      // Ambient blame failures stay silent visually — log only, to avoid popup spam
      // every time a file in a broken repo is opened. Command-triggered actions do surface errors.
      this.logger?.error(`blame failed for ${filePath}`, err);
      return null;
    }
  }

  /** One filesystem watcher per file a proactive consumer cares about (e.g. the active editor). Idempotent. */
  watchFile(filePath: string): void {
    if (this.fileWatchersByPath.has(filePath)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(filePath);
    const invalidate = (): void => {
      void this.invalidateForFile(filePath);
    };
    this.fileWatchersByPath.set(filePath, [watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate)]);
  }

  unwatchFile(filePath: string): void {
    for (const d of this.fileWatchersByPath.get(filePath) ?? []) {
      d.dispose();
    }
    this.fileWatchersByPath.delete(filePath);
  }

  /**
   * One shared HEAD/refs watcher per repo root — a branch switch affects every file in that
   * repo. Public (not just called internally from `getBlameLines`) so a consumer that has no
   * reason to blame a file itself — the commit graph, watching for external pulls/pushes to
   * auto-refresh — can still ensure this repo's watcher exists and subscribe via `onInvalidate`.
   */
  watchHeadFor(repoRoot: string): void {
    if (this.headWatchersByRoot.has(repoRoot)) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoRoot, '.git/{HEAD,refs/**}'),
    );
    const invalidate = (): void => this.scheduleInvalidate(repoRoot);
    this.headWatchersByRoot.set(repoRoot, [watcher, watcher.onDidChange(invalidate), watcher.onDidCreate(invalidate)]);
  }

  private async invalidateForFile(filePath: string): Promise<void> {
    const repoRoot = await this.git.getRepoRoot(filePath);
    if (repoRoot) {
      this.scheduleInvalidate(repoRoot);
    }
  }

  private scheduleInvalidate(repoRoot: string): void {
    const existing = this.invalidateTimers.get(repoRoot);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.invalidateTimers.delete(repoRoot);
      this.cache.deleteWhere((key) => key.startsWith(`${repoRoot}:`));
      for (const listener of this.invalidateListeners) {
        listener(repoRoot);
      }
    }, DEBOUNCE_MS);
    this.invalidateTimers.set(repoRoot, timer);
  }
}
