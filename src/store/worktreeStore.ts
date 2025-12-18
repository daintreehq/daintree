import { create, type StateCreator } from "zustand";
import { appClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/domain";
import type { GitHubIssue } from "@shared/types/github";

interface CreateDialogState {
  isOpen: boolean;
  initialIssue: GitHubIssue | null;
}

interface WorktreeSelectionState {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  expandedWorktrees: Set<string>;
  createDialog: CreateDialogState;

  setActiveWorktree: (id: string | null) => void;
  setFocusedWorktree: (id: string | null) => void;
  selectWorktree: (id: string) => void;
  toggleWorktreeExpanded: (id: string) => void;
  setWorktreeExpanded: (id: string, expanded: boolean) => void;
  collapseAllWorktrees: () => void;
  openCreateDialog: (initialIssue?: GitHubIssue | null) => void;
  closeCreateDialog: () => void;
  reset: () => void;
}

const createWorktreeSelectionStore: StateCreator<WorktreeSelectionState> = (set, get) => ({
  activeWorktreeId: null,
  focusedWorktreeId: null,
  expandedWorktrees: new Set<string>(),
  createDialog: { isOpen: false, initialIssue: null },

  setActiveWorktree: (id) => {
    set({ activeWorktreeId: id });

    appClient.setState({ activeWorktreeId: id ?? undefined }).catch((error) => {
      console.error("Failed to persist active worktree:", error);
    });

    // Ensure terminals in the active worktree have VISIBLE render policy.
    // All terminals stay active - we don't background for reliability.
    void import("@/store/terminalStore")
      .then(({ useTerminalStore }) => {
        const terminals = useTerminalStore.getState().terminals;
        const activeDockTerminalId = useTerminalStore.getState().activeDockTerminalId;
        for (const terminal of terminals) {
          if (terminal.id === activeDockTerminalId) {
            continue;
          }
          const isInActiveWorktree = (terminal.worktreeId ?? null) === (id ?? null);
          if (isInActiveWorktree) {
            terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
          }
        }
      })
      .catch((error) => {
        console.warn("[WorktreeStore] Failed to apply terminal render policy:", error);
      });
  },

  setFocusedWorktree: (id) => set({ focusedWorktreeId: id }),

  selectWorktree: (id) => {
    // Skip if already active to prevent terminal reload flicker
    if (get().activeWorktreeId === id) {
      return;
    }

    set({ activeWorktreeId: id, focusedWorktreeId: id });

    appClient.setState({ activeWorktreeId: id }).catch((error) => {
      console.error("Failed to persist active worktree:", error);
    });

    void import("@/store/terminalStore")
      .then(({ useTerminalStore }) => {
        const terminals = useTerminalStore.getState().terminals;
        const activeDockTerminalId = useTerminalStore.getState().activeDockTerminalId;
        for (const terminal of terminals) {
          if (terminal.id === activeDockTerminalId) {
            continue;
          }
          const isInActiveWorktree = (terminal.worktreeId ?? null) === id;
          if (isInActiveWorktree) {
            terminalInstanceService.applyRendererPolicy(terminal.id, TerminalRefreshTier.VISIBLE);
          }
        }
      })
      .catch((error) => {
        console.warn("[WorktreeStore] Failed to apply terminal streaming policy:", error);
      });
  },

  toggleWorktreeExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedWorktrees);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedWorktrees: next };
    }),

  setWorktreeExpanded: (id, expanded) =>
    set((state) => {
      const next = new Set(state.expandedWorktrees);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return { expandedWorktrees: next };
    }),

  collapseAllWorktrees: () => set({ expandedWorktrees: new Set<string>() }),

  openCreateDialog: (initialIssue = null) => set({ createDialog: { isOpen: true, initialIssue } }),

  closeCreateDialog: () => set({ createDialog: { isOpen: false, initialIssue: null } }),

  reset: () =>
    set({
      activeWorktreeId: null,
      focusedWorktreeId: null,
      expandedWorktrees: new Set<string>(),
      createDialog: { isOpen: false, initialIssue: null },
    }),
});

export const useWorktreeSelectionStore = create<WorktreeSelectionState>()(
  createWorktreeSelectionStore
);
