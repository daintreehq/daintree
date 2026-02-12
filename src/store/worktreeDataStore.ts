import { create } from "zustand";
import type { WorktreeState, IssueAssociation } from "@shared/types";
import { worktreeClient, githubClient } from "@/clients";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useTerminalStore } from "./terminalStore";
import { useNotificationStore } from "./notificationStore";
import { usePulseStore } from "./pulseStore";

interface WorktreeDataState {
  worktrees: Map<string, WorktreeState>;
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

    map.set(id, {
      ...fetched,
      prNumber: fetched.prNumber ?? existing.prNumber,
      prUrl: fetched.prUrl ?? existing.prUrl,
      prState: fetched.prState ?? existing.prState,
      prTitle: fetched.prTitle ?? existing.prTitle,
      issueNumber: fetched.issueNumber ?? existing.issueNumber,
      issueTitle: fetched.issueTitle ?? existing.issueTitle,
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
            next.set(state.id, {
              ...state,
              prNumber: state.prNumber ?? existing.prNumber,
              prUrl: state.prUrl ?? existing.prUrl,
              prState: state.prState ?? existing.prState,
              prTitle: state.prTitle ?? existing.prTitle,
              issueNumber: state.issueNumber ?? existing.issueNumber,
              issueTitle: state.issueTitle ?? existing.issueTitle,
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
            issueTitle: data.issueTitle,
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
      };
    }

    if (get().isInitialized) return;

    if (initPromise) return;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        // Fetch the initial state - any events emitted during this call
        // will be captured by the listeners we set up above
        const states = await worktreeClient.getAll();

        // Load persisted issue associations for each worktree
        const issueAssociations = await Promise.all(
          states.map(async (s) => {
            try {
              const assoc = await worktreeClient.getIssueAssociation(s.id);
              return { id: s.id, assoc };
            } catch {
              return { id: s.id, assoc: null };
            }
          })
        );
        const issueMap = new Map(
          issueAssociations.filter((a) => a.assoc !== null).map((a) => [a.id, a.assoc!])
        );

        set((prev) => {
          const map = mergeFetchedWorktrees(states, prev.worktrees, issueMap);

          return { worktrees: map, isLoading: false, isInitialized: true };
        });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to load worktrees",
          isLoading: false,
          isInitialized: true,
        });
      }
    })();
  },

  refresh: async () => {
    try {
      set({ error: null });
      await worktreeClient.refresh();
      const states = await worktreeClient.getAll();
      set((prev) => ({
        worktrees: mergeFetchedWorktrees(states, prev.worktrees),
        isLoading: false,
        isInitialized: true,
      }));
    } catch (e) {
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

export function cleanupWorktreeDataStore() {
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
    isLoading: true,
    error: null,
    isInitialized: true,
  });
}

export function forceReinitializeWorktreeDataStore() {
  // Called after backend project switch is complete to load worktrees for new project
  cleanupListeners?.();
  cleanupListeners = null;
  initPromise = null;
  // Clear pulse store to cancel all retry timers
  usePulseStore.getState().invalidateAll();
  useWorktreeDataStore.setState({
    worktrees: new Map(),
    isLoading: true,
    error: null,
    isInitialized: false,
  });
  // Trigger initialization
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
