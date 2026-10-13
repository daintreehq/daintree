import { useCallback, useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** The widest the viewport can show while keeping `reserve` px free, never below `min`. */
export function viewportAttainableWidth(min: number, reserve: number): number {
  return Math.max(min, window.innerWidth - reserve);
}

/**
 * `preferred`, narrowed so `reserve` px of the viewport stay free for the rest
 * of the layout, but never below `min`. A tiling window manager can hand the
 * window a tile narrower than a width the user picked in a bigger window; the
 * preference itself is left alone so it comes back when the window grows.
 *
 * Re-renders only when the result changes, so a window wide enough for the
 * preference never re-renders on resize.
 */
export function useViewportCappedWidth(preferred: number, min: number, reserve: number): number {
  const getSnapshot = useCallback(
    () => Math.min(preferred, viewportAttainableWidth(min, reserve)),
    [preferred, min, reserve]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * The preference after a resize asks for `requested`, where `attainable` is the
 * widest the viewport can show. While the preference is already past the cap,
 * a request at or beyond the cap changes nothing on screen, so it keeps the
 * preference instead of swapping it for the capped width the user is looking at.
 */
export function resizeCappedPreference(
  requested: number,
  current: number,
  min: number,
  max: number,
  attainable: number
): number {
  const next = Math.min(Math.max(requested, min), max, attainable);
  return next >= attainable && current > attainable ? current : next;
}
