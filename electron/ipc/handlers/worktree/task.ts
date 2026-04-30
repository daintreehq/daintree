import { getWindowForWebContents } from "../../../window/webContentsRegistry.js";
import { CHANNELS } from "../../channels.js";
import type { HandlerDependencies } from "../../types.js";
import type {
  CreateForTaskPayload,
  CleanupTaskOptions,
} from "../../../../shared/types/ipc/worktree.js";
import type { WorktreeState } from "../../../../shared/types/worktree.js";
import { generateWorktreePath } from "../../../../shared/utils/pathPattern.js";
import { projectStore } from "../../../services/ProjectStore.js";
import { logDebug, logError } from "../../../utils/logger.js";
import { fileSearchService } from "../../../services/FileSearchService.js";
import {
  checkRateLimit,
  waitForRateLimitSlot,
  typedHandle,
  typedHandleWithContext,
} from "../../utils.js";
import { resolveWorktreePattern } from "../../../utils/worktreePattern.js";
import { taskWorktreeService } from "../../../services/TaskWorktreeService.js";
import { WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS } from "./constants.js";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

export function registerTaskWorktreeHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleWorktreeCreateForTask = async (
    ctx: import("../../types.js").IpcContext,
    payload: CreateForTaskPayload
  ): Promise<WorktreeState> => {
    await waitForRateLimitSlot(WORKTREE_RATE_LIMIT_KEY, WORKTREE_RATE_LIMIT_INTERVAL_MS);
    if (!deps.worktreeService) {
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
    const project = projectStore.getCurrentProject();

    if (!project || !project.path) {
      throw new Error("No active project found");
    }

    const rootPath = project.path;

    // Get all states to find the main worktree and determine base branch
    const senderWindowCreate = getWindowForWebContents(ctx.event.sender);
    const states = await deps.worktreeService.getAllStatesAsync(senderWindowCreate?.id);
    const mainWorktree = states.find((wt) => wt.isMainWorktree);

    // Use provided baseBranch, or default to main worktree's branch, or "main"
    const effectiveBaseBranch = baseBranch || mainWorktree?.branch || "main";

    // Generate collision-safe branch name: task-{taskId} with suffix if needed
    const gitService = taskWorktreeService.getGitService(rootPath);
    const baseBranchName = `task-${taskId}`;
    const availableBranchName = await gitService.findAvailableBranchName(baseBranchName);

    // Generate path using the worktree path pattern (project-level → global → default)
    const pattern = await resolveWorktreePattern(rootPath);
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
      worktreeId = await deps.worktreeService.createWorktree(rootPath, {
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
      taskWorktreeService.addTaskWorktreeMapping(project.id, taskId, worktreeId);

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
        const monitor = await deps.worktreeService.getMonitorAsync(worktreeId);
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
  handlers.push(
    typedHandleWithContext(CHANNELS.WORKTREE_CREATE_FOR_TASK, handleWorktreeCreateForTask)
  );

  const handleWorktreeGetByTaskId = async (taskId: string): Promise<WorktreeState[]> => {
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }

    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("Invalid taskId: must be a non-empty string");
    }

    // Get current project to scope the lookup
    const currentProjectId = projectStore.getCurrentProjectId();
    if (!currentProjectId) {
      throw new Error("No active project found");
    }

    const worktreeIds = taskWorktreeService.getWorktreeIdsForTask(currentProjectId, taskId);
    const results: WorktreeState[] = [];

    for (const worktreeId of worktreeIds) {
      const monitor = await deps.worktreeService.getMonitorAsync(worktreeId);
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
  handlers.push(typedHandle(CHANNELS.WORKTREE_GET_BY_TASK_ID, handleWorktreeGetByTaskId));

  const handleWorktreeCleanupTask = async (
    ctx: import("../../types.js").IpcContext,
    taskId: string,
    options?: CleanupTaskOptions
  ): Promise<void> => {
    checkRateLimit(CHANNELS.WORKTREE_CLEANUP_TASK, 10, 10_000);
    if (!deps.worktreeService) {
      throw new Error("Workspace client not initialized");
    }

    if (typeof taskId !== "string" || !taskId.trim()) {
      throw new Error("Invalid taskId: must be a non-empty string");
    }

    // Get current project to scope the cleanup
    const currentProjectId = projectStore.getCurrentProjectId();
    if (!currentProjectId) {
      throw new Error("No active project found");
    }

    const worktreeIds = taskWorktreeService.getWorktreeIdsForTask(currentProjectId, taskId);

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
    const senderWindowCleanup = getWindowForWebContents(ctx.event.sender);
    let allStates: Awaited<ReturnType<typeof deps.worktreeService.getAllStatesAsync>> = [];
    try {
      allStates = await deps.worktreeService.getAllStatesAsync(senderWindowCleanup?.id);
    } catch (error) {
      logDebug("Could not fetch worktree states for cleanup pre-check", {
        error: formatErrorMessage(error, "Could not fetch worktree states"),
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
          taskWorktreeService.removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
          continue;
        }

        await deps.worktreeService.deleteWorktree(worktreeId, force, deleteBranch);
        if (targetWorktree) {
          try {
            fileSearchService.invalidate(targetWorktree.path);
          } catch (error) {
            console.warn("[worktree.cleanup-task] Failed to invalidate file search cache:", error);
          }
        }

        // Remove from tracking after successful deletion
        taskWorktreeService.removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
      } catch (error) {
        const errorMessage = formatErrorMessage(error, "Failed to cleanup worktree");

        // If worktree not found, treat as success and remove mapping (idempotent)
        if (errorMessage.includes("not found") || errorMessage.includes("does not exist")) {
          logDebug("Worktree already removed, cleaning up mapping", {
            worktreeId,
            taskId,
            projectId: currentProjectId,
          });
          taskWorktreeService.removeTaskWorktreeMapping(currentProjectId, taskId, worktreeId);
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
  handlers.push(typedHandleWithContext(CHANNELS.WORKTREE_CLEANUP_TASK, handleWorktreeCleanupTask));

  return () => handlers.forEach((cleanup) => cleanup());
}
