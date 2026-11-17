/**
 * Single source of truth for destructive-action tier escalation.
 *
 * The static `danger` metadata on an action classifies its worst-case tier;
 * this pure function derives the *effective* tier for a concrete invocation
 * from runtime context (the `force` flag, branch protection). The UI that
 * gates the action (e.g. `WorktreeDeleteDialog`'s typed-name input) consults
 * this rule, so it cannot disagree with the dispatch path about whether a call
 * is high-tier.
 *
 * `worktree.delete` consults it from its confirm surfaces rather than from
 * `run()`, and that is now a design rather than the gap it was (#12115). Both
 * surfaces derive the tier from a fresh fetch: `WorktreeDeleteDialog` for a
 * local delete, and the MCP bridge for an agent's, which puts the same
 * typed-name gate on `McpConfirmDialog` and re-derives it immediately before
 * dispatch so an approval cannot outlive the snapshot it was given for.
 * `run()` itself stays out of it deliberately — the typed string is a human
 * attestation, so it can only ever come from a surface with a human in front
 * of it, never from a dispatch argument.
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

export function deriveEffectiveTier(
  actionId: "worktree.delete",
  ctx: WorktreeDeleteTierCtx
): DestructiveTier;
export function deriveEffectiveTier(actionId: string, ctx: WorktreeDeleteTierCtx): DestructiveTier {
  if (actionId === "worktree.delete") {
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
  return "D0";
}
