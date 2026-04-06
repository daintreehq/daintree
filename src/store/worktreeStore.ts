import { create, type StateCreator } from "zustand";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import { useFocusStore } from "@/store/focusStore";
import { logErrorWithContext } from "@/utils/errorContext";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { setWorktreeSelectionStoreGetter } from "./projectStore";

interface CreateDialogState {
  isOpen: boolean;
  initialIssue: GitHubIssue | null;
  initialPR: GitHubPR | null;
  initialRecipeId: string | null;
  onCreated?: (worktreeId: string) => void;
}

interface QuickCreateState {
  isOpen: boolean;
  issue: GitHubIssue | null;
  pr: GitHubPR | null;
}

interface BulkCreateDialogState {
  isOpen: boolean;
  mode: "issue" | "pr";
  selectedIssues: GitHubIssue[];
  selectedPRs: GitHubPR[];
}

interface CrossDiffDialogState {
  isOpen: boolean;
  initialWorktreeId: string | null;
}

interface WorktreeSelectionState {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  pendingWorktreeId: string | null;
  expandedWorktrees: Set<string>;
  expandedTerminals: Set<string>;
  createDialog: CreateDialogState;
  bulkCreateDialog: BulkCreateDialogState;
  quickCreate: QuickCreateState;
  crossDiffDialog: CrossDiffDialogState;
  _policyGeneration: number;
  lastFocusedTerminalByWorktree: Map<string, string>;

  setActiveWorktree: (id: string | null) => void;
  setFocusedWorktree: (id: string | null) => void;
  selectWorktree: (id: string) => void;
  setPendingWorktree: (id: string | null) => void;
  applyPendingWorktreeSelection: (worktreeId: string) => void;
  toggleWorktreeExpanded: (id: string) => void;
  setWorktreeExpanded: (id: string, expanded: boolean) => void;
  collapseAllWorktrees: () => void;
  toggleTerminalsExpanded: (id: string) => void;
  setTerminalsExpanded: (id: string, expanded: boolean) => void;
  openCreateDialog: (
    initialIssue?: GitHubIssue | null,
    options?: { initialRecipeId?: string | null; onCreated?: (worktreeId: string) => void }
  ) => void;
  openCreateDialogForPR: (pr: GitHubPR) => void;
  closeCreateDialog: () => void;
  openBulkCreateDialog: (selectedIssues: GitHubIssue[]) => void;
  openBulkCreateDialogForPRs: (selectedPRs: GitHubPR[]) => void;
  closeBulkCreateDialog: () => void;
  openQuickCreate: (context?: { issue?: GitHubIssue | null; pr?: GitHubPR | null }) => void;
  closeQuickCreate: () => void;
  openCrossWorktreeDiff: (initialWorktreeId?: string | null) => void;
  closeCrossWorktreeDiff: () => void;
  trackTerminalFocus: (worktreeId: string, terminalId: string) => void;
  clearWorktreeFocusTracking: (worktreeId: string) => void;
  reset: () => void;
}

type ClientsModule = typeof import("@/clients");
type TerminalStoreModule = typeof import("@/store/panelStore");

let clientsModulePromise: Promise<ClientsModule> | null = null;
let terminalStoreModulePromise: Promise<TerminalStoreModule> | null = null;
let lastPersistedActiveWorktreeId: string | null | undefined;
let pendingPersistActiveWorktreeId: string | null | undefined;
let persistRequestVersion = 0;

let lastPersistedMruList: string[] | undefined;
let pendingPersistMruList: string[] | undefined;
let mruPersistVersion = 0;
let mruRecordingSuppressed = false;

/** Call before app/project hydration to prevent hydration focus events from corrupting MRU. */
export function suppressMruRecording(suppress: boolean): void {
  mruRecordingSuppressed = suppress;
}

export function isMruRecordingSuppressed(): boolean {
  return mruRecordingSuppressed;
}

function mruListsEqual(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function persistMruList(list: string[]): void {
  if (mruListsEqual(pendingPersistMruList ?? lastPersistedMruList, list)) {
    return;
  }

  pendingPersistMruList = list;
  const requestVersion = ++mruPersistVersion;

  void loadClientsModule()
    .then(({ appClient }) => appClient.setState({ mruList: list }))
    .then(() => {
      if (requestVersion === mruPersistVersion) {
        lastPersistedMruList = list;
        pendingPersistMruList = undefined;
      }
    })
    .catch((error) => {
      if (requestVersion === mruPersistVersion) {
        pendingPersistMruList = undefined;
      }
      logErrorWithContext(error, {
        operation: "persist_mru_list",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { listLength: list.length },
      });
    });
}

function loadClientsModule(): Promise<ClientsModule> {
  if (!clientsModulePromise) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    markRendererPerformance("dynamic_import_start", { module: "@/clients" });
    clientsModulePromise = import("@/clients")
      .then((module) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/clients",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: true,
        });
        return module;
      })
      .catch((error) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/clients",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }
  return clientsModulePromise;
}

function loadTerminalStoreModule(): Promise<TerminalStoreModule> {
  if (!terminalStoreModulePromise) {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    markRendererPerformance("dynamic_import_start", { module: "@/store/panelStore" });
    terminalStoreModulePromise = import("@/store/panelStore")
      .then((module) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/store/panelStore",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: true,
        });
        return module;
      })
      .catch((error) => {
        const now = typeof performance !== "undefined" ? performance.now() : Date.now();
        markRendererPerformance("dynamic_import_end", {
          module: "@/store/panelStore",
          durationMs: Number((now - startedAt).toFixed(3)),
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }
  return terminalStoreModulePromise;
}

function persistActiveWorktree(id: string | null): void {
  if (id === lastPersistedActiveWorktreeId || id === pendingPersistActiveWorktreeId) {
    return;
  }

  pendingPersistActiveWorktreeId = id;
  const requestVersion = ++persistRequestVersion;

  const payload = { activeWorktreeId: id ?? undefined };

  void loadClientsModule()
    .then(({ appClient }) => appClient.setState(payload))
    .then(() => {
      if (requestVersion === persistRequestVersion) {
        lastPersistedActiveWorktreeId = id;
      }
    })
    .catch((error) => {
      if (requestVersion === persistRequestVersion) {
        pendingPersistActiveWorktreeId = undefined;
      }
      logErrorWithContext(error, {
        operation: "persist_active_worktree",
        component: "worktreeStore",
        errorType: "filesystem",
        details: { worktreeId: id },
      });
    })
    .finally(() => {
      if (pendingPersistActiveWorktreeId === id) {
        pendingPersistActiveWorktreeId = undefined;
      }
    });
}

const createWorktreeSelectionStore: StateCreator<WorktreeSelectionState> = (set, get) => ({
  activeWorktreeId: null,
  focusedWorktreeId: null,
  pendingWorktreeId: null,
  expandedWorktrees: new Set<string>(),
  expandedTerminals: new Set<string>(),
  createDialog: {
    isOpen: false,
    initialIssue: null,
    initialPR: null,
    initialRecipeId: null,
    onCreated: undefined,
  },
  bulkCreateDialog: { isOpen: false, mode: "issue", selectedIssues: [], selectedPRs: [] },
  quickCreate: { isOpen: false, issue: null, pr: null },
  crossDiffDialog: { isOpen: false, initialWorktreeId: null },
  _policyGeneration: 0,
  lastFocusedTerminalByWorktree: new Map<string, string>(),

  setActiveWorktree: (id) => {
    const previousId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    const switchStartedAt = Date.now();
    markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_START, {
      fromWorktreeId: previousId ?? null,
      toWorktreeId: id ?? null,
    });

    // Auto-collapse terminals accordion when switching worktrees
    const updates: Partial<WorktreeSelectionState> = {
      activeWorktreeId: id,
      focusedWorktreeId: id,
      _policyGeneration: generation,
    };

    if (previousId !== id) {
      updates.expandedTerminals = new Set<string>();
    }

    set(updates);

    persistActiveWorktree(id);

    applyWorktreeTerminalPolicy(get, set, id, generation, () => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_END, {
        fromWorktreeId: previousId ?? null,
        toWorktreeId: id ?? null,
        durationMs: Date.now() - switchStartedAt,
      });
    });
  },

  setFocusedWorktree: (id) => set({ focusedWorktreeId: id }),

  selectWorktree: (id) => {
    // Skip if already active to prevent terminal reload flicker.
    // Also clear any pending selection for this ID — it's already active,
    // so the terminal policy was applied when we first selected it.
    if (get().activeWorktreeId === id) {
      if (get().pendingWorktreeId === id) {
        set({ pendingWorktreeId: null });
      }
      return;
    }

    const previousId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    const switchStartedAt = Date.now();
    markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_START, {
      fromWorktreeId: previousId ?? null,
      toWorktreeId: id,
    });
    // Auto-collapse terminals accordion when switching worktrees
    set({
      activeWorktreeId: id,
      focusedWorktreeId: id,
      _policyGeneration: generation,
      expandedTerminals: new Set<string>(),
    });

    persistActiveWorktree(id);

    // Record worktree MRU on explicit selection (suppressed during hydration)
    if (!mruRecordingSuppressed) {
      void loadTerminalStoreModule()
        .then(({ usePanelStore }) => {
          usePanelStore.getState().recordMru(`worktree:${id}`);
          persistMruList(usePanelStore.getState().mruList);
        })
        .catch(() => {});
    }

    applyWorktreeTerminalPolicy(get, set, id, generation, () => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_END, {
        fromWorktreeId: previousId ?? null,
        toWorktreeId: id,
        durationMs: Date.now() - switchStartedAt,
      });
    });

    // Restore the last focused terminal for this worktree
    const lastFocusedTerminalId = get().lastFocusedTerminalByWorktree.get(id);
    if (lastFocusedTerminalId) {
      void loadTerminalStoreModule()
        .then(({ usePanelStore }) => {
          // Check generation to ensure we're not applying stale focus from a previous switch
          if (get()._policyGeneration !== generation) return;
          // Verify the worktree hasn't changed
          if (get().activeWorktreeId !== id) return;

          const terminal = usePanelStore.getState().panelsById[lastFocusedTerminalId];

          // Validate terminal still exists, belongs to this worktree, and isn't in trash
          if (terminal && terminal.worktreeId === id && terminal.location !== "trash") {
            usePanelStore.getState().setFocused(lastFocusedTerminalId);
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

  setPendingWorktree: (id) => set({ pendingWorktreeId: id }),

  applyPendingWorktreeSelection: (worktreeId) => {
    const state = get();
    if (state.pendingWorktreeId !== worktreeId) {
      return;
    }
    // Always clear pending — if the active worktree has since changed, this pending is stale.
    set({ pendingWorktreeId: null });
    // Only apply terminal policy if this worktree is still the active one.
    if (state.activeWorktreeId !== worktreeId) {
      return;
    }
    const generation = state._policyGeneration;
    applyWorktreeTerminalPolicy(get, set, worktreeId, generation);
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

  openCreateDialog: (initialIssue = null, options) => {
    if (useFocusStore.getState().isFocusMode && typeof window !== "undefined") {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue,
        initialPR: null,
        initialRecipeId: options?.initialRecipeId ?? null,
        onCreated: options?.onCreated,
      },
    });
  },

  openCreateDialogForPR: (pr) => {
    if (useFocusStore.getState().isFocusMode && typeof window !== "undefined") {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue: null,
        initialPR: pr,
        initialRecipeId: null,
        onCreated: undefined,
      },
    });
  },

  closeCreateDialog: () =>
    set({
      createDialog: {
        isOpen: false,
        initialIssue: null,
        initialPR: null,
        initialRecipeId: null,
        onCreated: undefined,
      },
    }),

  openBulkCreateDialog: (selectedIssues) => {
    if (useFocusStore.getState().isFocusMode && typeof window !== "undefined") {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({ bulkCreateDialog: { isOpen: true, mode: "issue", selectedIssues, selectedPRs: [] } });
  },

  openBulkCreateDialogForPRs: (selectedPRs) => {
    if (useFocusStore.getState().isFocusMode && typeof window !== "undefined") {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({ bulkCreateDialog: { isOpen: true, mode: "pr", selectedIssues: [], selectedPRs } });
  },

  closeBulkCreateDialog: () =>
    set((s) => ({ bulkCreateDialog: { ...s.bulkCreateDialog, isOpen: false } })),

  openQuickCreate: (context) => {
    if (useFocusStore.getState().isFocusMode && typeof window !== "undefined") {
      window.dispatchEvent(new Event("canopy:toggle-focus-mode"));
    }
    set({
      quickCreate: {
        isOpen: true,
        issue: context?.issue ?? null,
        pr: context?.pr ?? null,
      },
    });
  },

  closeQuickCreate: () => set({ quickCreate: { isOpen: false, issue: null, pr: null } }),

  openCrossWorktreeDiff: (initialWorktreeId = null) =>
    set({ crossDiffDialog: { isOpen: true, initialWorktreeId } }),

  closeCrossWorktreeDiff: () =>
    set({ crossDiffDialog: { isOpen: false, initialWorktreeId: null } }),

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
      pendingWorktreeId: null,
      expandedWorktrees: new Set<string>(),
      expandedTerminals: new Set<string>(),
      createDialog: {
        isOpen: false,
        initialIssue: null,
        initialPR: null,
        initialRecipeId: null,
        onCreated: undefined,
      },
      bulkCreateDialog: { isOpen: false, mode: "issue", selectedIssues: [], selectedPRs: [] },
      quickCreate: { isOpen: false, issue: null, pr: null },
      crossDiffDialog: { isOpen: false, initialWorktreeId: null },
      lastFocusedTerminalByWorktree: new Map<string, string>(),
    }),
});

export const useWorktreeSelectionStore = create<WorktreeSelectionState>()(
  createWorktreeSelectionStore
);

// Inject lazy reference into projectStore to break circular dependency.
setWorktreeSelectionStoreGetter(() => useWorktreeSelectionStore.getState());

function applyWorktreeTerminalPolicy(
  get: () => WorktreeSelectionState,
  _set: (partial: Partial<WorktreeSelectionState>) => void,
  targetWorktreeId: string | null,
  generation: number,
  onComplete?: () => void
) {
  // Reliability: terminals from inactive worktrees should not stream output to the renderer.
  // They remain alive in the backend headless model and will be restored on wake.
  // Terminals in the active worktree must be activated to resume streaming.
  void loadTerminalStoreModule()
    .then(({ usePanelStore }) => {
      // Check generation to ensure we're not applying a stale policy from a previous switch
      if (get()._policyGeneration !== generation) return;
      // Double check that the active worktree hasn't changed underneath us
      if ((get().activeWorktreeId ?? null) !== (targetWorktreeId ?? null)) return;

      const { panelsById, panelIds } = usePanelStore.getState();
      const activeDockTerminalId = usePanelStore.getState().activeDockTerminalId;

      for (const id of panelIds) {
        const terminal = panelsById[id];
        if (!terminal) continue;
        const isInActiveWorktree = (terminal.worktreeId ?? null) === (targetWorktreeId ?? null);

        const location = terminal.location ?? "grid";
        const isDockOrTrash = location === "dock" || location === "trash";

        // Let DockedTerminalItem manage open/closed dock policy, but if the active dock
        // terminal is not in the active worktree, force it to BACKGROUND.
        if (terminal.id === activeDockTerminalId && isDockOrTrash && isInActiveWorktree) {
          continue;
        }

        const targetTier =
          isInActiveWorktree && !isDockOrTrash
            ? TerminalRefreshTier.VISIBLE
            : TerminalRefreshTier.BACKGROUND;

        // Apply appropriate renderer policy based on worktree membership.
        // Avoid waking dock/trash terminals - they manage their own visibility.
        // applyRendererPolicy handles backend tier transitions internally.
        terminalInstanceService.applyRendererPolicy(terminal.id, targetTier);
      }

      onComplete?.();
    })
    .catch((error) => {
      logErrorWithContext(error, {
        operation: "apply_terminal_streaming_policy",
        component: "worktreeStore",
        errorType: "process",
        details: { targetWorktreeId, generation },
      });
      onComplete?.();
    });
}
