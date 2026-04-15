import type {
  Project,
  ProjectState,
  ProjectSettings,
  ProjectStatus,
  TerminalRecipe,
} from "../types/index.js";
import type { NotificationSettings } from "../../shared/types/ipc/api.js";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { app } from "electron";
import { GitService } from "./GitService.js";
import { isCanopyError } from "../utils/errorTypes.js";
import { logError } from "../utils/logger.js";
import { store } from "../store.js";
import { getSharedDb } from "./persistence/db.js";
import {
  projects as projectsTable,
  appState as appStateTable,
  type ProjectRow,
} from "./persistence/schema.js";
import { eq, desc } from "drizzle-orm";
import { generateProjectId, getProjectStateDir } from "./projectStorePaths.js";
import { ProjectSettingsManager } from "./ProjectSettingsManager.js";
import { ProjectStateManager } from "./ProjectStateManager.js";
import { ProjectFileStore } from "./ProjectFileStore.js";
import { GlobalFileStore } from "./GlobalFileStore.js";
import { ProjectIdentityFiles } from "./ProjectIdentityFiles.js";
import { cleanupQuarantinedProjectFiles } from "./projectQuarantineCleanup.js";

import { computeFrecencyScore, FRECENCY_COLD_START } from "./frecency.js";

export const DEFAULT_PROJECT_EMOJI = "🌲";

function rowToProject(row: ProjectRow): Project {
  const project: Project = {
    id: row.id,
    path: row.path,
    name: row.name,
    emoji: row.emoji,
    lastOpened: row.lastOpened,
  };
  if (row.color !== null && row.color !== undefined) project.color = row.color;
  if (row.status !== null && row.status !== undefined) project.status = row.status as ProjectStatus;
  if (row.canopyConfigPresent !== null && row.canopyConfigPresent !== undefined)
    project.canopyConfigPresent = row.canopyConfigPresent;
  if (row.inRepoSettings !== null && row.inRepoSettings !== undefined)
    project.inRepoSettings = row.inRepoSettings;
  if (row.pinned) project.pinned = true;
  project.frecencyScore =
    typeof row.frecencyScore === "number" ? row.frecencyScore : FRECENCY_COLD_START;
  project.lastAccessedAt = typeof row.lastAccessedAt === "number" ? row.lastAccessedAt : 0;
  return project;
}

export class ProjectStore {
  private projectsConfigDir: string;
  private settingsManager: ProjectSettingsManager;
  private stateManager: ProjectStateManager;
  private fileStore: ProjectFileStore;
  private globalFileStore: GlobalFileStore;
  private identityFiles: ProjectIdentityFiles;

  constructor() {
    this.projectsConfigDir = path.join(app.getPath("userData"), "projects");
    const globalConfigDir = path.join(app.getPath("userData"), "global");
    this.settingsManager = new ProjectSettingsManager(this.projectsConfigDir, store);
    this.stateManager = new ProjectStateManager(this.projectsConfigDir);
    this.fileStore = new ProjectFileStore(this.projectsConfigDir);
    this.globalFileStore = new GlobalFileStore(globalConfigDir);
    this.identityFiles = new ProjectIdentityFiles();
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.projectsConfigDir)) {
      await fs.mkdir(this.projectsConfigDir, { recursive: true });
    }
    void cleanupQuarantinedProjectFiles(this.projectsConfigDir).catch((err) =>
      logError("[ProjectStore] Quarantine cleanup failed", err)
    );
  }

  // --- In-Repo Identity ---

  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ name?: string; emoji?: string; color?: string; found: boolean }> {
    return this.identityFiles.readInRepoProjectIdentity(projectPath);
  }

  async writeInRepoProjectIdentity(
    projectPath: string,
    data: { name?: string; emoji?: string; color?: string }
  ): Promise<void> {
    return this.identityFiles.writeInRepoProjectIdentity(projectPath, data);
  }

  async writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    return this.identityFiles.writeInRepoSettings(projectPath, settings);
  }

  async writeInRepoRecipe(projectPath: string, recipe: TerminalRecipe): Promise<void> {
    return this.identityFiles.writeInRepoRecipe(projectPath, recipe);
  }

  async readInRepoRecipes(projectPath: string): Promise<TerminalRecipe[]> {
    return this.identityFiles.readInRepoRecipes(projectPath);
  }

  async deleteInRepoRecipe(projectPath: string, recipeName: string): Promise<void> {
    return this.identityFiles.deleteInRepoRecipe(projectPath, recipeName);
  }

  // --- DB CRUD ---

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
      const now = Date.now();
      const newScore = computeFrecencyScore(
        existing.frecencyScore ?? FRECENCY_COLD_START,
        existing.lastAccessedAt ?? 0,
        now
      );
      return this.updateProject(existing.id, {
        lastOpened: now,
        frecencyScore: newScore,
        lastAccessedAt: now,
      });
    }

    const inRepo = await this.readInRepoProjectIdentity(normalizedPath);

    const now = Date.now();
    const project: Project = {
      id: generateProjectId(normalizedPath),
      path: normalizedPath,
      name: inRepo.name ?? path.basename(normalizedPath),
      emoji: inRepo.emoji ?? DEFAULT_PROJECT_EMOJI,
      lastOpened: now,
      status: "closed",
      frecencyScore: FRECENCY_COLD_START,
      lastAccessedAt: now,
      ...(inRepo.color ? { color: inRepo.color } : {}),
      ...(inRepo.found ? { canopyConfigPresent: true } : {}),
    };

    const db = getSharedDb();
    db.insert(projectsTable)
      .values({
        id: project.id,
        path: project.path,
        name: project.name,
        emoji: project.emoji,
        lastOpened: project.lastOpened,
        color: project.color ?? null,
        status: project.status ?? null,
        canopyConfigPresent: project.canopyConfigPresent ?? null,
        inRepoSettings: project.inRepoSettings ?? null,
        frecencyScore: FRECENCY_COLD_START,
        lastAccessedAt: now,
      })
      .run();

    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const db = getSharedDb();
    db.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();

    try {
      this.settingsManager.deleteAllEnvForProject(projectId);
    } catch (error) {
      logError(`Failed to remove secure env vars for ${projectId}`, error);
    }

    if (existsSync(stateDir)) {
      try {
        await fs.rm(stateDir, { recursive: true, force: true });
      } catch (error) {
        logError(`Failed to remove state directory for ${projectId}`, error);
      }
    }
    this.stateManager.invalidateProjectStateCache(projectId);

    if (this.getCurrentProjectId() === projectId) {
      this.clearCurrentProject();
    }
  }

  updateProject(projectId: string, updates: Partial<Project>): Project {
    const db = getSharedDb();

    const set: Partial<{
      name: string;
      path: string;
      emoji: string;
      color: string | null;
      lastOpened: number;
      status: string | null;
      canopyConfigPresent: boolean | null;
      inRepoSettings: boolean | null;
      pinned: number;
      frecencyScore: number;
      lastAccessedAt: number;
    }> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.path !== undefined) set.path = updates.path;
    if (updates.emoji !== undefined) set.emoji = updates.emoji;
    if ("color" in updates) set.color = updates.color ?? null;
    if (updates.lastOpened !== undefined) set.lastOpened = updates.lastOpened;
    if (updates.status !== undefined) set.status = updates.status ?? null;
    if (updates.canopyConfigPresent !== undefined)
      set.canopyConfigPresent = updates.canopyConfigPresent ?? null;
    if (updates.inRepoSettings !== undefined) set.inRepoSettings = updates.inRepoSettings ?? null;
    if (updates.pinned !== undefined) set.pinned = updates.pinned ? 1 : 0;
    if (updates.frecencyScore !== undefined) set.frecencyScore = updates.frecencyScore;
    if (updates.lastAccessedAt !== undefined) set.lastAccessedAt = updates.lastAccessedAt;

    if (Object.keys(set).length > 0) {
      db.update(projectsTable).set(set).where(eq(projectsTable.id, projectId)).run();
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return rowToProject(row);
  }

  updateProjectStatus(projectId: string, status: ProjectStatus): Project {
    return this.updateProject(projectId, { status });
  }

  getAllProjects(): Project[] {
    const db = getSharedDb();
    const rows = db
      .select()
      .from(projectsTable)
      .orderBy(desc(projectsTable.frecencyScore), desc(projectsTable.lastOpened))
      .all();

    const validStatuses: ProjectStatus[] = ["active", "background", "closed", "missing"];
    const currentProjectId = this.getCurrentProjectId();

    for (const row of rows) {
      if (row.id === currentProjectId) {
        if (row.status !== "active") {
          db.update(projectsTable)
            .set({ status: "active" })
            .where(eq(projectsTable.id, row.id))
            .run();
          row.status = "active";
        }
      } else {
        if (row.status === "active") {
          console.warn(
            `[ProjectStore] Demoting incorrectly active project ${row.id} to background`
          );
          db.update(projectsTable)
            .set({ status: "background" })
            .where(eq(projectsTable.id, row.id))
            .run();
          row.status = "background";
        } else if (row.status !== null && !validStatuses.includes(row.status as ProjectStatus)) {
          db.update(projectsTable)
            .set({ status: "closed" })
            .where(eq(projectsTable.id, row.id))
            .run();
          row.status = "closed";
        }
      }
    }

    if (process.env.DAINTREE_VERBOSE) {
      console.log(
        "[ProjectStore] getAllProjects statuses:",
        rows.map((r) => ({ name: r.name, status: r.status }))
      );
    }

    return rows.map(rowToProject);
  }

  async getProjectByPath(projectPath: string): Promise<Project | null> {
    const normalizedPath = path.normalize(projectPath);
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.path, normalizedPath)).get();
    return row ? rowToProject(row) : null;
  }

  getProjectById(projectId: string): Project | null {
    const db = getSharedDb();
    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    return row ? rowToProject(row) : null;
  }

  async checkMissingProjects(): Promise<string[]> {
    const projects = this.getAllProjects();
    const currentProjectId = this.getCurrentProjectId();
    const missingIds: string[] = [];

    await Promise.allSettled(
      projects.map(async (project) => {
        if (project.id === currentProjectId) return;

        let exists = false;
        try {
          await fs.access(project.path);
          exists = true;
        } catch {
          exists = false;
        }

        if (!exists && project.status !== "missing") {
          this.updateProjectStatus(project.id, "missing");
          missingIds.push(project.id);
        } else if (exists && project.status === "missing") {
          this.updateProjectStatus(project.id, "closed");
        }
      })
    );

    return missingIds;
  }

  async relocateProject(projectId: string, newPath: string): Promise<Project> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (projectId === this.getCurrentProjectId()) {
      throw new Error("Cannot relocate the currently active project");
    }

    const canonicalNewPath = await this.getGitRoot(newPath);
    const newProjectId = generateProjectId(canonicalNewPath);

    if (newProjectId === projectId) {
      return this.updateProject(projectId, { path: canonicalNewPath, status: "closed" });
    }

    const existingAtNewPath = this.getProjectById(newProjectId);
    if (existingAtNewPath) {
      throw new Error(`A project already exists at that location: ${existingAtNewPath.name}`);
    }

    const oldStateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    const newStateDir = getProjectStateDir(this.projectsConfigDir, newProjectId);

    if (oldStateDir && newStateDir && existsSync(oldStateDir)) {
      await fs.cp(oldStateDir, newStateDir, { recursive: true });
    }

    const projects = this.getAllProjects();
    const index = projects.findIndex((p) => p.id === projectId);
    if (index === -1) {
      if (newStateDir && existsSync(newStateDir)) {
        await fs.rm(newStateDir, { recursive: true, force: true }).catch(() => {});
      }
      throw new Error(`Project not found: ${projectId}`);
    }

    const oldProject = projects[index];
    const updatedProject: Project = {
      ...oldProject,
      id: newProjectId,
      path: canonicalNewPath,
      status: "closed",
    };

    const db = getSharedDb();
    try {
      db.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();
      db.insert(projectsTable)
        .values({
          id: updatedProject.id,
          path: updatedProject.path,
          name: updatedProject.name,
          emoji: updatedProject.emoji,
          lastOpened: updatedProject.lastOpened,
          color: updatedProject.color ?? null,
          status: updatedProject.status ?? null,
          canopyConfigPresent: updatedProject.canopyConfigPresent ?? null,
          inRepoSettings: updatedProject.inRepoSettings ?? null,
          pinned: updatedProject.pinned ? 1 : 0,
          frecencyScore: updatedProject.frecencyScore ?? FRECENCY_COLD_START,
          lastAccessedAt: updatedProject.lastAccessedAt ?? 0,
        })
        .run();
      this.settingsManager.migrateEnvForProject(projectId, newProjectId);
      this.stateManager.invalidateProjectStateCache(projectId);
      this.stateManager.invalidateProjectStateCache(newProjectId);
    } catch (error) {
      db.delete(projectsTable).where(eq(projectsTable.id, newProjectId)).run();
      db.insert(projectsTable)
        .values({
          id: oldProject.id,
          path: oldProject.path,
          name: oldProject.name,
          emoji: oldProject.emoji,
          lastOpened: oldProject.lastOpened,
          color: oldProject.color ?? null,
          status: oldProject.status ?? null,
          canopyConfigPresent: oldProject.canopyConfigPresent ?? null,
          inRepoSettings: oldProject.inRepoSettings ?? null,
          pinned: oldProject.pinned ? 1 : 0,
          frecencyScore: oldProject.frecencyScore ?? FRECENCY_COLD_START,
          lastAccessedAt: oldProject.lastAccessedAt ?? 0,
        })
        .run();
      if (newStateDir && existsSync(newStateDir)) {
        await fs.rm(newStateDir, { recursive: true, force: true }).catch(() => {});
      }
      throw error;
    }

    if (oldStateDir && existsSync(oldStateDir)) {
      await fs.rm(oldStateDir, { recursive: true, force: true }).catch((err) => {
        logError(`Failed to clean up old state dir for project ${projectId}`, err);
      });
    }

    return updatedProject;
  }

  // --- Current Project ---

  getCurrentProjectId(): string | null {
    const db = getSharedDb();
    const row = db
      .select()
      .from(appStateTable)
      .where(eq(appStateTable.key, "currentProjectId"))
      .get();
    return row?.value ?? null;
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

    const previousProjectId = this.getCurrentProjectId();
    const db = getSharedDb();

    const now = Date.now();
    const newScore = computeFrecencyScore(
      project.frecencyScore ?? FRECENCY_COLD_START,
      project.lastAccessedAt ?? 0,
      now
    );

    db.transaction((tx) => {
      if (previousProjectId && previousProjectId !== projectId) {
        console.log(`[ProjectStore] Marking previous project ${previousProjectId} as background`);
        tx.update(projectsTable)
          .set({ status: "background" })
          .where(eq(projectsTable.id, previousProjectId))
          .run();
      }
      tx.insert(appStateTable)
        .values({ key: "currentProjectId", value: projectId })
        .onConflictDoUpdate({ target: appStateTable.key, set: { value: projectId } })
        .run();
      tx.update(projectsTable)
        .set({
          lastOpened: now,
          status: "active",
          frecencyScore: newScore,
          lastAccessedAt: now,
        })
        .where(eq(projectsTable.id, projectId))
        .run();
    });

    if (process.env.DAINTREE_VERBOSE) {
      const updatedPrevious = previousProjectId ? this.getProjectById(previousProjectId) : null;
      console.log(`[ProjectStore] setCurrentProject complete:`, {
        newCurrentId: projectId,
        previousId: previousProjectId,
        previousStatus: updatedPrevious?.status,
        allStatuses: this.getAllProjects().map((p) => ({ name: p.name, status: p.status })),
      });
    }
  }

  clearCurrentProject(): void {
    const db = getSharedDb();
    db.delete(appStateTable).where(eq(appStateTable.key, "currentProjectId")).run();
  }

  // --- State ---

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    return this.stateManager.saveProjectState(projectId, state);
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    return this.stateManager.getProjectState(projectId);
  }

  async clearProjectState(projectId: string): Promise<void> {
    return this.stateManager.clearProjectState(projectId);
  }

  // --- Settings ---

  async getProjectSettings(projectId: string): Promise<ProjectSettings> {
    return this.settingsManager.getProjectSettings(projectId);
  }

  async saveProjectSettings(projectId: string, settings: ProjectSettings): Promise<void> {
    return this.settingsManager.saveProjectSettings(projectId, settings);
  }

  getEffectiveNotificationSettings(): NotificationSettings {
    return this.settingsManager.getEffectiveNotificationSettings(this.getCurrentProjectId());
  }

  // --- Recipes ---

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    return this.fileStore.getRecipes(projectId);
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    return this.fileStore.saveRecipes(projectId, recipes);
  }

  async addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void> {
    return this.fileStore.addRecipe(projectId, recipe);
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    return this.fileStore.updateRecipe(projectId, recipeId, updates);
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    return this.fileStore.deleteRecipe(projectId, recipeId);
  }

  // --- Global Recipes ---

  async getGlobalRecipes(): Promise<TerminalRecipe[]> {
    return this.globalFileStore.getRecipes();
  }

  async addGlobalRecipe(recipe: TerminalRecipe): Promise<void> {
    return this.globalFileStore.addRecipe(recipe);
  }

  async updateGlobalRecipe(
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    return this.globalFileStore.updateRecipe(recipeId, updates);
  }

  async deleteGlobalRecipe(recipeId: string): Promise<void> {
    return this.globalFileStore.deleteRecipe(recipeId);
  }
}

export const projectStore = new ProjectStore();
