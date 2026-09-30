/**
 * The one drag grip: a 24px box (the WCAG 2.5.8 target floor) around a 12px
 * `GripVertical`, secondary ink stepping to primary on hover and keyboard focus,
 * an inset accent focus outline so the ring stays inside a row that clips, and
 * the grab cursors. The ink sits on the box rather than the glyph: forced
 * colours keep an SVG's own colour, so a class on the glyph would stay theme
 * grey in high-contrast mode. The worktree card's full-height gutter grip is
 * a different control and does not use it.
 */
export const DRAG_GRIP_CLASS =
  "flex h-6 w-6 shrink-0 items-center justify-center cursor-grab rounded-[var(--radius-md)] text-text-secondary hover:text-text-primary focus-visible:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px] active:cursor-grabbing";

export const DRAG_GRIP_ICON_CLASS = "h-3 w-3";
