import type { CSSProperties } from "react";

/**
 * Neutral checkerboard so transparency reads correctly on both themes — the
 * border token tracks theme polarity, and the low-alpha mix keeps it quiet.
 *
 * Shared by the image diff viewer and the file browser's single-image view so
 * a transparent PNG looks the same wherever it is opened. Both paint it on the
 * image's own box rather than the frame around it, so where the image ends is
 * visible instead of dissolving into a board that fills the pane.
 */
const TILE_PX = 16;

export const TRANSPARENCY_CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-conic-gradient(color-mix(in oklab, var(--color-border-default) 45%, transparent) 0% 25%, transparent 0% 50%)",
  backgroundSize: `${TILE_PX}px ${TILE_PX}px`,
};

/**
 * The checkerboard for an element drawn under a CSS `scale()` transform. The
 * transform scales the background with it, so the tile is divided back out to
 * keep the squares the same size on screen at every zoom.
 */
export function transparencyCheckerboardUnderScale(scale: number): CSSProperties {
  const tile = TILE_PX / (scale > 0 ? scale : 1);
  return { ...TRANSPARENCY_CHECKERBOARD_STYLE, backgroundSize: `${tile}px ${tile}px` };
}
