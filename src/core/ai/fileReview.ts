import type { PullRequestSummary, ConversationThread } from '../forge/types';
import { truncateForModel } from './prompts';

/** One file's slice of a unified diff. `isBinary` is set when the diff contains a binary-files notice. */
export interface FileDiff {
  path: string;
  /** The full diff text for this file, starting with the `diff --git` header line. */
  diff: string;
  isBinary?: boolean;
}

/**
 * Extracts the destination path (`b/` side) from a `diff --git` header line.
 *
 * Handles:
 * - Symmetric paths: `a/<path> b/<path>` — verified by reconstruction.
 * - Asymmetric paths (renames): `a/<old> b/<new>` — falls back to last ` b/` occurrence.
 * - Quoted paths (paths with special chars): `"a/<path>" "b/<path>"`.
 */
function extractBPath(header: string): string {
  const rest = header.slice('diff --git '.length);

  // Quoted form: "a/<path>" "b/<path>"
  if (rest.startsWith('"a/')) {
    const closeA = rest.indexOf('"', 3);
    if (closeA > 0) {
      const afterA = rest.slice(closeA + 1).trimStart();
      if (afterA.startsWith('"b/') && afterA.endsWith('"')) {
        return afterA.slice(3, -1);
      }
    }
  }

  // Symmetric unquoted: a/<path> b/<path>
  // len("a/" + P + " b/" + P) = 7 + 2*len(P) → len(P) = (len(rest) - 7) / 2
  const pathLen = (rest.length - 7) / 2;
  if (pathLen > 0 && Number.isInteger(pathLen)) {
    const candidate = rest.slice(rest.length - pathLen);
    if (rest === `a/${candidate} b/${candidate}`) {
      return candidate;
    }
  }

  // Asymmetric (rename) or fallback: use the last ' b/' occurrence, which is the b/ prefix
  const bIdx = rest.lastIndexOf(' b/');
  if (bIdx !== -1) {
    return rest.slice(bIdx + 3);
  }

  // Last resort: strip the leading 'a/' prefix
  return rest.slice(2);
}

/**
 * Splits a unified diff string into per-file slices.
 *
 * Handles: empty input, binary files, renames, paths with spaces, no trailing newline,
 * a single huge file, and many files. Preamble lines before the first `diff --git` are
 * silently ignored — well-formed diffs don't have them, but robustness is cheap here.
 *
 * Pure — no I/O, no vscode import.
 */
export function splitDiffByFile(diff: string): FileDiff[] {
  if (!diff.trim()) return [];

  const lines = diff.split('\n');
  const result: FileDiff[] = [];

  let currentPath: string | undefined;
  let currentLines: string[] = [];
  let currentBinary = false;
  let currentRenameTo: string | undefined;

  function flush(): void {
    if (currentPath === undefined) return;
    const finalPath = currentRenameTo ?? currentPath;
    const entry: FileDiff = { path: finalPath, diff: currentLines.join('\n') };
    if (currentBinary) entry.isBinary = true;
    result.push(entry);
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = extractBPath(line);
      currentLines = [line];
      currentBinary = false;
      currentRenameTo = undefined;
    } else if (currentPath !== undefined) {
      currentLines.push(line);
      if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
        currentBinary = true;
      }
      if (line.startsWith('rename to ')) {
        currentRenameTo = line.slice('rename to '.length);
      }
    }
    // Lines before the first 'diff --git' are silently ignored.
  }

  flush();
  return result;
}

/**
 * Builds the prompt for reviewing a single changed file. Truncates the diff at `maxDiffChars`
 * using the shared truncation helper.
 *
 * Pure — no I/O, no vscode import.
 */
export function buildFileReviewPrompt(path: string, fileDiff: string, maxDiffChars: number): string {
  const body = truncateForModel(fileDiff, maxDiffChars);
  return `You are reviewing a single changed file in a pull request, as one step in a systematic review.

File: ${path}

Diff:
${body}

In 1-3 sentences, describe the key changes in this file and note any potential issues, risks, or questions a careful reviewer should raise. Be specific to this file; avoid generic observations. If the diff was truncated, base your notes only on what's shown.`;
}

/**
 * Builds the synthesis prompt for a draft PR review. Takes the per-file notes from the map step,
 * the paths of files beyond the 12-file cap, and the paths of files whose model call failed.
 *
 * Pure — no I/O, no vscode import.
 */
export function buildReviewSynthesisPrompt(
  pr: PullRequestSummary,
  perFileNotes: Array<{ path: string; notes: string }>,
  overflowPaths: string[],
  skippedPaths: string[],
  threads: ConversationThread[],
): string {
  const notesText = perFileNotes.length > 0
    ? perFileNotes.map(({ path, notes }) => `### ${path}\n${notes}`).join('\n\n')
    : '(no per-file notes)';

  const overflowSection = overflowPaths.length > 0
    ? `\nFiles not individually reviewed (listed by name only — your draft may miss issues in these):\n${overflowPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const skippedSection = skippedPaths.length > 0
    ? `\nFiles where review failed (model error — not included in per-file notes):\n${skippedPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const existingThreads = threads.length > 0
    ? threads.map((t) => `- ${t.authorLogin}: ${t.body}`).join('\n')
    : '(no existing review conversations)';

  return `You are drafting one top-level review comment for a pull request, to be edited by a human reviewer before posting — never post this yourself.

Title: ${pr.title}

Per-file review notes:
${notesText}
${overflowSection}${skippedSection}
Existing review conversations:
${existingThreads}

Based on the per-file notes above, write one draft comment (2-5 sentences) raising the most useful question or concern a careful reviewer would, that isn't already covered by an existing conversation above. Do not include a greeting or sign-off.`;
}

/**
 * Builds the synthesis prompt for a PR explanation (used by `explainPr` on oversized diffs).
 * Takes the per-file summaries from the map step, overflow paths, and skipped paths.
 *
 * Pure — no I/O, no vscode import.
 */
export function buildExplanationSynthesisPrompt(
  pr: PullRequestSummary,
  perFileNotes: Array<{ path: string; notes: string }>,
  overflowPaths: string[],
  skippedPaths: string[],
): string {
  const notesText = perFileNotes.length > 0
    ? perFileNotes.map(({ path, notes }) => `### ${path}\n${notes}`).join('\n\n')
    : '(no per-file summaries)';

  const overflowSection = overflowPaths.length > 0
    ? `\nFiles not individually summarized (too many files; listed by name only):\n${overflowPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  const skippedSection = skippedPaths.length > 0
    ? `\nFiles where summary failed (model error):\n${skippedPaths.map((p) => `- ${p}`).join('\n')}\n`
    : '';

  return `You are summarizing a pull request for a developer deciding whether to review it.

Title: ${pr.title}

Per-file change summaries:
${notesText}
${overflowSection}${skippedSection}
Write a plain-English summary of what this PR changes and why, in 2-4 sentences, followed by one sentence calling out the riskiest area to focus a review on. If some files were not individually summarized, note that your summary may be incomplete. Do not repeat the title verbatim.`;
}
