/**
 * Single source of truth for destructive-action tier escalation.
 *
 * The static `danger` metadata on an action classifies its worst-case tier;
 * this pure function derives the *effective* tier for a concrete invocation
 * from runtime context (the `force` flag, branch protection, how many tabs
 * would actually close). Both the UI that gates the action (e.g.
 * `WorktreeDeleteDialog`'s typed-name input) and the action `run()` body that
 * decides whether to escalate to a confirm consult this same rule, so the
 * dialog and the dispatch path can never disagree about whether a given call
 * is high-tier.
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
  actionId: "portal.closeAllTabs" | "portal.closeOthers",
  ctx: PortalCloseTierCtx
): DestructiveTier;
export function deriveEffectiveTier(
  actionId: string,
  ctx: WorktreeDeleteTierCtx | PortalCloseTierCtx
): DestructiveTier {
  // `in`-operator narrowing keeps each branch type-safe without a cast — the
  // two ctx shapes have disjoint fields, so the discriminant is structural.
  if (actionId === "worktree.delete" && "force" in ctx) {
    return ctx.force && (ctx.isProtectedBranch || ctx.isMainWorktree || ctx.hasTrackedChanges)
      ? "D3"
      : "D2";
  }
  if (
    (actionId === "portal.closeAllTabs" || actionId === "portal.closeOthers") &&
    "tabCount" in ctx
  ) {
    return ctx.tabCount >= PORTAL_BULK_CLOSE_TIER_THRESHOLD ? "D1" : "D0";
  }
  return "D0";
}
