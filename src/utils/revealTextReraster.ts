/**
 * Force a second raster of every piece of DOM text after a cached project view
 * is revealed.
 *
 * Before #12169 the warm switch stalled ~1.5 s behind the anti-flash bridge,
 * and the frame the user finally saw was never the first raster after
 * re-attach: the terminal wake's refit had already relaid the grid and
 * repainted the page behind the bridge. #12169 reveals within milliseconds,
 * so the first raster after `setVisible(true)` is now the one on screen — and
 * that is the frame that has shown the file tree's text with wrong glyphs
 * after a long dwell away. A later raster of the same tiles has always been
 * correct (hover and scroll heal it), so the cheapest robust repair is to make
 * that later raster happen on our own schedule instead of waiting for the
 * user to touch something.
 *
 * `webContents.invalidate()` only recomposites. A raster needs a paint
 * invalidation, so this toggles a root attribute whose only style effect is an
 * inherited, visually inert `text-shadow` (see `index.css`): the toggle-on
 * frame repaints all text once, the toggle-off frame repaints it again with
 * the original style. Two rasters of text-bearing tiles, no layout, no
 * reshaping, nothing the user can see.
 */

export const REVEAL_RERASTER_ATTR = "data-reveal-reraster";

/**
 * Arm the two-frame toggle. Returns a cancel function that clears any frame
 * still pending and removes the attribute. Callers must invoke it when the
 * view is cached again (`onViewCached`) or on unmount: a parked
 * `WebContentsView` keeps reporting `visibilityState: "visible"`, so the
 * guard below only covers the window or page genuinely going hidden.
 */
export function scheduleRevealTextReraster(
  root: HTMLElement = document.documentElement
): () => void {
  let rafId: number | null = requestAnimationFrame(() => {
    if (document.visibilityState !== "visible") {
      rafId = null;
      return;
    }
    root.setAttribute(REVEAL_RERASTER_ATTR, "");
    rafId = requestAnimationFrame(() => {
      rafId = null;
      root.removeAttribute(REVEAL_RERASTER_ATTR);
    });
  });
  return () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    root.removeAttribute(REVEAL_RERASTER_ATTR);
  };
}
