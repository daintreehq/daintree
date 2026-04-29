import type { ProjectState } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { getProjectStateDir, stateFilePath } from "./projectStorePaths.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance, withPerformanceSpan } from "../utils/performance.js";

const PROJECT_STATE_CACHE_TTL_MS = 60_000;

export const PROJECT_STATE_SCHEMA_VERSION = 1;

interface ProjectStateCacheEntry {
  expiresAt: number;
  value: ProjectState | null;
}

export interface ProjectStateReadResult {
  state: ProjectState | null;
  quarantinedPath?: string;
}

export class ProjectStateManager {
  private projectStateCache = new Map<string, ProjectStateCacheEntry>();
  private pendingQuarantines = new Map<string, string>();

  constructor(private projectsConfigDir: string) {}

  private cloneProjectState(state: ProjectState | null): ProjectState | null {
    if (!state) return null;
    return structuredClone(state);
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

    const writePayload = {
      ...validatedState,
      _schemaVersion: PROJECT_STATE_SCHEMA_VERSION,
    };
    const jsonString = JSON.stringify(writePayload, null, 2);
    const bytes = Buffer.byteLength(jsonString, "utf-8");

    const attemptSave = async (ensureDir: boolean): Promise<void> => {
      if (ensureDir) {
        await fs.mkdir(stateDir, { recursive: true });
      }
      await withPerformanceSpan(
        PERF_MARKS.PROJECT_STATE_WRITE,
        () => resilientAtomicWriteFile(filePath, jsonString, "utf-8"),
        { projectId, bytes }
      );
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
        throw error;
      }

      try {
        await attemptSave(true);
      } catch (retryError) {
        console.error(
          `[ProjectStateManager] Failed to save state for project ${projectId}:`,
          retryError
        );
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
      const content = await withPerformanceSpan(
        PERF_MARKS.PROJECT_STATE_READ,
        () => fs.readFile(filePath, "utf-8"),
        { projectId }
      );
      const parsed = JSON.parse(content);

      const rawVersion = parsed._schemaVersion;
      const onDiskVersion =
        typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
          ? rawVersion
          : 0;
      if (onDiskVersion > PROJECT_STATE_SCHEMA_VERSION) {
        // Avoid a deterministic destination so neither POSIX silently
        // clobbers a prior quarantine nor Windows throws EEXIST. A previously
        // quarantined .future-v{N} file is preserved with a timestamp suffix.
        let quarantinePath = `${filePath}.future-v${onDiskVersion}`;
        if (existsSync(quarantinePath)) {
          quarantinePath = `${quarantinePath}.${Date.now()}`;
        }
        markPerformance(PERF_MARKS.PROJECT_STATE_QUARANTINE, { projectId });
        try {
          await resilientRename(filePath, quarantinePath);
          this.pendingQuarantines.set(projectId, quarantinePath);
          console.warn(
            `[ProjectStateManager] state.json for ${projectId} was written by a newer app (v${onDiskVersion} > v${PROJECT_STATE_SCHEMA_VERSION}); quarantined to ${quarantinePath}`
          );
        } catch (renameError) {
          console.error(
            `[ProjectStateManager] Failed to quarantine future-version state for ${projectId}:`,
            renameError
          );
        }
        this.setProjectStateCache(projectId, null);
        return null;
      }

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
        tabGroups: Array.isArray(parsed.tabGroups) ? parsed.tabGroups : undefined,
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
        terminalSizes:
          parsed.terminalSizes &&
          typeof parsed.terminalSizes === "object" &&
          !Array.isArray(parsed.terminalSizes)
            ? parsed.terminalSizes
            : undefined,
        draftInputs:
          parsed.draftInputs &&
          typeof parsed.draftInputs === "object" &&
          !Array.isArray(parsed.draftInputs)
            ? parsed.draftInputs
            : undefined,
      };

      this.setProjectStateCache(projectId, state);
      return this.cloneProjectState(state);
    } catch (error) {
      console.error(`[ProjectStateManager] Failed to load state for project ${projectId}:`, error);
      try {
        const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
        markPerformance(PERF_MARKS.PROJECT_STATE_QUARANTINE, { projectId });
        await resilientRename(filePath, quarantinePath);
        this.pendingQuarantines.set(projectId, quarantinePath);
        console.warn(`[ProjectStateManager] Corrupted state file moved to ${quarantinePath}`);
      } catch {
        // Ignore
      }
      this.setProjectStateCache(projectId, null);
      return null;
    }
  }

  async getProjectStateWithRecovery(projectId: string): Promise<ProjectStateReadResult> {
    const state = await this.getProjectState(projectId);
    const quarantinedPath = this.pendingQuarantines.get(projectId);
    if (quarantinedPath !== undefined) {
      this.pendingQuarantines.delete(projectId);
      return { state, quarantinedPath };
    }
    return { state };
  }

  async clearProjectState(projectId: string): Promise<void> {
    const filePath = stateFilePath(this.projectsConfigDir, projectId);

    if (!filePath) {
      console.warn(`[ProjectStateManager] Invalid project ID: ${projectId}`);
      this.invalidateProjectStateCache(projectId);
      return;
    }

    if (!existsSync(filePath)) {
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[ProjectStateManager] No state file to clear for project ${projectId}`);
      }
      this.invalidateProjectStateCache(projectId);
      return;
    }

    try {
      await resilientUnlink(filePath);
      this.invalidateProjectStateCache(projectId);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[ProjectStateManager] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      console.error(`[ProjectStateManager] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
}
