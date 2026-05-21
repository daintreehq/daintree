import { Check, X } from "lucide-react";
import type { GitHubPRCIStatus, GitHubPRCISummary } from "@shared/types/github";

export type PRCIStatusVisual =
  | { kind: "icon"; Icon: typeof Check; colorClass: string; shortLabel: string; ariaLabel: string }
  | { kind: "dot"; colorClass: string; shortLabel: string; ariaLabel: string };

export function getPRCIStatusVisual(status: GitHubPRCIStatus | undefined): PRCIStatusVisual | null {
  switch (status) {
    case "SUCCESS":
      return {
        kind: "icon",
        Icon: Check,
        colorClass: "text-status-success",
        shortLabel: "passing",
        ariaLabel: "CI passing",
      };
    case "FAILURE":
    case "ERROR":
      return {
        kind: "icon",
        Icon: X,
        colorClass: "text-status-error",
        shortLabel: "failing",
        ariaLabel: "CI failing",
      };
    case "PENDING":
    case "EXPECTED":
      return {
        kind: "dot",
        colorClass: "bg-status-warning",
        shortLabel: "pending",
        ariaLabel: "CI pending",
      };
    default:
      return null;
  }
}

export function getPRCIStatusTooltip(
  status: GitHubPRCIStatus | undefined,
  summary?: GitHubPRCISummary
): string | null {
  switch (status) {
    case "SUCCESS":
      if (summary) {
        return summary.requiredTotal === 0
          ? "No required checks"
          : `${summary.requiredTotal} required check${summary.requiredTotal === 1 ? "" : "s"} passing`;
      }
      return "All checks passed";
    case "PENDING":
    case "EXPECTED":
      return summary && summary.requiredPending > 0
        ? `${summary.requiredPending} of ${summary.requiredTotal} required check${summary.requiredTotal === 1 ? "" : "s"} pending`
        : "Checks pending";
    case "FAILURE":
    case "ERROR":
      return summary && summary.requiredFailing > 0
        ? `${summary.requiredFailing} of ${summary.requiredTotal} required check${summary.requiredTotal === 1 ? "" : "s"} failing`
        : "Checks failing";
    default:
      return null;
  }
}
