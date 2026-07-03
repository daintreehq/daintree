import type { StagingStatus } from "@shared/types";
import type {
  CIStatusState,
  NormalizedPRState,
  NormalizedReviewDecision,
} from "@shared/types/forge";
import type { GitOperationReason } from "@shared/types/ipc/errors";
import { getGitRecoveryHint } from "@shared/utils/gitOperationErrors";
import { isProtectedBranch } from "@shared/utils/gitConstants";
import { isGeneratedFile } from "../generatedFileClassifier";

export type ReviewReadinessLevel = "ready" | "needs-review" | "blocked" | "unknown";

export type ReviewReadinessSeverity = "blocker" | "warning" | "info";

/** Closed vocabulary, exported so result schemas can enumerate it. */
export const REVIEW_READINESS_ITEM_IDS = [
  "operation-in-progress",
  "conflicts",
  "detached-head",
  "push-failed",
  "forge-auth-unhealthy",
  "forge-rate-limited",
  "behind-remote",
  "ci-failing",
  "review-changes-requested",
  "generated-only",
  "nothing-staged",
  "ci-pending",
  "review-required",
  "pr-draft",
  "pr-closed",
  "pr-merged",
  "pr-missing",
  "protected-branch",
  "no-remote",
  "unpushed-commits",
] as const;

export type ReviewReadinessItemId = (typeof REVIEW_READINESS_ITEM_IDS)[number];

/**
 * Safe, renderer-dispatchable next steps. Each kind maps onto a handler that
 * already exists in Review Hub (focus helpers, the D2-gated pull-rebase
 * confirm, external PR link) — the readiness layer never performs commit,
 * push, or merge itself.
 */
export type ReviewReadinessCta =
  | { kind: "focus-conflicts" }
  | { kind: "focus-staged" }
  | { kind: "pull-rebase" }
  | { kind: "open-pr"; url: string };

export interface ReviewReadinessItem {
  id: ReviewReadinessItemId;
  severity: ReviewReadinessSeverity;
  label: string;
  detail?: string;
  action?: ReviewReadinessCta;
}

export interface ReviewReadinessPRInput {
  number: number;
  url?: string;
  state: NormalizedPRState;
  /** Rollup CI state when known; omit (not "unknown") when no data arrived. */
  ciState?: CIStatusState | null;
  /**
   * Not derivable from the worktree snapshot today — accepted so the model is
   * complete if a provider-neutral field lands later. `undefined` means "no
   * data" and never counts as passing; `null` means the provider reported no
   * decision requirement.
   */
  reviewDecision?: NormalizedReviewDecision;
  /** Same contract as `reviewDecision`: `undefined` means unknown. */
  isDraft?: boolean;
}

export interface ReviewReadinessInput {
  status: StagingStatus | null;
  aheadCount?: number | null;
  behindCount?: number | null;
  pr?: ReviewReadinessPRInput | null;
  /** Health of the forge provider matched to this worktree, when resolved. */
  providerHealth?: { rateLimitBlocked: boolean; tokenUnhealthy: boolean } | null;
  /** Last push failure surfaced by the Review Hub banner, when present. */
  pushError?: { reason: GitOperationReason } | null;
}

export interface ReviewReadinessSummary {
  level: ReviewReadinessLevel;
  /** Structural: staged files exist and no conflict/detached/operation blocker. */
  commitReady: boolean;
  /** Literal "can push right now": remote + local commits + not behind/blocked. */
  pushReady: boolean;
  /** True only when forge data affirmatively says mergeable; "unknown" when data is missing. */
  prReady: boolean | "unknown";
  blockers: ReviewReadinessItem[];
  warnings: ReviewReadinessItem[];
  infos: ReviewReadinessItem[];
  /** Items carrying a safe CTA, highest priority first. */
  nextActions: ReviewReadinessItem[];
}

const OPERATION_LABELS: Partial<Record<StagingStatus["repoState"], string>> = {
  MERGING: "Merge in progress",
  REBASING: "Rebase in progress",
  CHERRY_PICKING: "Cherry-pick in progress",
  REVERTING: "Revert in progress",
};

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function deriveReviewReadiness(input: ReviewReadinessInput): ReviewReadinessSummary {
  const { status } = input;
  if (!status) {
    return {
      level: "unknown",
      commitReady: false,
      pushReady: false,
      prReady: "unknown",
      blockers: [],
      warnings: [],
      infos: [],
      nextActions: [],
    };
  }

  const aheadCount = input.aheadCount ?? null;
  const behindCount = input.behindCount ?? null;
  const pr = input.pr ?? null;
  const pushError = input.pushError ?? null;
  const providerHealth = input.providerHealth ?? null;

  const conflictCount = status.conflicted.length;
  const totalChanges = status.staged.length + status.unstaged.length + conflictCount;
  const operationLabel = OPERATION_LABELS[status.repoState];
  const isOperationState = operationLabel !== undefined;
  const prOpen = pr !== null && pr.state === "open";

  const items: ReviewReadinessItem[] = [];

  if (isOperationState) {
    const stepDetail =
      status.repoState === "REBASING" && status.rebaseStep !== null && status.rebaseTotalSteps
        ? `Step ${status.rebaseStep} of ${status.rebaseTotalSteps}`
        : undefined;
    const conflictDetail = conflictCount > 0 ? plural(conflictCount, "conflicted file") : undefined;
    items.push({
      id: "operation-in-progress",
      severity: "blocker",
      label: operationLabel,
      detail: [stepDetail, conflictDetail].filter(Boolean).join(" · ") || undefined,
    });
  } else if (conflictCount > 0) {
    items.push({
      id: "conflicts",
      severity: "blocker",
      label: plural(conflictCount, "conflicted file"),
      detail: "Resolve conflicts before committing",
      action: { kind: "focus-conflicts" },
    });
  }

  if (status.isDetachedHead) {
    items.push({
      id: "detached-head",
      severity: "blocker",
      label: "Detached HEAD",
      detail: "Check out a branch before committing",
    });
  }

  if (pushError) {
    items.push({
      id: "push-failed",
      severity: "blocker",
      label: "Last push failed",
      detail: getGitRecoveryHint(pushError.reason) ?? undefined,
    });
  }

  if (providerHealth?.tokenUnhealthy) {
    items.push({
      id: "forge-auth-unhealthy",
      severity: "warning",
      label: "Forge authentication needs attention",
      detail: "PR and CI signals may be stale",
    });
  }
  if (providerHealth?.rateLimitBlocked) {
    items.push({
      id: "forge-rate-limited",
      severity: "warning",
      label: "Forge rate limit active",
      detail: "PR and CI signals may be stale",
    });
  }

  // The push-rejected banner already owns divergence recovery (pull-rebase /
  // force-with-lease CTAs); a second behind-remote row would double-report the
  // same fact with a competing CTA.
  const behindAlreadyReported = pushError?.reason === "push-rejected-outdated";
  if (behindCount !== null && behindCount > 0 && !behindAlreadyReported) {
    items.push({
      id: "behind-remote",
      severity: "warning",
      label: `Behind remote by ${plural(behindCount, "commit")}`,
      detail:
        aheadCount !== null && aheadCount > 0
          ? `${plural(aheadCount, "local commit")} will be replayed on top`
          : undefined,
      action: status.hasRemote && !isOperationState ? { kind: "pull-rebase" } : undefined,
    });
  }

  const openPrAction: ReviewReadinessCta | undefined = pr?.url
    ? { kind: "open-pr", url: pr.url }
    : undefined;

  if (prOpen && pr.ciState === "failure") {
    items.push({
      id: "ci-failing",
      severity: "warning",
      label: `CI failing on PR #${pr.number}`,
      action: openPrAction,
    });
  }
  if (prOpen && pr.reviewDecision === "CHANGES_REQUESTED") {
    items.push({
      id: "review-changes-requested",
      severity: "warning",
      label: `Changes requested on PR #${pr.number}`,
      action: openPrAction,
    });
  }

  const workingFileCount = status.staged.length + status.unstaged.length;
  if (
    conflictCount === 0 &&
    workingFileCount > 0 &&
    status.staged.every((f) => isGeneratedFile(f.path)) &&
    status.unstaged.every((f) => isGeneratedFile(f.path))
  ) {
    items.push({
      id: "generated-only",
      severity: "warning",
      label: "Only generated files changed",
      detail: "Check whether source changes are missing",
    });
  }

  if (pr !== null && (pr.state === "closed" || pr.state === "declined")) {
    items.push({
      id: "pr-closed",
      severity: "warning",
      label: `PR #${pr.number} is closed`,
      detail: "Changes here won't ship through this PR",
      action: openPrAction,
    });
  }

  if (
    !isOperationState &&
    conflictCount === 0 &&
    status.staged.length === 0 &&
    status.unstaged.length > 0
  ) {
    // Warning, not info: the chip must not read "Ready" while commitReady is
    // false — unstaged-only worktrees genuinely need a staging step first.
    items.push({
      id: "nothing-staged",
      severity: "warning",
      label: "No files staged",
      detail: plural(status.unstaged.length, "changed file"),
      action: { kind: "focus-staged" },
    });
  }

  if (prOpen && pr.ciState === "pending") {
    items.push({
      id: "ci-pending",
      severity: "info",
      label: `CI pending on PR #${pr.number}`,
      action: openPrAction,
    });
  }
  if (prOpen && pr.reviewDecision === "REVIEW_REQUIRED") {
    items.push({
      id: "review-required",
      severity: "info",
      label: `Review required on PR #${pr.number}`,
      action: openPrAction,
    });
  }
  if (prOpen && pr.isDraft === true) {
    items.push({
      id: "pr-draft",
      severity: "info",
      label: `PR #${pr.number} is a draft`,
      action: openPrAction,
    });
  }
  if (pr !== null && pr.state === "merged") {
    items.push({
      id: "pr-merged",
      severity: "info",
      label: `PR #${pr.number} merged`,
      action: openPrAction,
    });
  }

  const hasShippableWork = totalChanges > 0 || (aheadCount !== null && aheadCount > 0);
  if (status.hasRemote && pr === null && hasShippableWork) {
    items.push({
      id: "pr-missing",
      severity: "info",
      label: "No pull request for this branch",
    });
  }

  if (
    !status.isDetachedHead &&
    status.currentBranch !== null &&
    isProtectedBranch(status.currentBranch.toLowerCase()) &&
    totalChanges > 0
  ) {
    items.push({
      id: "protected-branch",
      severity: "info",
      label: `Committing to protected branch '${status.currentBranch}'`,
      detail: "Consider a feature branch and PR instead",
    });
  }

  if (!status.hasRemote) {
    items.push({
      id: "no-remote",
      severity: "info",
      label: "No remote configured",
      detail: "Push is unavailable",
    });
  }

  if (
    status.hasRemote &&
    aheadCount !== null &&
    aheadCount > 0 &&
    totalChanges === 0 &&
    !behindAlreadyReported &&
    (behindCount === null || behindCount === 0)
  ) {
    items.push({
      id: "unpushed-commits",
      severity: "info",
      label: `${plural(aheadCount, "commit")} not pushed`,
    });
  }

  const blockers = items.filter((i) => i.severity === "blocker");
  const warnings = items.filter((i) => i.severity === "warning");
  const infos = items.filter((i) => i.severity === "info");

  const commitReady =
    status.staged.length > 0 && !status.isDetachedHead && conflictCount === 0 && !isOperationState;

  // behindCount must affirmatively be 0 — an unknown divergence state must
  // never read as pushable.
  const pushReady =
    status.hasRemote &&
    blockers.length === 0 &&
    aheadCount !== null &&
    aheadCount > 0 &&
    behindCount === 0;

  let prReady: boolean | "unknown";
  if (pr === null || pr.state !== "open") {
    prReady = pr === null && status.hasRemote ? "unknown" : false;
  } else if (
    pr.ciState === "failure" ||
    pr.isDraft === true ||
    pr.reviewDecision === "CHANGES_REQUESTED" ||
    pr.reviewDecision === "REVIEW_REQUIRED"
  ) {
    prReady = false;
  } else if (
    pr.ciState === "success" &&
    pr.isDraft === false &&
    (pr.reviewDecision === "APPROVED" || pr.reviewDecision === null)
  ) {
    prReady = true;
  } else {
    prReady = "unknown";
  }

  return {
    level: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "needs-review" : "ready",
    commitReady,
    pushReady,
    prReady,
    blockers,
    warnings,
    infos,
    nextActions: items.filter((i) => i.action !== undefined),
  };
}
