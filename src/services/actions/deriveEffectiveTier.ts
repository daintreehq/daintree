/**
 * Single source of truth for destructive-action tier escalation.
 *
 * The static `danger` metadata on an action classifies its worst-case tier;
 * this pure function derives the *effective* tier for a concrete invocation
 * from runtime context (the `force` flag, branch protection, how many tabs
 * would actually close). The UI that gates the action (e.g.
 * `WorktreeDeleteDialog`'s typed-name input) consults this rule, and so do the
 * portal close actions' `run()` bodies, so those surfaces cannot disagree with
 * their dispatch path about whether a call is high-tier.
 *
 * `worktree.delete` is the exception and it is a real gap, not a design: its
 * `run()` does NOT consult this, so a `force: true` dispatch that never passes
 * through `WorktreeDeleteDialog` — an agent calling it over MCP — is gated by
 * the static `danger: "confirm"` metadata alone and never reaches the D3
 * typed-name gate the same arguments would trigger locally.
 *
 * Keep this module pure — no store, React, or IPC imports — so the policy is
 * unit-testable in isolation.
 */

export type DestructiveTier = "D0" | "D1" | "D2" | "D3";

export interface WorktreeDeleteTierCtx {
  /** The `force` checkbox — discards uncommitted tracked changes. */
  force: boolean;
  /** Branch is protected (main/master/develop/etc.). */
  isProtectedBranch: boolean;
  /** This is the repository's main worktree. */
  isMainWorktree: boolean;
  /**
   * Tracked (non-untracked, non-ignored) changes exist. Must be derived from
   * the tracked-only change count, never a combined `hasChanges` — collapsing
   * the two regresses #4927 (untracked-only worktrees would wrongly demand the
   * typed-name gate).
   */
  hasTrackedChanges: boolean;
  /**
   * A completed inventory found modified or untracked files inside this
   * worktree's submodules. Working-tree content, which is exactly what `force`
   * consents to everywhere else — so it escalates under `force` and never
   * without it, the same shape as `hasTrackedChanges`.
   *
   * The parent's own status cannot stand in for this: it collapses a submodule
   * into one ` M vendor/lib` row, and can be configured not to report it at all.
   */
  submoduleFilesAtRisk: boolean;
}

export interface PortalCloseTierCtx {
  /** Number of tabs the invocation would actually close. */
  tabCount: number;
}

/**
 * Bulk portal closes escalate to a D1 confirm once this many tabs (or more)
 * would be closed in one action. Below it the close is routine (D0, no gate).
 */
export const PORTAL_BULK_CLOSE_TIER_THRESHOLD = 3;

export function deriveEffectiveTier(
  actionId: "worktree.delete",
  ctx: WorktreeDeleteTierCtx
): DestructiveTier;
export function deriveEffectiveTier(
  actionId: "portal.closeAllTabs" | "portal.closeOthers" | "portal.closeToRight",
  ctx: PortalCloseTierCtx
): DestructiveTier;
export function deriveEffectiveTier(
  actionId: string,
  ctx: WorktreeDeleteTierCtx | PortalCloseTierCtx
): DestructiveTier {
  // `in`-operator narrowing keeps each branch type-safe without a cast — the
  // two ctx shapes have disjoint fields, so the discriminant is structural.
  if (actionId === "worktree.delete" && "force" in ctx) {
    // Every input is conditioned on `force`, and that is sound because a
    // backend invariant stands behind each: `git worktree remove` refuses a
    // dirty tree and `WorkspaceService.guardSubmoduleDelete` refuses nested
    // working-tree content, so a non-force delete cannot destroy either and the
    // gate can wait for the flag that lifts the refusal.
    //
    // The two submodule states that have NO such flag — commits held only in
    // this worktree's own module store, and an inventory that could not be
    // completed — are deliberately absent. The host throws on both before it
    // reads `force`, so they are not a tier at all: they are blocked, and the
    // surfaces model them that way (`submoduleDeleteBlock`). Ranking a refusal
    // as a tier is what produced a typed-name gate leading to a toast.
    //
    // #4927 is not regressed: `submoduleFilesAtRisk` covers nested content,
    // which the parent reports as a tracked ` M vendor/lib` row anyway, and an
    // untracked-only parent worktree still never demands the gate on its own.
    return ctx.force &&
      (ctx.isProtectedBranch ||
        ctx.isMainWorktree ||
        ctx.hasTrackedChanges ||
        ctx.submoduleFilesAtRisk)
      ? "D3"
      : "D2";
  }
  if (
    (actionId === "portal.closeAllTabs" ||
      actionId === "portal.closeOthers" ||
      actionId === "portal.closeToRight") &&
    "tabCount" in ctx
  ) {
    return ctx.tabCount >= PORTAL_BULK_CLOSE_TIER_THRESHOLD ? "D1" : "D0";
  }
  return "D0";
}
