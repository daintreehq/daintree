import { store } from "../store.js";
import type { Project, ProjectState, ProjectSettings, ProjectStatus } from "../types/index.js";
import { createHash } from "crypto";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { app } from "electron";
import { GitService } from "./GitService.js";
import { isCanopyError } from "../utils/errorTypes.js";
import { sanitizeSvg } from "../../shared/utils/svgSanitizer.js";

const SETTINGS_FILENAME = "settings.json";

export class ProjectStore {
  private projectsConfigDir: string;

  constructor() {
    this.projectsConfigDir = path.join(app.getPath("userData"), "projects");
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.projectsConfigDir)) {
      await fs.mkdir(this.projectsConfigDir, { recursive: true });
    }
  }

  private generateProjectId(projectPath: string): string {
    return createHash("sha256").update(projectPath).digest("hex");
  }

  private isValidProjectId(projectId: string): boolean {
    return /^[0-9a-f]{64}$/.test(projectId);
  }

  private getProjectStateDir(projectId: string): string | null {
    if (!this.isValidProjectId(projectId)) {
      return null;
    }
    const stateDir = path.join(this.projectsConfigDir, projectId);
    const normalized = path.normalize(stateDir);
    if (!normalized.startsWith(this.projectsConfigDir + path.sep)) {
      return null;
    }
    return normalized;
  }

  private async getGitRoot(projectPath: string): Promise<string> {
    const gitService = new GitService(projectPath);
    const root = await gitService.getRepositoryRoot(projectPath);
    const canonical = await fs.realpath(root);
    return canonical;
  }

  async addProject(projectPath: string): Promise<Project> {
    let gitRoot: string;
    try {
      gitRoot = await this.getGitRoot(projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const causeMessage =
        isCanopyError(error) && error.cause instanceof Error ? error.cause.message : undefined;
      const combined = [message, causeMessage].filter(Boolean).join("\n");
      const lower = combined.toLowerCase();

      if (lower.includes("spawn git enoent") || lower.includes("git: not found")) {
        throw new Error(
          "Git executable not found. Install Git and ensure it is available on your PATH."
        );
      }

      if (lower.includes("dubious ownership") || lower.includes("safe.directory")) {
        throw new Error(
          "Git refused to open this repository due to 'dubious ownership'. Mark it as safe.directory and try again."
        );
      }

      if (lower.includes("not a git repository")) {
        throw new Error(`Not a git repository: ${projectPath}`);
      }

      throw new Error(combined || "Failed to open project");
    }

    const normalizedPath = path.normalize(gitRoot);

    const existing = await this.getProjectByPath(normalizedPath);
    if (existing) {
      return this.updateProject(existing.id, { lastOpened: Date.now() });
    }

    const project: Project = {
      id: this.generateProjectId(normalizedPath),
      path: normalizedPath,
      name: path.basename(normalizedPath),
      emoji: "🌲",
      lastOpened: Date.now(),
      status: "closed",
    };

    const projects = this.getAllProjects();
    projects.push(project);
    store.set("projects.list", projects);

    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const projects = this.getAllProjects();
    const filtered = projects.filter((p) => p.id !== projectId);
    store.set("projects.list", filtered);

    if (existsSync(stateDir)) {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`[ProjectStore] Failed to remove state directory for ${projectId}:`, error);
      }
    }

    if (this.getCurrentProjectId() === projectId) {
      store.set("projects.currentProjectId", undefined);
    }
  }

  updateProject(projectId: string, updates: Partial<Project>): Project {
    const projects = this.getAllProjects();
    const index = projects.findIndex((p) => p.id === projectId);

    if (index === -1) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const safeUpdates: Partial<Project> = {};
    if (updates.name !== undefined) safeUpdates.name = updates.name;
    if (updates.emoji !== undefined) safeUpdates.emoji = updates.emoji;
    if (updates.color !== undefined) safeUpdates.color = updates.color;
    if (updates.lastOpened !== undefined) safeUpdates.lastOpened = updates.lastOpened;
    if (updates.status !== undefined) safeUpdates.status = updates.status;

    const updated = { ...projects[index], ...safeUpdates };
    projects[index] = updated;
    store.set("projects.list", projects);

    return updated;
  }

  /**
   * Update a project's lifecycle status.
   * @param projectId - Project ID to update
   * @param status - New status (active, background, closed)
   */
  updateProjectStatus(projectId: string, status: ProjectStatus): Project {
    return this.updateProject(projectId, { status });
  }

  getAllProjects(): Project[] {
    const rawProjects = store.get("projects.list", []);

    // Defensive: ensure projects.list is a valid array
    if (!Array.isArray(rawProjects)) {
      console.error("[ProjectStore] projects.list is not an array, resetting to empty");
      store.set("projects.list", []);
      return [];
    }

    const currentProjectId = this.getCurrentProjectId();
    let needsPersistence = false;

    // Normalize status for all projects (handles legacy projects without status)
    const normalizedProjects = rawProjects
      .filter((p) => p && typeof p === "object" && p.id) // Filter out corrupted entries
      .map((project) => {
        const validStatuses: ProjectStatus[] = ["active", "background", "closed"];
        const isValidStatus = validStatuses.includes(project.status as ProjectStatus);

        // Enforce single active project: only the current project can be active
        if (project.id === currentProjectId) {
          // This is the current project - must be active
          if (project.status !== "active") {
            needsPersistence = true;
            return { ...project, status: "active" as const };
          }
          return project;
        } else {
          // Not the current project - cannot be active
          if (project.status === "active") {
            // Demote incorrectly active projects to background
            needsPersistence = true;
            console.warn(
              `[ProjectStore] Demoting incorrectly active project ${project.id} to background`
            );
            return { ...project, status: "background" as const };
          }

          // Handle invalid/missing status for non-current projects
          if (!isValidStatus) {
            needsPersistence = true;
            // Default to closed for safety (background would imply running processes)
            return { ...project, status: "closed" as const };
          }

          return project;
        }
      });

    // Persist normalized data to heal corrupted/missing statuses
    if (needsPersistence) {
      console.log("[ProjectStore] Persisting normalized project statuses");
      store.set("projects.list", normalizedProjects);
    }

    if (process.env.CANOPY_VERBOSE) {
      console.log(
        "[ProjectStore] getAllProjects statuses:",
        normalizedProjects.map((p) => ({ name: p.name, status: p.status }))
      );
    }
    return normalizedProjects.sort((a, b) => b.lastOpened - a.lastOpened);
  }

  async getProjectByPath(projectPath: string): Promise<Project | null> {
    const normalizedPath = path.normalize(projectPath);
    const projects = this.getAllProjects();
    return projects.find((p) => p.path === normalizedPath) || null;
  }

  getProjectById(projectId: string): Project | null {
    const projects = this.getAllProjects();
    return projects.find((p) => p.id === projectId) || null;
  }

  getCurrentProjectId(): string | null {
    return store.get("projects.currentProjectId") || null;
  }

  getCurrentProject(): Project | null {
    const currentId = this.getCurrentProjectId();
    if (!currentId) return null;
    return this.getProjectById(currentId);
  }

  async setCurrentProject(projectId: string): Promise<void> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    // Mark the previous active project as background (if any)
    // Always set to background when switching away - the status will be used
    // by the UI to show the project in the Background section
    const previousProjectId = this.getCurrentProjectId();
    if (previousProjectId && previousProjectId !== projectId) {
      // Mark as background - terminals keep running but UI state is cleared
      console.log(`[ProjectStore] Marking previous project ${previousProjectId} as background`);
      this.updateProjectStatus(previousProjectId, "background");

      // Verify the update was applied
      if (process.env.CANOPY_VERBOSE) {
        const updatedPrevious = this.getProjectById(previousProjectId);
        console.log(
          `[ProjectStore] Previous project status after update: ${updatedPrevious?.status}`
        );
      }
    }

    store.set("projects.currentProjectId", projectId);
    this.updateProject(projectId, { lastOpened: Date.now(), status: "active" });

    // Log final state for debugging
    if (process.env.CANOPY_VERBOSE) {
      console.log(`[ProjectStore] setCurrentProject complete:`, {
        newCurrentId: projectId,
        previousId: previousProjectId,
        allStatuses: this.getAllProjects().map((p) => ({ name: p.name, status: p.status })),
      });
    }
  }

  /**
   * Clear the current project reference (used when closing the active project).
   */
  clearCurrentProject(): void {
    store.set("projects.currentProjectId", undefined);
  }

  private getStateFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      return null;
    }
    return path.join(stateDir, "state.json");
  }

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    if (!existsSync(stateDir)) {
      await fs.mkdir(stateDir, { recursive: true });
    }

    const stateFilePath = this.getStateFilePath(projectId);
    if (!stateFilePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const tempFilePath = `${stateFilePath}.tmp`;
    try {
      await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2), "utf-8");
      await fs.rename(tempFilePath, stateFilePath);
    } catch (error) {
      console.error(`[ProjectStore] Failed to save state for project ${projectId}:`, error);
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore
      }
      throw error;
    }
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const stateFilePath = this.getStateFilePath(projectId);
    if (!stateFilePath || !existsSync(stateFilePath)) {
      return null;
    }

    try {
      const content = await fs.readFile(stateFilePath, "utf-8");
      const parsed = JSON.parse(content);

      const state: ProjectState = {
        projectId: parsed.projectId || projectId,
        activeWorktreeId: parsed.activeWorktreeId,
        sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : 350,
        terminals: Array.isArray(parsed.terminals) ? parsed.terminals : [],
        terminalLayout: parsed.terminalLayout || undefined,
      };

      return state;
    } catch (error) {
      console.error(`[ProjectStore] Failed to load state for project ${projectId}:`, error);
      try {
        const quarantinePath = `${stateFilePath}.corrupted`;
        await fs.rename(stateFilePath, quarantinePath);
        console.warn(`[ProjectStore] Corrupted state file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return null;
    }
  }

  private getSettingsFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) return null;
    return path.join(stateDir, SETTINGS_FILENAME);
  }

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    const filePath = this.getSettingsFilePath(projectId);
    if (!filePath || !existsSync(filePath)) {
      return { runCommands: [] };
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      // Sanitize projectIconSvg on load (defense in depth for existing files)
      let sanitizedIconSvg: string | undefined;
      if (typeof parsed.projectIconSvg === "string" && parsed.projectIconSvg.trim()) {
        const sanitizeResult = sanitizeSvg(parsed.projectIconSvg);
        if (sanitizeResult.ok) {
          sanitizedIconSvg = sanitizeResult.svg;
          if (sanitizeResult.modified) {
            console.warn(
              `[ProjectStore] Sanitized potentially unsafe SVG content for project ${projectId}`
            );
          }
        } else {
          console.warn(
            `[ProjectStore] Invalid SVG in settings for project ${projectId}: ${sanitizeResult.error}`
          );
          // Don't include invalid SVG in settings
        }
      }

      const settings: ProjectSettings = {
        runCommands: Array.isArray(parsed.runCommands) ? parsed.runCommands : [],
        environmentVariables: parsed.environmentVariables,
        excludedPaths: parsed.excludedPaths,
        projectIconSvg: sanitizedIconSvg,
        defaultWorktreeRecipeId:
          typeof parsed.defaultWorktreeRecipeId === "string"
            ? parsed.defaultWorktreeRecipeId
            : undefined,
        devServerCommand:
          typeof parsed.devServerCommand === "string" ? parsed.devServerCommand : undefined,
      };

      return settings;
    } catch (error) {
      console.error(`[ProjectStore] Failed to load settings for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await fs.rename(filePath, quarantinePath);
        console.warn(`[ProjectStore] Corrupted settings file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return { runCommands: [] };
    }
  }

  async saveProjectSettings(projectId: string, settings: ProjectSettings): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    if (!existsSync(stateDir)) {
      await fs.mkdir(stateDir, { recursive: true });
    }

    const filePath = this.getSettingsFilePath(projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Sanitize projectIconSvg before saving
    let sanitizedSettings = settings;
    if (settings.projectIconSvg) {
      const sanitizeResult = sanitizeSvg(settings.projectIconSvg);
      if (sanitizeResult.ok) {
        sanitizedSettings = { ...settings, projectIconSvg: sanitizeResult.svg };
        if (sanitizeResult.modified) {
          console.warn(
            `[ProjectStore] Sanitized potentially unsafe SVG content before saving for project ${projectId}`
          );
        }
      } else {
        // Don't save invalid SVG - strip it from settings
        console.warn(
          `[ProjectStore] Rejecting invalid SVG for project ${projectId}: ${sanitizeResult.error}`
        );
        sanitizedSettings = { ...settings, projectIconSvg: undefined };
      }
    }

    const tempFilePath = `${filePath}.tmp`;
    try {
      await fs.writeFile(tempFilePath, JSON.stringify(sanitizedSettings, null, 2), "utf-8");
      await fs.rename(tempFilePath, filePath);
    } catch (error) {
      console.error(`[ProjectStore] Failed to save settings for ${projectId}:`, error);
      try {
        await fs.unlink(tempFilePath);
      } catch {
        // Ignore
      }
      throw error;
    }
  }

  /**
   * Clear persisted state for a project.
   * Deletes the state.json file, forcing fresh state on next load.
   * Used when explicitly closing a project to free resources.
   * @param projectId - Project ID to clear state for
   */
  async clearProjectState(projectId: string): Promise<void> {
    const stateFilePath = this.getStateFilePath(projectId);

    if (!stateFilePath) {
      console.warn(`[ProjectStore] Invalid project ID: ${projectId}`);
      return;
    }

    if (!existsSync(stateFilePath)) {
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStore] No state file to clear for project ${projectId}`);
      }
      return;
    }

    try {
      await fs.unlink(stateFilePath);
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStore] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      console.error(`[ProjectStore] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
}

export const projectStore = new ProjectStore();
