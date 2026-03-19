import path from "path";
import type { Project } from "../types/index.js";
import type { HandlerDependencies } from "../ipc/types.js";
import { projectStore, DEFAULT_PROJECT_EMOJI } from "./ProjectStore.js";
import { logBuffer } from "./LogBuffer.js";
import { taskQueueService } from "./TaskQueueService.js";
import { taskWorktreeService } from "./TaskWorktreeService.js";
import { contextInjectionTracker } from "./ContextInjectionTracker.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/utils.js";
import { randomUUID } from "crypto";
import { store } from "../store.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance, withPerformanceSpan } from "../utils/performance.js";

export class ProjectSwitchService {
  private deps: HandlerDependencies;
  private switchChain: Promise<void> = Promise.resolve();

  constructor(deps: HandlerDependencies) {
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
    if (previousProjectId === projectId) {
      console.log(
        "[ProjectSwitch] Ignoring switch request for already active project:",
        project.name
      );
      markPerformance(PERF_MARKS.PROJECT_SWITCH_END, {
        projectId,
        durationMs: Date.now() - startedAt,
        noOp: true,
      });
      return project;
    }

    // Save the current active worktree to the outgoing project's per-project state
    // This ensures the worktree selection is remembered when switching back
    if (previousProjectId) {
      await this.saveOutgoingProjectWorktreeState(previousProjectId);
    }

    try {
      await this.cleanupWorktreeService();
      const cleanupPromise = withPerformanceSpan(
        PERF_MARKS.PROJECT_SWITCH_CLEANUP,
        () => this.cleanupSupportingServices(projectId, previousProjectId ?? null),
        { projectId }
      );

      console.log("[ProjectSwitch] Previous project cleanup in progress");

      await projectStore.setCurrentProject(projectId);

      // Apply portable project identity from .canopy/project.json if the user
      // hasn't customised the project name/emoji (still has defaults).
      await this.applyInRepoIdentity(project);

      const updatedProject = projectStore.getProjectById(projectId);
      if (!updatedProject) {
        throw new Error(`Project not found after update: ${projectId}`);
      }

      const [, worktreeLoadError] = await Promise.all([
        cleanupPromise,
        withPerformanceSpan(
          PERF_MARKS.PROJECT_SWITCH_LOAD_PROJECT,
          () => this.loadNewProject(project),
          { projectId }
        ),
      ]);

      // Start MCP servers for the new project after cleanup is complete
      await this.startProjectMcpServers(updatedProject);

      const switchId = randomUUID();
      sendToRenderer(this.deps.mainWindow, CHANNELS.PROJECT_ON_SWITCH, {
        project: updatedProject,
        switchId,
        ...(worktreeLoadError ? { worktreeLoadError } : {}),
      });

      console.log("[ProjectSwitch] Project switch complete, switchId:", switchId);
      return updatedProject;
    } catch (error) {
      console.error("[ProjectSwitch] Project switch failed, rolling back:", error);
      try {
        if (previousProjectId) {
          this.deps.ptyClient!.onProjectSwitch(previousProjectId);
        } else {
          this.deps.ptyClient!.setActiveProject(null);
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

  private async cleanupWorktreeService(): Promise<void> {
    if (!this.deps.worktreeService?.onProjectSwitch) {
      return;
    }

    try {
      await Promise.resolve().then(() => this.deps.worktreeService!.onProjectSwitch());
    } catch (error) {
      console.error("[ProjectSwitch] WorktreeService cleanup failed:", error);
    }
  }

  private async cleanupSupportingServices(
    projectId: string,
    previousProjectId: string | null
  ): Promise<void> {
    console.log("[ProjectSwitch] Cleaning up previous project state...");

    const safeCall = (fn: () => unknown): Promise<unknown> => Promise.resolve().then(fn);
    const cleanupResults = await Promise.allSettled([
      safeCall(() => this.deps.ptyClient!.onProjectSwitch(projectId)),
      safeCall(() => logBuffer.onProjectSwitch()),
      this.deps.eventBuffer?.onProjectSwitch
        ? safeCall(() => this.deps.eventBuffer!.onProjectSwitch())
        : Promise.resolve(),
      safeCall(() => taskQueueService.onProjectSwitch(projectId)),
      previousProjectId && this.deps.projectMcpManager
        ? safeCall(() => this.deps.projectMcpManager!.stopForProject(previousProjectId!))
        : Promise.resolve(),
      safeCall(() => taskWorktreeService.onProjectSwitch()),
      safeCall(() => contextInjectionTracker.onProjectSwitch()),
    ]);

    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const serviceNames = [
          "PtyClient",
          "LogBuffer",
          "EventBuffer",
          "TaskQueueService",
          "ProjectMcpManager",
          "TaskWorktreeService",
          "ContextInjectionTracker",
        ];
        console.error(`[ProjectSwitch] ${serviceNames[index]} cleanup failed:`, result.reason);
      }
    });
  }

  private async loadNewProject(project: Project): Promise<string | undefined> {
    if (!this.deps.worktreeService) {
      return undefined;
    }

    try {
      console.log("[ProjectSwitch] Loading worktrees for new project...");
      await this.deps.worktreeService.loadProject(project.path);
      console.log("[ProjectSwitch] Worktrees loaded successfully");
      return undefined;
    } catch (err) {
      console.error("Failed to load worktrees for project:", err);
      return err instanceof Error ? err.message : "Failed to load worktrees";
    }
  }

  /**
   * Apply portable project identity from .canopy/project.json during switch.
   * Only applies values when the project still has default name/emoji (user hasn't customised).
   */
  private async applyInRepoIdentity(project: Project): Promise<void> {
    try {
      const inRepo = await projectStore.readInRepoProjectIdentity(project.path);
      const updates: Partial<Project> = {};

      if (inRepo.found && !project.canopyConfigPresent) {
        updates.canopyConfigPresent = true;
      } else if (!inRepo.found && project.canopyConfigPresent) {
        updates.canopyConfigPresent = false;
      }

      const defaultName = path.basename(project.path);
      const defaultEmoji = DEFAULT_PROJECT_EMOJI;

      if (inRepo.name && project.name === defaultName) {
        updates.name = inRepo.name;
      }
      if (inRepo.emoji && project.emoji === defaultEmoji) {
        updates.emoji = inRepo.emoji;
      }
      if (inRepo.color && !project.color) {
        updates.color = inRepo.color;
      }

      if (Object.keys(updates).length > 0) {
        projectStore.updateProject(project.id, updates);
      }
    } catch (error) {
      console.error("[ProjectSwitch] Failed to apply in-repo identity:", error);
    }
  }

  private async startProjectMcpServers(project: Project): Promise<void> {
    if (!this.deps.projectMcpManager) return;
    try {
      const settings = await projectStore.getProjectSettings(project.id);
      const servers = settings?.mcpServers;
      if (servers && Object.keys(servers).length > 0) {
        await this.deps.projectMcpManager.startForProject(project.id, project.path, servers);
        console.log(
          `[ProjectSwitch] Started ${Object.keys(servers).length} MCP server(s) for project ${project.name}`
        );
      }
    } catch (error) {
      console.error("[ProjectSwitch] Failed to start project MCP servers:", error);
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
