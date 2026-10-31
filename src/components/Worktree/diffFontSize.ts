import type { CSSProperties } from "react";
import type { DiffFontSize } from "@/store/preferencesStore";

// The S/M/L rungs are the shared type steps, so the preference keeps meaning the
// same sizes it always did while still tracking the scale.
const DIFF_FONT_SIZE: Record<DiffFontSize, string> = {
  s: "var(--text-2xs)",
  m: "var(--text-xs)",
  l: "var(--text-sm)",
};

/**
 * `DiffViewer.lines.css` reads `--diff-font-size`; a host declares it on the
 * element around the viewer so the size preference reaches the rendered diff.
 */
export function diffFontStyle(
  size: DiffFontSize
): CSSProperties & Record<"--diff-font-size", string> {
  return { "--diff-font-size": DIFF_FONT_SIZE[size] };
}
