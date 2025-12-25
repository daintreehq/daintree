import type { StateCreator } from "zustand";
import type { TerminalInstance } from "./terminalRegistrySlice";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export type NavigationDirection = "up" | "down" | "left" | "right";

interface PreMaximizeLayoutSnapshot {
  gridCols: number;
  gridItemCount: number;
  worktreeId: string | undefined;
}

export interface TerminalFocusSlice {
  focusedId: string | null;
  maximizedId: string | null;
  activeDockTerminalId: string | null;
  pingedId: string | null;
  preMaximizeLayout: PreMaximizeLayoutSnapshot | null;

  setFocused: (id: string | null, shouldPing?: boolean) => void;
  pingTerminal: (id: string) => void;
  toggleMaximize: (id: string, currentGridCols?: number, currentGridItemCount?: number) => void;
  clearPreMaximizeLayout: () => void;
  focusNext: () => void;
  focusPrevious: () => void;
  focusDirection: (
    direction: NavigationDirection,
    findNearest: (id: string, dir: NavigationDirection) => string | null
  ) => void;
  focusByIndex: (index: number, findByIndex: (idx: number) => string | null) => void;
  focusDockDirection: (
    direction: "left" | "right",
    findDockByIndex: (id: string, dir: "left" | "right") => string | null
  ) => void;

  // Dock terminal activation
  openDockTerminal: (id: string) => void;
  closeDockTerminal: () => void;
  activateTerminal: (id: string) => void;

  // Waiting agent navigation
  focusNextWaiting: (isInTrash: (id: string) => boolean) => void;

  handleTerminalRemoved: (
    removedId: string,
    terminals: TerminalInstance[],
    removedIndex: number
  ) => void;
}

export const createTerminalFocusSlice =
  (
    getTerminals: () => TerminalInstance[]
  ): StateCreator<TerminalFocusSlice, [], [], TerminalFocusSlice> =>
  (set, get) => {
    let pingTimeout: ReturnType<typeof setTimeout> | null = null;

    return {
      focusedId: null,
      maximizedId: null,
      activeDockTerminalId: null,
      pingedId: null,
      preMaximizeLayout: null,

      setFocused: (id, shouldPing = false) => {
        set({ focusedId: id });
        if (id) {
          // Wake-on-focus: sync terminal state from backend when focused.
          // This is a safety net to recover from any missed data.
          // Skip wake for browser panes - they don't have backend PTY processes.
          const terminal = getTerminals().find((t) => t.id === id);
          if (terminal?.kind !== "browser") {
            terminalInstanceService.wake(id);
          }
          if (shouldPing) {
            get().pingTerminal(id);
          }
        }
      },

      pingTerminal: (id) => {
        if (pingTimeout) clearTimeout(pingTimeout);
        set({ pingedId: id });
        pingTimeout = setTimeout(() => {
          if (get().pingedId === id) {
            set({ pingedId: null });
          }
          pingTimeout = null;
        }, 1600);
      },

      toggleMaximize: (id, currentGridCols, currentGridItemCount) =>
        set((state) => {
          const isMaximizing = state.maximizedId !== id;
          const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

          if (isMaximizing) {
            if (currentGridCols !== undefined && currentGridItemCount !== undefined) {
              return {
                maximizedId: id,
                preMaximizeLayout: {
                  gridCols: currentGridCols,
                  gridItemCount: currentGridItemCount,
                  worktreeId: activeWorktreeId ?? undefined,
                },
              };
            } else {
              return {
                maximizedId: id,
                preMaximizeLayout: null,
              };
            }
          } else {
            return {
              maximizedId: null,
            };
          }
        }),

      clearPreMaximizeLayout: () =>
        set({
          preMaximizeLayout: null,
        }),

      focusNext: () => {
        const terminals = getTerminals();
        // Only navigate through grid terminals (not docked ones)
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        const gridTerminals = terminals.filter(
          (t) =>
            (t.location === "grid" || !t.location) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
        if (gridTerminals.length === 0) return;

        set((state) => {
          const currentIndex = state.focusedId
            ? gridTerminals.findIndex((t) => t.id === state.focusedId)
            : -1;
          const nextIndex = (currentIndex + 1) % gridTerminals.length;
          return { focusedId: gridTerminals[nextIndex].id };
        });
      },

      focusPrevious: () => {
        const terminals = getTerminals();
        // Only navigate through grid terminals (not docked ones)
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        const gridTerminals = terminals.filter(
          (t) =>
            (t.location === "grid" || !t.location) &&
            (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
        );
        if (gridTerminals.length === 0) return;

        set((state) => {
          const currentIndex = state.focusedId
            ? gridTerminals.findIndex((t) => t.id === state.focusedId)
            : 0;
          const prevIndex = currentIndex <= 0 ? gridTerminals.length - 1 : currentIndex - 1;
          return { focusedId: gridTerminals[prevIndex].id };
        });
      },

      focusDirection: (direction, findNearest) => {
        set((state) => {
          if (!state.focusedId) return state;
          const nextId = findNearest(state.focusedId, direction);
          if (nextId) {
            return { focusedId: nextId };
          }
          return state;
        });
      },

      focusByIndex: (index, findByIndex) => {
        const nextId = findByIndex(index);
        if (nextId) {
          set({ focusedId: nextId });
        }
      },

      focusDockDirection: (direction, findDockByIndex) => {
        set((state) => {
          if (!state.focusedId) return state;
          const nextId = findDockByIndex(state.focusedId, direction);
          if (nextId) {
            return { focusedId: nextId };
          }
          return state;
        });
      },

      openDockTerminal: (id) => {
        // Skip wake for browser panes - they don't have backend PTY processes.
        const terminal = getTerminals().find((t) => t.id === id);
        if (terminal?.kind !== "browser") {
          terminalInstanceService.wake(id);
        }
        set({ activeDockTerminalId: id, focusedId: id });
      },

      closeDockTerminal: () => set({ activeDockTerminalId: null }),

      activateTerminal: (id) => {
        const terminals = getTerminals();
        const terminal = terminals.find((t) => t.id === id);
        if (!terminal) return;

        // Wake-on-focus: sync terminal state from backend when activated.
        // Skip wake for browser panes - they don't have backend PTY processes.
        if (terminal.kind !== "browser") {
          terminalInstanceService.wake(id);
        }

        if (terminal.location === "dock") {
          set({ activeDockTerminalId: id, focusedId: id });
        } else {
          set({ focusedId: id, activeDockTerminalId: null });
        }
      },

      focusNextWaiting: (isInTrash) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all waiting terminals excluding trash
        const waitingTerminals = terminals.filter(
          (t) => t.agentState === "waiting" && !isInTrash(t.id)
        );

        if (waitingTerminals.length === 0) return;

        // Find current index in waiting list
        const currentIndex = waitingTerminals.findIndex((t) => t.id === focusedId);

        // Calculate next index with wrap-around
        const nextIndex = (currentIndex + 1) % waitingTerminals.length;
        const nextTerminal = waitingTerminals[nextIndex];

        const worktreeStore = useWorktreeSelectionStore.getState();
        if (nextTerminal.worktreeId && nextTerminal.worktreeId !== worktreeStore.activeWorktreeId) {
          worktreeStore.trackTerminalFocus(nextTerminal.worktreeId, nextTerminal.id);
          worktreeStore.selectWorktree(nextTerminal.worktreeId);
        }

        // Activate and ping the terminal for visual feedback
        activateTerminal(nextTerminal.id);
        pingTerminal(nextTerminal.id);
      },

      handleTerminalRemoved: (removedId, remainingTerminals, removedIndex) => {
        const state = get();
        if (state.pingedId === removedId && pingTimeout) {
          clearTimeout(pingTimeout);
          pingTimeout = null;
        }

        set((state) => {
          const updates: Partial<TerminalFocusSlice> = {};

          if (state.pingedId === removedId) {
            updates.pingedId = null;
          }

          if (state.focusedId === removedId) {
            const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
            const gridTerminals = remainingTerminals.filter(
              (t) =>
                (t.location === "grid" || !t.location) &&
                (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
            );

            if (gridTerminals.length > 0) {
              const boundedIndex = Math.max(0, removedIndex);
              const precedingCount = remainingTerminals
                .slice(0, boundedIndex)
                .filter(
                  (t) =>
                    (t.location === "grid" || !t.location) &&
                    (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
                ).length;
              const nextIndex = Math.min(precedingCount, gridTerminals.length - 1);
              updates.focusedId = gridTerminals[nextIndex]?.id || null;
            } else {
              updates.focusedId = null;
            }
          }

          if (state.maximizedId === removedId) {
            updates.maximizedId = null;
            updates.preMaximizeLayout = null;
          }

          if (state.activeDockTerminalId === removedId) {
            updates.activeDockTerminalId = null;
          }

          return Object.keys(updates).length > 0 ? updates : state;
        });
      },
    };
  };
