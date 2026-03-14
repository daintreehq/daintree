import type {
  Project,
  ProjectState,
  ProjectSettings,
  ProjectTerminalSettings,
  ProjectStatus,
  TerminalRecipe,
  WorkflowDefinition,
} from "../types/index.js";
import { workflowLoader } from "./WorkflowLoader.js";
import { createHash } from "crypto";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { app } from "electron";
import { GitService } from "./GitService.js";
import { isCanopyError } from "../utils/errorTypes.js";
import { resilientRename, resilientWriteFile, resilientUnlink } from "../utils/fs.js";
import { sanitizeSvg } from "../../shared/utils/svgSanitizer.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { logError } from "../utils/logger.js";
import { projectEnvSecureStorage } from "./ProjectEnvSecureStorage.js";
import { isSensitiveEnvKey } from "../../shared/utils/envVars.js";
import { normalizeScrollbackLines } from "../../shared/config/scrollback.js";
import { getSharedDb } from "./persistence/db.js";
import {
  projects as projectsTable,
  appState as appStateTable,
  type ProjectRow,
} from "./persistence/schema.js";
import { eq, desc } from "drizzle-orm";

const SETTINGS_FILENAME = "settings.json";
const RECIPES_FILENAME = "recipes.json";
const WORKFLOWS_FILENAME = "workflows.json";
const PROJECT_STATE_CACHE_TTL_MS = 60_000;
const CANOPY_PROJECT_JSON = ".canopy/project.json";
const CANOPY_SETTINGS_JSON = ".canopy/settings.json";
const MAX_PROJECT_NAME_LENGTH = 100;
export const DEFAULT_PROJECT_EMOJI = "🌲";
// UTF-8 BOM that editors may prepend to JSON files
const UTF8_BOM = "\uFEFF";

interface ProjectStateCacheEntry {
  expiresAt: number;
  value: ProjectState | null;
}

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
  return project;
}

export class ProjectStore {
  private projectsConfigDir: string;
  private projectStateCache = new Map<string, ProjectStateCacheEntry>();

  constructor() {
    this.projectsConfigDir = path.join(app.getPath("userData"), "projects");
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.projectsConfigDir)) {
      await fs.mkdir(this.projectsConfigDir, { recursive: true });
    }
  }

  /**
   * Read portable project identity from .canopy/project.json in the repository root.
   *
   * Expected schema:
   * {
   *   "version": 1,
   *   "name": "My Project",    // optional, string, max 100 chars
   *   "emoji": "🚀",           // optional, string
   *   "color": "#ff6600"       // optional, string
   * }
   *
   * Returns an empty object if the file is absent, unreadable, or malformed.
   */
  async readInRepoProjectIdentity(
    projectPath: string
  ): Promise<{ name?: string; emoji?: string; color?: string; found: boolean }> {
    const filePath = path.join(projectPath, CANOPY_PROJECT_JSON);
    try {
      let content = await fs.readFile(filePath, "utf-8");
      if (content.startsWith(UTF8_BOM)) {
        content = content.slice(1);
      }
      const parsed = JSON.parse(content);

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { found: false };
      }

      if (!Number.isFinite(parsed.version) || !Number.isInteger(parsed.version)) {
        return { found: false };
      }

      const result: { name?: string; emoji?: string; color?: string; found: boolean } = {
        found: true,
      };

      if (typeof parsed.name === "string" && parsed.name.trim().length > 0) {
        result.name = parsed.name.trim().slice(0, MAX_PROJECT_NAME_LENGTH);
      }

      if (typeof parsed.emoji === "string" && parsed.emoji.trim().length > 0) {
        result.emoji = parsed.emoji.trim();
      }

      if (typeof parsed.color === "string" && parsed.color.trim().length > 0) {
        result.color = parsed.color.trim();
      }

      return result;
    } catch {
      return { found: false };
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

    const inRepo = await this.readInRepoProjectIdentity(normalizedPath);

    const project: Project = {
      id: this.generateProjectId(normalizedPath),
      path: normalizedPath,
      name: inRepo.name ?? path.basename(normalizedPath),
      emoji: inRepo.emoji ?? DEFAULT_PROJECT_EMOJI,
      lastOpened: Date.now(),
      status: "closed",
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
      })
      .run();

    return project;
  }

  async removeProject(projectId: string): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const db = getSharedDb();
    db.delete(projectsTable).where(eq(projectsTable.id, projectId)).run();

    // Clean up secure environment variables for this project
    try {
      projectEnvSecureStorage.deleteAllForProject(projectId);
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
    this.invalidateProjectStateCache(projectId);

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
    }> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.path !== undefined) set.path = updates.path;
    if (updates.emoji !== undefined) set.emoji = updates.emoji;
    if (updates.color !== undefined) set.color = updates.color ?? null;
    if (updates.lastOpened !== undefined) set.lastOpened = updates.lastOpened;
    if (updates.status !== undefined) set.status = updates.status ?? null;
    if (updates.canopyConfigPresent !== undefined)
      set.canopyConfigPresent = updates.canopyConfigPresent ?? null;
    if (updates.inRepoSettings !== undefined) set.inRepoSettings = updates.inRepoSettings ?? null;
    if (updates.pinned !== undefined) set.pinned = updates.pinned ? 1 : 0;

    if (Object.keys(set).length > 0) {
      db.update(projectsTable).set(set).where(eq(projectsTable.id, projectId)).run();
    }

    const row = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
    if (!row) throw new Error(`Project not found: ${projectId}`);
    return rowToProject(row);
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
    const db = getSharedDb();
    const rows = db.select().from(projectsTable).orderBy(desc(projectsTable.lastOpened)).all();

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

    if (process.env.CANOPY_VERBOSE) {
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

  /**
   * Checks which projects have directories that no longer exist at their stored path.
   * Updates each missing project's status to "missing" in the store and returns their IDs.
   * Projects whose directories exist are reset from "missing" back to "closed".
   */
  async checkMissingProjects(): Promise<string[]> {
    const projects = this.getAllProjects();
    const currentProjectId = this.getCurrentProjectId();
    const missingIds: string[] = [];

    await Promise.allSettled(
      projects.map(async (project) => {
        // Never mark the active project as missing — it's currently in use
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
          // Directory was restored — reset to closed
          this.updateProjectStatus(project.id, "closed");
        }
      })
    );

    return missingIds;
  }

  /**
   * Relocate a project to a new path, migrating all associated state.
   *
   * Resolves the canonical git root of newPath, computes the new project ID,
   * copies the state directory to the new location, migrates env var keys,
   * updates the project record (including ID if it changed), then cleans up
   * the old state directory.
   *
   * If the resolved path hashes to the same project ID, only the path and
   * status are updated (no directory migration needed).
   */
  async relocateProject(projectId: string, newPath: string): Promise<Project> {
    const project = this.getProjectById(projectId);
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    if (projectId === this.getCurrentProjectId()) {
      throw new Error("Cannot relocate the currently active project");
    }

    const canonicalNewPath = await this.getGitRoot(newPath);
    const newProjectId = this.generateProjectId(canonicalNewPath);

    if (newProjectId === projectId) {
      return this.updateProject(projectId, { path: canonicalNewPath, status: "closed" });
    }

    const existingAtNewPath = this.getProjectById(newProjectId);
    if (existingAtNewPath) {
      throw new Error(`A project already exists at that location: ${existingAtNewPath.name}`);
    }

    const oldStateDir = this.getProjectStateDir(projectId);
    const newStateDir = this.getProjectStateDir(newProjectId);

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
        })
        .run();
      projectEnvSecureStorage.migrateAllForProject(projectId, newProjectId);
      this.invalidateProjectStateCache(projectId);
      this.invalidateProjectStateCache(newProjectId);
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

    // Atomic: demote previous project, update currentProjectId, activate new project
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
        .set({ lastOpened: Date.now(), status: "active" })
        .where(eq(projectsTable.id, projectId))
        .run();
    });

    if (process.env.CANOPY_VERBOSE) {
      const updatedPrevious = previousProjectId ? this.getProjectById(previousProjectId) : null;
      console.log(`[ProjectStore] setCurrentProject complete:`, {
        newCurrentId: projectId,
        previousId: previousProjectId,
        previousStatus: updatedPrevious?.status,
        allStatuses: this.getAllProjects().map((p) => ({ name: p.name, status: p.status })),
      });
    }
  }

  /**
   * Clear the current project reference (used when closing the active project).
   */
  clearCurrentProject(): void {
    const db = getSharedDb();
    db.delete(appStateTable).where(eq(appStateTable.key, "currentProjectId")).run();
  }

  private getStateFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      return null;
    }
    return path.join(stateDir, "state.json");
  }

  private cloneProjectState(state: ProjectState | null): ProjectState | null {
    if (!state) {
      return null;
    }

    return JSON.parse(JSON.stringify(state)) as ProjectState;
  }

  private getCachedProjectState(projectId: string): ProjectState | null | undefined {
    const cached = this.projectStateCache.get(projectId);
    if (!cached) {
      return undefined;
    }

    if (cached.expiresAt <= Date.now()) {
      this.projectStateCache.delete(projectId);
      return undefined;
    }

    return this.cloneProjectState(cached.value);
  }

  private setProjectStateCache(projectId: string, state: ProjectState | null): void {
    this.projectStateCache.set(projectId, {
      expiresAt: Date.now() + PROJECT_STATE_CACHE_TTL_MS,
      value: this.cloneProjectState(state),
    });
  }

  private invalidateProjectStateCache(projectId?: string): void {
    if (projectId) {
      this.projectStateCache.delete(projectId);
      return;
    }
    this.projectStateCache.clear();
  }

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const stateFilePath = this.getStateFilePath(projectId);
    if (!stateFilePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Validate and filter terminal snapshots before persisting
    const validatedState: ProjectState = {
      ...state,
      terminals: filterValidTerminalEntries(
        state.terminals,
        TerminalSnapshotSchema,
        `ProjectStore.saveProjectState(${projectId})`
      ),
    };

    // Use unique temp file to avoid races between concurrent saves
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${stateFilePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(validatedState, null, 2), "utf-8");
      await resilientRename(tempFilePath, stateFilePath);
    };

    try {
      // First attempt: assume directory exists
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        // Not a missing directory error, rethrow
        console.error(`[ProjectStore] Failed to save state for project ${projectId}:`, error);
        this.cleanupTempFile(tempFilePath);
        throw error;
      }

      // Directory might not exist or was deleted, retry with mkdir
      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectStore] Failed to save state for project ${projectId}:`, retryError);
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }

    this.setProjectStateCache(projectId, validatedState);
  }

  private cleanupTempFile(tempFilePath: string): void {
    fs.unlink(tempFilePath).catch(() => {
      // Ignore cleanup errors
    });
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const cachedState = this.getCachedProjectState(projectId);
    if (cachedState !== undefined) {
      return cachedState;
    }

    const stateFilePath = this.getStateFilePath(projectId);
    if (!stateFilePath || !existsSync(stateFilePath)) {
      this.setProjectStateCache(projectId, null);
      return null;
    }

    try {
      const content = await fs.readFile(stateFilePath, "utf-8");
      const parsed = JSON.parse(content);

      // Validate and filter terminal snapshots during deserialization
      const rawTerminals = Array.isArray(parsed.terminals) ? parsed.terminals : [];
      const validTerminals = filterValidTerminalEntries(
        rawTerminals,
        TerminalSnapshotSchema,
        `ProjectStore.getProjectState(${projectId})`
      );

      const state: ProjectState = {
        projectId: parsed.projectId || projectId,
        activeWorktreeId: parsed.activeWorktreeId,
        sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : 350,
        terminals: validTerminals,
        terminalLayout: parsed.terminalLayout || undefined,
        focusMode: typeof parsed.focusMode === "boolean" ? parsed.focusMode : undefined,
        focusPanelState:
          parsed.focusPanelState &&
          typeof parsed.focusPanelState === "object" &&
          typeof parsed.focusPanelState.sidebarWidth === "number"
            ? {
                sidebarWidth: parsed.focusPanelState.sidebarWidth,
                diagnosticsOpen: Boolean(parsed.focusPanelState.diagnosticsOpen),
              }
            : undefined,
      };

      this.setProjectStateCache(projectId, state);
      return this.cloneProjectState(state);
    } catch (error) {
      console.error(`[ProjectStore] Failed to load state for project ${projectId}:`, error);
      try {
        const quarantinePath = `${stateFilePath}.corrupted`;
        await resilientRename(stateFilePath, quarantinePath);
        console.warn(`[ProjectStore] Corrupted state file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      this.setProjectStateCache(projectId, null);
      return null;
    }
  }

  private getSettingsFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) return null;
    return path.join(stateDir, SETTINGS_FILENAME);
  }

  private parseTerminalSettings(raw: unknown): ProjectTerminalSettings | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const obj = raw as Record<string, unknown>;
    const result: ProjectTerminalSettings = {};

    if (typeof obj.shell === "string" && obj.shell.trim() && path.isAbsolute(obj.shell.trim())) {
      result.shell = obj.shell.trim();
    }
    if (Array.isArray(obj.shellArgs)) {
      const args = obj.shellArgs.filter((a): a is string => typeof a === "string");
      if (args.length > 0) result.shellArgs = args;
    }
    if (
      typeof obj.defaultWorkingDirectory === "string" &&
      obj.defaultWorkingDirectory.trim() &&
      path.isAbsolute(obj.defaultWorkingDirectory.trim())
    ) {
      result.defaultWorkingDirectory = obj.defaultWorkingDirectory.trim();
    }
    if (typeof obj.scrollbackLines === "number" || typeof obj.scrollbackLines === "string") {
      result.scrollbackLines = normalizeScrollbackLines(obj.scrollbackLines);
    }

    return Object.keys(result).length > 0 ? result : undefined;
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

      // Sanitize commandOverrides
      let sanitizedCommandOverrides: typeof parsed.commandOverrides = undefined;
      if (Array.isArray(parsed.commandOverrides)) {
        sanitizedCommandOverrides = parsed.commandOverrides
          .filter((override: unknown) => {
            if (!override || typeof override !== "object") return false;
            const o = override as Record<string, unknown>;
            if (typeof o.commandId !== "string") return false;
            // Reject null defaults explicitly (typeof null === "object")
            if (
              o.defaults !== undefined &&
              (o.defaults === null || typeof o.defaults !== "object" || Array.isArray(o.defaults))
            )
              return false;
            if (o.disabled !== undefined && typeof o.disabled !== "boolean") return false;
            // Validate prompt field if present - reject empty/whitespace-only strings
            if (o.prompt !== undefined && (typeof o.prompt !== "string" || o.prompt.trim() === ""))
              return false;
            return true;
          })
          .map((override: unknown) => {
            const o = override as Record<string, unknown>;
            return {
              commandId: o.commandId as string,
              defaults: o.defaults as Record<string, unknown> | undefined,
              disabled: o.disabled as boolean | undefined,
              prompt: o.prompt as string | undefined,
            };
          });
      }

      const secureEnvVarKeys = Array.isArray(parsed.secureEnvironmentVariables)
        ? parsed.secureEnvironmentVariables.filter((k: unknown) => typeof k === "string")
        : [];

      // Resolve secure environment variables from secure storage
      const resolvedEnvVars: Record<string, string> = {};
      const insecureKeys: string[] = [];
      const unresolvedKeys: string[] = [];

      // First, add non-sensitive env vars from settings.json
      if (parsed.environmentVariables && typeof parsed.environmentVariables === "object") {
        for (const [key, value] of Object.entries(parsed.environmentVariables)) {
          if (typeof key === "string" && typeof value === "string") {
            if (isSensitiveEnvKey(key)) {
              // This is a plaintext sensitive value that should be migrated
              insecureKeys.push(key);
              resolvedEnvVars[key] = value;
            } else {
              // Non-sensitive value, use as-is
              resolvedEnvVars[key] = value;
            }
          }
        }
      }

      // Then, resolve secure values from secure storage
      for (const key of secureEnvVarKeys) {
        const secureValue = projectEnvSecureStorage.get(projectId, key);
        if (secureValue !== undefined) {
          resolvedEnvVars[key] = secureValue;
        } else {
          // Key exists in metadata but couldn't be decrypted
          unresolvedKeys.push(key);
        }
      }

      const settings: ProjectSettings = {
        runCommands: Array.isArray(parsed.runCommands) ? parsed.runCommands : [],
        environmentVariables: resolvedEnvVars,
        secureEnvironmentVariables: secureEnvVarKeys,
        insecureEnvironmentVariables: insecureKeys.length > 0 ? insecureKeys : undefined,
        unresolvedSecureEnvironmentVariables:
          unresolvedKeys.length > 0 ? unresolvedKeys : undefined,
        excludedPaths: parsed.excludedPaths,
        projectIconSvg: sanitizedIconSvg,
        defaultWorktreeRecipeId:
          typeof parsed.defaultWorktreeRecipeId === "string"
            ? parsed.defaultWorktreeRecipeId
            : undefined,
        devServerCommand:
          typeof parsed.devServerCommand === "string" ? parsed.devServerCommand : undefined,
        devServerDismissed:
          typeof parsed.devServerDismissed === "boolean" ? parsed.devServerDismissed : undefined,
        devServerAutoDetected:
          typeof parsed.devServerAutoDetected === "boolean"
            ? parsed.devServerAutoDetected
            : undefined,
        devServerLoadTimeout:
          typeof parsed.devServerLoadTimeout === "number" &&
          Number.isFinite(parsed.devServerLoadTimeout) &&
          parsed.devServerLoadTimeout >= 1 &&
          parsed.devServerLoadTimeout <= 120
            ? parsed.devServerLoadTimeout
            : undefined,
        copyTreeSettings:
          parsed.copyTreeSettings && typeof parsed.copyTreeSettings === "object"
            ? parsed.copyTreeSettings
            : undefined,
        commandOverrides:
          sanitizedCommandOverrides && sanitizedCommandOverrides.length > 0
            ? sanitizedCommandOverrides
            : undefined,
        preferredEditor:
          parsed.preferredEditor &&
          typeof parsed.preferredEditor === "object" &&
          typeof (parsed.preferredEditor as Record<string, unknown>).id === "string"
            ? (parsed.preferredEditor as import("../../shared/types/editor.js").EditorConfig)
            : undefined,
        branchPrefixMode:
          parsed.branchPrefixMode === "none" ||
          parsed.branchPrefixMode === "username" ||
          parsed.branchPrefixMode === "custom"
            ? parsed.branchPrefixMode
            : undefined,
        branchPrefixCustom:
          typeof parsed.branchPrefixCustom === "string" ? parsed.branchPrefixCustom : undefined,
        agentInstructions:
          typeof parsed.agentInstructions === "string" && parsed.agentInstructions.trim()
            ? parsed.agentInstructions
            : undefined,
        worktreePathPattern:
          typeof parsed.worktreePathPattern === "string" && parsed.worktreePathPattern.trim()
            ? parsed.worktreePathPattern.trim()
            : undefined,
        terminalSettings: this.parseTerminalSettings(parsed.terminalSettings),
      };

      return settings;
    } catch (error) {
      console.error(`[ProjectStore] Failed to load settings for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
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

    const filePath = this.getSettingsFilePath(projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Split environment variables into sensitive and non-sensitive
    const nonSensitiveEnvVars: Record<string, string> = {};
    const secureEnvVarKeys: string[] = [];
    const existingSecureKeys = projectEnvSecureStorage.listKeys(projectId);

    if (settings.environmentVariables) {
      for (const [key, value] of Object.entries(settings.environmentVariables)) {
        if (isSensitiveEnvKey(key)) {
          try {
            projectEnvSecureStorage.set(projectId, key, value);
            secureEnvVarKeys.push(key);
          } catch (error) {
            console.error(
              `[ProjectStore] Failed to store secure env var ${key} for project ${projectId}:`,
              error
            );
            throw error;
          }
        } else {
          // Store non-sensitive value in settings.json
          nonSensitiveEnvVars[key] = value;
        }
      }
    }

    // Preserve unresolved secure keys (couldn't decrypt) to avoid data loss
    const unresolvedKeys = settings.unresolvedSecureEnvironmentVariables || [];
    for (const unresolvedKey of unresolvedKeys) {
      if (!secureEnvVarKeys.includes(unresolvedKey)) {
        secureEnvVarKeys.push(unresolvedKey);
      }
    }

    // Delete orphaned secure keys (were resolved at load but user removed them)
    for (const existingKey of existingSecureKeys) {
      if (!secureEnvVarKeys.includes(existingKey)) {
        projectEnvSecureStorage.delete(projectId, existingKey);
      }
    }

    // Sanitize projectIconSvg and commandOverrides before saving
    let sanitizedSettings = {
      ...settings,
      environmentVariables: nonSensitiveEnvVars,
      secureEnvironmentVariables: secureEnvVarKeys.length > 0 ? secureEnvVarKeys : undefined,
      // Don't persist transient migration metadata
      insecureEnvironmentVariables: undefined,
      unresolvedSecureEnvironmentVariables: undefined,
      // Validate boolean fields
      devServerDismissed:
        typeof settings.devServerDismissed === "boolean" ? settings.devServerDismissed : undefined,
      devServerAutoDetected:
        typeof settings.devServerAutoDetected === "boolean"
          ? settings.devServerAutoDetected
          : undefined,
      devServerLoadTimeout:
        typeof settings.devServerLoadTimeout === "number" &&
        Number.isFinite(settings.devServerLoadTimeout) &&
        settings.devServerLoadTimeout >= 1 &&
        settings.devServerLoadTimeout <= 120
          ? settings.devServerLoadTimeout
          : undefined,
      terminalSettings: this.parseTerminalSettings(settings.terminalSettings),
    };

    // Sanitize SVG
    if (settings.projectIconSvg) {
      const sanitizeResult = sanitizeSvg(settings.projectIconSvg);
      if (sanitizeResult.ok) {
        sanitizedSettings = { ...sanitizedSettings, projectIconSvg: sanitizeResult.svg };
        if (sanitizeResult.modified) {
          console.warn(
            `[ProjectStore] Sanitized potentially unsafe SVG content before saving for project ${projectId}`
          );
        }
      } else {
        console.warn(
          `[ProjectStore] Rejecting invalid SVG for project ${projectId}: ${sanitizeResult.error}`
        );
        sanitizedSettings = { ...sanitizedSettings, projectIconSvg: undefined };
      }
    }

    // Sanitize commandOverrides
    if (settings.commandOverrides !== undefined) {
      if (!Array.isArray(settings.commandOverrides)) {
        console.warn(
          `[ProjectStore] Coercing non-array commandOverrides to undefined in project ${projectId}`
        );
        sanitizedSettings = {
          ...sanitizedSettings,
          commandOverrides: undefined,
        };
      } else {
        const validOverrides = settings.commandOverrides.filter((override) => {
          if (!override || typeof override !== "object") return false;
          if (typeof override.commandId !== "string") return false;
          // Reject null defaults explicitly
          if (
            override.defaults !== undefined &&
            (override.defaults === null ||
              typeof override.defaults !== "object" ||
              Array.isArray(override.defaults))
          ) {
            console.warn(
              `[ProjectStore] Dropping invalid commandOverride for ${override.commandId} in project ${projectId}`
            );
            return false;
          }
          if (override.disabled !== undefined && typeof override.disabled !== "boolean")
            return false;
          // Validate prompt field if present - reject empty/whitespace-only strings
          if (
            override.prompt !== undefined &&
            (typeof override.prompt !== "string" || override.prompt.trim() === "")
          ) {
            console.warn(
              `[ProjectStore] Dropping invalid/empty prompt in commandOverride for ${override.commandId} in project ${projectId}`
            );
            return false;
          }
          return true;
        });
        sanitizedSettings = {
          ...sanitizedSettings,
          commandOverrides: validOverrides.length > 0 ? validOverrides : undefined,
        };
      }
    }

    // Use unique temp file to avoid races between concurrent saves
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(sanitizedSettings, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectStore] Failed to save settings for ${projectId}:`, error);
        this.cleanupTempFile(tempFilePath);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectStore] Failed to save settings for ${projectId}:`, retryError);
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }
  }

  private getRecipesFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) return null;
    return path.join(stateDir, RECIPES_FILENAME);
  }

  async getRecipes(projectId: string): Promise<TerminalRecipe[]> {
    const filePath = this.getRecipesFilePath(projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn(`[ProjectStore] Invalid recipes format for ${projectId}, expected array`);
        return [];
      }

      return parsed.filter(
        (recipe: unknown): recipe is TerminalRecipe =>
          recipe !== null &&
          typeof recipe === "object" &&
          typeof (recipe as TerminalRecipe).id === "string" &&
          typeof (recipe as TerminalRecipe).name === "string" &&
          Array.isArray((recipe as TerminalRecipe).terminals)
      );
    } catch (error) {
      console.error(`[ProjectStore] Failed to load recipes for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectStore] Corrupted recipes file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveRecipes(projectId: string, recipes: TerminalRecipe[]): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = this.getRecipesFilePath(projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Use unique temp file to avoid races between concurrent saves
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(recipes, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectStore] Failed to save recipes for ${projectId}:`, error);
        this.cleanupTempFile(tempFilePath);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectStore] Failed to save recipes for ${projectId}:`, retryError);
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }
  }

  async addRecipe(projectId: string, recipe: TerminalRecipe): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    recipes.push(recipe);
    await this.saveRecipes(projectId, recipes);
  }

  async updateRecipe(
    projectId: string,
    recipeId: string,
    updates: Partial<Omit<TerminalRecipe, "id" | "projectId" | "createdAt">>
  ): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const index = recipes.findIndex((r) => r.id === recipeId);
    if (index === -1) {
      throw new Error(`Recipe ${recipeId} not found in project ${projectId}`);
    }
    recipes[index] = { ...recipes[index], ...updates };
    await this.saveRecipes(projectId, recipes);
  }

  async deleteRecipe(projectId: string, recipeId: string): Promise<void> {
    const recipes = await this.getRecipes(projectId);
    const filtered = recipes.filter((r) => r.id !== recipeId);
    await this.saveRecipes(projectId, filtered);
  }

  private getWorkflowsFilePath(projectId: string): string | null {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) return null;
    return path.join(stateDir, WORKFLOWS_FILENAME);
  }

  async getWorkflows(projectId: string): Promise<WorkflowDefinition[]> {
    const filePath = this.getWorkflowsFilePath(projectId);
    if (!filePath || !existsSync(filePath)) {
      return [];
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (!Array.isArray(parsed)) {
        console.warn(`[ProjectStore] Invalid workflows format for ${projectId}, expected array`);
        return [];
      }

      // Validate each workflow with full validation (schema + cycles + references)
      return parsed.filter((workflow: unknown): workflow is WorkflowDefinition => {
        const validation = workflowLoader.validate(workflow);
        if (!validation.valid) {
          const workflowId =
            workflow &&
            typeof workflow === "object" &&
            "id" in workflow &&
            typeof (workflow as { id: unknown }).id === "string"
              ? (workflow as { id: string }).id
              : "unknown";
          const errors = validation.errors?.map((e) => e.message).join("; ");
          console.warn(`[ProjectStore] Filtering invalid workflow ${workflowId}: ${errors}`);
          return false;
        }
        return true;
      });
    } catch (error) {
      console.error(`[ProjectStore] Failed to load workflows for ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectStore] Corrupted workflows file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      return [];
    }
  }

  async saveWorkflows(projectId: string, workflows: WorkflowDefinition[]): Promise<void> {
    const stateDir = this.getProjectStateDir(projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = this.getWorkflowsFilePath(projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    // Validate all workflows with full validation (schema + cycles + references)
    for (const workflow of workflows) {
      const validation = workflowLoader.validate(workflow);
      if (!validation.valid) {
        const errors = validation.errors?.map((e) => e.message).join("; ");
        throw new Error(`Invalid workflow ${workflow.id}: ${errors}`);
      }
    }

    // Use unique temp file to avoid races between concurrent saves
    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(workflows, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(`[ProjectStore] Failed to save workflows for ${projectId}:`, error);
        this.cleanupTempFile(tempFilePath);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(`[ProjectStore] Failed to save workflows for ${projectId}:`, retryError);
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }
  }

  async addWorkflow(projectId: string, workflow: WorkflowDefinition): Promise<void> {
    // Validate the workflow with full validation
    const validation = workflowLoader.validate(workflow);
    if (!validation.valid) {
      const errors = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow: ${errors}`);
    }

    const workflows = await this.getWorkflows(projectId);

    // Check for duplicate ID
    if (workflows.some((w) => w.id === workflow.id)) {
      throw new Error(`Workflow with ID ${workflow.id} already exists`);
    }

    workflows.push(workflow);
    await this.saveWorkflows(projectId, workflows);
  }

  async updateWorkflow(
    projectId: string,
    workflowId: string,
    updates: Partial<Omit<WorkflowDefinition, "id">>
  ): Promise<void> {
    const workflows = await this.getWorkflows(projectId);
    const index = workflows.findIndex((w) => w.id === workflowId);
    if (index === -1) {
      throw new Error(`Workflow ${workflowId} not found in project ${projectId}`);
    }

    const updated = { ...workflows[index], ...updates };

    // Validate the updated workflow with full validation
    const validation = workflowLoader.validate(updated);
    if (!validation.valid) {
      const errors = validation.errors?.map((e) => e.message).join("; ");
      throw new Error(`Invalid workflow update: ${errors}`);
    }

    workflows[index] = updated;
    await this.saveWorkflows(projectId, workflows);
  }

  async deleteWorkflow(projectId: string, workflowId: string): Promise<void> {
    const workflows = await this.getWorkflows(projectId);
    const filtered = workflows.filter((w) => w.id !== workflowId);
    await this.saveWorkflows(projectId, filtered);
  }

  async getWorkflow(projectId: string, workflowId: string): Promise<WorkflowDefinition | null> {
    const workflows = await this.getWorkflows(projectId);
    return workflows.find((w) => w.id === workflowId) || null;
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
      this.invalidateProjectStateCache(projectId);
      return;
    }

    if (!existsSync(stateFilePath)) {
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStore] No state file to clear for project ${projectId}`);
      }
      this.invalidateProjectStateCache(projectId);
      return;
    }

    try {
      await resilientUnlink(stateFilePath);
      this.invalidateProjectStateCache(projectId);
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStore] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      console.error(`[ProjectStore] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
  /**
   * Reject writes if .canopy/ is a symlink (could redirect writes outside the repository).
   */
  private async assertCanopyDirNotSymlink(projectPath: string): Promise<void> {
    const canopyDir = path.join(projectPath, ".canopy");
    try {
      const stat = await fs.lstat(canopyDir);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `.canopy/ in ${projectPath} is a symbolic link — refusing to write to prevent path traversal`
        );
      }
    } catch (error) {
      // ENOENT means .canopy/ doesn't exist yet — that's fine, we'll create it
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  /**
   * Atomically write project identity to `.canopy/project.json` in the repository root.
   * Creates the `.canopy/` directory if absent.
   */
  async writeInRepoProjectIdentity(
    projectPath: string,
    data: { name?: string; emoji?: string; color?: string }
  ): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const canopyDir = path.join(projectPath, ".canopy");
    const filePath = path.join(projectPath, CANOPY_PROJECT_JSON);

    const payload: { version: 1; name?: string; emoji?: string; color?: string } = { version: 1 };
    if (data.name !== undefined) payload.name = data.name;
    if (data.emoji !== undefined) payload.emoji = data.emoji;
    if (data.color !== undefined) payload.color = data.color;

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(canopyDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(payload, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectStore] Failed to write .canopy/project.json for ${projectPath}:`,
          error
        );
        this.cleanupTempFile(tempFilePath);
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectStore] Failed to write .canopy/project.json for ${projectPath}:`,
          retryError
        );
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }
  }

  /**
   * Atomically write shareable project settings to `.canopy/settings.json`.
   * Machine-local fields (secrets, dismissed flags, auto-detected values) are omitted.
   * Creates the `.canopy/` directory if absent.
   */
  async writeInRepoSettings(projectPath: string, settings: ProjectSettings): Promise<void> {
    await this.assertCanopyDirNotSymlink(projectPath);
    const canopyDir = path.join(projectPath, ".canopy");
    const filePath = path.join(projectPath, CANOPY_SETTINGS_JSON);

    const payload: {
      version: 1;
      runCommands?: import("../types/index.js").RunCommand[];
      devServerCommand?: string;
      devServerLoadTimeout?: number;
      copyTreeSettings?: import("../types/index.js").CopyTreeSettings;
      excludedPaths?: string[];
      agentInstructions?: string;
      worktreePathPattern?: string;
      terminalSettings?: { shellArgs?: string[]; defaultWorkingDirectory?: string; scrollbackLines?: number };
    } = { version: 1 };

    if (settings.runCommands?.length) payload.runCommands = settings.runCommands;
    if (settings.devServerCommand) payload.devServerCommand = settings.devServerCommand;
    if (settings.devServerLoadTimeout) payload.devServerLoadTimeout = settings.devServerLoadTimeout;
    if (settings.copyTreeSettings) payload.copyTreeSettings = settings.copyTreeSettings;
    if (settings.excludedPaths?.length) payload.excludedPaths = settings.excludedPaths;
    if (settings.agentInstructions?.trim())
      payload.agentInstructions = settings.agentInstructions.trim();
    if (settings.worktreePathPattern) payload.worktreePathPattern = settings.worktreePathPattern;

    if (settings.terminalSettings) {
      const shareableTerminal: { shellArgs?: string[]; defaultWorkingDirectory?: string; scrollbackLines?: number } = {};
      if (settings.terminalSettings.shellArgs?.length) shareableTerminal.shellArgs = settings.terminalSettings.shellArgs;
      if (settings.terminalSettings.defaultWorkingDirectory) shareableTerminal.defaultWorkingDirectory = settings.terminalSettings.defaultWorkingDirectory;
      if (settings.terminalSettings.scrollbackLines !== undefined) shareableTerminal.scrollbackLines = settings.terminalSettings.scrollbackLines;
      if (Object.keys(shareableTerminal).length > 0) payload.terminalSettings = shareableTerminal;
    }

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptWrite = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(canopyDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(payload, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptWrite(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectStore] Failed to write .canopy/settings.json for ${projectPath}:`,
          error
        );
        this.cleanupTempFile(tempFilePath);
        throw error;
      }
      try {
        await attemptWrite(true);
      } catch (retryError) {
        console.error(
          `[ProjectStore] Failed to write .canopy/settings.json for ${projectPath}:`,
          retryError
        );
        this.cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }
  }
}

export const projectStore = new ProjectStore();
