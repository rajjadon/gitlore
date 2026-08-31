import type { BlameLine, Commit, FileChange } from '../core/git/types';
import { formatAge, formatAbsolute } from './date';
import { buildGravatarUrl } from './gravatar';
import { linkifyIssues, type IssueLinkOptions } from './issueLinks';
import { COMMANDS } from '../constants';
import type { LineExplanationState } from '../core/ai/lineExplanationKey';

const MARKDOWN_SPECIAL_RE = /([\\`*_{}[\]()#+\-.!|>~])/g;
/** Caps the rendered "done" explanation length — nothing else in this file bounds model output, and an unbounded response pushes the whole hover very tall. */
const MAX_EXPLANATION_CHARS = 500;

/**
 * Escapes markdown syntax characters. `author` and `summary` come from git history, which
 * is attacker-influenced content if the repo isn't trusted — without this, a commit message
 * could inject fake links/emphasis/headings into the rendered hover.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_RE, '\\$1');
}

/** Escapes `text` for markdown, linkifying any issue references per `issueLinking` first. */
function formatMessage(text: string, issueLinking: IssueLinkOptions | null): string {
  if (!issueLinking) {
    return escapeMarkdown(text);
  }
  return linkifyIssues(text, issueLinking.pattern, issueLinking.urlTemplate)
    .map((segment) => (segment.url ? `[${escapeMarkdown(segment.text)}](${segment.url})` : escapeMarkdown(segment.text)))
    .join('');
}

/** `$(sparkle)` matches GitLore's existing AI glyph (see `AI_ICON` in `src/views/icons.ts`) — same metaphor, rendered as a codicon here instead of inline SVG since this is a native hover, not a webview. */
function buildExplainLineLink(filePath: string, sha: string, lineContent: string): string {
  const linkArgs = encodeURIComponent(JSON.stringify([filePath, sha, lineContent]));
  return `[$(sparkle) Explain this line](command:${COMMANDS.explainLine}?${linkArgs})`;
}

/** Compare / File History / Copy SHA — all three already exist as standalone commands; the hover just links to them rather than duplicating their behavior. Compare and File History act on the file, not the specific commit, so they take no arguments; only Copy SHA needs one. */
function buildQuickActionsRow(sha: string): string {
  const copyArgs = encodeURIComponent(JSON.stringify([sha]));
  return [
    `[$(git-compare) Compare](command:${COMMANDS.compareBranches})`,
    `[$(history) File History](command:${COMMANDS.showFileHistory})`,
    `[$(copy) Copy SHA](command:${COMMANDS.copySha}?${copyArgs})`,
  ].join(' · ');
}

/**
 * The lone "Older" link shown on the *live* blame card (nothing to page through yet — going
 * "forward" from the current line doesn't mean anything). Deliberately doesn't show a "N of M"
 * count: that would require fetching the line's full `-L` history — a meaningfully more
 * expensive git call than a blame lookup — on every hover, whether or not the user ever clicks
 * it. Cost is paid only once they actually navigate; see `buildLineHistoryNavRow`.
 */
function buildLineHistoryNavLink(filePath: string, line: number): string {
  const args = encodeURIComponent(JSON.stringify([filePath, line, 'prev']));
  return `[$(chevron-left) Older](command:${COMMANDS.stepLineHistory}?${args})`;
}

/**
 * The full prev/next row shown once the stepper has actually navigated — at that point the
 * caller already paid for the `-L` history fetch, so the total count is known and both
 * directions can be rendered precisely: "next" is always a link (going to index 0, the live
 * entry, is always valid), "prev" becomes plain (non-link) text once the oldest revision is reached.
 */
function buildLineHistoryNavRow(filePath: string, line: number, index: number, total: number): string {
  const prevArgs = encodeURIComponent(JSON.stringify([filePath, line, 'prev']));
  const nextArgs = encodeURIComponent(JSON.stringify([filePath, line, 'next']));
  const prev = index < total - 1 ? `[$(chevron-left)](command:${COMMANDS.stepLineHistory}?${prevArgs})` : '$(chevron-left)';
  const next = `[$(chevron-right)](command:${COMMANDS.stepLineHistory}?${nextArgs})`;
  return `${prev} ${index + 1} of ${total} ${next}`;
}

/**
 * Renders the line-explanation section of the hover based on its current state. A `Hover` can't
 * be updated after it's returned (no live-streaming API), so "in progress" and "finished" are
 * both just different static renders of whatever `formatBlameHover`'s caller looked up before
 * building this hover — see `LineExplanationService` for the writer side. Every state shares the
 * `$(sparkle)` anchor (link states have it inside the link, non-link states before the text) so
 * switching states reads as one feature progressing, not unrelated content appearing.
 */
function formatLineExplanation(
  state: LineExplanationState | undefined,
  filePath: string,
  sha: string,
  lineContent: string,
): string {
  if (state === undefined) {
    return buildExplainLineLink(filePath, sha, lineContent);
  }
  switch (state.status) {
    case 'pending':
      return '$(sparkle) $(loading~spin) Generating explanation…';
    case 'done': {
      const truncated =
        state.text.length > MAX_EXPLANATION_CHARS ? `${state.text.slice(0, MAX_EXPLANATION_CHARS)}…` : state.text;
      return `$(sparkle) **Why this line exists**\n\n${escapeMarkdown(truncated)}`;
    }
    case 'noModel':
      return `${state.message}\n\n${buildExplainLineLink(filePath, sha, lineContent)}`;
    case 'error':
      return `Failed to generate explanation: ${escapeMarkdown(state.message)}\n\n${buildExplainLineLink(filePath, sha, lineContent)}`;
  }
}

/**
 * Builds the markdown body for the blame hover card. Pure — the caller wraps the result in a
 * `vscode.MarkdownString` and must set both `isTrusted = { enabledCommands: [...] }` (listing
 * every command a link in this output points at — `explainLine`, `compareBranches`,
 * `showFileHistory`, `copySha`, `stepLineHistory` — for the links to be clickable) and
 * `supportThemeIcons = true` (for `$(sparkle)` etc. to render as icons instead of literal text) —
 * VS Code ignores both by default.
 *
 * Every return path ends with a trailing `---` thematic break. GitLore cannot suppress or control
 * other hover providers (VS Code's own native git blame, TypeScript's type-info hover, etc.) that
 * VS Code may stack in the same tooltip for the same cursor position — the trailing rule is the
 * one thing GitLore's own markdown can do to guarantee a clean visual seam against whatever
 * renders after it, since VS Code's own inter-provider divider isn't reliably present.
 */
export function formatBlameHover(
  entry: BlameLine,
  diffStat: FileChange | null,
  filePath: string,
  lineContent: string,
  lineExplanation: LineExplanationState | undefined,
  now: Date = new Date(),
  issueLinking: IssueLinkOptions | null = null,
): string {
  if (entry.isUncommitted) {
    return '**Uncommitted changes**\n\nThis line has not been committed yet.\n\n---';
  }

  const date = new Date(entry.authorTime * 1000);
  const avatarUrl = buildGravatarUrl(entry.authorEmail, { size: 20 });
  const author = escapeMarkdown(entry.author);
  const message = formatMessage(entry.summary, issueLinking);
  const age = formatAge(date, now);
  const absoluteDate = formatAbsolute(date, 'yyyy-MM-dd HH:mm');
  const shortSha = entry.sha.slice(0, 7);

  // A bare `![](url) **name**` paragraph baseline-aligns the image with the text, so the avatar
  // hangs noticeably above the name — confirmed against VS Code's own sanitizer allowlist
  // (github.com/microsoft/vscode markdownRenderer.ts): `img` may not carry `style` or `class`, so
  // there is no markdown/HTML way to set `vertical-align` on it directly. A borderless two-cell
  // table sidesteps this: `td`/`th` default to `vertical-align: middle` in every browser, which
  // centers the avatar against the name regardless of the image's own inline alignment.
  const lines = [
    `| ![](${avatarUrl}) | **${author}** |`,
    '| :--- | :--- |',
    '',
    message,
    '',
    `${age} · ${absoluteDate} · \`${shortSha}\``,
  ];

  if (diffStat && !diffStat.binary) {
    lines.push(`$(diff) +${diffStat.insertions} -${diffStat.deletions} in this file`);
  }

  lines.push('', buildQuickActionsRow(entry.sha));
  lines.push('', buildLineHistoryNavLink(filePath, entry.line));
  lines.push('', formatLineExplanation(lineExplanation, filePath, entry.sha, lineContent));
  lines.push('', '---');

  return lines.join('\n');
}

/**
 * Renders the card shown once the hover's prev/next stepper has navigated away from the live
 * blame entry. Same avatar/author/message/date/sha/diffstat layout as `formatBlameHover`, but no
 * AI-explain section — that feature is keyed to the *current* file's line content, which doesn't
 * correspond to a historical revision's version of the line — and a full nav row instead of the
 * single "Older" link, now that the caller already knows the total step count.
 */
export function formatLineHistoryHover(
  commit: Commit,
  diffStat: FileChange | null,
  filePath: string,
  line: number,
  index: number,
  total: number,
  now: Date = new Date(),
  issueLinking: IssueLinkOptions | null = null,
): string {
  const date = new Date(commit.date);
  const avatarUrl = buildGravatarUrl(commit.authorEmail, { size: 20 });
  const author = escapeMarkdown(commit.author);
  const message = formatMessage(commit.message, issueLinking);
  const age = formatAge(date, now);
  const absoluteDate = formatAbsolute(date, 'yyyy-MM-dd HH:mm');
  const shortSha = commit.sha.slice(0, 7);

  const lines = [
    `| ![](${avatarUrl}) | **${author}** |`,
    '| :--- | :--- |',
    '',
    message,
    '',
    `${age} · ${absoluteDate} · \`${shortSha}\``,
  ];

  if (diffStat && !diffStat.binary) {
    lines.push(`$(diff) +${diffStat.insertions} -${diffStat.deletions} in this file`);
  }

  lines.push('', buildQuickActionsRow(commit.sha));
  lines.push('', buildLineHistoryNavRow(filePath, line, index, total));
  lines.push('', '---');

  return lines.join('\n');
}
