import path from "path";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle, typedHandleWithContext } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type { PulseRangeDays, ProjectPulse } from "../../../shared/types/pulse.js";
import { taskWorktreeService } from "../../services/TaskWorktreeService.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

export function registerGitReadHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleGitCompareWorktrees = async (payload: {
    cwd: string;
    branch1: string;
    branch2: string;
    filePath?: string;
    useMergeBase?: boolean;
  }) => {
    checkRateLimit(CHANNELS.GIT_COMPARE_WORKTREES, 20, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }

    const { cwd, branch1, branch2, filePath, useMergeBase } = payload;

    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (typeof branch1 !== "string" || !branch1) {
      throw new Error("Invalid branch1");
    }
    if (typeof branch2 !== "string" || !branch2) {
      throw new Error("Invalid branch2");
    }
    if (filePath !== undefined && (typeof filePath !== "string" || !filePath)) {
      throw new Error("Invalid filePath");
    }
    if (useMergeBase !== undefined && typeof useMergeBase !== "boolean") {
      throw new Error("Invalid useMergeBase");
    }

    const gitService = taskWorktreeService.getGitService(cwd);
    return gitService.compareWorktrees(branch1, branch2, filePath, useMergeBase);
  };
  handlers.push(typedHandle(CHANNELS.GIT_COMPARE_WORKTREES, handleGitCompareWorktrees));

  const handleGitGetFileDiff = async (payload: {
    cwd: string;
    filePath: string;
    status: string;
  }): Promise<string> => {
    checkRateLimit(CHANNELS.GIT_GET_FILE_DIFF, 10, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }

    const { cwd, filePath, status } = payload;

    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (typeof filePath !== "string" || !filePath) {
      throw new Error("Invalid file path");
    }
    if (typeof status !== "string" || !status) {
      throw new Error("Invalid file status");
    }

    if (!deps.worktreeService) {
      throw new Error("WorkspaceClient not initialized");
    }

    try {
      return await deps.worktreeService.getFileDiff(cwd, filePath, status);
    } catch (error) {
      const errorMessage = formatErrorMessage(error, "Failed to get file diff");
      console.error("[Git] Failed to get file diff via WorkspaceClient:", errorMessage);
      throw new Error(`Failed to get file diff: ${errorMessage}`, { cause: error });
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_FILE_DIFF, handleGitGetFileDiff));

  const handleGitGetProjectPulse = async (
    ctx: import("../types.js").IpcContext,
    payload: {
      worktreeId: string;
      rangeDays: PulseRangeDays;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }
  ): Promise<ProjectPulse> => {
    checkRateLimit(CHANNELS.GIT_GET_PROJECT_PULSE, 10, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }

    const { worktreeId, rangeDays, includeDelta, includeRecentCommits, forceRefresh } = payload;

    if (typeof worktreeId !== "string" || !worktreeId) {
      throw new Error("Invalid worktree ID");
    }

    if (![60, 120, 180].includes(rangeDays)) {
      throw new Error("Invalid rangeDays: must be 60, 120, or 180");
    }

    if (includeDelta !== undefined && typeof includeDelta !== "boolean") {
      throw new Error("Invalid includeDelta: must be a boolean");
    }

    if (includeRecentCommits !== undefined && typeof includeRecentCommits !== "boolean") {
      throw new Error("Invalid includeRecentCommits: must be a boolean");
    }

    if (forceRefresh !== undefined && typeof forceRefresh !== "boolean") {
      throw new Error("Invalid forceRefresh: must be a boolean");
    }

    if (!deps.worktreeService) {
      throw new Error("WorkspaceClient not initialized");
    }

    const monitor = await deps.worktreeService.getMonitorAsync(worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    const senderWindowPulse = getWindowForWebContents(ctx.event.sender);
    const states = await deps.worktreeService.getAllStatesAsync(senderWindowPulse?.id);
    const mainWorktree = states.find((wt) => wt.isMainWorktree);
    const mainBranch = mainWorktree?.branch ?? "main";

    return deps.worktreeService.getProjectPulse(monitor.path, worktreeId, mainBranch, rangeDays, {
      includeDelta,
      includeRecentCommits,
      forceRefresh,
    });
  };
  handlers.push(typedHandleWithContext(CHANNELS.GIT_GET_PROJECT_PULSE, handleGitGetProjectPulse));

  const handleGitListCommits = async (payload: {
    cwd: string;
    search?: string;
    branch?: string;
    skip?: number;
    limit?: number;
  }) => {
    checkRateLimit(CHANNELS.GIT_LIST_COMMITS, 10, 10_000);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }

    const { cwd, search, branch, skip, limit } = payload;

    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }
    if (!path.isAbsolute(cwd)) {
      throw new Error("Working directory must be an absolute path");
    }

    const { listCommits } = await import("../../utils/git.js");

    return listCommits({ cwd, search, branch, skip, limit });
  };
  handlers.push(typedHandle(CHANNELS.GIT_LIST_COMMITS, handleGitListCommits));

  return () => handlers.forEach((cleanup) => cleanup());
}
