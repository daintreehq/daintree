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
  _policyGeneration: number;

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
  _policyGeneration: 0,

  setActiveWorktree: (id) => {
    set({ activeWorktreeId: id });

    appClient.setState({ activeWorktreeId: id ?? undefined }).catch((error) => {
      console.error("Failed to persist active worktree:", error);
    });

    applyWorktreeTerminalPolicy(get, set, id);
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

    applyWorktreeTerminalPolicy(get, set, id);
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

function applyWorktreeTerminalPolicy(
  get: () => WorktreeSelectionState,
  set: (partial: Partial<WorktreeSelectionState>) => void,
  targetWorktreeId: string | null
) {
  const generation = get()._policyGeneration + 1;
  set({ _policyGeneration: generation });

  // Reliability: terminals from inactive worktrees should not stream output to the renderer.
  // They remain alive in the backend headless model and will be restored on wake.
  // Terminals in the active worktree must be activated to resume streaming.
  void import("@/store/terminalStore")
    .then(({ useTerminalStore }) => {
      // Check generation to ensure we're not applying a stale policy from a previous switch
      if (get()._policyGeneration !== generation) return;
      // Double check that the active worktree hasn't changed underneath us
      if ((get().activeWorktreeId ?? null) !== (targetWorktreeId ?? null)) return;

      const terminals = useTerminalStore.getState().terminals;
      const activeDockTerminalId = useTerminalStore.getState().activeDockTerminalId;

      for (const terminal of terminals) {
        const isInActiveWorktree = (terminal.worktreeId ?? null) === (targetWorktreeId ?? null);

        const location = terminal.location ?? "grid";
        const isDockOrTrash = location === "dock" || location === "trash";

        // Let DockedTerminalItem manage open/closed dock policy, but if the active dock
        // terminal is not in the active worktree, force it to BACKGROUND.
        if (terminal.id === activeDockTerminalId && isDockOrTrash && isInActiveWorktree) {
          continue;
        }

        // Apply appropriate renderer policy based on worktree membership.
        // Avoid waking dock/trash terminals - they manage their own visibility.
        // applyRendererPolicy handles backend tier transitions internally.
        terminalInstanceService.applyRendererPolicy(
          terminal.id,
          isInActiveWorktree && !isDockOrTrash
            ? TerminalRefreshTier.VISIBLE
            : TerminalRefreshTier.BACKGROUND
        );
      }
    })
    .catch((error) => {
      console.warn("[WorktreeStore] Failed to apply terminal streaming policy:", error);
    });
}
