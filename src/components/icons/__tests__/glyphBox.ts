/**
 * The element that carries a state glyph's classes (size, tone, motion): the
 * `<svg>` for most states, and `SpinnerCircle`'s CSS-drawn span for working,
 * which is an HTML box so its spin can run on the compositor.
 */
export const GLYPH_SELECTOR = "[data-glyph-box], svg";

export function glyphBox(scope: ParentNode): Element | null {
  return scope.querySelector(GLYPH_SELECTOR);
}
