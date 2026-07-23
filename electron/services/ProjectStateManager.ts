// eager-import-allow: reads/writes project state via sync fs
import type { ProjectState } from "../types/index.js";
import fs from "fs/promises";
import { existsSync } from "fs";
import { resilientAtomicWriteFile, resilientRename, resilientUnlink } from "../utils/fs.js";
import { TerminalSnapshotSchema, filterValidTerminalEntries } from "../schemas/ipc.js";
import { getProjectStateDir, stateFilePath } from "./projectStorePaths.js";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import { markPerformance, withPerformanceSpan } from "../utils/performance.js";

const PROJECT_STATE_CACHE_TTL_MS = 60_000;
const PROJECT_STATE_CACHE_SWEEP_MS = 60_000;

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
  // Projects whose state.json existed on disk this session but could not be read
  // into a complete terminal enumeration — future-schema quarantine, parse
  // failure, or any non-ENOENT read error. Distinct from `pendingQuarantines`
  // (a one-shot signal drained by hydration): this set is append-only and never
  // cleared for the lifetime of the process, so destructive maintenance that
  // relies on a *complete* set of known terminal ids (the boot .restore sweep)
  // can fail closed for a project whose ids it could never learn. An ENOENT
  // (genuinely no saved state) is authoritative emptiness, not unreadability,
  // and must never land here.
  private unreadableProjectIds = new Set<string>();
  private writeQueues = new Map<string, Promise<void>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private projectsConfigDir: string) {
    // Lazy eviction only fires on a re-read of the same projectId, so a
    // structuredClone-bearing entry for a project never touched again this
    // session is retained forever. Sweep expired entries proactively.
    this.sweepTimer = setInterval(() => this.sweepExpiredCache(), PROJECT_STATE_CACHE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  private sweepExpiredCache(): void {
    const now = Date.now();
    for (const [projectId, entry] of this.projectStateCache) {
      if (entry.expiresAt <= now) {
        this.projectStateCache.delete(projectId);
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.projectStateCache.clear();
  }

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

  /**
   * Serialize read-merge-write updates per project. ipcMain.handle runs
   * handlers concurrently, so two unqueued read-modify-write cycles for the
   * same projectId read the same snapshot and the last write silently reverts
   * the other's field. Each queued updater sees the previous update's
   * committed state. Returning null from the updater skips the save.
   */
  enqueueProjectStateUpdate(
    projectId: string,
    updater: (existing: ProjectState | null) => ProjectState | null | Promise<ProjectState | null>
  ): Promise<void> {
    const current = this.writeQueues.get(projectId) ?? Promise.resolve();
    // .catch() keeps one failed update from poisoning the chain for later
    // updates; the failure still propagates to that update's own caller.
    const next = current
      .catch(() => {})
      .then(async () => {
        const existing = await this.getProjectState(projectId);
        const updated = await updater(existing);
        if (updated !== null) {
          await this.saveProjectState(projectId, updated);
        }
      });
    this.writeQueues.set(projectId, next);
    const cleanup = () => {
      if (this.writeQueues.get(projectId) === next) {
        this.writeQueues.delete(projectId);
      }
    };
    // .then(cleanup, cleanup) instead of .finally(): .finally would create a
    // new rejected promise nobody handles when the update fails.
    next.then(cleanup, cleanup);
    return next;
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
    const jsonString = JSON.stringify(writePayload);
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

    // Stamp the id we actually saved under, so a cached read and a fresh disk
    // read agree. The disk path treats the state directory as authoritative, and
    // a caller passing a stale embedded id must not get a different answer just
    // because the cache happened to be warm.
    this.setProjectStateCache(projectId, { ...validatedState, projectId });
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const cachedState = this.getCachedProjectState(projectId);
    if (cachedState !== undefined) {
      return cachedState;
    }

    const filePath = stateFilePath(this.projectsConfigDir, projectId);
    if (!filePath) {
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
        // Record unreadability before touching disk: a future-version file
        // holds terminal ids this build can't parse, so its scrollback must
        // survive the orphan sweep even if the quarantine rename below fails.
        this.unreadableProjectIds.add(projectId);
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
        // The state directory this was read from is the authority. An embedded
        // id can be stale — older builds copied the state dir wholesale when a
        // relocation minted a new id, leaving the previous id inside the file
        // (#11282) — and trusting it hands callers an id that no longer names
        // any project.
        projectId,
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
        mruList: Array.isArray(parsed.mruList)
          ? parsed.mruList.filter((id: unknown): id is string => typeof id === "string")
          : undefined,
      };

      this.setProjectStateCache(projectId, state);
      return this.cloneProjectState(state);
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        this.setProjectStateCache(projectId, null);
        return null;
      }
      // State existed but couldn't be read (parse failure, EACCES/EMFILE/EIO,
      // etc.). Record it before the corruption quarantine below so a double
      // fault — unreadable AND unrenameable — is still visible to the sweep.
      this.unreadableProjectIds.add(projectId);
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

  /**
   * Whether this project's state.json existed but could not be read into a
   * complete terminal enumeration at any point this session (future-schema
   * quarantine, parse failure, or a non-ENOENT read error). Unlike
   * `getProjectStateWithRecovery`, this is a non-draining peek — reading it
   * never clears it — because destructive maintenance that gates on a complete
   * set of known ids must fail closed for the whole process lifetime, not just
   * until the recovery signal is consumed by hydration. A project that has
   * simply never persisted state (ENOENT) reads back false.
   */
  wasStateUnreadableThisSession(projectId: string): boolean {
    return this.unreadableProjectIds.has(projectId);
  }

  async clearProjectState(projectId: string): Promise<void> {
    const filePath = stateFilePath(this.projectsConfigDir, projectId);

    if (!filePath) {
      console.warn(`[ProjectStateManager] Invalid project ID: ${projectId}`);
      this.invalidateProjectStateCache(projectId);
      return;
    }

    // Invalidate cache eagerly: a failed unlink must not leave callers reading
    // a presumed-deleted state from the 60s TTL cache.
    this.invalidateProjectStateCache(projectId);

    try {
      await resilientUnlink(filePath);
      // Re-invalidate after the unlink completes: a concurrent getProjectState
      // racing the unlink could have re-read the still-present file and
      // repopulated the cache after our pre-unlink wipe.
      this.invalidateProjectStateCache(projectId);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[ProjectStateManager] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        return;
      }
      console.error(`[ProjectStateManager] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
}
