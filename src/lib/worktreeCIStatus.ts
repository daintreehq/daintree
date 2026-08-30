import { Check, CircleMinus, X } from "lucide-react";
import type { CIStatus } from "@shared/types/forge";

/**
 * A run still in flight is a dot; a settled one is a glyph. That is GitHub's own
 * vocabulary, and the one the forge dropdown rows already speak
 * (`plugins/builtin/github/renderer/utils/prCIStatus.ts`) — a clock for pending
 * read as a duration rather than a state and put the two out of step.
 *
 * The dot is painted as a background, which `forced-colors: active` strips to
 * nothing, so every consumer renders it with the shared `.status-mark` hook
 * `src/index.css` repaints to CanvasText (#12000). Neutral keeps the glyph it
 * got there: a second dot would collapse onto pending's under that override,
 * where hue is gone and only shape is left to tell them apart.
 */
export type CIStatusVisual =
  | { kind: "icon"; Icon: typeof Check; colorClass: string; shortLabel: string; ariaLabel: string }
  | { kind: "dot"; colorClass: string; labelClass: string; shortLabel: string; ariaLabel: string };

export function getCIStatusVisual(status: CIStatus | undefined | null): CIStatusVisual | null {
  if (!status) return null;
  switch (status.state) {
    case "success":
      return {
        kind: "icon",
        Icon: Check,
        colorClass: "text-status-success",
        shortLabel: "passing",
        ariaLabel: "CI passing",
      };
    case "failure":
      return {
        kind: "icon",
        Icon: X,
        colorClass: "text-status-error",
        shortLabel: "failing",
        ariaLabel: "CI failing",
      };
    case "pending":
      return {
        kind: "dot",
        colorClass: "bg-status-warning",
        labelClass: "text-status-warning",
        shortLabel: "pending",
        ariaLabel: "CI pending",
      };
    case "neutral":
      // Secondary rather than the old dot's muted token: as a lone mark it owes
      // the 3:1 non-text floor, which muted only clears on light themes
      // (`shared/theme/contrast.ts`).
      return {
        kind: "icon",
        Icon: CircleMinus,
        colorClass: "text-text-secondary",
        shortLabel: "neutral",
        ariaLabel: "CI neutral",
      };
    case "unknown":
      return null;
    default:
      return null;
  }
}
