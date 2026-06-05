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
// Geometry is used rather than intersectionRatio because sub-pixel rounding can
// report a ratio below 1 for a fully visible element. The check confirms the
// element actually OVERLAPS the observation root, not merely that it has a
// layout box — a terminal scrolled off the grid keeps its full dimensions while
// genuinely hidden, so a width/height test alone would wrongly suppress that
// legitimate hide and strand a hidden terminal at a high refresh tier. We only
// treat a `false` as stale when the element is truly on-screen.
export function isStaleHiddenReading(
  entry: Pick<IntersectionObserverEntry, "isIntersecting">,
  getElementRect: () => DOMRect | undefined,
  getRootRect: () => DOMRect | undefined
): boolean {
  // A visible reading is never a stale hide.
  if (entry.isIntersecting) return false;
  const rect = getElementRect();
  // No rect (element unmounted between observe and callback) → genuine hide.
  if (!rect) return false;
  // No layout box → genuine hide.
  if (rect.width <= 0 || rect.height <= 0) return false;
  const root = getRootRect();
  // Can't confirm against the root → trust the reading and let the hide stand.
  if (!root) return false;
  // Stale only if the element's fresh bounds overlap the observation root,
  // i.e. it is actually on-screen (axis-aligned bounding-box intersection).
  return (
    rect.right > root.left &&
    rect.left < root.right &&
    rect.bottom > root.top &&
    rect.top < root.bottom
  );
}
