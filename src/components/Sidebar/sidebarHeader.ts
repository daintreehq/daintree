/**
 * The sidebar's title row, shared by every branch that draws one: the worktree
 * list (populated, loading, empty) and the non-git workspace sidebar. A fixed
 * height, so switching workspace kind, or a project resolving from loading to
 * populated, never moves the title or the list's top edge.
 *
 * 42px puts the title's centre on the first pane header's centre across the
 * gutter (the grid's 4px inset + 1px frame + half a 32px header), so the one
 * line the eye reads across the window has one baseline. The 16px inset is the
 * cards' and footer's, so the whole column shares one left and right edge.
 */
export const SIDEBAR_HEADER_ROW = "flex h-10.5 shrink-0 items-center px-4";

/** A header action: the panel-chrome `icon-xs` box with its 14px glyph. */
export const SIDEBAR_HEADER_ACTION = "[&_svg]:size-3.5";
