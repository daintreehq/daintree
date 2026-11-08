import type {
  WorktreeDiskUsageCancelRequest,
  WorktreeDiskUsageMeasureRequest,
  WorktreeDiskUsageResult,
} from "@shared/types/ipc/worktreeDiskUsage";

export const worktreeDiskUsageClient = {
  measure: (request: WorktreeDiskUsageMeasureRequest): Promise<WorktreeDiskUsageResult> => {
    return window.electron.worktreeDiskUsage.measure(request);
  },
  cancel: (request: WorktreeDiskUsageCancelRequest): Promise<void> => {
    return window.electron.worktreeDiskUsage.cancel(request);
  },
};
