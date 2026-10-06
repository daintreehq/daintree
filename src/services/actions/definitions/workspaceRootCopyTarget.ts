import type { ActionContext } from "@shared/types/actions";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";

/**
 * Whether a copy that names no worktree should bundle the workspace root
 * (#13210) — main then resolves that root from the dispatching view.
 *
 * Only when there is provably no worktree to mean instead. A scratch never has
 * one. A project qualifies only once its worktree list has loaded and come back
 * empty — a non-git folder: while a git project's list is still loading (or
 * failed to), "no active worktree" is a gap in what the view knows, and filling
 * it with the whole project folder would hand an agent a bundle it never asked
 * for, past the explicit-target guard (#11722).
 */
export function copiesWorkspaceRoot(ctx: ActionContext): boolean {
  if (ctx.focusedWorktreeId || ctx.activeWorktreeId) return false;
  if (ctx.scratchId) return true;
  if (!ctx.projectId) return false;
  const state = getCurrentViewStoreOrNull()?.getState();
  return Boolean(state?.isInitialized && state.worktrees.size === 0);
}
