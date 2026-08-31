/** The blame hover's line-explanation state, written by LineExplanationService and read by BlameHoverProvider on the next hover — a Hover can't be updated after it's returned, so this is how a background click's result reaches the UI. */
export type LineExplanationState =
  | { status: 'pending' }
  | { status: 'done'; text: string }
  | { status: 'noModel'; message: string }
  | { status: 'error'; message: string };

/** Both the writer (LineExplanationService) and the reader (BlameHoverProvider) must compute the exact same key from the same inputs for a background click's result to ever be seen by a later hover. Pure — no I/O, no vscode import. */
export function buildLineExplanationKey(repoRoot: string | null, filePath: string, sha: string, lineContent: string): string {
  return `${repoRoot ?? filePath}:${sha}:${lineContent}`;
}
