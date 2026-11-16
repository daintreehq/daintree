import type {
  BulkWorktreeRunCommand,
  BulkWorktreeRunCommandResult,
  BulkWorktreeRunSnapshot,
  BulkWorktreeRunsChanged,
} from "@shared/types/ipc/bulkWorktreeRuns";

/** Bulk worktree creation runs as main holds them, from any view (#17085). */
export const bulkWorktreeRunsClient = {
  /** Report a run this view is executing. */
  publish: (snapshot: BulkWorktreeRunSnapshot): Promise<void> =>
    window.electron.bulkWorktreeRuns.publish(snapshot),
  list: (): Promise<BulkWorktreeRunSnapshot[]> => window.electron.bulkWorktreeRuns.list(),
  cancel: (runId: string): Promise<BulkWorktreeRunCommandResult> =>
    window.electron.bulkWorktreeRuns.command({ runId, kind: "cancel" }),
  retryFailed: (runId: string): Promise<BulkWorktreeRunCommandResult> =>
    window.electron.bulkWorktreeRuns.command({ runId, kind: "retry-failed" }),
  /** Forget an ended run. A live one is kept. */
  dismiss: (runId: string): Promise<boolean> => window.electron.bulkWorktreeRuns.dismiss(runId),
  onChanged: (callback: (change: BulkWorktreeRunsChanged) => void): (() => void) =>
    window.electron.bulkWorktreeRuns.onChanged(callback),
  /** Commands for runs this view executes, from whichever view asked. */
  onCommand: (callback: (command: BulkWorktreeRunCommand) => void): (() => void) =>
    window.electron.bulkWorktreeRuns.onCommand(callback),
};
