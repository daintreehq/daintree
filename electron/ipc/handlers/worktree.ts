import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { WorktreeSetActivePayload, WorktreeDeletePayload } from "../../types/index.js";
import type { PulseRangeDays, ProjectPulse } from "../../../shared/types/pulse.js";
import {
  generateWorktreePath,
  DEFAULT_WORKTREE_PATH_PATTERN,
  validatePathPattern,
} from "../../../shared/utils/pathPattern.js";

export function registerWorktreeHandlers(deps: HandlerDependencies): () => void {
  const { worktreeService: workspaceClient } = deps;

  const handlers: Array<() => void> = [];

  const handleWorktreeGetAll = async () => {
    if (!workspaceClient) {
      return [];
    }
    return await workspaceClient.getAllStatesAsync();
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_ALL, handleWorktreeGetAll);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_ALL));

  const handleWorktreeRefresh = async () => {
    if (!workspaceClient) {
      return;
    }
    await workspaceClient.refresh();
  };
  ipcMain.handle(CHANNELS.WORKTREE_REFRESH, handleWorktreeRefresh);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_REFRESH));

  const handleWorktreePRRefresh = async () => {
    if (!workspaceClient) {
      return;
    }
    await workspaceClient.refreshPullRequests();
  };
  ipcMain.handle(CHANNELS.WORKTREE_PR_REFRESH, handleWorktreePRRefresh);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_PR_REFRESH));

  const handleWorktreeSetActive = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: WorktreeSetActivePayload
  ) => {
    if (!workspaceClient) {
      return;
    }
    await workspaceClient.setActiveWorktree(payload.worktreeId);
  };
  ipcMain.handle(CHANNELS.WORKTREE_SET_ACTIVE, handleWorktreeSetActive);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_SET_ACTIVE));

  const handleWorktreeCreate = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      rootPath: string;
      options: { baseBranch: string; newBranch: string; path: string; fromRemote?: boolean };
    }
  ): Promise<string> => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }
    return await workspaceClient.createWorktree(payload.rootPath, payload.options);
  };
  ipcMain.handle(CHANNELS.WORKTREE_CREATE, handleWorktreeCreate);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_CREATE));

  const handleWorktreeListBranches = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { rootPath: string }
  ) => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }
    return await workspaceClient.listBranches(payload.rootPath);
  };
  ipcMain.handle(CHANNELS.WORKTREE_LIST_BRANCHES, handleWorktreeListBranches);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_LIST_BRANCHES));

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

    const configPattern = store.get("worktreeConfig.pathPattern");
    const pattern =
      typeof configPattern === "string" && configPattern.trim()
        ? configPattern
        : DEFAULT_WORKTREE_PATH_PATTERN;

    const validation = validatePathPattern(pattern);
    if (!validation.valid) {
      throw new Error(`Invalid stored pattern: ${validation.error}`);
    }

    return generateWorktreePath(rootPath, branchName, pattern);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_DEFAULT_PATH, handleWorktreeGetDefaultPath);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_DEFAULT_PATH));

  const handleWorktreeDelete = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: WorktreeDeletePayload
  ) => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }
    if (typeof payload.worktreeId !== "string" || !payload.worktreeId) {
      throw new Error("Invalid worktree ID");
    }
    if (payload.force !== undefined && typeof payload.force !== "boolean") {
      throw new Error("Invalid force parameter");
    }
    await workspaceClient.deleteWorktree(payload.worktreeId, payload.force);
  };
  ipcMain.handle(CHANNELS.WORKTREE_DELETE, handleWorktreeDelete);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_DELETE));

  const handleGitGetFileDiff = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: { cwd: string; filePath: string; status: string }
  ): Promise<string> => {
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

    if (!workspaceClient) {
      throw new Error("WorkspaceClient not initialized");
    }

    try {
      return await workspaceClient.getFileDiff(cwd, filePath, status);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[Git] Failed to get file diff via WorkspaceClient:", errorMessage);
      throw new Error(`Failed to get file diff: ${errorMessage}`);
    }
  };
  ipcMain.handle(CHANNELS.GIT_GET_FILE_DIFF, handleGitGetFileDiff);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_GET_FILE_DIFF));

  const handleGitGetProjectPulse = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      worktreeId: string;
      rangeDays: PulseRangeDays;
      includeDelta?: boolean;
      includeRecentCommits?: boolean;
      forceRefresh?: boolean;
    }
  ): Promise<ProjectPulse> => {
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

    if (!workspaceClient) {
      throw new Error("WorkspaceClient not initialized");
    }

    const monitor = await workspaceClient.getMonitorAsync(worktreeId);
    if (!monitor) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    const states = await workspaceClient.getAllStatesAsync();
    const mainWorktree = states.find((wt) => wt.isMainWorktree);
    const mainBranch = mainWorktree?.branch ?? "main";

    return workspaceClient.getProjectPulse(monitor.path, worktreeId, mainBranch, rangeDays, {
      includeDelta,
      includeRecentCommits,
      forceRefresh,
    });
  };
  ipcMain.handle(CHANNELS.GIT_GET_PROJECT_PULSE, handleGitGetProjectPulse);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_GET_PROJECT_PULSE));

  const handleGitListCommits = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: {
      cwd: string;
      search?: string;
      branch?: string;
      skip?: number;
      limit?: number;
    }
  ) => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload");
    }

    const { cwd, search, branch, skip, limit } = payload;

    if (typeof cwd !== "string" || !cwd) {
      throw new Error("Invalid working directory");
    }

    const { listCommits } = await import("../../utils/git.js");

    return listCommits({ cwd, search, branch, skip, limit });
  };
  ipcMain.handle(CHANNELS.GIT_LIST_COMMITS, handleGitListCommits);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.GIT_LIST_COMMITS));

  return () => handlers.forEach((cleanup) => cleanup());
}
