import * as vscode from 'vscode';
import type { BlameSource } from './BlameSource';
import { findStaleSymbol } from '../core/git/staleness';
import { formatAge } from '../utils/date';
import { CONFIG, COMMANDS, DEFAULT_MAX_BLAME_FILE_SIZE } from '../constants';

const DEFAULT_STALE_THRESHOLD_DAYS = 180;

/**
 * Walks a document's top-level symbols for stale-check candidates: top-level functions, plus one
 * level into a class for its methods/constructors. Never recurses further — a function nested
 * inside another function is never flagged, and a class's own declaration line never gets its own
 * lens (its range spans every method inside it, so a stale class would otherwise double up with
 * every one of its already-flagged stale methods).
 */
function collectCandidates(symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  const candidates: vscode.DocumentSymbol[] = [];
  for (const symbol of symbols) {
    if (symbol.kind === vscode.SymbolKind.Function) {
      candidates.push(symbol);
    } else if (symbol.kind === vscode.SymbolKind.Class) {
      for (const child of symbol.children) {
        if (child.kind === vscode.SymbolKind.Method || child.kind === vscode.SymbolKind.Constructor) {
          candidates.push(child);
        }
      }
    }
  }
  return candidates;
}

/** Flags functions/methods untouched for longer than `gitLore.staleThresholdDays`, per §7 Phase 2 of CLAUDE.md. */
export class StaleCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  private readonly invalidateDisposable: vscode.Disposable;
  private readonly configDisposable: vscode.Disposable;

  constructor(private readonly source: BlameSource) {
    this.invalidateDisposable = this.source.onInvalidate(() => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
    this.configDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG.section)) {
        this.onDidChangeCodeLensesEmitter.fire();
      }
    });
  }

  dispose(): void {
    this.invalidateDisposable.dispose();
    this.configDisposable.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration(CONFIG.section);
    if (!config.get<boolean>(CONFIG.staleCodeEnabled, true) || document.uri.scheme !== 'file') {
      return [];
    }

    const maxSize = config.get<number>(CONFIG.maxBlameFileSize, DEFAULT_MAX_BLAME_FILE_SIZE);
    if (Buffer.byteLength(document.getText(), 'utf8') > maxSize) {
      return [];
    }

    // Fetch symbols before blame: the provider is registered for every `file`-scheme document
    // (JSON, plain text, lockfiles, ...), most of which have no symbol provider and thus no
    // candidates. Bailing here avoids spawning a `git blame` subprocess — and polluting the
    // shared BlameSource LRU cache that decorations/hover actually depend on — for files that
    // were never going to produce a lens anyway.
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
      'vscode.executeDocumentSymbolProvider',
      document.uri,
    );
    if (!symbols || symbols.length === 0) {
      return [];
    }

    const candidates = collectCandidates(symbols);
    if (candidates.length === 0) {
      return [];
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const filePath = document.uri.fsPath;
    const ignoreWhitespace = config.get<boolean>(CONFIG.blameIgnoreWhitespace, true);
    const detectMoves = config.get<boolean>(CONFIG.blameDetectMoves, false);
    const blameLines = await this.source.getBlameLines(filePath, { ignoreWhitespace, detectMoves });
    if (!blameLines || blameLines.length === 0) {
      return [];
    }

    const thresholdDays = config.get<number>(CONFIG.staleThresholdDays, DEFAULT_STALE_THRESHOLD_DAYS);
    const now = new Date();
    const lenses: vscode.CodeLens[] = [];

    for (const symbol of candidates) {
      // Blame line numbers are read from the file on disk, but `symbol.range` comes from
      // `executeDocumentSymbolProvider` against the in-memory (possibly unsaved/edited) buffer —
      // an edit above a stale function can shift its reported range relative to blame. Same
      // caveat as inline blame/hover; worth calling out here since the lens's click action below
      // names one specific commit SHA.
      const stale = findStaleSymbol(blameLines, symbol.range.start.line, symbol.range.end.line, thresholdDays, now);
      if (!stale) {
        continue;
      }
      const range = new vscode.Range(symbol.range.start, symbol.range.start);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Stale · last changed ${formatAge(stale.lastTouched, now)}`,
          command: COMMANDS.showCommit,
          arguments: [filePath, stale.sha],
        }),
      );
    }

    return lenses;
  }
}
