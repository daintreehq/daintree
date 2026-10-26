/**
 * The open Review Hubs that `worktree.markReviewed` and
 * `worktree.clearReviewMark` act through (#14585). Marking stores what a hub
 * displayed, so it needs a hub open on the worktree; each one registers here
 * while it's open, keyed by the panel hosting it, in a dialog or the grid. A
 * dialog's hub unmounts when the dialog closes, so one registered here is on
 * screen.
 */
export interface ReviewHubMarkTarget {
  panelId: string;
  worktreeId: string;
  isDialog: boolean;
  /** Why marking can't run right now, or null when it can. */
  markBlockedReason: () => string | null;
  hasMark: () => boolean;
  markReviewed: () => Promise<void>;
  clearReviewMark: () => Promise<void>;
}

/** Registration order is kept, so the newest dialog is last. */
const targets = new Map<string, ReviewHubMarkTarget>();

/** Register an open hub. The disposer removes this registration only, never a newer one. */
export function registerReviewHubMarkTarget(target: ReviewHubMarkTarget): () => void {
  targets.delete(target.panelId);
  targets.set(target.panelId, target);
  return () => {
    if (targets.get(target.panelId) === target) targets.delete(target.panelId);
  };
}

export interface ReviewHubMarkTargetQuery {
  /** Only a hub on this worktree. */
  worktreeId?: string;
  /** The focused panel, which counts when it's a hub in the grid. */
  focusedPanelId?: string | null;
}

/**
 * The hub an action means: the newest one presented as a dialog, else the
 * focused grid panel. Named by worktree, it's a hub on that worktree, in the
 * same order of preference, and never one on another worktree.
 */
export function findReviewHubMarkTarget(
  query: ReviewHubMarkTargetQuery
): ReviewHubMarkTarget | null {
  const candidates = [...targets.values()].filter(
    (target) => query.worktreeId === undefined || target.worktreeId === query.worktreeId
  );
  const dialog = candidates.filter((target) => target.isDialog).at(-1);
  if (dialog) return dialog;
  const focused = candidates.find((target) => target.panelId === query.focusedPanelId);
  if (focused) return focused;
  return query.worktreeId === undefined ? null : (candidates.at(-1) ?? null);
}

/** @internal Tests only. */
export function _resetReviewHubMarkTargetsForTesting(): void {
  targets.clear();
}
