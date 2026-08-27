import { Check, CircleMinus, Clock, X } from "lucide-react";
import type { CIStatus } from "@shared/types/forge";

/**
 * Every state gets a glyph, terminal or not (#12000). The non-terminal states
 * used to render a disc painted with a status background, which
 * `forced-colors: active` strips to nothing — pending and neutral simply
 * disappeared while passing and failing
 * stayed. A stroked icon inherits `currentColor`, which the UA repaints, so the
 * shape carries the state where the palette no longer can.
 */
export type CIStatusVisual = {
  Icon: typeof Check;
  colorClass: string;
  shortLabel: string;
  ariaLabel: string;
};

export function getCIStatusVisual(status: CIStatus | undefined | null): CIStatusVisual | null {
  if (!status) return null;
  switch (status.state) {
    case "success":
      return {
        Icon: Check,
        colorClass: "text-status-success",
        shortLabel: "passing",
        ariaLabel: "CI passing",
      };
    case "failure":
      return {
        Icon: X,
        colorClass: "text-status-error",
        shortLabel: "failing",
        ariaLabel: "CI failing",
      };
    case "pending":
      return {
        Icon: Clock,
        colorClass: "text-status-warning",
        shortLabel: "pending",
        ariaLabel: "CI pending",
      };
    case "neutral":
      // `text-secondary` rather than the old dot's `text-muted`: as a lone glyph
      // it owes the 3:1 non-text floor, which `text-muted` only clears on light
      // themes (`shared/theme/contrast.ts`).
      return {
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
