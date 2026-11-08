/**
 * One worktree's size on disk, measured on request for the Worktrees overview.
 *
 * `unknown` is a measurement that didn't finish (an unreadable directory, a
 * timeout, a cancelled pass, a worktree the host no longer lists), never zero:
 * a measured empty worktree is `{ status: "measured", bytes: 0 }`.
 *
 * A measured figure is allocated blocks with hard links inside the worktree
 * counted once, and nested worktrees and symlink targets left out. It can still
 * overstate what deleting the worktree frees — a hard link shared with a store
 * outside it, or a copy-on-write clone — which no cheap scan can rule out, so
 * the overview labels every figure as approximate.
 */
export type WorktreeDiskUsageResult = { status: "measured"; bytes: number } | { status: "unknown" };

export interface WorktreeDiskUsageMeasureRequest {
  /** The overview opening this measurement belongs to; cancelling it drops the request. */
  sessionId: string;
  worktreeId: string;
}

export interface WorktreeDiskUsageCancelRequest {
  sessionId: string;
}
