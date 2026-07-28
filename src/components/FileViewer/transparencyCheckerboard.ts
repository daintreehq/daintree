import type { CSSProperties } from "react";

/**
 * Neutral checkerboard so transparency reads correctly on both themes — the
 * border token tracks theme polarity, and the low-alpha mix keeps it quiet.
 *
 * Shared by the image diff viewer and the file browser's single-image view so
 * a transparent PNG looks the same wherever it is opened.
 */
export const TRANSPARENCY_CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    "repeating-conic-gradient(color-mix(in oklab, var(--color-daintree-border) 45%, transparent) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};
