/**
 * The title strip across the top of a popover: padding and a bottom divider,
 * no fill of its own, because the popover is the surface. Settled on the dock
 * status popovers and shared by every popover with a titled header, so a strip
 * reads the same whether it opens from the dock, a pane header or the toolbar.
 *
 * A strip that holds a field (search, a name input) is not a title strip: it
 * keeps `p-3` so the field has room, and shares only the divider.
 */
export const POPOVER_HEADER_CLASS =
  "flex items-center justify-between gap-2 border-b border-divider px-3 py-2";

/** The popover's name in its header strip. Secondary ink: the list below is the content. */
export const POPOVER_TITLE_CLASS = "text-xs font-medium text-text-secondary";

/** A qualifier beside or under the title — a count, a scope, a one-line rule. */
export const POPOVER_HEADER_META_CLASS = "text-3xs text-text-secondary tabular-nums";

/**
 * An icon button in the header strip (refresh, and the like), passed to a
 * ghost `icon-xs` Button. The negative margins keep the strip at its title
 * height and sit the 14px glyph on the strip's right inset instead of 6px
 * inside it.
 */
export const POPOVER_HEADER_ACTION_CLASS = "-my-1 -mr-1.5 [&_svg]:size-3.5";

/**
 * Hover on a popover row: the neutral ladder's first step. Keyboard focus is
 * the focus ring on top, never a second fill.
 */
export const POPOVER_ROW_HOVER_CLASS =
  "transition-colors duration-150 ease-out hover:bg-overlay-subtle";
