import { Check, X } from "lucide-react";
import type { CIStatus } from "@shared/types/forge";

export type CIStatusVisual =
  | { kind: "icon"; Icon: typeof Check; colorClass: string; shortLabel: string; ariaLabel: string }
  | { kind: "dot"; colorClass: string; shortLabel: string; ariaLabel: string };

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
        shortLabel: "pending",
        ariaLabel: "CI pending",
      };
    case "neutral":
      return {
        kind: "dot",
        colorClass: "bg-text-muted",
        shortLabel: "neutral",
        ariaLabel: "CI neutral",
      };
    case "unknown":
      return null;
    default:
      return null;
  }
}
