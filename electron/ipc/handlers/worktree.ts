import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { store } from "../../store.js";
import type { HandlerDependencies } from "../types.js";
import type { WorktreeSetActivePayload, WorktreeDeletePayload } from "../../types/index.js";
import type { PulseRangeDays, ProjectPulse } from "../../../shared/types/pulse.js";
import type {
  CreateForTaskPayload,
  CleanupTaskOptions,
  AttachIssuePayload,
  DetachIssuePayload,
  IssueAssociation,
} from "../../../shared/types/ipc/worktree.js";
import type { WorktreeState } from "../../../shared/types/domain.js";
import {
  generateWorktreePath,
  DEFAULT_WORKTREE_PATH_PATTERN,
  validatePathPattern,
} from "../../../shared/utils/pathPattern.js";
import { GitService } from "../../services/GitService.js";
import { logDebug, logError } from "../../utils/logger.js";
import { fileSearchService } from "../../services/FileSearchService.js";

// In-memory map to track taskId -> worktreeIds for orchestration
// Scoped by projectId to avoid cross-project collisions
// This is stored in-process since taskId is transient orchestration metadata
const taskWorktreeMap = new Map<string, Map<string, Set<string>>>();

function getProjectTaskMap(projectId: string): Map<string, Set<string>> {
  if (!taskWorktreeMap.has(projectId)) {
    taskWorktreeMap.set(projectId, new Map());
  }
  return taskWorktreeMap.get(projectId)!;
}

function addTaskWorktreeMapping(projectId: string, taskId: string, worktreeId: string): void {
  const projectMap = getProjectTaskMap(projectId);
  if (!projectMap.has(taskId)) {
    projectMap.set(taskId, new Set());
  }
  projectMap.get(taskId)!.add(worktreeId);
}

function removeTaskWorktreeMapping(projectId: string, taskId: string, worktreeId: string): void {
  const projectMap = getProjectTaskMap(projectId);
  const worktrees = projectMap.get(taskId);
  if (worktrees) {
    worktrees.delete(worktreeId);
    if (worktrees.size === 0) {
      projectMap.delete(taskId);
    }
  }
}

function getWorktreeIdsForTask(projectId: string, taskId: string): string[] {
  const projectMap = getProjectTaskMap(projectId);
  const worktrees = projectMap.get(taskId);
  return worktrees ? Array.from(worktrees) : [];
}

// Commented out for now - will be needed when implementing project switch cleanup
// function clearProjectMappings(projectId: string): void {
//   taskWorktreeMap.delete(projectId);
// }

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

  const handleWorktreePRStatus = async () => {
    if (!workspaceClient) {
      return null;
    }
    return await workspaceClient.getPRStatus();
  };
  ipcMain.handle(CHANNELS.WORKTREE_PR_STATUS, handleWorktreePRStatus);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_PR_STATUS));

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
    const worktreeId = await workspaceClient.createWorktree(payload.rootPath, payload.options);
    try {
      fileSearchService.invalidate(payload.options.path);
    } catch (error) {
      console.warn("[worktree.create] Failed to invalidate file search cache:", error);
    }
    return worktreeId;
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

    // Generate the initial path
    const initialPath = generateWorktreePath(rootPath, branchName, pattern);

    // Auto-resolve path conflicts by finding an available path
    const gitService = new GitService(rootPath);
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

    const gitService = new GitService(rootPath);
    return gitService.findAvailableBranchName(branchName);
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH, handleWorktreeGetAvailableBranch);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_AVAILABLE_BRANCH));

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
    if (payload.deleteBranch !== undefined && typeof payload.deleteBranch !== "boolean") {
      throw new Error("Invalid deleteBranch parameter");
    }
    const states = await workspaceClient.getAllStatesAsync();
    const worktree = states.find((wt) => wt.id === payload.worktreeId);
    await workspaceClient.deleteWorktree(payload.worktreeId, payload.force, payload.deleteBranch);
    if (worktree) {
      try {
        fileSearchService.invalidate(worktree.path);
      } catch (error) {
        console.warn("[worktree.delete] Failed to invalidate file search cache:", error);
      }
    }
    // Clean up persisted issue association
    const issueMap = store.get("worktreeIssueMap", {});
    if (issueMap[payload.worktreeId]) {
      const { [payload.worktreeId]: _, ...rest } = issueMap;
      store.set("worktreeIssueMap", rest);
    }
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

  // Task orchestration handlers

  const handleWorktreeCreateForTask = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: CreateForTaskPayload
  ): Promise<WorktreeState> => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:create-for-task");
    }

    const { taskId, baseBranch, description } = payload;

    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("Invalid taskId: must be a non-empty string");
    }

    // Get the current project to determine root path
    const projectsData = store.get("projects");
    const currentProjectId = projectsData?.currentProjectId;
    const projectsList = projectsData?.list;
    const project = projectsList?.find((p) => p.id === currentProjectId);

    if (!project || !project.path) {
      throw new Error("No active project found");
    }

    const rootPath = project.path;

    // Get all states to find the main worktree and determine base branch
    const states = await workspaceClient.getAllStatesAsync();
    const mainWorktree = states.find((wt) => wt.isMainWorktree);

    // Use provided baseBranch, or default to main worktree's branch, or "main"
    const effectiveBaseBranch = baseBranch || mainWorktree?.branch || "main";

    // Generate collision-safe branch name: task-{taskId} with suffix if needed
    const gitService = new GitService(rootPath);
    const baseBranchName = `task-${taskId}`;
    const availableBranchName = await gitService.findAvailableBranchName(baseBranchName);

    // Generate path using the worktree path pattern
    const configPattern = store.get("worktreeConfig.pathPattern");
    const pattern =
      typeof configPattern === "string" && configPattern.trim()
        ? configPattern
        : DEFAULT_WORKTREE_PATH_PATTERN;

    const initialPath = generateWorktreePath(rootPath, availableBranchName, pattern);
    const availablePath = gitService.findAvailablePath(initialPath);

    logDebug("Creating worktree for task", {
      taskId,
      projectId: project.id,
      branch: availableBranchName,
      path: availablePath,
      baseBranch: effectiveBaseBranch,
      description,
    });

    let worktreeId: string;
    try {
      // Create the worktree
      worktreeId = await workspaceClient.createWorktree(rootPath, {
        baseBranch: effectiveBaseBranch,
        newBranch: availableBranchName,
        path: availablePath,
      });

      // Invalidate file search cache for the new worktree path
      try {
        fileSearchService.invalidate(availablePath);
      } catch (error) {
        console.warn("[worktree.create-for-task] Failed to invalidate file search cache:", error);
      }

      // Store the taskId mapping
      addTaskWorktreeMapping(project.id, taskId, worktreeId);

      logDebug("Worktree created for task", {
        worktreeId,
        taskId,
        projectId: project.id,
        branch: availableBranchName,
        path: availablePath,
      });
    } catch (error) {
      // Worktree creation failed, don't leave partial state
      logError(
        "Failed to create worktree for task",
        error instanceof Error ? error : new Error(String(error)),
        {
          taskId,
          projectId: project.id,
        }
      );
      throw error;
    }

    // Wait for the monitor to be ready and return the full state
    // Retry a few times since the worktree might not be fully indexed yet
    let state: WorktreeState | null = null;
    try {
      for (let i = 0; i < 5; i++) {
        const monitor = await workspaceClient.getMonitorAsync(worktreeId);
        if (monitor) {
          state = {
            id: monitor.id,
            path: monitor.path,
            name: monitor.name,
            branch: monitor.branch,
            isCurrent: monitor.isCurrent,
            isMainWorktree: monitor.isMainWorktree,
            gitDir: monitor.gitDir,
            summary: monitor.summary,
            modifiedCount: monitor.modifiedCount,
            changes: monitor.changes,
            mood: monitor.mood,
            lastActivityTimestamp: monitor.lastActivityTimestamp ?? null,
            createdAt: monitor.createdAt,
            aiNote: monitor.aiNote,
            aiNoteTimestamp: monitor.aiNoteTimestamp,
            issueNumber: monitor.issueNumber,
            prNumber: monitor.prNumber,
            prUrl: monitor.prUrl,
            prState: monitor.prState,
            prTitle: monitor.prTitle,
            issueTitle: monitor.issueTitle,
            worktreeChanges: monitor.worktreeChanges ?? null,
            worktreeId: monitor.worktreeId,
            taskId,
          };
          break;
        }
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (!state) {
        // Worktree was created but not yet indexed, return minimal state
        state = {
          id: worktreeId,
          path: availablePath,
          name: availableBranchName,
          branch: availableBranchName,
          isCurrent: false,
          lastActivityTimestamp: null,
          worktreeId: worktreeId,
          worktreeChanges: null,
          taskId,
        };
      }

      return state;
    } catch (error) {
      // Monitor polling failed - worktree exists but we can't get its state
      // Return minimal state rather than failing completely
      logError(
        "Failed to get monitor state after creating worktree",
        error instanceof Error ? error : new Error(String(error)),
        {
          worktreeId,
          taskId,
          projectId: project.id,
        }
      );

      return {
        id: worktreeId,
        path: availablePath,
        name: availableBranchName,
        branch: availableBranchName,
        isCurrent: false,
        lastActivityTimestamp: null,
        worktreeId: worktreeId,
        worktreeChanges: null,
        taskId,
      };
    }
  };
  ipcMain.handle(CHANNELS.WORKTREE_CREATE_FOR_TASK, handleWorktreeCreateForTask);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_CREATE_FOR_TASK));

  const handleWorktreeGetByTaskId = async (
    _event: Electron.IpcMainInvokeEvent,
    taskId: string
  ): Promise<WorktreeState[]> => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }

    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("Invalid taskId: must be a non-empty string");
    }

    // Get current project to scope the lookup
    const projectsData = store.get("projects");
    const currentProjectId = projectsData?.currentProjectId;
    if (!currentProjectId) {
      throw new Error("No active project found");
    }

    const worktreeIds = getWorktreeIdsForTask(currentProjectId, taskId);
    const results: WorktreeState[] = [];

    for (const worktreeId of worktreeIds) {
      const monitor = await workspaceClient.getMonitorAsync(worktreeId);
      if (monitor) {
        results.push({
          id: monitor.id,
          path: monitor.path,
          name: monitor.name,
          branch: monitor.branch,
          isCurrent: monitor.isCurrent,
          isMainWorktree: monitor.isMainWorktree,
          gitDir: monitor.gitDir,
          summary: monitor.summary,
          modifiedCount: monitor.modifiedCount,
          changes: monitor.changes,
          mood: monitor.mood,
          lastActivityTimestamp: monitor.lastActivityTimestamp ?? null,
          createdAt: monitor.createdAt,
          aiNote: monitor.aiNote,
          aiNoteTimestamp: monitor.aiNoteTimestamp,
          issueNumber: monitor.issueNumber,
          prNumber: monitor.prNumber,
          prUrl: monitor.prUrl,
          prState: monitor.prState,
          prTitle: monitor.prTitle,
          issueTitle: monitor.issueTitle,
          worktreeChanges: monitor.worktreeChanges ?? null,
          worktreeId: monitor.worktreeId,
          taskId,
        });
      }
    }

    return results;
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_BY_TASK_ID, handleWorktreeGetByTaskId);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_BY_TASK_ID));

  const handleWorktreeCleanupTask = async (
    _event: Electron.IpcMainInvokeEvent,
    taskId: string,
    options?: CleanupTaskOptions
  ): Promise<void> => {
    if (!workspaceClient) {
      throw new Error("Workspace client not initialized");
    }

    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("Invalid taskId: must be a non-empty string");
    }

    // Get current project to scope the cleanup
    const projectsData = store.get("projects");
    const currentProjectId = projectsData?.currentProjectId;
    if (!currentProjectId) {
      throw new Error("No active project found");
    }

    const worktreeIds = getWorktreeIdsForTask(currentProjectId, taskId);

    if (worktreeIds.length === 0) {
      // No worktrees to clean up, return silently (idempotent)
      return;
    }

    const force = options?.force ?? true;
    const deleteBranch = options?.deleteBranch ?? true;

    logDebug("Cleaning up worktrees for task", {
      taskId,
      projectId: currentProjectId,
      worktreeIds,
      force,
      deleteBranch,
    });

    const errors: string[] = [];

    // Fetch all worktree states once for efficient main-worktree checking
    let allStates: Awaited<ReturnType<typeof workspaceClient.getAllStatesAsync>> = [];
    try {
      allStates = await workspaceClient.getAllStatesAsync();
    } catch (error) {
      logDebug("Could not fetch worktree states for cleanup pre-check", {
        error: error instanceof Error ? error.message : String(error),
        taskId,
      });
    }

    for (const worktreeId of worktreeIds) {
      try {
        // Safeguard: Check if this is the main worktree before attempting deletion
        const targetWorktree = allStates.find((wt) => wt.id === worktreeId);

        if (targetWorktree?.isMainWorktree) {
          logDebug("Skipping deletion of main worktree in cleanup task", {
            worktreeId,
            taskId,
            projectId: currentProjectId,
          });
          removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
          continue;
        }

        await workspaceClient.deleteWorktree(worktreeId, force, deleteBranch);
        if (targetWorktree) {
          try {
            fileSearchService.invalidate(targetWorktree.path);
          } catch (error) {
            console.warn("[worktree.cleanup-task] Failed to invalidate file search cache:", error);
          }
        }

        // Remove from tracking after successful deletion
        removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // If worktree not found, treat as success and remove mapping (idempotent)
        if (errorMessage.includes("not found") || errorMessage.includes("does not exist")) {
          logDebug("Worktree already removed, cleaning up mapping", {
            worktreeId,
            taskId,
            projectId: currentProjectId,
          });
          removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
        } else {
          logError(
            "Failed to cleanup worktree",
            error instanceof Error ? error : new Error(errorMessage),
            {
              worktreeId,
              taskId,
              projectId: currentProjectId,
            }
          );
          errors.push(`${worktreeId}: ${errorMessage}`);
        }
      }
    }

    logDebug("Task cleanup completed", {
      taskId,
      projectId: currentProjectId,
      worktreeIds,
      errors: errors.length > 0 ? errors : undefined,
    });

    if (errors.length > 0) {
      throw new Error(`Failed to cleanup some worktrees: ${errors.join("; ")}`);
    }
  };
  ipcMain.handle(CHANNELS.WORKTREE_CLEANUP_TASK, handleWorktreeCleanupTask);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_CLEANUP_TASK));

  // Issue attachment handlers

  const handleWorktreeAttachIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: AttachIssuePayload
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:attach-issue");
    }

    const { worktreeId, issueNumber, issueTitle, issueState, issueUrl } = payload;

    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }
    if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("Invalid issueNumber: must be a positive integer");
    }
    if (typeof issueTitle !== "string") {
      throw new Error("Invalid issueTitle: must be a string");
    }
    if (issueState !== "OPEN" && issueState !== "CLOSED") {
      throw new Error("Invalid issueState: must be 'OPEN' or 'CLOSED'");
    }
    if (typeof issueUrl !== "string" || !issueUrl.trim()) {
      throw new Error("Invalid issueUrl: must be a non-empty string");
    }

    const association: IssueAssociation = {
      issueNumber,
      issueTitle,
      issueState,
      issueUrl,
    };

    const currentMap = store.get("worktreeIssueMap") ?? {};
    store.set("worktreeIssueMap", { ...currentMap, [worktreeId]: association });
  };
  ipcMain.handle(CHANNELS.WORKTREE_ATTACH_ISSUE, handleWorktreeAttachIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_ATTACH_ISSUE));

  const handleWorktreeDetachIssue = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: DetachIssuePayload
  ): Promise<void> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid payload for worktree:detach-issue");
    }

    const { worktreeId } = payload;

    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const currentMap = store.get("worktreeIssueMap") ?? {};
    const { [worktreeId]: _removed, ...rest } = currentMap;
    store.set("worktreeIssueMap", rest);
  };
  ipcMain.handle(CHANNELS.WORKTREE_DETACH_ISSUE, handleWorktreeDetachIssue);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_DETACH_ISSUE));

  const handleWorktreeGetIssueAssociation = async (
    _event: Electron.IpcMainInvokeEvent,
    worktreeId: string
  ): Promise<IssueAssociation | null> => {
    if (typeof worktreeId !== "string" || !worktreeId.trim()) {
      throw new Error("Invalid worktreeId: must be a non-empty string");
    }

    const currentMap = store.get("worktreeIssueMap") ?? {};
    return currentMap[worktreeId] ?? null;
  };
  ipcMain.handle(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION, handleWorktreeGetIssueAssociation);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.WORKTREE_GET_ISSUE_ASSOCIATION));

  return () => handlers.forEach((cleanup) => cleanup());
}
