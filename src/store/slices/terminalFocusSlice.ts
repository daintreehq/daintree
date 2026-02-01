import type { StateCreator } from "zustand";
import type { TerminalInstance } from "./terminalRegistrySlice";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isAgentTerminal } from "@/utils/terminalType";

export type NavigationDirection = "up" | "down" | "left" | "right";

function isTerminalOrphaned(terminal: TerminalInstance, worktreeIds: Set<string>): boolean {
  const worktreeId = typeof terminal.worktreeId === "string" ? terminal.worktreeId.trim() : "";
  if (!worktreeId) return false;
  return !worktreeIds.has(worktreeId);
}

function isTerminalVisible(
  terminal: TerminalInstance,
  isInTrash: (id: string) => boolean,
  worktreeIds: Set<string>
): boolean {
  if (isInTrash(terminal.id)) return false;
  if (terminal.location === "trash") return false;
  if (isTerminalOrphaned(terminal, worktreeIds)) return false;
  return true;
}

interface PreMaximizeLayoutSnapshot {
  gridCols: number;
  gridItemCount: number;
  worktreeId: string | undefined;
}

export type MaximizeTarget = { type: "panel"; id: string } | { type: "group"; id: string } | null;

export interface TerminalFocusSlice {
  focusedId: string | null;
  maximizedId: string | null;
  /** Tracks whether maximize is for a single panel or a tab group */
  maximizeTarget: MaximizeTarget;
  activeDockTerminalId: string | null;
  pingedId: string | null;
  preMaximizeLayout: PreMaximizeLayoutSnapshot | null;
  /** Tracks which panel is active in each tab group (groupId -> panelId) */
  activeTabByGroup: Map<string, string>;

  setFocused: (id: string | null, shouldPing?: boolean) => void;
  pingTerminal: (id: string) => void;
  toggleMaximize: (
    id: string,
    currentGridCols?: number,
    currentGridItemCount?: number,
    getPanelGroup?: (panelId: string) => { id: string; panelIds: string[] } | undefined
  ) => void;
  setMaximizedId: (id: string | null) => void;
  /** Get the maximize target (panel or group) */
  getMaximizeTarget: () => MaximizeTarget;
  /** Validate and cleanup maximize state if target is invalid */
  validateMaximizeTarget: (
    getPanelGroup: (panelId: string) => { id: string; panelIds: string[] } | undefined,
    getTerminal: (id: string) => TerminalInstance | undefined
  ) => void;
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

  // Agent state navigation
  focusNextWaiting: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  focusNextWorking: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  focusNextFailed: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;

  // Agent cycling (any state)
  focusNextAgent: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;
  focusPreviousAgent: (isInTrash: (id: string) => boolean, validWorktreeIds: Set<string>) => void;

  handleTerminalRemoved: (
    removedId: string,
    terminals: TerminalInstance[],
    removedIndex: number
  ) => void;

  // Tab group active tab tracking
  /** Set the active tab for a tab group */
  setActiveTab: (groupId: string, panelId: string) => void;
  /** Get the active tab ID for a tab group, returns null if group not tracked */
  getActiveTabId: (groupId: string) => string | null;
  /** Clean up stale entries when panels are removed (called internally) */
  cleanupStaleTabs: (validPanelIds: Set<string>) => void;
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
      maximizeTarget: null,
      activeDockTerminalId: null,
      pingedId: null,
      preMaximizeLayout: null,
      activeTabByGroup: new Map(),

      setFocused: (id, shouldPing = false) => {
        set({ focusedId: id });
        if (id) {
          // Wake-on-focus: sync terminal state from backend when focused.
          // This is a safety net to recover from any missed data.
          // Skip wake for non-PTY panels - they don't have backend PTY processes.
          const terminal = getTerminals().find((t) => t.id === id);
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
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

      toggleMaximize: (id, currentGridCols, currentGridItemCount, getPanelGroup) =>
        set((state) => {
          const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;

          // Check if we're unmaximizing
          // Unmaximize if:
          // 1. The maximized panel/group contains this panel
          // 2. We're clicking on a panel that's already maximized (same panel)
          // 3. We're clicking on any panel while a group is maximized that contains this panel
          let shouldUnmaximize = false;
          if (state.maximizeTarget) {
            if (state.maximizeTarget.type === "panel" && state.maximizeTarget.id === id) {
              shouldUnmaximize = true;
            } else if (state.maximizeTarget.type === "group") {
              if (getPanelGroup) {
                const group = getPanelGroup(id);
                if (group && group.id === state.maximizeTarget.id) {
                  shouldUnmaximize = true;
                }
              } else {
                // Backwards compatibility: if getPanelGroup not provided, fall back to panel ID check
                if (state.maximizedId === id) {
                  shouldUnmaximize = true;
                }
              }
            }
          } else if (state.maximizedId === id) {
            // Backwards compatibility: old behavior when no maximizeTarget
            shouldUnmaximize = true;
          }

          if (shouldUnmaximize) {
            return {
              maximizedId: null,
              maximizeTarget: null,
            };
          }

          // Maximizing - check if panel is in a group
          const group = getPanelGroup?.(id);
          const layoutSnapshot =
            currentGridCols !== undefined && currentGridItemCount !== undefined
              ? {
                  gridCols: currentGridCols,
                  gridItemCount: currentGridItemCount,
                  worktreeId: activeWorktreeId ?? undefined,
                }
              : null;

          if (group && group.panelIds.length > 1) {
            // Panel is in a group with multiple panels - maximize the entire group
            return {
              maximizedId: id, // Keep track of which panel triggered maximize for backwards compatibility
              maximizeTarget: { type: "group", id: group.id },
              preMaximizeLayout: layoutSnapshot,
            };
          } else {
            // Single panel (not in a group or group has only 1 panel) - maximize just the panel
            return {
              maximizedId: id,
              maximizeTarget: { type: "panel", id },
              preMaximizeLayout: layoutSnapshot,
            };
          }
        }),

      setMaximizedId: (id) =>
        set({
          maximizedId: id,
        }),

      getMaximizeTarget: () => get().maximizeTarget,

      validateMaximizeTarget: (getPanelGroup, getTerminal) => {
        const state = get();
        if (!state.maximizeTarget || !state.maximizedId) return;

        let shouldClear = false;

        if (state.maximizeTarget.type === "panel") {
          // Check if the panel still exists
          const terminal = getTerminal(state.maximizedId);
          if (!terminal || terminal.location === "trash") {
            shouldClear = true;
          }
        } else if (state.maximizeTarget.type === "group") {
          // Check if the group still exists and contains the maximized panel
          const group = getPanelGroup(state.maximizedId);
          if (!group || group.id !== state.maximizeTarget.id) {
            // Group is gone or panel moved out - clear maximize
            shouldClear = true;
          } else if (group.panelIds.length === 1) {
            // Group shrunk to single panel - downgrade to panel maximize
            set({
              maximizeTarget: { type: "panel", id: state.maximizedId },
            });
            return;
          }
        }

        if (shouldClear) {
          set({
            maximizedId: null,
            maximizeTarget: null,
            preMaximizeLayout: null,
          });
        }
      },

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
        // Skip wake for non-PTY panels - they don't have backend PTY processes.
        const terminal = getTerminals().find((t) => t.id === id);
        if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
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
        // Skip wake for non-PTY panels - they don't have backend PTY processes.
        if (panelKindHasPty(terminal.kind ?? "terminal")) {
          terminalInstanceService.wake(id);
        }

        if (terminal.location === "dock") {
          set({ activeDockTerminalId: id, focusedId: id });
        } else {
          set({ focusedId: id, activeDockTerminalId: null });
        }
      },

      focusNextWaiting: (isInTrash, validWorktreeIds) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all waiting terminals excluding trash and orphaned
        const waitingTerminals = terminals.filter(
          (t) => t.agentState === "waiting" && isTerminalVisible(t, isInTrash, validWorktreeIds)
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

      focusNextFailed: (isInTrash, validWorktreeIds) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all failed terminals excluding trash and orphaned
        const failedTerminals = terminals.filter(
          (t) => t.agentState === "failed" && isTerminalVisible(t, isInTrash, validWorktreeIds)
        );

        if (failedTerminals.length === 0) return;

        // Find current index in failed list
        const currentIndex = failedTerminals.findIndex((t) => t.id === focusedId);

        // Calculate next index with wrap-around
        const nextIndex = (currentIndex + 1) % failedTerminals.length;
        const nextTerminal = failedTerminals[nextIndex];

        const worktreeStore = useWorktreeSelectionStore.getState();
        if (nextTerminal.worktreeId && nextTerminal.worktreeId !== worktreeStore.activeWorktreeId) {
          worktreeStore.trackTerminalFocus(nextTerminal.worktreeId, nextTerminal.id);
          worktreeStore.selectWorktree(nextTerminal.worktreeId);
        }

        // Activate and ping the terminal for visual feedback
        activateTerminal(nextTerminal.id);
        pingTerminal(nextTerminal.id);
      },

      focusNextWorking: (isInTrash, validWorktreeIds) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all working terminals excluding trash and orphaned
        const workingTerminals = terminals.filter(
          (t) => t.agentState === "working" && isTerminalVisible(t, isInTrash, validWorktreeIds)
        );

        if (workingTerminals.length === 0) return;

        // Find current index in working list
        const currentIndex = workingTerminals.findIndex((t) => t.id === focusedId);

        // Calculate next index with wrap-around
        const nextIndex = (currentIndex + 1) % workingTerminals.length;
        const nextTerminal = workingTerminals[nextIndex];

        const worktreeStore = useWorktreeSelectionStore.getState();
        if (nextTerminal.worktreeId && nextTerminal.worktreeId !== worktreeStore.activeWorktreeId) {
          worktreeStore.trackTerminalFocus(nextTerminal.worktreeId, nextTerminal.id);
          worktreeStore.selectWorktree(nextTerminal.worktreeId);
        }

        // Activate and ping the terminal for visual feedback
        activateTerminal(nextTerminal.id);
        pingTerminal(nextTerminal.id);
      },

      focusNextAgent: (isInTrash, validWorktreeIds) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all agent terminals excluding trash and orphaned
        const agentTerminals = terminals.filter(
          (t) =>
            isAgentTerminal(t.kind ?? t.type, t.agentId) &&
            isTerminalVisible(t, isInTrash, validWorktreeIds)
        );

        if (agentTerminals.length === 0) return;

        // Find current index in agent list
        const currentIndex = agentTerminals.findIndex((t) => t.id === focusedId);

        // Calculate next index with wrap-around
        const nextIndex = (currentIndex + 1) % agentTerminals.length;
        const nextTerminal = agentTerminals[nextIndex];

        const worktreeStore = useWorktreeSelectionStore.getState();
        if (nextTerminal.worktreeId && nextTerminal.worktreeId !== worktreeStore.activeWorktreeId) {
          worktreeStore.trackTerminalFocus(nextTerminal.worktreeId, nextTerminal.id);
          worktreeStore.selectWorktree(nextTerminal.worktreeId);
        }

        // Activate and ping the terminal for visual feedback
        activateTerminal(nextTerminal.id);
        pingTerminal(nextTerminal.id);
      },

      focusPreviousAgent: (isInTrash, validWorktreeIds) => {
        const terminals = getTerminals();
        const { focusedId, activateTerminal, pingTerminal } = get();

        // Find all agent terminals excluding trash and orphaned
        const agentTerminals = terminals.filter(
          (t) =>
            isAgentTerminal(t.kind ?? t.type, t.agentId) &&
            isTerminalVisible(t, isInTrash, validWorktreeIds)
        );

        if (agentTerminals.length === 0) return;

        // Find current index in agent list
        const currentIndex = agentTerminals.findIndex((t) => t.id === focusedId);

        // Calculate previous index with wrap-around
        const prevIndex = currentIndex <= 0 ? agentTerminals.length - 1 : currentIndex - 1;
        const prevTerminal = agentTerminals[prevIndex];

        const worktreeStore = useWorktreeSelectionStore.getState();
        if (prevTerminal.worktreeId && prevTerminal.worktreeId !== worktreeStore.activeWorktreeId) {
          worktreeStore.trackTerminalFocus(prevTerminal.worktreeId, prevTerminal.id);
          worktreeStore.selectWorktree(prevTerminal.worktreeId);
        }

        // Activate and ping the terminal for visual feedback
        activateTerminal(prevTerminal.id);
        pingTerminal(prevTerminal.id);
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

          // Clear maximize state if the removed panel was maximized, or if it was in a maximized group
          if (state.maximizedId === removedId) {
            updates.maximizedId = null;
            updates.maximizeTarget = null;
            updates.preMaximizeLayout = null;
          } else if (state.maximizeTarget?.type === "group") {
            // Check if the removed panel was part of the maximized group
            // We need to validate the group still exists and is valid
            // This will be handled by the group cleanup logic in the registry slice
            // For now, we mark that validation is needed by checking in the next render
            // The ContentGrid will handle the fallback when it can't find the group
          }

          if (state.activeDockTerminalId === removedId) {
            updates.activeDockTerminalId = null;
          }

          return Object.keys(updates).length > 0 ? updates : state;
        });
      },

      setActiveTab: (groupId, panelId) => {
        set((state) => {
          const newMap = new Map(state.activeTabByGroup);
          newMap.set(groupId, panelId);
          return { activeTabByGroup: newMap };
        });
      },

      getActiveTabId: (groupId) => {
        return get().activeTabByGroup.get(groupId) ?? null;
      },

      cleanupStaleTabs: (validPanelIds) => {
        set((state) => {
          const newMap = new Map<string, string>();
          let changed = false;

          for (const [groupId, panelId] of state.activeTabByGroup) {
            if (validPanelIds.has(panelId)) {
              newMap.set(groupId, panelId);
            } else {
              changed = true;
            }
          }

          return changed ? { activeTabByGroup: newMap } : state;
        });
      },
    };
  };
