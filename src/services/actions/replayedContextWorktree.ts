import type { ActionContext } from "@shared/types/actions";

export interface ReplayedWorktreeDetails {
  name: string;
  path: string;
  branch?: string;
  isMainWorktree?: boolean;
}

/**
 * Describe a replayed context's worktree from the view's live worktree store
 * (#12486).
 *
 * An agent pane's launch context pins its worktree by id alone, because the
 * description can be missing when it is taken — a pane restored at boot spawns
 * before its view's worktree store has loaded — and freezing that gap would
 * leave every path-defaulting action failing for the pane's whole life. Filled
 * here instead, per dispatch, from the store that is populated by then.
 *
 * Only a context that names a worktree and carries no path is touched, so a
 * help session's complete provision-time snapshot (#8317) replays exactly as
 * captured. A worktree the store no longer knows stays undescribed rather than
 * borrowing the selected one: "No active worktree" is the honest answer for a
 * pane whose worktree is gone.
 */
export function withReplayedWorktreeDetails(
  context: ActionContext,
  lookup: (worktreeId: string) => ReplayedWorktreeDetails | undefined
): ActionContext {
  if (context.activeWorktreeId === undefined || context.activeWorktreePath !== undefined) {
    return context;
  }
  const worktree = lookup(context.activeWorktreeId);
  if (!worktree) return context;
  return {
    ...context,
    activeWorktreeName: worktree.name,
    activeWorktreePath: worktree.path,
    activeWorktreeBranch: worktree.branch,
    activeWorktreeIsMain: worktree.isMainWorktree,
  };
}
