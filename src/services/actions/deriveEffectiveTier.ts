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
   * Commits that live ONLY in this worktree's own submodule object store were
   * positively observed. A linked worktree gets its own
   * `.git/worktrees/<id>/modules/<path>` with no `alternates`, so removing the
   * worktree takes those commits with it — no dangling object, no reflog,
   * nothing for `fsck --lost-found` to return.
   */
  submoduleCommitsAtRisk: boolean;
  /**
   * The submodule inventory could not be completed (the fetch failed, or the
   * host walked only part of the tree). Fails closed the same way a failed
   * parent status fetch does — it counts as work present under `force` — but
   * deliberately does NOT demand the typed-name gate on its own.
   */
  submoduleRiskUnverified: boolean;
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
    // Observed at-risk submodule commits escalate WITHOUT `force`, and that
    // asymmetry is deliberate.
    //
    // Conditioning the other three inputs on `force` is only sound because a
    // backend invariant stands behind it: `git worktree remove` refuses a
    // dirty tree, so a non-force delete cannot destroy parent work and the
    // gate can wait for the flag that lifts the refusal. No such invariant
    // covers a submodule. In the case this input exists for — a submodule back
    // at its recorded gitlink, clean working tree, holding a commit made on
    // its detached HEAD — the parent's `git status --porcelain` prints zero
    // bytes, so nothing in the refusal path is looking at the commits that
    // would be lost. Whether the removal is refused at all turns on the mere
    // existence of `<gitdir>/modules`, a mechanical fact about the checkout
    // rather than about the work inside it. Gating on `force` would rest the
    // escalation on a guard that has no view of what it is guarding, and would
    // in any case only surface the gate AFTER the user had already reached for
    // the destructive option.
    //
    // #4927 is not regressed: nested dirty and untracked content is
    // deliberately not an input here. The parent reports both as a tracked
    // ` M vendor/lib` row, so they already ride `hasTrackedChanges` under
    // `force`, and an untracked-only worktree still never demands the gate on
    // its own.
    if (ctx.submoduleCommitsAtRisk) return "D3";
    return ctx.force &&
      (ctx.isProtectedBranch ||
        ctx.isMainWorktree ||
        ctx.hasTrackedChanges ||
        ctx.submoduleRiskUnverified)
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
