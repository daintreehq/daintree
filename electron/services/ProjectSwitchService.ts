import type { BrowserWindow } from "electron";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { EventBuffer } from "./EventBuffer.js";
import type { Project } from "../types/index.js";
import { projectStore } from "./ProjectStore.js";
import { logBuffer } from "./LogBuffer.js";
import { taskQueueService } from "./TaskQueueService.js";
import { assistantService } from "./AssistantService.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/utils.js";
import { randomUUID } from "crypto";
import { store } from "../store.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance } from "../utils/performance.js";

export interface ProjectSwitchDependencies {
  mainWindow: BrowserWindow;
  ptyClient: PtyClient;
  worktreeService?: WorkspaceClient;
  eventBuffer?: EventBuffer;
}

export class ProjectSwitchService {
  private deps: ProjectSwitchDependencies;
  private switchChain: Promise<void> = Promise.resolve();

  constructor(deps: ProjectSwitchDependencies) {
    this.deps = deps;
  }

  async switchProject(projectId: string): Promise<Project> {
    const task = this.switchChain.then(() => this.performSwitch(projectId));
    this.switchChain = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async performSwitch(projectId: string): Promise<Project> {
    const startedAt = Date.now();
    markPerformance(PERF_MARKS.PROJECT_SWITCH_START, { projectId });

    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    console.log("[ProjectSwitch] Starting project switch to:", project.name);

    const previousProjectId = projectStore.getCurrentProjectId();

    // Save the current active worktree to the outgoing project's per-project state
    // This ensures the worktree selection is remembered when switching back
    if (previousProjectId) {
      await this.saveOutgoingProjectWorktreeState(previousProjectId);
    }

    try {
      await this.cleanupPreviousProject(projectId);

      console.log("[ProjectSwitch] Previous project state cleaned up");

      await projectStore.setCurrentProject(projectId);

      const updatedProject = projectStore.getProjectById(projectId);
      if (!updatedProject) {
        throw new Error(`Project not found after update: ${projectId}`);
      }

      await this.loadNewProject(project);

      const switchId = randomUUID();
      sendToRenderer(this.deps.mainWindow, CHANNELS.PROJECT_ON_SWITCH, {
        project: updatedProject,
        switchId,
      });

      console.log("[ProjectSwitch] Project switch complete, switchId:", switchId);
      return updatedProject;
    } catch (error) {
      console.error("[ProjectSwitch] Project switch failed, rolling back:", error);
      try {
        if (previousProjectId) {
          this.deps.ptyClient.onProjectSwitch(previousProjectId);
        } else {
          this.deps.ptyClient.setActiveProject(null);
        }
      } catch (rollbackError) {
        console.error("[ProjectSwitch] Rollback failed:", rollbackError);
      }
      throw error;
    } finally {
      markPerformance(PERF_MARKS.PROJECT_SWITCH_END, {
        projectId,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Save the current active worktree ID to the outgoing project's per-project state.
   * This ensures the worktree selection is remembered when switching back to the project.
   */
  private async saveOutgoingProjectWorktreeState(projectId: string): Promise<void> {
    try {
      const currentAppState = store.get("appState");
      const activeWorktreeId = currentAppState.activeWorktreeId;

      // Get existing project state to preserve all fields
      const existingState = await projectStore.getProjectState(projectId);
      if (existingState?.activeWorktreeId === activeWorktreeId) {
        return;
      }

      // Persist only when the active worktree changed to avoid unnecessary disk writes.
      // Null/undefined changes are still persisted because the equality check above compares exact values.
      await projectStore.saveProjectState(projectId, {
        ...existingState,
        projectId,
        activeWorktreeId,
        sidebarWidth: existingState?.sidebarWidth ?? currentAppState.sidebarWidth ?? 350,
        terminals: existingState?.terminals ?? [],
      });

      console.log(
        `[ProjectSwitch] Saved activeWorktreeId (${activeWorktreeId ?? "null"}) to project ${projectId}`
      );
    } catch (error) {
      // Non-fatal: log but don't block the switch
      console.error("[ProjectSwitch] Failed to save outgoing project worktree state:", error);
    }
  }

  private async cleanupPreviousProject(projectId: string): Promise<void> {
    console.log("[ProjectSwitch] Cleaning up previous project state...");

    const safeCall = (fn: () => unknown): Promise<unknown> => Promise.resolve().then(fn);
    const cleanupResults = await Promise.allSettled([
      this.deps.worktreeService?.onProjectSwitch
        ? safeCall(() => this.deps.worktreeService!.onProjectSwitch())
        : Promise.resolve(),
      safeCall(() => this.deps.ptyClient.onProjectSwitch(projectId)),
      safeCall(() => logBuffer.onProjectSwitch()),
      this.deps.eventBuffer?.onProjectSwitch
        ? safeCall(() => this.deps.eventBuffer!.onProjectSwitch())
        : Promise.resolve(),
      safeCall(() => taskQueueService.onProjectSwitch(projectId)),
      safeCall(() => assistantService.clearAllSessions()),
    ]);

    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const serviceNames = [
          "WorktreeService",
          "PtyClient",
          "LogBuffer",
          "EventBuffer",
          "TaskQueueService",
          "AssistantService",
        ];
        console.error(`[ProjectSwitch] ${serviceNames[index]} cleanup failed:`, result.reason);
      }
    });
  }

  private async loadNewProject(project: Project): Promise<void> {
    if (!this.deps.worktreeService) {
      return;
    }

    try {
      console.log("[ProjectSwitch] Loading worktrees for new project...");
      await this.deps.worktreeService.loadProject(project.path);
      console.log("[ProjectSwitch] Worktrees loaded successfully");
    } catch (err) {
      console.error("Failed to load worktrees for project:", err);
    }
  }

  /**
   * Reopen a background project, making it the active project.
   * This is essentially a switch operation but specifically for background projects.
   * Terminals that were running in the background will be reconnected on the frontend.
   */
  async reopenProject(projectId: string): Promise<Project> {
    return this.switchProject(projectId);
  }
}
