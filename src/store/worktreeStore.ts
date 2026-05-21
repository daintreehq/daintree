import { create, type StateCreator } from "zustand";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@shared/types/panel";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { GitHubIssue, GitHubPR } from "@shared/types/github";
import type { FleetScopeToken } from "@shared/types/worktree";
import { useFocusStore } from "@/store/focusStore";
import { usePanelStore } from "@/store/panelStore";
import { logErrorWithContext } from "@/utils/errorContext";
import { PERF_MARKS } from "@shared/perf/marks";
import { markRendererPerformance } from "@/utils/performance";
import { getFleetArmedIds, getFleetLastArmedId } from "./storeAccessors";
import { formatErrorMessage } from "@shared/utils/errorMessage";

interface CreateDialogState {
  isOpen: boolean;
  initialIssue: GitHubIssue | null;
  initialPR: GitHubPR | null;
  initialRecipeId: string | null;
  initialBranchInput: string | null;
  onCreated?: (worktreeId: string) => void;
}

export interface PendingCreation {
  path: string;
  branch: string;
  startedAt: number;
  status: "creating" | "error";
  error?: string;
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
  onComplete?: () => void;
}

interface CrossDiffDialogState {
  isOpen: boolean;
  initialWorktreeId: string | null;
}

interface WorktreeSelectionState {
  activeWorktreeId: string | null;
  focusedWorktreeId: string | null;
  pendingWorktreeId: string | null;
  pendingCreations: Map<string, PendingCreation>;
  expandedWorktrees: Set<string>;
  expandedTerminals: Set<string>;
  createDialog: CreateDialogState;
  bulkCreateDialog: BulkCreateDialogState;
  quickCreate: QuickCreateState;
  crossDiffDialog: CrossDiffDialogState;
  _policyGeneration: number;
  lastFocusedTerminalByWorktree: Map<string, string>;
  isFleetScopeActive: boolean;
  _previousActiveWorktreeId: string | null;
  _fleetScopeToken: FleetScopeToken | null;

  setActiveWorktree: (id: string | null) => void;
  setFocusedWorktree: (id: string | null) => void;
  selectWorktree: (id: string) => void;
  setPendingWorktree: (id: string | null) => void;
  applyPendingWorktreeSelection: (worktreeId: string) => void;
  addPendingCreation: (path: string, meta: { branch: string }) => void;
  resolvePendingCreation: (path: string) => void;
  failPendingCreation: (path: string, error: string) => void;
  dismissPendingCreation: (path: string) => void;
  toggleWorktreeExpanded: (id: string) => void;
  setWorktreeExpanded: (id: string, expanded: boolean) => void;
  collapseAllWorktrees: () => void;
  toggleTerminalsExpanded: (id: string) => void;
  setTerminalsExpanded: (id: string, expanded: boolean) => void;
  openCreateDialog: (
    initialIssue?: GitHubIssue | null,
    options?: {
      initialRecipeId?: string | null;
      initialBranchInput?: string | null;
      onCreated?: (worktreeId: string) => void;
    }
  ) => void;
  openCreateDialogForPR: (pr: GitHubPR) => void;
  closeCreateDialog: () => void;
  openBulkCreateDialog: (selectedIssues: GitHubIssue[], onComplete?: () => void) => void;
  openBulkCreateDialogForPRs: (selectedPRs: GitHubPR[], onComplete?: () => void) => void;
  closeBulkCreateDialog: () => void;
  openQuickCreate: (context?: { issue?: GitHubIssue | null; pr?: GitHubPR | null }) => void;
  closeQuickCreate: () => void;
  openCrossWorktreeDiff: (initialWorktreeId?: string | null) => void;
  closeCrossWorktreeDiff: () => void;
  trackTerminalFocus: (worktreeId: string, terminalId: string) => void;
  clearWorktreeFocusTracking: (worktreeId: string) => void;
  enterFleetScope: () => FleetScopeToken;
  exitFleetScope: (token: FleetScopeToken) => void;
  reset: () => void;
}

type ClientsModule = typeof import("@/clients");

let clientsModulePromise: Promise<ClientsModule> | null = null;
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
          error: formatErrorMessage(error, "Failed to load @/clients module"),
        });
        throw error;
      });
  }
  return clientsModulePromise;
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
  pendingCreations: new Map<string, PendingCreation>(),
  expandedWorktrees: new Set<string>(),
  expandedTerminals: new Set<string>(),
  createDialog: {
    isOpen: false,
    initialIssue: null,
    initialPR: null,
    initialRecipeId: null,
    initialBranchInput: null,
    onCreated: undefined,
  },
  bulkCreateDialog: {
    isOpen: false,
    mode: "issue",
    selectedIssues: [],
    selectedPRs: [],
    onComplete: undefined,
  },
  quickCreate: { isOpen: false, issue: null, pr: null },
  crossDiffDialog: { isOpen: false, initialWorktreeId: null },
  _policyGeneration: 0,
  lastFocusedTerminalByWorktree: new Map<string, string>(),
  isFleetScopeActive: false,
  _previousActiveWorktreeId: null,
  _fleetScopeToken: null,

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
      usePanelStore.getState().recordMru(`worktree:${id}`);
      persistMruList(usePanelStore.getState().mruList);
    }

    applyWorktreeTerminalPolicy(get, set, id, generation, () => {
      markRendererPerformance(PERF_MARKS.WORKTREE_SWITCH_END, {
        fromWorktreeId: previousId ?? null,
        toWorktreeId: id,
        durationMs: Date.now() - switchStartedAt,
      });
    });

    // Restore the last focused terminal for this worktree. Runs synchronously
    // in the same tick as the set() above, so the prior generation/active
    // guards are now dead — nothing between the set() and here can change
    // them. Only the terminal-validity checks remain load-bearing.
    const lastFocusedTerminalId = get().lastFocusedTerminalByWorktree.get(id);
    if (lastFocusedTerminalId) {
      const terminal = usePanelStore.getState().panelsById[lastFocusedTerminalId];
      // Validate terminal still exists, belongs to this worktree, and isn't in trash
      if (terminal && terminal.worktreeId === id && terminal.location !== "trash") {
        usePanelStore.getState().setFocused(lastFocusedTerminalId);
      }
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
    // Read _policyGeneration WITHOUT incrementing: this applies a pending
    // selection that was queued before the active worktree settled, so it
    // must not supersede an in-flight explicit transition that bumped the
    // generation after the pending was set — passing the current value lets
    // applyWorktreeTerminalPolicy's guard bail if that happened.
    const generation = state._policyGeneration;
    applyWorktreeTerminalPolicy(get, set, worktreeId, generation);
  },

  addPendingCreation: (path, meta) => {
    set((state) => {
      // Idempotent for in-flight creations (StrictMode-safe). An error entry is
      // replaced so a retry resubmission resets status to "creating".
      const existing = state.pendingCreations.get(path);
      if (existing && existing.status === "creating") return state;
      const next = new Map(state.pendingCreations);
      next.set(path, {
        path,
        branch: meta.branch,
        startedAt: Date.now(),
        status: "creating",
      });
      return { pendingCreations: next };
    });
  },

  resolvePendingCreation: (path) => {
    set((state) => {
      if (!state.pendingCreations.has(path)) return state;
      const next = new Map(state.pendingCreations);
      next.delete(path);
      return { pendingCreations: next };
    });
  },

  failPendingCreation: (path, error) => {
    set((state) => {
      const existing = state.pendingCreations.get(path);
      if (!existing) return state;
      const next = new Map(state.pendingCreations);
      next.set(path, { ...existing, status: "error", error });
      return { pendingCreations: next };
    });
  },

  dismissPendingCreation: (path) => {
    set((state) => {
      if (!state.pendingCreations.has(path)) return state;
      const next = new Map(state.pendingCreations);
      next.delete(path);
      return { pendingCreations: next };
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
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue,
        initialPR: null,
        initialRecipeId: options?.initialRecipeId ?? null,
        initialBranchInput: options?.initialBranchInput ?? null,
        onCreated: options?.onCreated,
      },
    });
  },

  openCreateDialogForPR: (pr) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      createDialog: {
        isOpen: true,
        initialIssue: null,
        initialPR: pr,
        initialRecipeId: null,
        initialBranchInput: null,
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
        initialBranchInput: null,
        onCreated: undefined,
      },
    }),

  openBulkCreateDialog: (selectedIssues, onComplete) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      bulkCreateDialog: {
        isOpen: true,
        mode: "issue",
        selectedIssues,
        selectedPRs: [],
        onComplete,
      },
    });
  },

  openBulkCreateDialogForPRs: (selectedPRs, onComplete) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
    }
    set({
      bulkCreateDialog: {
        isOpen: true,
        mode: "pr",
        selectedIssues: [],
        selectedPRs,
        onComplete,
      },
    });
  },

  closeBulkCreateDialog: () =>
    set((s) => ({
      bulkCreateDialog: { ...s.bulkCreateDialog, isOpen: false, onComplete: undefined },
    })),

  openQuickCreate: (context) => {
    // Restore the worktree sidebar (only) before opening a dialog that needs
    // it visible. The assistant gesture is left alone — dialogs don't depend
    // on the assistant. The sidebar's xterm resize suppression is handled by
    // a window event so the renderer side can call into sidebarToggle without
    // forcing a circular import (sidebarToggle reads worktree state, which
    // would otherwise require this store to depend on the lib).
    if (useFocusStore.getState().gestureSidebarHidden) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("daintree:suppress-sidebar-resizes"));
      }
      useFocusStore.getState().clearSidebarGesture();
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

  enterFleetScope: () => {
    // Idempotent: first pre-scope activeWorktreeId wins so the restoration
    // target isn't corrupted by a double-enter. Return the existing token so
    // a caller that re-enters still holds a token that matches the live scope.
    if (get().isFleetScopeActive) {
      // Non-null in this branch: an active scope always has a live token.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branded token narrowing
      return get()._fleetScopeToken as FleetScopeToken;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- branding an opaque uuid
    const token = crypto.randomUUID() as FleetScopeToken;
    const activeWorktreeId = get().activeWorktreeId;
    const generation = get()._policyGeneration + 1;
    set({
      isFleetScopeActive: true,
      _previousActiveWorktreeId: activeWorktreeId,
      _fleetScopeToken: token,
      _policyGeneration: generation,
    });
    // Clear any active maximize so the fleet-scope render path isn't shadowed
    // by the single-panel/group maximize branch in ContentGrid. Also clear the
    // preMaximizeLayout snapshot so exiting scope later doesn't restore a
    // stale layout captured against a different worktree. The earlier
    // idempotency guard already ensures we only reach here when scope is
    // active, so no further re-check is needed now that this runs in-tick
    // (the token-equality guard the dynamic-import path used inside its
    // microtask callback was solely to protect against a back-to-back
    // exit+re-enter that drained later — that race is structurally gone now).
    usePanelStore.setState({
      maximizedId: null,
      maximizeTarget: null,
      preMaximizeLayout: null,
    });
    // Promote armed cross-worktree terminals to VISIBLE so their xterm
    // instances actually stream live output inside the fleet grid. The
    // policy function consults `isFleetScopeActive` + the armed set.
    applyWorktreeTerminalPolicy(get, set, activeWorktreeId, generation);
    return token;
  },

  exitFleetScope: (token) => {
    // Token-equality guard: a stale exit whose async caller fired after a
    // newer `enterFleetScope()` carries an outdated token and is structurally
    // a no-op here — it can't restore against the wrong scope. This replaces
    // the prior `isFleetScopeActive` boolean check, which couldn't tell a
    // stale exit apart from a legitimate one.
    if (get()._fleetScopeToken !== token) return;
    const restoreId = get()._previousActiveWorktreeId;
    const generation = get()._policyGeneration + 1;
    // Snapshot the primary (most-recently-armed) terminal BEFORE `set()` so
    // the value used for focus restore is stable against any reads/writes
    // the in-tick clears below might trigger.
    const primaryTerminalId = getFleetLastArmedId();
    set({
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
      _fleetScopeToken: null,
      activeWorktreeId: restoreId,
      focusedWorktreeId: restoreId,
      _policyGeneration: generation,
    });
    persistActiveWorktree(restoreId);
    // Defensive: drop any preMaximizeLayout snapshot that may have survived
    // scope entry. The restored worktree's layout should be computed fresh.
    usePanelStore.setState({ preMaximizeLayout: null });
    // Focus the primary (most-recently-armed) terminal so the user lands on
    // a known pane instead of whatever `focusedId` happened to be during
    // fleet scope. Runs in-tick now, so the prior token/generation guards
    // inside the async callback are structurally dead — the set() above
    // already cleared `_fleetScopeToken` and bumped the generation in the
    // same tick, and nothing between that set() and here can mutate them.
    // Still guarded by:
    //   - worktreeId match: the user's scope-exit intent is "restore the
    //     pre-scope worktree". If the primary lives elsewhere, focusing it
    //     would let `rendererStoreOrchestrator`'s focusedId subscription
    //     call `selectWorktree(primary.worktreeId)` and undo the restore.
    //   - location: skip trashed/backgrounded/docked primaries — a dock
    //     focus would activate the dock rather than a grid pane, and
    //     trashed/background terminals aren't valid focus targets.
    if (primaryTerminalId && restoreId) {
      const terminal = usePanelStore.getState().panelsById[primaryTerminalId];
      if (
        terminal &&
        terminal.worktreeId === restoreId &&
        terminal.location !== "trash" &&
        terminal.location !== "background" &&
        terminal.location !== "dock"
      ) {
        usePanelStore.getState().setFocused(primaryTerminalId);
      }
    }
    // Reconcile terminal streaming tiers: consumers may have mutated
    // activeWorktreeId during scope, so the renderer policy must be
    // reapplied for the restored worktree.
    applyWorktreeTerminalPolicy(get, set, restoreId, generation);
  },

  reset: () =>
    set({
      activeWorktreeId: null,
      focusedWorktreeId: null,
      pendingWorktreeId: null,
      pendingCreations: new Map<string, PendingCreation>(),
      expandedWorktrees: new Set<string>(),
      expandedTerminals: new Set<string>(),
      createDialog: {
        isOpen: false,
        initialIssue: null,
        initialPR: null,
        initialRecipeId: null,
        initialBranchInput: null,
        onCreated: undefined,
      },
      bulkCreateDialog: {
        isOpen: false,
        mode: "issue",
        selectedIssues: [],
        selectedPRs: [],
        onComplete: undefined,
      },
      quickCreate: { isOpen: false, issue: null, pr: null },
      crossDiffDialog: { isOpen: false, initialWorktreeId: null },
      lastFocusedTerminalByWorktree: new Map<string, string>(),
      isFleetScopeActive: false,
      _previousActiveWorktreeId: null,
      _fleetScopeToken: null,
      // Bump the generation so any in-flight deferred policy/focus-restore
      // microtask (which captured an older generation) sees a mismatch and
      // bails — clearing the token alone can't invalidate them because the
      // post-reset token is null and the exit-side guard compares against
      // null.
      _policyGeneration: get()._policyGeneration + 1,
    }),
});

export const useWorktreeSelectionStore = create<WorktreeSelectionState>()(
  createWorktreeSelectionStore
);

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
  //
  // Runs synchronously: callers invoke this immediately after their own set(),
  // so the generation/active guards below are defensive (they no longer guard a
  // microtask boundary, but are kept because applyPendingWorktreeSelection
  // passes a generation captured at a different point).
  if (get()._policyGeneration !== generation) return;
  if ((get().activeWorktreeId ?? null) !== (targetWorktreeId ?? null)) return;

  const { panelsById, panelIds } = usePanelStore.getState();
  const activeDockTerminalId = usePanelStore.getState().activeDockTerminalId;

  // Fleet scope pins armed grid/agent terminals to VISIBLE regardless of
  // worktree affiliation — the whole point of the scope view is to see
  // live output across worktrees. Without this, cross-worktree armed
  // terminals would get demoted to BACKGROUND and show stale/frozen
  // content even though they are mounted in the fleet grid. We fetch the
  // armed set through the shared accessor module to avoid a cyclic import.
  const fleetActive = get().isFleetScopeActive;
  const armedIds = fleetActive ? getFleetArmedIds() : null;

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

    const isArmedInFleetScope = armedIds?.has(terminal.id) && !isDockOrTrash;

    const targetTier =
      isArmedInFleetScope || (isInActiveWorktree && !isDockOrTrash)
        ? TerminalRefreshTier.VISIBLE
        : TerminalRefreshTier.BACKGROUND;

    // Apply appropriate renderer policy based on worktree membership.
    // Avoid waking dock/trash terminals - they manage their own visibility.
    // `applyRendererPolicy(VISIBLE)` only restores on a real
    // BACKGROUND->active transition. It returns early on same-tier VISIBLE,
    // so pair active grid promotion with an explicit wake to pull any bytes
    // that arrived while the renderer was hidden or not yet mounted.
    terminalInstanceService.applyRendererPolicy(terminal.id, targetTier);
    if (
      targetTier !== TerminalRefreshTier.BACKGROUND &&
      terminal.hasPty !== false &&
      panelKindHasPty(terminal.kind ?? "terminal")
    ) {
      try {
        terminalInstanceService.wake(terminal.id);
      } catch (error) {
        logErrorWithContext(error, {
          operation: "wake_visible_worktree_terminal",
          component: "worktreeStore",
          errorType: "process",
          details: { terminalId: terminal.id, targetWorktreeId, generation },
        });
      }
    }
  }

  onComplete?.();
}
