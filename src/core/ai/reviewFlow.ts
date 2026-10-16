import type { SummaryModel } from './commitSummaryFlow';
import { splitDiffByFile } from './fileReview';

/**
 * Maximum number of per-file model calls in the map step. Files beyond this cap are listed by
 * name in the synthesis prompt rather than silently dropped — the reviewer knows coverage is
 * partial, but the review is never suppressed.
 *
 * ponytail: hard-coded at 12; make configurable if users report needing more/fewer calls.
 */
const MAX_FILE_REVIEW_CALLS = 12;

export type ReviewFlowEvent =
  | { type: 'disabled' }
  | { type: 'noModel' }
  | { type: 'progress'; message: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export interface ReviewFlowParams {
  /** Whether `gitLore.ai.enabled` is true. The flow short-circuits before any model call if false. */
  enabled: boolean;
  /** The full unified diff text for the PR. */
  diff: string;
  /** Max chars per diff/file-diff passed to the model. */
  maxDiffChars: number;
  /** Abort signal — aborting mid-map stops further file calls and the synthesis call. */
  signal: AbortSignal;
  /** Selects a language model; called once at the start of the flow. Injected for testability. */
  selectModel: () => Promise<SummaryModel | undefined>;
  /**
   * Builds the prompt for the single-call path (diff ≤ maxDiffChars).
   * Called lazily — only when a model is available and the diff is small.
   */
  buildSingleCallPrompt: () => string;
  /**
   * Builds the per-file review prompt for the map step.
   * Called once per file that needs a model call (skips cached + binary).
   */
  buildFilePrompt: (path: string, fileDiff: string) => string;
  /**
   * Builds the synthesis prompt from accumulated per-file notes.
   * Called once after the map step completes.
   */
  buildSynthesisPrompt: (
    perFileNotes: Array<{ path: string; notes: string }>,
    overflowPaths: string[],
    skippedPaths: string[],
  ) => string;
  /** Per-file summary cache lookup. Returns undefined on a cache miss. */
  getCachedFileSummary: (path: string) => string | undefined;
  /** Writes a successfully generated per-file summary to the cache. */
  setCachedFileSummary: (path: string, notes: string) => void;
}

/**
 * Pure orchestration for PR review/explanation on large diffs.
 *
 * - `enabled: false` → yields `disabled`, stops. Zero fetches, zero model calls.
 * - Diff ≤ `maxDiffChars` → single prompt → streams chunks → `done`.
 * - Diff > `maxDiffChars` → splits by file → map step (≤ 12 calls, caching, abort) → synthesis.
 *
 * Vscode-free: `SummaryModel` and `AbortSignal` are generic stand-ins so every branch is
 * unit-testable with fakes.
 */
export async function* runReviewFlow(params: ReviewFlowParams): AsyncGenerator<ReviewFlowEvent> {
  const {
    enabled, diff, maxDiffChars, signal,
    selectModel, buildSingleCallPrompt, buildFilePrompt, buildSynthesisPrompt,
    getCachedFileSummary, setCachedFileSummary,
  } = params;

  if (!enabled) {
    yield { type: 'disabled' };
    return;
  }

  const model = await selectModel();
  if (!model) {
    yield { type: 'noModel' };
    return;
  }

  // Same post-selectModel abort check as runCommitSummaryFlow: selectModel can block on the
  // consent UI for seconds, and the caller may have aborted by the time it resolves.
  if (signal.aborted) {
    return;
  }

  // ── Single-call path (diff fits within maxDiffChars) ──────────────────────
  if (diff.length <= maxDiffChars) {
    const prompt = buildSingleCallPrompt();
    let fullText = '';
    try {
      for await (const chunk of model.streamText(prompt, signal)) {
        if (signal.aborted) return;
        fullText += chunk;
        yield { type: 'chunk', text: chunk };
      }
    } catch (err) {
      if (signal.aborted) return;
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    yield { type: 'done', text: fullText };
    return;
  }

  // ── Map-reduce path (diff exceeds maxDiffChars) ───────────────────────────
  const files = splitDiffByFile(diff);
  const mapFiles = files.slice(0, MAX_FILE_REVIEW_CALLS);
  const overflowPaths = files.slice(MAX_FILE_REVIEW_CALLS).map((f) => f.path);

  const perFileNotes: Array<{ path: string; notes: string }> = [];
  const skippedPaths: string[] = [];

  for (const [i, file] of mapFiles.entries()) {
    if (signal.aborted) return;

    // Cache hit — use the stored notes, no model call needed.
    const cachedNotes = getCachedFileSummary(file.path);
    if (cachedNotes !== undefined) {
      perFileNotes.push({ path: file.path, notes: cachedNotes });
      continue;
    }

    // Binary files can't be reviewed from diff text — list them in the synthesis.
    if (file.isBinary) {
      skippedPaths.push(file.path);
      continue;
    }

    yield { type: 'progress', message: `Reviewing file ${i + 1} of ${mapFiles.length}…` };

    const prompt = buildFilePrompt(file.path, file.diff);
    let fileNotes = '';
    try {
      for await (const chunk of model.streamText(prompt, signal)) {
        if (signal.aborted) return;
        fileNotes += chunk;
      }
      perFileNotes.push({ path: file.path, notes: fileNotes });
      setCachedFileSummary(file.path, fileNotes);
    } catch (err) {
      if (signal.aborted) return;
      // A model error on one file must not kill the whole review.
      // Skip it, note it by name in the synthesis prompt.
      skippedPaths.push(file.path);
    }
  }

  if (signal.aborted) return;

  // ── Synthesis step ────────────────────────────────────────────────────────
  const synthesisPrompt = buildSynthesisPrompt(perFileNotes, overflowPaths, skippedPaths);
  let fullText = '';
  try {
    for await (const chunk of model.streamText(synthesisPrompt, signal)) {
      if (signal.aborted) return;
      fullText += chunk;
      yield { type: 'chunk', text: chunk };
    }
  } catch (err) {
    if (signal.aborted) return;
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }
  yield { type: 'done', text: fullText };
}
