/** Counted in Unicode code points after normalising, never UTF-16 units. */
export const WORKTREE_CUSTOM_TITLE_MAX_LENGTH = 80;

// `\s` misses the zero-width characters, which would otherwise let a title that
// reads as blank survive the trim and occupy the headline as nothing.
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

/** Strips zero-width characters, collapses whitespace runs to one space, trims. */
export function normalizeWorktreeCustomTitle(raw: string): string {
  return raw.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

export function worktreeCustomTitleLength(normalized: string): number {
  return [...normalized].length;
}

export function isWorktreeCustomTitleTooLong(normalized: string): boolean {
  return worktreeCustomTitleLength(normalized) > WORKTREE_CUSTOM_TITLE_MAX_LENGTH;
}
