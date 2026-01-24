import type { BrowserWindow } from "electron";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import type { EventBuffer } from "./EventBuffer.js";
import type { Project } from "../types/index.js";
import { projectStore } from "./ProjectStore.js";
import { logBuffer } from "./LogBuffer.js";
import { CHANNELS } from "../ipc/channels.js";
import { sendToRenderer } from "../ipc/utils.js";
import { randomUUID } from "crypto";

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
    const project = projectStore.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    console.log("[ProjectSwitch] Starting project switch to:", project.name);

    const previousProjectId = projectStore.getCurrentProjectId();

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
      if (previousProjectId) {
        this.deps.ptyClient.onProjectSwitch(previousProjectId);
      } else {
        this.deps.ptyClient.setActiveProject(null);
      }
      throw error;
    }
  }

  private async cleanupPreviousProject(projectId: string): Promise<void> {
    console.log("[ProjectSwitch] Cleaning up previous project state...");

    const cleanupResults = await Promise.allSettled([
      this.deps.worktreeService?.onProjectSwitch() ?? Promise.resolve(),
      Promise.resolve(this.deps.ptyClient.onProjectSwitch(projectId)),
      Promise.resolve(logBuffer.onProjectSwitch()),
      Promise.resolve(this.deps.eventBuffer?.onProjectSwitch()),
    ]);

    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const serviceNames = ["WorktreeService", "PtyClient", "LogBuffer", "EventBuffer"];
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
