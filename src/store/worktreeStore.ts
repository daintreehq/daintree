import { create, type StateCreator } from "zustand";
import { appClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/domain";
import type { GitHubIssue } from "@shared/types/github";
import { useFocusStore } from "@/store/focusStore";
import { logErrorWithContext } from "@/utils/errorContext";

interface CreateDialogState {
  isOpen: boolean;
  initialIssue: GitHubIssue | null;
}

interface WorktreeSelectionState {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  expandedWorktrees: Set<string>;
  expandedTerminals: Set<string>;
  createDialog: CreateDialogState;
  _policyGeneration: number;
  lastFocusedTerminalByWorktree: Map<string, string>;

  setActiveWorktree: (id: string | null) => void;
  setFocusedWorktree: (id: string | null) => void;
  selectWorktree: (id: string) => void;
  toggleWorktreeExpanded: (id: string) => void;
  setWorktreeExpanded: (id: string, expanded: boolean) => void;
  collapseAllWorktrees: () => void;
  toggleTerminalsExpanded: (id: string) => void;
  setTerminalsExpanded: (id: string, expanded: boolean) => void;
  openCreateDialog: (initialIssue?: GitHubIssue | null) => void;
  closeCreateDialog: () => void;
  trackTerminalFocus: (worktreeId: string, terminalId: string) => void;
  clearWorktreeFocusTracking: (worktreeId: string) => void;
  reset: () => void;
}

const createWorktreeSelectionStore: StateCreator<WorktreeSelectionState> = (set, get) => ({
  activeWorktreeId: null,
  focusedWorktreeId: null,
  expandedWorktrees: new Set<string>(),
  expandedTerminals: new Set<string>(),
  createDialog: { isOpen: false, initialIssue: null },
  _policyGeneration: 0,
  lastFocusedTerminalByWorktree: new Map<string, string>(),

  setActiveWorktree: (id) => {
    const previousId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;

    // Auto-collapse terminals accordion when switching worktrees
    const updates: Partial<WorktreeSelectionState> = {
      activeWorktreeId: id,
      _policyGeneration: generation,
    };

    if (previousId !== id) {
      updates.expandedTerminals = new Set<string>();
    }

    set(updates);

    appClient.setState({ activeWorktreeId: id ?? undefined }).catch((error) => {
      logErrorWithContext(error, {
        operation: "persist_active_worktree",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { worktreeId: id },
      });
    });

    applyWorktreeTerminalPolicy(get, set, id, generation);
  },

  setFocusedWorktree: (id) => set({ focusedWorktreeId: id }),

  selectWorktree: (id) => {
    // Skip if already active to prevent terminal reload flicker
    if (get().activeWorktreeId === id) {
      return;
    }

    const generation = get()._policyGeneration + 1;
    // Auto-collapse terminals accordion when switching worktrees
    set({
      activeWorktreeId: id,
      focusedWorktreeId: id,
      _policyGeneration: generation,
      expandedTerminals: new Set<string>(),
    });

    appClient.setState({ activeWorktreeId: id }).catch((error) => {
      logErrorWithContext(error, {
        operation: "persist_active_worktree",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { worktreeId: id },
      });
    });

    applyWorktreeTerminalPolicy(get, set, id, generation);

    // Restore the last focused terminal for this worktree
    const lastFocusedTerminalId = get().lastFocusedTerminalByWorktree.get(id);
    if (lastFocusedTerminalId) {
      void import("@/store/terminalStore")
        .then(({ useTerminalStore }) => {
          // Check generation to ensure we're not applying stale focus from a previous switch
          if (get()._policyGeneration !== generation) return;
          // Verify the worktree hasn't changed
          if (get().activeWorktreeId !== id) return;

          const terminals = useTerminalStore.getState().terminals;
          const terminal = terminals.find((t) => t.id === lastFocusedTerminalId);

          // Validate terminal still exists, belongs to this worktree, and isn't in trash
          if (terminal && terminal.worktreeId === id && terminal.location !== "trash") {
            useTerminalStore.getState().setFocused(lastFocusedTerminalId);
          }
        })
        .catch((error) => {
          logErrorWithContext(error, {
            operation: "import_terminal_store_for_focus_restore",
            component: "worktreeStore",
            details: { worktreeId: id, lastFocusedTerminalId },
          });
        });
    }
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

  toggleTerminalsExpanded: (id) =>
    set((state) => {
      const next = new Set(state.expandedTerminals);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { expandedTerminals: next };
    }),

  setTerminalsExpanded: (id, expanded) =>
    set((state) => {
      const next = new Set(state.expandedTerminals);
      if (expanded) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return { expandedTerminals: next };
    }),

  openCreateDialog: (initialIssue = null) => {
    if (useFocusStore.getState().isFocusMode) {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({ createDialog: { isOpen: true, initialIssue } });
  },

  closeCreateDialog: () => set({ createDialog: { isOpen: false, initialIssue: null } }),

  trackTerminalFocus: (worktreeId, terminalId) =>
    set((state) => {
      const next = new Map(state.lastFocusedTerminalByWorktree);
      next.set(worktreeId, terminalId);
      return { lastFocusedTerminalByWorktree: next };
    }),

  clearWorktreeFocusTracking: (worktreeId) =>
    set((state) => {
      const next = new Map(state.lastFocusedTerminalByWorktree);
      next.delete(worktreeId);
      return { lastFocusedTerminalByWorktree: next };
    }),

  reset: () =>
    set({
      activeWorktreeId: null,
      focusedWorktreeId: null,
      expandedWorktrees: new Set<string>(),
      expandedTerminals: new Set<string>(),
      createDialog: { isOpen: false, initialIssue: null },
      lastFocusedTerminalByWorktree: new Map<string, string>(),
    }),
});

export const useWorktreeSelectionStore = create<WorktreeSelectionState>()(
  createWorktreeSelectionStore
);

let focusTrackingUnsubscribe: (() => void) | null = null;

export function setupWorktreeFocusTracking() {
  if (focusTrackingUnsubscribe !== null) {
    return () => {
      focusTrackingUnsubscribe?.();
      focusTrackingUnsubscribe = null;
    };
  }

  void import("@/store/terminalStore")
    .then(({ useTerminalStore }) => {
      let previousFocusedId: string | null = null;

      focusTrackingUnsubscribe = useTerminalStore.subscribe((state) => {
        const focusedId = state.focusedId;

        // Only track when focus changes
        if (focusedId === previousFocusedId) return;
        previousFocusedId = focusedId;

        if (!focusedId) return;

        const terminal = state.terminals.find((t) => t.id === focusedId);
        if (terminal?.worktreeId) {
          useWorktreeSelectionStore.getState().trackTerminalFocus(terminal.worktreeId, focusedId);
        }
      });
    })
    .catch((error) => {
      logErrorWithContext(error, {
        operation: "import_terminal_store_for_focus_tracking",
        component: "worktreeStore",
      });
    });

  return () => {
    focusTrackingUnsubscribe?.();
    focusTrackingUnsubscribe = null;
  };
}

export function cleanupWorktreeFocusTracking() {
  if (focusTrackingUnsubscribe) {
    focusTrackingUnsubscribe();
    focusTrackingUnsubscribe = null;
  }
}

function applyWorktreeTerminalPolicy(
  get: () => WorktreeSelectionState,
  _set: (partial: Partial<WorktreeSelectionState>) => void,
  targetWorktreeId: string | null,
  generation: number
) {
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
      logErrorWithContext(error, {
        operation: "apply_terminal_streaming_policy",
        component: "worktreeStore",
        errorType: "process",
        details: { targetWorktreeId, generation },
      });
    });
}
