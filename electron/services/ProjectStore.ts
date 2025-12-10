import { store } from "../store.js";
import type { Project, ProjectState, ProjectSettings } from "../types/index.js";
import { createHash } from "crypto";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { app } from "electron";
import { GitService } from "./GitService.js";

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

  private async getGitRoot(projectPath: string): Promise<string | null> {
    try {
      const gitService = new GitService(projectPath);
      const root = await gitService.getRepositoryRoot(projectPath);
      const canonical = await fs.realpath(root);
      return canonical;
    } catch {
      return null;
    }
  }

  async addProject(projectPath: string): Promise<Project> {
    const gitRoot = await this.getGitRoot(projectPath);
    if (!gitRoot) {
      throw new Error(`Not a git repository: ${projectPath}`);
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

    const updated = { ...projects[index], ...safeUpdates };
    projects[index] = updated;
    store.set("projects.list", projects);

    return updated;
  }

  getAllProjects(): Project[] {
    const projects = store.get("projects.list", []);
    return projects.sort((a, b) => b.lastOpened - a.lastOpened);
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

    store.set("projects.currentProjectId", projectId);
    this.updateProject(projectId, { lastOpened: Date.now() });
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

      const settings: ProjectSettings = {
        runCommands: Array.isArray(parsed.runCommands) ? parsed.runCommands : [],
        devServer: parsed.devServer,
        environmentVariables: parsed.environmentVariables,
        excludedPaths: parsed.excludedPaths,
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

    const tempFilePath = `${filePath}.tmp`;
    try {
      await fs.writeFile(tempFilePath, JSON.stringify(settings, null, 2), "utf-8");
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
