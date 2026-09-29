import { Check, X } from "lucide-react";
import type { CIStatusState, PRMergeState } from "@shared/types/forge";
import { GitMergeConflict } from "@/components/icons";
import type { GitHubPRCIStatus, GitHubPRCISummary } from "../../shared/types.js";
import { toGitHubCIStatus } from "./forgeRowAdapters.js";

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

const MERGE_CONFLICT_VISUAL: PRCIStatusVisual = {
  kind: "icon",
  Icon: GitMergeConflict,
  colorClass: "text-status-warning",
  shortLabel: "conflicts",
  ariaLabel: "Merge conflicts",
};

// GitHub skips `pull_request` workflows while the head conflicts with the base,
// so a conflicted PR usually has no roll-up at all. `pull_request_target`
// workflows still run, hence naming the event rather than claiming "no CI".
const MERGE_CONFLICT_TOOLTIP =
  "Merge conflicts with the base branch — GitHub skips pull_request workflows until they're resolved";

/**
 * Status for a forge PR's CI slot. A reported merge conflict takes the slot
 * over any roll-up: it has to be resolved before anything else moves.
 */
export function getPRStatusVisual(
  ciStatus: CIStatusState | undefined,
  mergeState: PRMergeState | undefined
): PRCIStatusVisual | null {
  if (mergeState === "conflicts") return MERGE_CONFLICT_VISUAL;
  return getPRCIStatusVisual(toGitHubCIStatus(ciStatus));
}

/** Tooltip counterpart to {@link getPRStatusVisual}. */
export function getPRStatusTooltip(
  ciStatus: CIStatusState | undefined,
  mergeState: PRMergeState | undefined
): string | null {
  if (mergeState === "conflicts") return MERGE_CONFLICT_TOOLTIP;
  return getPRCIStatusTooltip(toGitHubCIStatus(ciStatus));
}
