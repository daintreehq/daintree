import { createStore, type StoreApi } from "zustand/vanilla";
import type { WorktreeSnapshot } from "@shared/types";
import { usePanelStore } from "./panelStore";
import { logDebug } from "@/utils/logger";

let _currentViewStore: WorktreeViewStoreApi | null = null;

export function setCurrentViewStore(store: WorktreeViewStoreApi): void {
  _currentViewStore = store;
}

export function getCurrentViewStore(): WorktreeViewStoreApi {
  if (!_currentViewStore) {
    throw new Error(
      "WorktreeViewStore not initialized — called before WorktreeStoreProvider mount"
    );
  }
  return _currentViewStore;
}

export interface WorktreeViewState {
  worktrees: Map<string, WorktreeSnapshot>;
  version: number;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  isReconnecting: boolean;
}

export interface WorktreeViewActions {
  nextVersion(): number;
  applySnapshot(states: WorktreeSnapshot[], version: number): void;
  applyUpdate(state: WorktreeSnapshot, version: number): void;
  applyRemove(worktreeId: string, version: number): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  setReconnecting(reconnecting: boolean): void;
}

export type WorktreeViewStore = WorktreeViewState & WorktreeViewActions;
export type WorktreeViewStoreApi = StoreApi<WorktreeViewStore>;

export function createWorktreeStore(): WorktreeViewStoreApi {
  let versionCounter = 0;

  return createStore<WorktreeViewStore>((set, get) => ({
    worktrees: new Map(),
    version: 0,
    isLoading: true,
    error: null,
    isInitialized: false,
    isReconnecting: false,

    nextVersion() {
      return ++versionCounter;
    },

    applySnapshot(states: WorktreeSnapshot[], version: number) {
      if (version <= get().version) return;
      const map = new Map(states.map((s) => [s.id, s]));
      set({
        worktrees: map,
        version,
        isLoading: false,
        isInitialized: true,
        error: null,
        isReconnecting: false,
      });
    },

    applyUpdate(state: WorktreeSnapshot, version: number) {
      if (version <= get().version) return;
      const prev = get().worktrees;
      const existing = prev.get(state.id);
      if (existing && snapshotsEqual(existing, state)) {
        set({ version });
        return;
      }
      const next = new Map(prev);
      next.set(state.id, state);
      set({ worktrees: next, version });
    },

    applyRemove(worktreeId: string, version: number) {
      if (version <= get().version) return;
      const prev = get().worktrees;
      if (!prev.has(worktreeId)) {
        set({ version });
        return;
      }
      const next = new Map(prev);
      next.delete(worktreeId);
      set({ worktrees: next, version });
    },

    setLoading(loading: boolean) {
      set({ isLoading: loading });
    },

    setError(error: string | null) {
      set({ error });
    },

    setReconnecting(reconnecting: boolean) {
      set({ isReconnecting: reconnecting });
    },
  }));
}

export function cleanupOrphanedTerminals(): void {
  if (!_currentViewStore) return;

  const state = _currentViewStore.getState();
  if (!state.isInitialized || state.worktrees.size === 0) return;

  const worktreeMap = state.worktrees;
  const worktreeIds = new Set<string>();
  for (const [id, wt] of worktreeMap) {
    worktreeIds.add(id);
    if (wt.worktreeId) {
      worktreeIds.add(wt.worktreeId);
    }
  }

  const terminalStore = usePanelStore.getState();
  const orphanedTerminals = terminalStore.panelIds
    .map((id) => terminalStore.panelsById[id])
    .filter((t) => {
      if (!t) return false;
      const worktreeId = typeof t.worktreeId === "string" ? t.worktreeId.trim() : "";
      return worktreeId && !worktreeIds.has(worktreeId);
    });

  if (orphanedTerminals.length > 0) {
    logDebug("[WorktreeStore] Removing orphaned terminals from deleted worktrees", {
      count: orphanedTerminals.length,
    });
    orphanedTerminals.forEach((terminal) => terminalStore.removePanel(terminal.id));
  }
}

function snapshotsEqual(a: WorktreeSnapshot, b: WorktreeSnapshot): boolean {
  return (
    a.branch === b.branch &&
    a.path === b.path &&
    a.name === b.name &&
    a.isCurrent === b.isCurrent &&
    a.isMainWorktree === b.isMainWorktree &&
    a.modifiedCount === b.modifiedCount &&
    a.summary === b.summary &&
    a.mood === b.mood &&
    a.aiNote === b.aiNote &&
    a.aiNoteTimestamp === b.aiNoteTimestamp &&
    a.lastActivityTimestamp === b.lastActivityTimestamp &&
    a.prNumber === b.prNumber &&
    a.prUrl === b.prUrl &&
    a.prState === b.prState &&
    a.prTitle === b.prTitle &&
    a.issueNumber === b.issueNumber &&
    a.issueTitle === b.issueTitle &&
    a.taskId === b.taskId &&
    a.hasPlanFile === b.hasPlanFile &&
    a.planFilePath === b.planFilePath &&
    a.aheadCount === b.aheadCount &&
    a.behindCount === b.behindCount &&
    a.worktreeMode === b.worktreeMode &&
    a.worktreeEnvironmentLabel === b.worktreeEnvironmentLabel &&
    a.hasResourceConfig === b.hasResourceConfig &&
    a.hasStatusCommand === b.hasStatusCommand &&
    a.hasProvisionCommand === b.hasProvisionCommand &&
    a.hasPauseCommand === b.hasPauseCommand &&
    a.hasResumeCommand === b.hasResumeCommand &&
    a.hasTeardownCommand === b.hasTeardownCommand &&
    a.resourceConnectCommand === b.resourceConnectCommand &&
    resourceStatusEqual(a.resourceStatus, b.resourceStatus) &&
    worktreeChangesEqual(a.worktreeChanges, b.worktreeChanges) &&
    lifecycleStatusEqual(a.lifecycleStatus, b.lifecycleStatus)
  );
}

function resourceStatusEqual(
  a: WorktreeSnapshot["resourceStatus"],
  b: WorktreeSnapshot["resourceStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.lastStatus === b.lastStatus &&
    a.provider === b.provider &&
    a.endpoint === b.endpoint &&
    a.lastCheckedAt === b.lastCheckedAt &&
    a.lastOutput === b.lastOutput &&
    a.error === b.error &&
    a.resumedAt === b.resumedAt &&
    a.pausedAt === b.pausedAt
  );
}

function worktreeChangesEqual(
  a: WorktreeSnapshot["worktreeChanges"],
  b: WorktreeSnapshot["worktreeChanges"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.lastUpdated !== undefined && a.lastUpdated === b.lastUpdated) return true;
  return (
    a.changedFileCount === b.changedFileCount &&
    a.changes.length === b.changes.length &&
    a.totalInsertions === b.totalInsertions &&
    a.totalDeletions === b.totalDeletions &&
    a.latestFileMtime === b.latestFileMtime &&
    a.lastCommitMessage === b.lastCommitMessage &&
    a.lastCommitTimestampMs === b.lastCommitTimestampMs
  );
}

function lifecycleStatusEqual(
  a: WorktreeSnapshot["lifecycleStatus"],
  b: WorktreeSnapshot["lifecycleStatus"]
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.phase === b.phase &&
    a.state === b.state &&
    a.currentCommand === b.currentCommand &&
    a.commandIndex === b.commandIndex &&
    a.totalCommands === b.totalCommands &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.error === b.error
  );
}
