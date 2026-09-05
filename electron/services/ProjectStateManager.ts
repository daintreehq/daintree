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

/**
 * Notified after project state is successfully persisted, with exactly what
 * landed on disk — the post-validation state, or `null` when the state was
 * cleared away entirely.
 *
 * Exists so metadata derived from the terminals array (the resumable-agent
 * count behind the switcher's dot, #11801) is recomputed by the same write that
 * changes it, rather than by every would-be reader guessing when to look. It
 * fires only on success: a failed write leaves the previous derived value
 * standing, which is still the truth about what is on disk.
 */
export type ProjectStatePersistedObserver = (projectId: string, state: ProjectState | null) => void;

type ProjectStateUpdater = (
  existing: ProjectState | null
) => ProjectState | null | Promise<ProjectState | null>;

/** One caller's update, plus the settlement of the promise it was handed. */
interface QueuedUpdate {
  updater: ProjectStateUpdater;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * What one updater in a batch did, recorded rather than acted on.
 *
 * Settlement waits for the batch's save: a later updater that throws must not
 * resolve ahead of an earlier one whose result is still unwritten.
 */
type UpdateOutcome =
  | { entry: QueuedUpdate; kind: "wrote" }
  | { entry: QueuedUpdate; kind: "noop" }
  | { entry: QueuedUpdate; kind: "threw"; error: unknown };

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
  /**
   * Updates waiting BEHIND the batch a project's runner is currently applying.
   *
   * Not a promise tail any more: the whole point is that several updates
   * waiting together become one save, and a chain of `.then()` links can only
   * express one save each.
   */
  private writeQueues = new Map<string, QueuedUpdate[]>();
  /** Projects whose runner is live. Claimed before the runner starts. */
  private drainingProjects = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private onStatePersisted: ProjectStatePersistedObserver | null = null;

  constructor(private projectsConfigDir: string) {
    // Lazy eviction only fires on a re-read of the same projectId, so a
    // structuredClone-bearing entry for a project never touched again this
    // session is retained forever. Sweep expired entries proactively.
    this.sweepTimer = setInterval(() => this.sweepExpiredCache(), PROJECT_STATE_CACHE_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Install the post-write hook. Single-slot rather than a listener list: the
   * one consumer is the owning {@link ProjectStore}, and a set of subscribers
   * would invite derived state to be recomputed by several owners at once.
   */
  setStatePersistedObserver(observer: ProjectStatePersistedObserver | null): void {
    this.onStatePersisted = observer;
  }

  /**
   * Never lets a derived-metadata failure escape into the write path — the
   * state file is already committed by the time this runs, and throwing here
   * would report a successful save as a failure to its caller.
   */
  private notifyStatePersisted(projectId: string, state: ProjectState | null): void {
    if (!this.onStatePersisted) return;
    try {
      this.onStatePersisted(projectId, state);
    } catch (error) {
      console.error(
        `[ProjectStateManager] State-persisted observer failed for project ${projectId}:`,
        error
      );
    }
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
    this.cacheUnsharedProjectState(projectId, this.cloneProjectState(state));
  }

  /**
   * Cache a value nothing else holds a reference to.
   *
   * {@link setProjectStateCache} clones because its argument is normally the
   * caller's object. A freshly parsed disk read is not: it is built here field
   * by field, and the only other reference handed out is the clone returned to
   * the caller. Cloning it a second time buys no isolation the first one did
   * not already provide, and a project's state is the largest thing this class
   * copies.
   */
  private cacheUnsharedProjectState(projectId: string, state: ProjectState | null): void {
    this.projectStateCache.set(projectId, {
      expiresAt: Date.now() + PROJECT_STATE_CACHE_TTL_MS,
      value: state,
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
  enqueueProjectStateUpdate(projectId: string, updater: ProjectStateUpdater): Promise<void> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // The old chain hung `.then(cleanup, cleanup)` off the promise it returned,
    // which incidentally marked a rejection as handled. Callers that never
    // await (relocation fans several of these into allSettled) relied on that,
    // so keep it: this handler settles a derived promise, not the returned one,
    // and the caller still sees the rejection.
    void promise.catch(() => {});

    const entry: QueuedUpdate = { updater, resolve, reject };

    if (this.drainingProjects.has(projectId)) {
      // A batch is already applying. Wait behind it — with everything else that
      // arrives before it finishes, so the whole group costs one save.
      const pending = this.writeQueues.get(projectId);
      if (pending) pending.push(entry);
      else this.writeQueues.set(projectId, [entry]);
    } else {
      this.drainingProjects.add(projectId);
      // Claimed before the runner starts, and the batch handed straight to it:
      // nothing here depends on how much of `drainQueue` happens to run before
      // its first await.
      void this.drainQueue(projectId, [entry]);
    }

    return promise;
  }

  /**
   * Apply batches for one project, back to back, until nothing is waiting.
   *
   * A batch is frozen when the runner picks it up, so an update arriving later
   * can never postpone a save that is already due — the longest anything waits
   * is the batch in front of it, never a deadline that keeps moving. That is
   * why there is no flush ceiling here: there is no timer to starve.
   */
  private async drainQueue(projectId: string, firstBatch: QueuedUpdate[]): Promise<void> {
    try {
      let batch = firstBatch;
      for (;;) {
        await this.runBatch(projectId, batch);
        const pending = this.writeQueues.get(projectId);
        // Nothing waiting. The `finally` below releases the claim in this same
        // synchronous step, so no enqueue can slip in between the two and be
        // left with no runner to pick it up.
        if (!pending) return;
        this.writeQueues.delete(projectId);
        batch = pending;
      }
    } finally {
      this.drainingProjects.delete(projectId);
    }
  }

  /**
   * Read once, apply every updater in order, save once.
   *
   * `runBatch` never throws: each caller's outcome is delivered through its own
   * promise, and a runner that died would strand every update behind it.
   */
  private async runBatch(projectId: string, batch: QueuedUpdate[]): Promise<void> {
    let existing: ProjectState | null;
    try {
      existing = await this.getProjectState(projectId);
    } catch (error) {
      for (const entry of batch) entry.reject(error);
      return;
    }

    // One update is by far the common case. Keep it on the original path so an
    // isolated write pays nothing at all for the batching machinery.
    const only = batch.length === 1 ? batch[0] : undefined;
    if (only) {
      try {
        const updated = await only.updater(existing);
        if (updated !== null) {
          await this.saveProjectState(projectId, updated);
        }
        only.resolve();
      } catch (error) {
        only.reject(error);
      }
      return;
    }

    let state = existing;
    let pendingSave: ProjectState | null = null;
    const outcomes: UpdateOutcome[] = [];

    for (const entry of batch) {
      // Every updater gets its own copy, including the first.
      //
      // An updater may mutate what it is handed and THEN throw or return null,
      // and that mutation has to be discarded — which is what happens today,
      // where each update reads its own copy and a declined write simply
      // abandons it. `shutdown.ts` and `projectSessionJournal.ts` both mutate
      // `state.terminals[n]` in place and return the same object, so this is
      // the live shape, not a hypothetical one.
      //
      // Handing the first updater the read's own clone would save a copy and
      // was tried: it lets a first updater that mutates and then declines write
      // straight through to the state the rest of the batch builds on.
      const input = this.cloneProjectState(state);
      try {
        const updated = await entry.updater(input);
        if (updated === null) {
          outcomes.push({ entry, kind: "noop" });
          continue;
        }
        // Stamp the id the state directory says, which is what the next updater
        // would have read back through the cache had this update saved on its
        // own. Deliberately NOT re-running terminal validation per step: the
        // save filters the batch's final state, and a filter is a per-entry
        // predicate, so no entry survives to disk that a per-step pass would
        // have dropped.
        state = updated.projectId === projectId ? updated : { ...updated, projectId };
        pendingSave = state;
        outcomes.push({ entry, kind: "wrote" });
      } catch (error) {
        outcomes.push({ entry, kind: "threw", error });
      }
    }

    let saveError: { error: unknown } | undefined;
    if (pendingSave) {
      try {
        await this.saveProjectState(projectId, pendingSave);
      } catch (error) {
        saveError = { error };
      }
    }

    for (const outcome of outcomes) {
      if (outcome.kind === "threw") {
        outcome.entry.reject(outcome.error);
      } else if (outcome.kind === "wrote" && saveError) {
        // Everything this save carried fails together — it is one write.
        outcome.entry.reject(saveError.error);
      } else {
        // A null updater asked for no write, so a failed one is not its failure.
        outcome.entry.resolve();
      }
    }
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
    // After the cache, so an observer that reads back through this manager sees
    // the state it was just handed rather than the previous one.
    this.notifyStatePersisted(projectId, validatedState);
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

      // A present-but-non-array `terminals` field means the enumeration we can
      // recover is incomplete — we fall back to zero ids below, so this project
      // can't be trusted to gate the destructive orphan sweep any more than a
      // corrupt file could. Flag it. A missing or null field is a legitimately
      // empty project, not corruption, and must not flag. (Individual entries
      // that fail schema validation are dropped as genuine orphans — the
      // terminal won't be restored, so its scrollback is already dead.)
      if (parsed.terminals != null && !Array.isArray(parsed.terminals)) {
        this.unreadableProjectIds.add(projectId);
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

      // `state` was just built from parsed JSON and is shared with nothing, so
      // the cache can take it as-is and the caller gets the only other copy.
      this.cacheUnsharedProjectState(projectId, state);
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
      // No state file is an answer, not an absence of one: the project restores
      // nothing, so anything derived from the terminals array is now a known
      // zero rather than unknown.
      this.notifyStatePersisted(projectId, null);
      if (process.env.DAINTREE_VERBOSE) {
        console.log(`[ProjectStateManager] Cleared state for project ${projectId}`);
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        // Already absent, which is the state the caller asked for — same
        // authoritative emptiness as a successful unlink.
        this.notifyStatePersisted(projectId, null);
        return;
      }
      console.error(`[ProjectStateManager] Failed to clear state for ${projectId}:`, error);
      throw error;
    }
  }
}
