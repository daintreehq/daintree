/**
 * Bulk worktree creation runs (#17085). A run executes in the project view
 * that started it and outlives the dialog that started it. That view publishes
 * each change to main, which keeps the latest snapshot of every run, pushes it
 * to every local view, and routes cancel and retry back to the view running it.
 * In memory only: nothing here survives the app.
 */

/** Where one item of a run has got to. */
export type BulkWorktreeRunItemStage =
  | "pending"
  | "worktree-creating"
  | "worktree-created"
  | "terminals-spawning"
  | "terminals-error"
  | "worktree-error"
  | "assigning"
  | "verifying"
  | "succeeded"
  | "failed"
  /** Never finished because the run was cancelled. `worktreeId` says whether its worktree landed. */
  | "cancelled"
  /** Never finished because the view running it went away. `worktreeId` says whether its worktree landed. */
  | "interrupted";

export type BulkWorktreeRunFailedStep = "worktree" | "terminals" | "verification" | "assignment";

export interface BulkWorktreeRunItem {
  /** The issue or pull request number. */
  number: number;
  title: string;
  stage: BulkWorktreeRunItemStage;
  /** Attempts at the current step; above 1 means it is being retried. */
  attempt: number;
  /** Times the user has retried this item after it failed. */
  retried?: number;
  error?: string;
  failedStep?: BulkWorktreeRunFailedStep;
  /** Set once the item's worktree exists on disk, whatever happened after. */
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
}

/**
 * `running` and `cancelling` are live: the view running the run is still
 * working on it. `cancelling` waits for work that was already underway, such
 * as a worktree create, to settle. `done` covers success and failure alike;
 * the items say which.
 */
export type BulkWorktreeRunPhase = "running" | "cancelling" | "cancelled" | "done";

/** One pass over a run. `endedAt` is set once that pass has settled. */
export interface BulkWorktreeRunExecution {
  startedAt: number;
  endedAt?: number;
}

export interface BulkWorktreeRunSnapshot {
  runId: string;
  projectId: string;
  mode: "issue" | "pr";
  phase: BulkWorktreeRunPhase;
  /** Every item the run was started with, in order. */
  items: BulkWorktreeRunItem[];
  startedAt: number;
  /** Every pass over the run, oldest first: its start, then each Retry failed. */
  executions?: BulkWorktreeRunExecution[];
  updatedAt: number;
  /**
   * False once the view that ran it has gone, so nothing can cancel or retry
   * it any more. Main sets it; a published snapshot never does.
   */
  controllable: boolean;
}

export interface BulkWorktreeRunCounts {
  total: number;
  succeeded: number;
  failed: number;
  /** Cancelled or interrupted before finishing. */
  stopped: number;
  /** Items whose worktree exists, finished or not. */
  worktreesCreated: number;
  /** Items not yet settled. */
  remaining: number;
}

export function countBulkWorktreeRun(run: Pick<BulkWorktreeRunSnapshot, "items">) {
  const counts: BulkWorktreeRunCounts = {
    total: run.items.length,
    succeeded: 0,
    failed: 0,
    stopped: 0,
    worktreesCreated: 0,
    remaining: 0,
  };
  for (const item of run.items) {
    if (item.worktreeId) counts.worktreesCreated++;
    if (item.stage === "succeeded") counts.succeeded++;
    else if (item.stage === "failed") counts.failed++;
    else if (item.stage === "cancelled" || item.stage === "interrupted") counts.stopped++;
    else counts.remaining++;
  }
  return counts;
}

/** How often the view running a live run republishes it, so main's hold on that view doesn't lapse during a long step. */
export const BULK_RUN_HEARTBEAT_MS = 2 * 60_000;

export function isBulkWorktreeRunLive(phase: BulkWorktreeRunPhase): boolean {
  return phase === "running" || phase === "cancelling";
}

/** What another view asks of the view running a run. */
export type BulkWorktreeRunCommandKind = "cancel" | "retry-failed";

export interface BulkWorktreeRunCommand {
  runId: string;
  kind: BulkWorktreeRunCommandKind;
}

/**
 * `not-found`: no such run. `uncontrollable`: the view that ran it is gone.
 * `not-live`: a cancel for a run that has already ended. `busy`: a retry for a
 * run still running. `nothing-to-retry`: a retry for a run with no failures.
 */
export type BulkWorktreeRunCommandResult =
  | { accepted: true }
  | {
      accepted: false;
      reason: "not-found" | "uncontrollable" | "not-live" | "busy" | "nothing-to-retry";
    };

/** Main's push whenever any run changes: every run it holds, oldest first. */
export interface BulkWorktreeRunsChanged {
  runs: BulkWorktreeRunSnapshot[];
}

/**
 * How long a run that ended without a failure stays on show before it retires
 * to the notification center. Every view hides it once this has passed since
 * it ended, so a view opened later never shows a stale finish.
 */
export const BULK_RUN_LINGER_MS = 6_000;

/**
 * Whether an ended run still wants the user: something failed, or the view
 * running it went away before it finished. Such a run stays until it is
 * retried or dismissed; any other ended run retires on its own.
 */
export function bulkWorktreeRunNeedsAttention(
  run: Pick<BulkWorktreeRunSnapshot, "items">
): boolean {
  return run.items.some((item) => item.stage === "failed" || item.stage === "interrupted");
}
