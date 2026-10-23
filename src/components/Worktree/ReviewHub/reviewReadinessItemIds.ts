// A leaf, so the `worktree.reviewReadiness` result schema can enumerate the ids
// without pulling the readiness derivation onto the boot path (#14274).
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
