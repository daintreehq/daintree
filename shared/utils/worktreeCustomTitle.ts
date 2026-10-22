/** Counted in Unicode code points after normalising, never UTF-16 units. */
export const WORKTREE_CUSTOM_TITLE_MAX_LENGTH = 80;

// `\s` misses the zero-width characters, which would otherwise let a title that
// reads as blank survive the trim and occupy the headline as nothing. The
// joiners (U+200C, U+200D) carry meaning mid-text — emoji sequences, script
// shaping — so they are only trimmed from the ends, never stripped inside.
const ZERO_WIDTH_SPACE = /[\u200B\uFEFF]/g;
const EDGE_JOINERS = /^[\s\u200C\u200D]+|[\s\u200C\u200D]+$/g;

/** Strips zero-width spaces, collapses whitespace runs to one space, trims. */
export function normalizeWorktreeCustomTitle(raw: string): string {
  return raw.replace(ZERO_WIDTH_SPACE, "").replace(/\s+/g, " ").replace(EDGE_JOINERS, "");
}

export function worktreeCustomTitleLength(normalized: string): number {
  return [...normalized].length;
}

export function isWorktreeCustomTitleTooLong(normalized: string): boolean {
  return worktreeCustomTitleLength(normalized) > WORKTREE_CUSTOM_TITLE_MAX_LENGTH;
}
