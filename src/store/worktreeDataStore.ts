import { create } from "zustand";
import type { WorktreeState } from "@shared/types";
import { worktreeClient, githubClient } from "@/clients";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useTerminalStore } from "./terminalStore";
import { useNotificationStore } from "./notificationStore";

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

export const useWorktreeDataStore = create<WorktreeDataStore>()((set, get) => ({
  worktrees: new Map(),
  isLoading: true,
  error: null,
  isInitialized: false,

  initialize: () => {
    if (get().isInitialized) return;

    if (initPromise) return;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        // Set up listeners BEFORE calling getAll() to avoid missing events
        // that the backend might emit during or after the getAll() response.
        // This prevents race conditions where issue titles or PR data are lost.
        if (!cleanupListeners) {
          const unsubUpdate = worktreeClient.onUpdate((state) => {
            set((prev) => {
              const next = new Map(prev.worktrees);
              const existing = prev.worktrees.get(state.id);
              if (existing) {
                next.set(state.id, {
                  ...state,
                  // Preserve PR/issue metadata if not present in update
                  prNumber: state.prNumber ?? existing.prNumber,
                  prUrl: state.prUrl ?? existing.prUrl,
                  prState: state.prState ?? existing.prState,
                  prTitle: state.prTitle ?? existing.prTitle,
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

              // Safeguard: Never remove main worktree from the store
              if (worktree?.isMainWorktree) {
                console.warn("[WorktreeStore] Attempted to remove main worktree - blocked", {
                  worktreeId,
                  branch: worktree.branch,
                });
                return prev;
              }

              const next = new Map(prev.worktrees);
              next.delete(worktreeId);

              // Clear active selection if this worktree was selected
              const selectionStore = useWorktreeSelectionStore.getState();
              if (selectionStore.activeWorktreeId === worktreeId) {
                selectionStore.setActiveWorktree(null);
              }

              // Move orphaned terminals to trash (not hard-kill them)
              const terminalStore = useTerminalStore.getState();
              const notificationStore = useNotificationStore.getState();
              const terminalsToTrash = terminalStore.terminals.filter(
                (t) => (t.worktreeId ?? undefined) === worktreeId && t.location !== "trash"
              );

              if (terminalsToTrash.length > 0) {
                terminalsToTrash.forEach((terminal) => {
                  terminalStore.trashTerminal(terminal.id);
                });

                notificationStore.addNotification({
                  type: "info",
                  title: "Worktree Deleted Externally",
                  message: `${terminalsToTrash.length} terminal(s) moved to trash. Check trash to view logs before cleanup.`,
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
                // Preserve existing values if payload fields are undefined
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

        // Now fetch the initial state - any events emitted during this call
        // will be captured by the listeners we set up above
        const states = await worktreeClient.getAll();

        // Merge getAll results with any events that arrived during the fetch
        // This preserves PR/issue metadata from events that fired while we were waiting
        set((prev) => {
          const map = new Map(states.map((s) => [s.id, s]));

          // Merge in any PR/issue metadata from events that arrived during fetch
          for (const [id, existing] of prev.worktrees) {
            const fetched = map.get(id);
            if (fetched && existing) {
              map.set(id, {
                ...fetched,
                // Preserve event-driven metadata if present
                prNumber: fetched.prNumber ?? existing.prNumber,
                prUrl: fetched.prUrl ?? existing.prUrl,
                prState: fetched.prState ?? existing.prState,
                prTitle: fetched.prTitle ?? existing.prTitle,
                issueTitle: fetched.issueTitle ?? existing.issueTitle,
              });
            }
          }

          return { worktrees: map, isLoading: false, isInitialized: true };
        });

        // Startup cleanup: trash orphaned terminals from deleted worktrees
        const getWorktreeIds = (wtMap: Map<string, WorktreeState>) => {
          const ids = new Set<string>();
          for (const [id, wt] of wtMap) {
            ids.add(id);
            if (wt.worktreeId) ids.add(wt.worktreeId);
          }
          return ids;
        };

        const runOrphanCleanup = () => {
          const currentWorktrees = get().worktrees;
          const worktreeIds = getWorktreeIds(currentWorktrees);
          const terminalStore = useTerminalStore.getState();
          const orphanedTerminals = terminalStore.terminals.filter((t) => {
            const worktreeId = typeof t.worktreeId === "string" ? t.worktreeId.trim() : "";
            return worktreeId && !worktreeIds.has(worktreeId) && t.location !== "trash";
          });

          if (orphanedTerminals.length > 0) {
            console.log(
              `[WorktreeDataStore] Trashing ${orphanedTerminals.length} orphaned terminal(s) from deleted worktrees`
            );
            orphanedTerminals.forEach((terminal) => terminalStore.trashTerminal(terminal.id));
          }
        };

        runOrphanCleanup();
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
  useWorktreeDataStore.setState({
    worktrees: new Map(),
    isLoading: true,
    error: null,
    isInitialized: false,
  });
  // Trigger initialization
  useWorktreeDataStore.getState().initialize();
}
