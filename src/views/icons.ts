/** Small monochrome inline SVGs for webview chrome — `currentColor`-stroked so they follow the theme for free, with no icon-font/library dependency. */

/** Wraps a path body in a 16x16 `currentColor` SVG. `size` is in px; callers style position/opacity via `className`. */
function icon(body: string, className: string, size = 14): string {
  return `<svg class="${className}" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const FILE_BODY = '<path d="M4 1.5h5.5L13 5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Z" /><path d="M9 1.5V5h4" />';

export const FILES_ICON = icon(FILE_BODY, 'section-icon');

export const DIFF_ICON = icon(
  '<path d="M5 2v9a2 2 0 0 0 2 2h4M5 2 2.5 4.5M5 2l2.5 2.5M11 14V5a2 2 0 0 0-2-2H5m6 11 2.5-2.5M11 14l-2.5-2.5" />',
  'section-icon',
);

/** Changes column: a file glyph next to the changed-file count. */
export const FILE_COUNT_ICON = icon(FILE_BODY, 'cell-icon', 12);

/** Local branch — the standard two-node-and-a-fork git glyph. */
export const BRANCH_ICON = icon(
  '<circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="3.5" r="1.6" /><path d="M4 5.1v5.8M12 5.1v1.3a3 3 0 0 1-3 3H4" />',
  'ref-icon',
  12,
);

/** Remote-tracking branch — a cloud, matching how VS Code signals "lives on the remote". */
export const REMOTE_ICON = icon(
  '<path d="M4.6 12.5h6.9a2.6 2.6 0 0 0 .3-5.18 3.6 3.6 0 0 0-6.7-1.1A2.95 2.95 0 0 0 4.6 12.5Z" />',
  'ref-icon',
  12,
);

/** Tag — a label with a punch hole. */
export const TAG_ICON = icon('<path d="M1.8 3.6h6.6l5.3 4.4-5.3 4.4H1.8z" /><circle cx="4.4" cy="8" r="0.9" />', 'ref-icon', 12);

export const SEARCH_ICON = icon('<circle cx="6.6" cy="6.6" r="4.3" /><path d="M9.8 9.8 14 14" />', 'toolbar-icon', 13);

export const REFRESH_ICON = icon('<path d="M13.4 8a5.4 5.4 0 1 1-1.86-4.08" /><path d="M13.6 2.2v3.2h-3.2" />', 'toolbar-icon', 13);

/** Fetch — a cloud with a download arrow, distinct from REFRESH_ICON (reload the local view) and ARROW_DOWN_ICON (Pull, which also merges). */
export const FETCH_ICON = icon(
  '<path d="M4.6 9.8h6.9a2.4 2.4 0 0 0 .3-4.78 3.3 3.3 0 0 0-6.1-1A2.7 2.7 0 0 0 4.6 9.8Z" /><path d="M8 9.8v4.7" /><path d="M6 12.5 8 14.5l2-2" />',
  'toolbar-icon',
  13,
);

export const COPY_ICON = icon(
  '<rect x="5.6" y="5.6" width="8" height="8.8" rx="1" /><path d="M10.4 3.4H3.4a1 1 0 0 0-1 1v7" />',
  'toolbar-icon',
  13,
);

/** Pending-changes row marker — a dashed node, the common convention for an uncommitted row. */
export const PENDING_ICON = icon('<circle cx="8" cy="8" r="5.2" stroke-dasharray="2.4 2" />', 'ref-icon', 12);

/** Stash — a small stacked-box glyph, for the commit graph's stash chip. */
export const STASH_ICON = icon('<rect x="2.5" y="5" width="11" height="8" rx="1" /><path d="M2.5 8.5h11" /><path d="M5.5 5V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V5" />', 'ref-icon', 12);

/** Open this file's before/after in a real diff editor. */
export const OPEN_CHANGES_ICON = icon(
  '<path d="M5 2v9a2 2 0 0 0 2 2h4M5 2 2.5 4.5M5 2l2.5 2.5M11 14V5a2 2 0 0 0-2-2H5m6 11 2.5-2.5M11 14l-2.5-2.5" />',
  'action-icon',
  12,
);

/** Copy the commit message. */
export const MESSAGE_ICON = icon(
  '<path d="M2.5 3.5h11v7h-6L4.5 13.5V10.5h-2z" /><path d="M5 6.5h6M5 8.5h3.5" />',
  'action-icon',
  12,
);

/** Leave the editor for the commit's page on the hosting service. */
export const EXTERNAL_ICON = icon('<path d="M9.5 2.5H13.5v4" /><path d="M13.5 2.5 7.5 8.5" /><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />', 'action-icon', 12);

/** Soft-wrap long diff lines instead of scrolling them. */
export const WRAP_ICON = icon('<path d="M2.5 3.5h11M2.5 8h8.5a2.5 2.5 0 0 1 0 5H8.5" /><path d="M10 11 8.5 13l1.5 2" /><path d="M2.5 12.5h3" />', 'action-icon', 12);

/** Swap which ref is the base and which is the compare. */
export const SWAP_ICON = icon('<path d="M2.5 5.5h11L10.5 2.5" /><path d="M13.5 10.5h-11l3 3" />', 'toolbar-icon', 13);

/** Nothing to show, and that's the good outcome — used by the "up to date" empty state. */
export const CHECK_ICON = icon('<path d="M3 8.5 6.5 12 13 4.5" />', 'empty-icon', 15);

/** Four-point sparkle — marks AI-generated content. */
export const AI_ICON = icon(
  '<path d="M8 2.2 9.1 6 12.9 7 9.1 8 8 11.8 6.9 8 3.1 7 6.9 6Z" /><path d="M12.5 2.4l0.5 1.3 1.3 0.5-1.3 0.5-0.5 1.3-0.5-1.3-1.3-0.5 1.3-0.5Z" />',
  'action-icon',
  12,
);

/** Author column header — a simple head-and-shoulders glyph. */
export const AUTHOR_ICON = icon(
  '<circle cx="8" cy="5.3" r="2.6" /><path d="M3 13.3c0-2.9 2.2-4.6 5-4.6s5 1.7 5 4.6" />',
  'cell-icon',
  12,
);

/** Commit Date column header. */
export const CLOCK_ICON = icon('<circle cx="8" cy="8" r="5.3" /><path d="M8 5.2v3l2 1.2" />', 'cell-icon', 12);

/** SHA column header — a hash mark, since a git SHA is a hash. */
export const HASH_ICON = icon(
  '<path d="M6.2 2.5 4.6 13.5M11.4 2.5 9.8 13.5M3 6.3h10M2.6 9.7h10" />',
  'cell-icon',
  12,
);

/** Rebase row drag handle — two columns of grip dots, the standard "drag this" affordance. */
export const DRAG_HANDLE_ICON = icon(
  '<circle cx="5.5" cy="4" r="1" /><circle cx="5.5" cy="8" r="1" /><circle cx="5.5" cy="12" r="1" /><circle cx="10.5" cy="4" r="1" /><circle cx="10.5" cy="8" r="1" /><circle cx="10.5" cy="12" r="1" />',
  'rb-drag-icon',
  14,
);

export const CHEVRON_UP_ICON = icon('<path d="M3.5 10.5 8 5.5l4.5 5" />', 'action-icon', 12);
export const CHEVRON_DOWN_ICON = icon('<path d="M3.5 5.5 8 10.5l4.5-5" />', 'action-icon', 12);

/** Pull — incoming commits, drawn as an arrow landing (stem + head, not a bare chevron like the rebase reorder buttons, so the two read as different actions at a glance). */
export const ARROW_DOWN_ICON = icon('<path d="M8 3v8.5" /><path d="M4.5 8.5 8 12l3.5-3.5" />', 'toolbar-icon', 13);

/** Push — outgoing commits. */
export const ARROW_UP_ICON = icon('<path d="M8 13V4.5" /><path d="M4.5 7.5 8 4l3.5 3.5" />', 'toolbar-icon', 13);

/** Snooze a Launchpad card — a simple clock face, echoing "come back to this later". */
export const SNOOZE_ICON = icon('<circle cx="8" cy="8.5" r="5.3" /><path d="M8 5.7v3l2 1.2" /><path d="M6 1.5h4" />', 'action-icon', 12);
export const CLOSE_ICON = icon('<path d="M4 4l8 8" /><path d="M12 4l-8 8" />', 'action-icon', 12);

/** Approve a PR review — a plain checkmark, sized to match the other Launchpad card actions. */
export const APPROVE_ICON = icon('<path d="M3 8.5 6.5 12 13 4.5" />', 'action-icon', 12);

/** Request changes on a PR review — an exclamation-in-circle, distinct from Close's X so the two aren't mistaken for one another. */
export const REQUEST_CHANGES_ICON = icon('<circle cx="8" cy="8" r="5.3" /><path d="M8 5.3v3" /><circle cx="8" cy="11" r="0.2" />', 'action-icon', 12);

/** Reopen a closed PR — a counter-clockwise restore arrow, distinct from Refresh's full circle so "reopen this" isn't mistaken for "reload the board". */
export const REOPEN_ICON = icon('<path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.27" /><path d="M2.5 2.5v3h3" />', 'action-icon', 12);

/** CI checks section — a checklist glyph: three lines of varying length with a small tick in the corner. */
export const CHECKS_ICON = icon(
  '<path d="M3.5 4.5h9M3.5 8h6M3.5 11.5h7.5" /><path d="M12.5 9 11 10.5l-0.8-0.8" />',
  'section-icon',
);

/** A small warning badge — exclamation mark — used inline next to text, smaller than the full REQUEST_CHANGES_ICON. */
export const WARNING_INLINE_ICON = icon('<circle cx="8" cy="8" r="5.3" /><path d="M8 5.3v3" /><circle cx="8" cy="11" r="0.2" />', 'status-icon', 12);

/** Merge a PR — two branch nodes converging into one, the standard git-merge glyph. */
export const MERGE_ICON = icon(
  '<circle cx="4" cy="3.3" r="1.6" /><circle cx="12" cy="3.3" r="1.6" /><circle cx="8" cy="12.7" r="1.6" /><path d="M4 4.9v1.3a3 3 0 0 0 3 3h.3M12 4.9v1.3a3 3 0 0 1-3 3h-.3" />',
  'action-icon',
  12,
);

/** Sign out of a forge host — a door frame with an arrow pointing out. */
export const SIGN_OUT_ICON = icon(
  '<path d="M6.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2.5" /><path d="M9.3 5.3 13 8l-3.7 2.7" /><path d="M13 8H6" />',
  'toolbar-icon',
  13,
);
