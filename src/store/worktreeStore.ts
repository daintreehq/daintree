import { create, type StateCreator } from "zustand";
import { appClient } from "@/clients";
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

const createWorktreeSelectionStore: StateCreator<WorktreeSelectionState> = (set) => ({
  activeWorktreeId: null,
  focusedWorktreeId: null,
  expandedWorktrees: new Set<string>(),
  createDialog: { isOpen: false, initialIssue: null },

  setActiveWorktree: (id) => {
    set({ activeWorktreeId: id });

    appClient.setState({ activeWorktreeId: id ?? undefined }).catch((error) => {
      console.error("Failed to persist active worktree:", error);
    });
  },

  setFocusedWorktree: (id) => set({ focusedWorktreeId: id }),

  selectWorktree: (id) => {
    set((state) => {
      // Toggle: clicking the active worktree deselects it
      const newId = state.activeWorktreeId === id ? null : id;

      appClient.setState({ activeWorktreeId: newId ?? undefined }).catch((error) => {
        console.error("Failed to persist active worktree:", error);
      });

      return { activeWorktreeId: newId, focusedWorktreeId: newId };
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
