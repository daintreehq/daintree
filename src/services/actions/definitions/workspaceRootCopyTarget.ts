import type { ActionContext } from "@shared/types/actions";
import { worktreeClient } from "@/clients/worktreeClient";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";

/**
 * Whether, by what this view already knows, a copy that names no worktree could
 * bundle the workspace root (#13210). Synchronous, for gating a palette row; a
 * project still needs {@link copiesWorkspaceRoot} before anything is copied.
 *
 * A scratch never has a worktree. A project only qualifies once its worktree
 * list has loaded and come back empty: while a git project's list is still
 * loading, "no active worktree" is a gap in what the view knows, and filling it
 * with the whole project folder would hand an agent a bundle it never asked
 * for, past the explicit-target guard (#11722).
 */
export function mayCopyWorkspaceRoot(ctx: ActionContext): boolean {
  if (ctx.focusedWorktreeId || ctx.activeWorktreeId) return false;
  if (ctx.scratchId) return true;
  if (!ctx.projectId) return false;
  const state = getCurrentViewStoreOrNull()?.getState();
  return Boolean(state?.isInitialized && state.worktrees.size === 0);
}

/**
 * Whether a copy that names no worktree bundles the workspace root — main then
 * resolves that root from the dispatching view.
 *
 * An empty list is not proof on its own: a view's port can deliver one before a
 * cold host has finished probing the folder. So a project also needs the host's
 * own `checkIsRepo` to say there is no repository; `null` (not classified yet)
 * stays a refusal.
 */
export async function copiesWorkspaceRoot(ctx: ActionContext): Promise<boolean> {
  if (!mayCopyWorkspaceRoot(ctx)) return false;
  if (ctx.scratchId) return true;
  try {
    const { gitBacked } = await worktreeClient.getAllWithStatus();
    return gitBacked === false;
  } catch {
    return false;
  }
}
