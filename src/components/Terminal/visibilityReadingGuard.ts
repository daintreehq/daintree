// Guards the terminal visibility observer against stale `isIntersecting=false`
// readings (#9780). Under heavy main-thread load the IntersectionObserver can
// deliver a false negative for a terminal element that is actually fully
// on-screen — IO computes geometry at frame-end, so a delivered callback can
// reflect geometry from several frames prior. A single stale `false` writes
// `isVisible=false` to the store, which caps the terminal at the BACKGROUND
// refresh tier and freezes its output until the user clicks it.
//
// To suppress these false negatives we confirm a `false` reading against fresh
// synchronous geometry: if the element still has non-zero bounds it is
// physically present, so the reading is stale and must not be committed. The
// geometry must be read BEFORE any visibility write — calling
// getBoundingClientRect after a setVisible(false) would force a redundant
// layout reflow. `true` readings are always trusted and committed immediately.
//
// Geometry (width/height) is used rather than intersectionRatio because
// sub-pixel rounding can report a ratio below 1 for a fully visible element.
export function isStaleHiddenReading(
  entry: Pick<IntersectionObserverEntry, "isIntersecting">,
  getRect: () => DOMRect | undefined
): boolean {
  // A visible reading is never a stale hide.
  if (entry.isIntersecting) return false;
  const rect = getRect();
  // No rect (element unmounted between observe and callback) → genuine hide.
  if (!rect) return false;
  // Non-zero geometry means the element is on-screen, so the `false` is stale.
  return rect.width > 0 && rect.height > 0;
}
