import { create } from "zustand";
import type { WorktreeState, IssueAssociation } from "@shared/types";
import { worktreeClient, githubClient } from "@/clients";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useTerminalStore } from "./terminalStore";
import { useNotificationStore } from "./notificationStore";
import { usePulseStore } from "./pulseStore";

interface WorktreeDataState {
  worktrees: Map<string, WorktreeState>;
  projectId: string | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
}

interface WorktreeDataActions {
  initialize: () => void;
  refresh: () => Promise<void>;
  getWorktree: (id: string) => WorktreeState | undefined;
  getWorktreeList: () => WorktreeState[];
}

type WorktreeDataStore = WorktreeDataState & WorktreeDataActions;

let cleanupListeners: (() => void) | null = null;
let initPromise: Promise<void> | null = null;
let storeGeneration = 0;
let targetProjectId: string | null = null;

const MAX_SNAPSHOT_CACHE_SIZE = 3;

interface ProjectSnapshot {
  worktrees: Map<string, WorktreeState>;
  activeWorktreeId: string | null;
}

const projectSnapshotCache = new Map<string, ProjectSnapshot>();

function evictOldestSnapshot(): void {
  if (projectSnapshotCache.size <= MAX_SNAPSHOT_CACHE_SIZE) return;
  const firstKey = projectSnapshotCache.keys().next().value;
  if (firstKey !== undefined) {
    projectSnapshotCache.delete(firstKey);
  }
}

function mergeFetchedWorktrees(
  fetchedStates: WorktreeState[],
  existingWorktrees: Map<string, WorktreeState>,
  issueAssociations?: Map<string, IssueAssociation>
): Map<string, WorktreeState> {
  const map = new Map(fetchedStates.map((state) => [state.id, state]));

  // Preserve event-driven metadata that may still be in-flight while we refresh.
  for (const [id, existing] of existingWorktrees) {
    const fetched = map.get(id);
    if (!fetched) continue;

    const branchChanged = fetched.branch !== existing.branch;
    map.set(id, {
      ...fetched,
      prNumber: branchChanged ? fetched.prNumber : (fetched.prNumber ?? existing.prNumber),
      prUrl: branchChanged ? fetched.prUrl : (fetched.prUrl ?? existing.prUrl),
      prState: branchChanged ? fetched.prState : (fetched.prState ?? existing.prState),
      prTitle: branchChanged ? fetched.prTitle : (fetched.prTitle ?? existing.prTitle),
      issueNumber: branchChanged
        ? fetched.issueNumber
        : (fetched.issueNumber ?? existing.issueNumber),
      issueTitle: branchChanged ? fetched.issueTitle : (fetched.issueTitle ?? existing.issueTitle),
    });
  }

  // Persisted manual issue associations should override discovered metadata.
  if (issueAssociations) {
    for (const [id, assoc] of issueAssociations) {
      const worktree = map.get(id);
      if (!worktree) continue;

      map.set(id, {
        ...worktree,
        issueNumber: assoc.issueNumber,
        issueTitle: assoc.issueTitle,
      });
    }
  }

  return map;
}

export const useWorktreeDataStore = create<WorktreeDataStore>()((set, get) => ({
  worktrees: new Map(),
  projectId: null,
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    // Always re-attach IPC listeners if they were torn down (e.g. by
    // React StrictMode's unmount/remount cycle calling cleanup).
    // This must run before the isInitialized guard so that push events
    // are never silently dropped after a cleanup+remount.
    if (!cleanupListeners) {
      const unsubUpdate = worktreeClient.onUpdate((state) => {
        set((prev) => {
          const next = new Map(prev.worktrees);
          const existing = prev.worktrees.get(state.id);
          if (existing) {
            const branchChanged = existing.branch !== state.branch;
            next.set(state.id, {
              ...state,
              prNumber: branchChanged ? state.prNumber : (state.prNumber ?? existing.prNumber),
              prUrl: branchChanged ? state.prUrl : (state.prUrl ?? existing.prUrl),
              prState: branchChanged ? state.prState : (state.prState ?? existing.prState),
              prTitle: branchChanged ? state.prTitle : (state.prTitle ?? existing.prTitle),
              issueNumber: branchChanged
                ? state.issueNumber
                : (state.issueNumber ?? existing.issueNumber),
              issueTitle: branchChanged
                ? state.issueTitle
                : (state.issueTitle ?? existing.issueTitle),
            });
          } else {
            next.set(state.id, state);
          }
          return { worktrees: next };
        });
      });

      const unsubRemove = worktreeClient.onRemove(({ worktreeId }) => {
        set((prev) => {
          const worktree = prev.worktrees.get(worktreeId);

          if (worktree?.isMainWorktree) {
            console.warn("[WorktreeStore] Attempted to remove main worktree - blocked", {
              worktreeId,
              branch: worktree.branch,
            });
            return prev;
          }

          usePulseStore.getState().invalidate(worktreeId);

          const next = new Map(prev.worktrees);
          next.delete(worktreeId);

          const selectionStore = useWorktreeSelectionStore.getState();
          if (selectionStore.activeWorktreeId === worktreeId) {
            selectionStore.setActiveWorktree(null);
          }

          const terminalStore = useTerminalStore.getState();
          const notificationStore = useNotificationStore.getState();
          const terminalsToKill = terminalStore.terminals.filter(
            (t) => (t.worktreeId ?? undefined) === worktreeId
          );

          if (terminalsToKill.length > 0) {
            terminalsToKill.forEach((terminal) => {
              terminalStore.removeTerminal(terminal.id);
            });

            notificationStore.addNotification({
              type: "info",
              title: "Worktree Deleted",
              message: `${terminalsToKill.length} terminal(s) removed with worktree.`,
              duration: 5000,
            });
          }

          return { worktrees: next };
        });
      });

      const unsubPRDetected = githubClient.onPRDetected((data) => {
        set((prev) => {
          const worktree = prev.worktrees.get(data.worktreeId);
          if (!worktree) return prev;

          const next = new Map(prev.worktrees);
          next.set(data.worktreeId, {
            ...worktree,
            prNumber: data.prNumber,
            prUrl: data.prUrl,
            prState: data.prState,
            prTitle: data.prTitle ?? worktree.prTitle,
            issueTitle: data.issueTitle ?? worktree.issueTitle,
          });
          return { worktrees: next };
        });
      });

      const unsubPRCleared = githubClient.onPRCleared((data) => {
        set((prev) => {
          const worktree = prev.worktrees.get(data.worktreeId);
          if (!worktree) return prev;

          const next = new Map(prev.worktrees);
          next.set(data.worktreeId, {
            ...worktree,
            prNumber: undefined,
            prUrl: undefined,
            prState: undefined,
            prTitle: undefined,
          });
          return { worktrees: next };
        });
      });

      const unsubIssueDetected = githubClient.onIssueDetected((data) => {
        set((prev) => {
          const worktree = prev.worktrees.get(data.worktreeId);
          if (!worktree) return prev;

          const next = new Map(prev.worktrees);
          next.set(data.worktreeId, {
            ...worktree,
            issueNumber: data.issueNumber,
            issueTitle: data.issueTitle,
          });
          return { worktrees: next };
        });
      });

      const unsubIssueNotFound = githubClient.onIssueNotFound((data) => {
        set((prev) => {
          const worktree = prev.worktrees.get(data.worktreeId);
          if (!worktree) return prev;
          if (worktree.issueNumber !== data.issueNumber) return prev;

          const next = new Map(prev.worktrees);
          next.set(data.worktreeId, {
            ...worktree,
            issueNumber: undefined,
            issueTitle: undefined,
          });
          return { worktrees: next };
        });
      });

      cleanupListeners = () => {
        unsubUpdate();
        unsubRemove();
        unsubPRDetected();
        unsubPRCleared();
        unsubIssueDetected();
        unsubIssueNotFound();
      };
    }

    if (get().isInitialized) return;

    if (initPromise) return;

    const capturedGeneration = storeGeneration;
    const capturedProjectId = targetProjectId;

    initPromise = (async () => {
      try {
        // Only show full loading state if no snapshot was pre-populated.
        // When a snapshot exists, worktrees are already visible and we
        // just need to refresh in the background.
        if (get().worktrees.size === 0) {
          set({ isLoading: true, error: null });
        } else {
          set({ error: null });
        }

        // Fetch the initial state - any events emitted during this call
        // will be captured by the listeners we set up above
        const states = await worktreeClient.getAll();

        if (storeGeneration !== capturedGeneration) {
          console.warn(
            "[WorktreeDataStore] Discarding stale initialize response - project switched"
          );
          return;
        }

        // Load all persisted issue associations in a single IPC call
        const issueMap = new Map<string, IssueAssociation>();
        try {
          const allAssociations = await worktreeClient.getAllIssueAssociations();
          if (storeGeneration !== capturedGeneration) {
            console.warn(
              "[WorktreeDataStore] Discarding stale initialize response - project switched"
            );
            return;
          }
          // Only include associations for worktrees that exist in the current fetch
          const stateIds = new Set(states.map((s) => s.id));
          for (const [id, assoc] of Object.entries(allAssociations)) {
            if (stateIds.has(id)) {
              issueMap.set(id, assoc);
            }
          }
        } catch (assocErr) {
          console.warn("[WorktreeDataStore] Failed to load issue associations, skipping", assocErr);
        }

        set((prev) => {
          if (storeGeneration !== capturedGeneration) {
            return prev;
          }
          const map = mergeFetchedWorktrees(states, prev.worktrees, issueMap);

          // Update the snapshot cache with the fresh data
          if (capturedProjectId) {
            const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
            projectSnapshotCache.delete(capturedProjectId);
            projectSnapshotCache.set(capturedProjectId, {
              worktrees: new Map(map),
              activeWorktreeId,
            });
            evictOldestSnapshot();
          }

          return {
            worktrees: map,
            projectId: capturedProjectId,
            isLoading: false,
            isInitialized: true,
          };
        });
      } catch (e) {
        if (storeGeneration !== capturedGeneration) return;
        set({
          error: e instanceof Error ? e.message : "Failed to load worktrees",
          isLoading: false,
          isInitialized: true,
        });
      }
    })();
  },

  refresh: async () => {
    const capturedGeneration = storeGeneration;
    const capturedProjectId = targetProjectId;
    try {
      set({ error: null });
      await worktreeClient.refresh();

      if (storeGeneration !== capturedGeneration) return;

      const states = await worktreeClient.getAll();

      if (storeGeneration !== capturedGeneration) return;

      set((prev) => {
        if (storeGeneration !== capturedGeneration) return prev;
        const map = mergeFetchedWorktrees(states, prev.worktrees);

        // Update the snapshot cache
        if (capturedProjectId) {
          const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
          projectSnapshotCache.delete(capturedProjectId);
          projectSnapshotCache.set(capturedProjectId, {
            worktrees: new Map(map),
            activeWorktreeId,
          });
          evictOldestSnapshot();
        }

        return {
          worktrees: map,
          projectId: capturedProjectId,
          isLoading: false,
          isInitialized: true,
        };
      });
    } catch (e) {
      if (storeGeneration !== capturedGeneration) return;
      set({ error: e instanceof Error ? e.message : "Failed to refresh worktrees" });
    }
  },

  getWorktree: (id: string) => get().worktrees.get(id),

  getWorktreeList: () => {
    return Array.from(get().worktrees.values()).sort((a, b) => {
      // Use isMainWorktree flag for consistent sorting
      if (a.isMainWorktree && !b.isMainWorktree) return -1;
      if (!a.isMainWorktree && b.isMainWorktree) return 1;
      return a.name.localeCompare(b.name);
    });
  },
}));

export function snapshotProjectWorktrees(projectId: string): void {
  const { worktrees, projectId: storeProjectId } = useWorktreeDataStore.getState();
  if (worktrees.size === 0) return;
  // Don't cache if the store has already moved to a different project.
  if (storeProjectId && storeProjectId !== projectId) return;
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  projectSnapshotCache.delete(projectId);
  projectSnapshotCache.set(projectId, {
    worktrees: new Map(worktrees),
    activeWorktreeId,
  });
  evictOldestSnapshot();
}

export function cleanupWorktreeDataStore() {
  storeGeneration++;
  targetProjectId = null;
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }
  initPromise = null;
  // Clear pulse store to cancel all retry timers
  usePulseStore.getState().invalidateAll();
  // Clear worktrees but keep isInitialized: true to prevent
  // auto-reinitialization race during project switch.
  // The store will be properly reinitialized when forceReinitialize() is called.
  useWorktreeDataStore.setState({
    worktrees: new Map(),
    projectId: null,
    isLoading: true,
    error: null,
    isInitialized: true,
  });
}

export function prePopulateWorktreeSnapshot(projectId: string) {
  // Pre-populate the store with cached snapshot data for instant sidebar rendering.
  // Does NOT trigger IPC fetch — the main process may not have switched yet.
  // Call forceReinitializeWorktreeDataStore() once the backend is ready to fetch fresh data.
  storeGeneration++;
  targetProjectId = projectId;
  cleanupListeners?.();
  cleanupListeners = null;
  initPromise = null;
  usePulseStore.getState().invalidateAll();

  const snapshot = projectSnapshotCache.get(projectId);
  const hasSnapshot = snapshot && snapshot.worktrees.size > 0;

  useWorktreeDataStore.setState({
    worktrees: hasSnapshot ? new Map(snapshot.worktrees) : new Map(),
    projectId,
    isLoading: !hasSnapshot,
    error: null,
    // Keep isInitialized: true so the hook doesn't auto-trigger initialize()
    // before the backend is ready. forceReinitializeWorktreeDataStore() will
    // flip this to false and start the real fetch.
    isInitialized: true,
  });

  // Restore the active worktree selection from the snapshot so the sidebar
  // shows the correct worktree highlighted immediately.
  if (hasSnapshot && snapshot.activeWorktreeId) {
    useWorktreeSelectionStore.setState({ activeWorktreeId: snapshot.activeWorktreeId });
  }
}

export function forceReinitializeWorktreeDataStore(projectId?: string) {
  // Called after backend project switch is complete to load fresh worktrees.
  // If prePopulateWorktreeSnapshot() was called first, the store already has
  // cached data visible in the sidebar — this just triggers a background refresh.
  const currentWorktrees = useWorktreeDataStore.getState().worktrees;
  storeGeneration++;
  targetProjectId = projectId ?? null;
  cleanupListeners?.();
  cleanupListeners = null;
  initPromise = null;
  usePulseStore.getState().invalidateAll();

  // Keep existing worktrees if they match the target project (from prePopulate)
  const storeProjectId = useWorktreeDataStore.getState().projectId;
  const keepExisting = projectId && storeProjectId === projectId && currentWorktrees.size > 0;

  useWorktreeDataStore.setState({
    worktrees: keepExisting ? currentWorktrees : new Map(),
    projectId: targetProjectId,
    isLoading: true,
    error: null,
    isInitialized: false,
  });
  // Trigger initialization (will refresh in background if snapshot was used)
  useWorktreeDataStore.getState().initialize();
}

/**
 * Cleanup orphaned terminals from deleted worktrees.
 * This should be called after terminal hydration completes to ensure
 * terminals are loaded before checking for orphans.
 */
export function cleanupOrphanedTerminals() {
  const getWorktreeIds = (wtMap: Map<string, WorktreeState>) => {
    const ids = new Set<string>();
    for (const [id, wt] of wtMap) {
      ids.add(id);
      if (wt.worktreeId) ids.add(wt.worktreeId);
    }
    return ids;
  };

  const currentWorktrees = useWorktreeDataStore.getState().worktrees;
  const worktreeIds = getWorktreeIds(currentWorktrees);
  const terminalStore = useTerminalStore.getState();
  const orphanedTerminals = terminalStore.terminals.filter((t) => {
    const worktreeId = typeof t.worktreeId === "string" ? t.worktreeId.trim() : "";
    return worktreeId && !worktreeIds.has(worktreeId);
  });

  if (orphanedTerminals.length > 0) {
    console.log(
      `[WorktreeDataStore] Removing ${orphanedTerminals.length} orphaned terminal(s) from deleted worktrees`
    );
    orphanedTerminals.forEach((terminal) => terminalStore.removeTerminal(terminal.id));
  }
}
