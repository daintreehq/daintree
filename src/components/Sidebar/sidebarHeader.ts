/**
 * The sidebar's title row, shared by every branch that draws one: the worktree
 * list (populated, loading, empty) and the non-git workspace sidebar. A fixed
 * 48px — 12px above and below a 24px action button — so switching workspace
 * kind, or a project resolving from loading to populated, never moves the
 * title or the list's top edge.
 */
export const SIDEBAR_HEADER_ROW = "flex h-12 shrink-0 items-center px-3";

/** A header action: the panel-chrome `icon-xs` box with its 14px glyph. */
export const SIDEBAR_HEADER_ACTION = "[&_svg]:size-3.5";
