import type { ProjectState } from "../types/index.js";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientRename, resilientWriteFile, resilientUnlink } from "../utils/fs.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { getProjectStateDir, stateFilePath } from "./projectStorePaths.js";

const PROJECT_STATE_CACHE_TTL_MS = 60_000;

interface ProjectStateCacheEntry {
  expiresAt: number;
  value: ProjectState | null;
}

function cleanupTempFile(tempFilePath: string): void {
  fs.unlink(tempFilePath).catch(() => {});
}

export class ProjectStateManager {
  private projectStateCache = new Map<string, ProjectStateCacheEntry>();

  constructor(private projectsConfigDir: string) {}

  private cloneProjectState(state: ProjectState | null): ProjectState | null {
    if (!state) return null;
    return JSON.parse(JSON.stringify(state)) as ProjectState;
  }

  private getCachedProjectState(projectId: string): ProjectState | null | undefined {
    const cached = this.projectStateCache.get(projectId);
    if (!cached) return undefined;

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

  invalidateProjectStateCache(projectId?: string): void {
    if (projectId) {
      this.projectStateCache.delete(projectId);
      return;
    }
    this.projectStateCache.clear();
  }

  async saveProjectState(projectId: string, state: ProjectState): Promise<void> {
    const stateDir = getProjectStateDir(this.projectsConfigDir, projectId);
    if (!stateDir) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const filePath = stateFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
      throw new Error(`Invalid project ID: ${projectId}`);
    }

    const validatedState: ProjectState = {
      ...state,
      terminals: filterValidTerminalEntries(
        state.terminals,
        TerminalSnapshotSchema,
        `ProjectStore.saveProjectState(${projectId})`
      ),
    };

    const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempFilePath = `${filePath}.${uniqueSuffix}.tmp`;

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await resilientWriteFile(tempFilePath, JSON.stringify(validatedState, null, 2), "utf-8");
      await resilientRename(tempFilePath, filePath);
    };

    try {
      await attemptSave(false);
    } catch (error) {
      const isEnoent = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!isEnoent) {
        console.error(
          `[ProjectStateManager] Failed to save state for project ${projectId}:`,
          error
        );
        cleanupTempFile(tempFilePath);
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(
          `[ProjectStateManager] Failed to save state for project ${projectId}:`,
          retryError
        );
        cleanupTempFile(tempFilePath);
        throw retryError;
      }
    }

    this.setProjectStateCache(projectId, validatedState);
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const cachedState = this.getCachedProjectState(projectId);
    if (cachedState !== undefined) {
      return cachedState;
    }

    const filePath = stateFilePath(this.projectsConfigDir, projectId);
    if (!filePath || !existsSync(filePath)) {
      this.setProjectStateCache(projectId, null);
      return null;
    }

    try {
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);

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
      console.error(`[ProjectStateManager] Failed to load state for project ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted`;
        await resilientRename(filePath, quarantinePath);
        console.warn(`[ProjectStateManager] Corrupted state file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      this.setProjectStateCache(projectId, null);
      return null;
    }
  }

  async clearProjectState(projectId: string): Promise<void> {
    const filePath = stateFilePath(this.projectsConfigDir, projectId);

    if (!filePath) {
      console.warn(`[ProjectStateManager] Invalid project ID: ${projectId}`);
      this.invalidateProjectStateCache(projectId);
      return;
    }

    if (!existsSync(filePath)) {
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStateManager] No state file to clear for project ${projectId}`);
      }
      this.invalidateProjectStateCache(projectId);
      return;
    }

    try {
      await resilientUnlink(filePath);
      this.invalidateProjectStateCache(projectId);
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectStateManager] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      console.error(`[ProjectStateManager] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
}
