import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import { generateWorktreePath, validatePathPattern } from "../../../../shared/utils/pathPattern.js";
import { resolveWorktreePattern } from "../../../utils/worktreePattern.js";
import { taskWorktreeService } from "../../../services/TaskWorktreeService.js";

export function registerWorktreeBranchHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreeListBranches = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string }
  ) => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    return await deps.worktreeService.listBranches(payload.rootPath);
  };
  ipcMain.handle(CHANNELS.WORKTREE_LIST_BRANCHES, handleWorktreeListBranches);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_LIST_BRANCHES));

  const handleWorktreeFetchPRBranch = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string; prNumber: number; headRefName: string }
  ) => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    if (!payload.rootPath || typeof payload.rootPath !== "string") {
      throw new Error("rootPath is required");
    }
    if (!payload.prNumber || typeof payload.prNumber !== "number" || payload.prNumber <= 0) {
      throw new Error("prNumber must be a positive number");
    }
    if (!payload.headRefName || typeof payload.headRefName !== "string") {
      throw new Error("headRefName is required");
    }
    return await deps.worktreeService.fetchPRBranch(
      payload.rootPath,
      payload.prNumber,
      payload.headRefName
    );
  };
  ipcMain.handle(CHANNELS.WORKTREE_FETCH_PR_BRANCH, handleWorktreeFetchPRBranch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_FETCH_PR_BRANCH));

  const handleWorktreeGetRecentBranches = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string }
  ) => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }
    return await deps.worktreeService.getRecentBranches(payload.rootPath);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_RECENT_BRANCHES, handleWorktreeGetRecentBranches);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_RECENT_BRANCHES));

  const handleWorktreeGetDefaultPath = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string; branchName: string }
  ): Promise<string> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:get-default-path");
    }

    const { rootPath, branchName } = payload;

    if (typeof rootPath !== "string" || !rootPath.trim()) {
      throw new Error("Invalid rootPath: must be a non-empty string");
    }

    if (typeof branchName !== "string" || !branchName.trim()) {
      throw new Error("Invalid branchName: must be a non-empty string");
    }

    const pattern = await resolveWorktreePattern(rootPath);

    const validation = validatePathPattern(pattern);
    if (!validation.valid) {
      throw new Error(`Invalid stored pattern: ${validation.error}`);
    }

    // Generate the initial path
    const initialPath = generateWorktreePath(rootPath, branchName, pattern);

    // Auto-resolve path conflicts by finding an available path
    const gitService = taskWorktreeService.getGitService(rootPath);
    return gitService.findAvailablePath(initialPath);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_DEFAULT_PATH, handleWorktreeGetDefaultPath);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_DEFAULT_PATH));

  const handleWorktreeGetAvailableBranch = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string; branchName: string }
  ): Promise<string> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:get-available-branch");
    }

    const { rootPath, branchName } = payload;

    if (typeof rootPath !== "string" || !rootPath.trim()) {
      throw new Error("Invalid rootPath: must be a non-empty string");
    }

    if (typeof branchName !== "string" || !branchName.trim()) {
      throw new Error("Invalid branchName: must be a non-empty string");
    }

    const gitService = taskWorktreeService.getGitService(rootPath);
    return gitService.findAvailableBranchName(branchName);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH, handleWorktreeGetAvailableBranch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH));

  return () => handlers.forEach((cleanup) => cleanup());
}
