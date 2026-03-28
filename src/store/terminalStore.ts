/**
 * Use atomic selectors to prevent unnecessary re-renders.
 * @see src/hooks/useTerminalSelectors.ts for optimized selector hooks
 */

import { create } from "zustand";
import {
  createTerminalRegistrySlice,
  createTerminalFocusSlice,
  createTerminalCommandQueueSlice,
  createTerminalBulkActionsSlice,
  createTerminalMruSlice,
  createWatchedPanelsSlice,
  flushTerminalPersistence,
  type TerminalRegistrySlice,
  type TerminalFocusSlice,
  type TerminalCommandQueueSlice,
  type TerminalBulkActionsSlice,
  type TerminalMruSlice,
  type WatchedPanelsSlice,
  type AddTerminalOptions,
  type QueuedCommand,
  isAgentReady,
} from "./slices";
import type {
  TerminalInstance,
  TerminalRefreshTier,
  AgentStateChangePayload,
  TerminalActivityPayload,
  TerminalStatusPayload,
} from "@shared/types";
import { TerminalRefreshTier as TerminalRefreshTierEnum } from "@/types";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import type { CrashType } from "@shared/types/pty-host";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { useResourceMonitoringStore } from "./resourceMonitoringStore";

export type { TerminalInstance, AddTerminalOptions, QueuedCommand, CrashType };
export { isAgentReady };
export type { TerminalMruSlice, WatchedPanelsSlice };

const PROJECT_SWITCH_RESIZE_SUPPRESSION_MS = 10_000;

function normalizeCrashType(value: unknown): CrashType | null {
  const validTypes: CrashType[] = [
    "OUT_OF_MEMORY",
    "ASSERTION_FAILURE",
    "SIGNAL_TERMINATED",
    "UNKNOWN_CRASH",
    "CLEAN_EXIT",
  ];
  return validTypes.includes(value as CrashType) ? (value as CrashType) : null;
}

export function getTerminalRefreshTier(
  terminal: TerminalInstance | undefined,
  isFocused: boolean
): TerminalRefreshTier {
  if (!terminal) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Always use maximum refresh rate when agent is working to prevent render jitter
  if (terminal.agentState === "working") {
    return TerminalRefreshTierEnum.FOCUSED;
  }

  if (isFocused) {
    return TerminalRefreshTierEnum.FOCUSED;
  }

  // Agent terminals stay at VISIBLE minimum — they must never be hibernated
  if (isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId)) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Non-agent, non-focused terminals drop to BACKGROUND so idle instances
  // can be hibernated (xterm.js disposed) to free memory.
  return TerminalRefreshTierEnum.BACKGROUND;
}

export type BackendStatus = "connected" | "disconnected" | "recovering";

export interface PanelGridState
  extends
    TerminalRegistrySlice,
    TerminalFocusSlice,
    TerminalCommandQueueSlice,
    TerminalBulkActionsSlice,
    TerminalMruSlice,
    WatchedPanelsSlice {
  backendStatus: BackendStatus;
  lastCrashType: CrashType | null;
  setBackendStatus: (status: BackendStatus) => void;
  setLastCrashType: (crashType: CrashType | null) => void;
  reset: () => Promise<void>;
  resetWithoutKilling: (options?: { preserveTerminalIds?: Set<string> }) => Promise<void>;
  detachTerminalsForProjectSwitch: () => void;
  clearTerminalStoreForSwitch: () => void;
  restoreLastTrashed: () => void;
}

export const useTerminalStore = create<PanelGridState>()((set, get, api) => {
  const getTerminals = () => get().terminals;
  const getTerminal = (id: string) => get().terminals.find((t) => t.id === id);

  const registrySlice = createTerminalRegistrySlice({
    onTerminalRemoved: (id, removedIndex, remainingTerminals, _removedTerminal) => {
      clearTerminalRestartGuard(id);
      get().clearQueue(id);
      get().handleTerminalRemoved(id, remainingTerminals, removedIndex);

      // Auto-clear watch if panel is removed while watched
      get().unwatchPanel(id);
    },
  })(set, get, api);

  const getActiveWorktreeId = () => useWorktreeSelectionStore.getState().activeWorktreeId;
  const focusSlice = createTerminalFocusSlice(getTerminals, getActiveWorktreeId)(set, get, api);
  const commandQueueSlice = createTerminalCommandQueueSlice(getTerminal)(set, get, api);
  const mruSlice = createTerminalMruSlice(set, get, api);
  const watchedPanelsSlice = createWatchedPanelsSlice()(set, get, api);
  const bulkActionsSlice = createTerminalBulkActionsSlice(
    getTerminals,
    (id) => get().removeTerminal(id),
    (id) => get().restartTerminal(id),
    (id) => get().trashTerminal(id),
    (id) => get().moveTerminalToDock(id),
    (id) => get().moveTerminalToGrid(id),
    () => get().focusedId,
    (id) => set({ focusedId: id }),
    getActiveWorktreeId
  )(set, get, api);

  return {
    ...registrySlice,
    ...focusSlice,
    ...commandQueueSlice,
    ...bulkActionsSlice,
    ...mruSlice,
    ...watchedPanelsSlice,

    backendStatus: "connected" as BackendStatus,
    lastCrashType: null as CrashType | null,
    setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),
    setLastCrashType: (crashType: CrashType | null) => set({ lastCrashType: crashType }),

    addTerminal: async (options: AddTerminalOptions) => {
      const id = await registrySlice.addTerminal(options);
      if (id === null) return null;
      if (!options.location || options.location === "grid") {
        set({ focusedId: id });
      }
      return id;
    },

    moveTerminalToDock: (id: string) => {
      const state = get();
      registrySlice.moveTerminalToDock(id);

      const updates: Partial<PanelGridState> = {};

      if (state.focusedId === id) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt
        );
        updates.focusedId = gridTerminals[0]?.id ?? null;
      }

      if (state.maximizedId) {
        const group = registrySlice.getPanelGroup(id);
        if (state.maximizedId === id || (group && group.panelIds.includes(state.maximizedId))) {
          updates.maximizedId = null;
          updates.maximizeTarget = null;
          updates.preMaximizeLayout = null;
        }
      }

      if (Object.keys(updates).length > 0) {
        set(updates);
      }
    },

    moveTerminalToGrid: (id: string) => {
      const moveSucceeded = registrySlice.moveTerminalToGrid(id);
      if (moveSucceeded) {
        set({ focusedId: id, activeDockTerminalId: null });
      }
      return moveSucceeded;
    },

    trashTerminal: (id: string) => {
      const state = get();
      registrySlice.trashTerminal(id);

      // Clear watch when panel is trashed (onTerminalRemoved only fires on full removal)
      get().unwatchPanel(id);

      const updates: Partial<PanelGridState> = {};

      if (state.focusedId === id) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt
        );
        const trashedTerminal = state.terminals.find((t) => t.id === id);
        const wasAgent =
          trashedTerminal &&
          isAgentTerminal(trashedTerminal.kind ?? trashedTerminal.type, trashedTerminal.agentId);
        const nextAgent = wasAgent
          ? gridTerminals.find((t) => isAgentTerminal(t.kind ?? t.type, t.agentId))
          : undefined;
        updates.focusedId = nextAgent?.id ?? gridTerminals[0]?.id ?? null;
      }

      if (state.maximizedId === id) {
        updates.maximizedId = null;
      }

      if (state.activeDockTerminalId === id) {
        updates.activeDockTerminalId = null;
      }

      if (Object.keys(updates).length > 0) {
        set(updates);
      }
    },

    trashPanelGroup: (panelId: string) => {
      const state = get();
      // Get the group before trashing to identify all panels
      const group = registrySlice.getPanelGroup(panelId);
      const panelIdsInGroup = group?.panelIds ?? [panelId];

      registrySlice.trashPanelGroup(panelId);

      const updates: Partial<PanelGridState> = {};

      // If any panel in the group was focused, find a new focus
      if (panelIdsInGroup.includes(state.focusedId ?? "")) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) =>
            !panelIdsInGroup.includes(t.id) &&
            t.location === "grid" &&
            (t.worktreeId ?? undefined) === activeWt
        );
        const focusedTerminal = state.terminals.find((t) => t.id === state.focusedId);
        const wasAgent =
          focusedTerminal &&
          isAgentTerminal(focusedTerminal.kind ?? focusedTerminal.type, focusedTerminal.agentId);
        const nextAgent = wasAgent
          ? gridTerminals.find((t) => isAgentTerminal(t.kind ?? t.type, t.agentId))
          : undefined;
        updates.focusedId = nextAgent?.id ?? gridTerminals[0]?.id ?? null;
      }

      // If any panel in the group was maximized, clear maximize
      if (state.maximizedId && panelIdsInGroup.includes(state.maximizedId)) {
        updates.maximizedId = null;
      }

      // If any panel in the group was the active dock terminal, clear it
      if (state.activeDockTerminalId && panelIdsInGroup.includes(state.activeDockTerminalId)) {
        updates.activeDockTerminalId = null;
      }

      if (Object.keys(updates).length > 0) {
        set(updates);
      }
    },

    restoreTerminal: (id: string, targetWorktreeId?: string) => {
      registrySlice.restoreTerminal(id, targetWorktreeId);
      set({ focusedId: id, activeDockTerminalId: null });
    },

    restoreTrashedGroup: (groupRestoreId: string, targetWorktreeId?: string) => {
      const trashedTerminals = get().trashedTerminals;

      // Find anchor panel to determine what to focus after restore
      let anchorPanel: ReturnType<typeof trashedTerminals.get> | undefined;
      const groupPanelIds: string[] = [];
      for (const [id, trashed] of trashedTerminals.entries()) {
        if (trashed.groupRestoreId === groupRestoreId) {
          groupPanelIds.push(id);
          if (trashed.groupMetadata) {
            anchorPanel = trashed;
          }
        }
      }

      if (groupPanelIds.length === 0) {
        return;
      }

      registrySlice.restoreTrashedGroup(groupRestoreId, targetWorktreeId);

      // Focus the active tab from the restored group
      const focusId =
        anchorPanel?.groupMetadata?.activeTabId &&
        groupPanelIds.includes(anchorPanel.groupMetadata.activeTabId)
          ? anchorPanel.groupMetadata.activeTabId
          : groupPanelIds[0];
      set({ focusedId: focusId, activeDockTerminalId: null });

      // Sync the registry's active tab for restored groups
      const group = get().getPanelGroup(focusId);
      if (group) {
        get().setActiveTab(group.id, focusId);
      }
    },

    restoreLastTrashed: () => {
      const trashedTerminals = get().trashedTerminals;
      const trashedIds = Array.from(trashedTerminals.keys());
      if (trashedIds.length === 0) {
        return;
      }

      const lastId = trashedIds[trashedIds.length - 1];
      const lastTrashed = trashedTerminals.get(lastId);

      // Check if this panel was part of a group
      if (lastTrashed?.groupRestoreId) {
        // Use the group restore method
        get().restoreTrashedGroup(lastTrashed.groupRestoreId);
      } else {
        // Single panel restore (existing behavior)
        get().restoreTerminal(lastId);
      }
    },

    moveTerminalToPosition: (
      id: string,
      toIndex: number,
      location: "grid" | "dock",
      worktreeId?: string | null
    ) => {
      const state = get();
      registrySlice.moveTerminalToPosition(id, toIndex, location, worktreeId);

      if (location === "grid") {
        set({ focusedId: id, activeDockTerminalId: null });
      } else if (state.focusedId === id) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt
        );
        set({ focusedId: gridTerminals[0]?.id ?? null });
      }
    },

    focusNext: () => {
      focusSlice.focusNext();
      const focusedId = get().focusedId;
      if (focusedId) {
        const terminal = get().terminals.find((t) => t.id === focusedId);
        if (terminal?.location === "dock") {
          const group = get().getPanelGroup(focusedId);
          if (group) get().setActiveTab(group.id, focusedId);
        }
      }
    },

    focusPrevious: () => {
      focusSlice.focusPrevious();
      const focusedId = get().focusedId;
      if (focusedId) {
        const terminal = get().terminals.find((t) => t.id === focusedId);
        if (terminal?.location === "dock") {
          const group = get().getPanelGroup(focusedId);
          if (group) get().setActiveTab(group.id, focusedId);
        }
      }
    },

    reset: async () => {
      const state = get();

      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.destroy(terminal.id);
        } catch (error) {
          logWarn(`Failed to destroy terminal instance ${terminal.id}`, { error });
        }
      }

      const killPromises = state.terminals.map((terminal) =>
        terminalRegistryController.kill(terminal.id).catch((error) => {
          logError(`Failed to kill terminal ${terminal.id}`, error);
        })
      );

      await Promise.all(killPromises);

      const { useTerminalInputStore: inputStore } = await import("./terminalInputStore");
      inputStore.getState().clearAllDraftInputs();

      set({
        terminals: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        backendStatus: "connected",
        lastCrashType: null,
        mruList: [],
      });
    },

    resetWithoutKilling: async (_options) => {
      const state = get();

      flushTerminalPersistence();

      const allTerminalIds = state.terminals.map((t) => t.id);
      terminalInstanceService.suppressResizesDuringProjectSwitch(
        allTerminalIds,
        PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
      );

      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.detachForProjectSwitch(terminal.id);
        } catch (error) {
          logWarn(`Failed to detach terminal instance ${terminal.id}`, { error });
        }
      }

      logInfo(
        `Detached ${state.terminals.length} terminal instances for project switch (processes preserved)`
      );

      set({
        terminals: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        backendStatus: "connected",
        lastCrashType: null,
        mruList: [],
      });
    },

    detachTerminalsForProjectSwitch: () => {
      const state = get();

      flushTerminalPersistence();

      const allTerminalIds = state.terminals.map((t) => t.id);
      terminalInstanceService.suppressResizesDuringProjectSwitch(
        allTerminalIds,
        PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
      );

      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.detachForProjectSwitch(terminal.id);
        } catch (error) {
          logWarn(`Failed to detach terminal instance ${terminal.id}`, { error });
        }
      }

      logInfo(
        `Detached ${state.terminals.length} terminal instances for project switch (processes preserved, state retained)`
      );
    },

    clearTerminalStoreForSwitch: () => {
      set({
        terminals: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        backendStatus: "connected",
        lastCrashType: null,
        mruList: [],
      });
    },
  };
});

let agentStateUnsubscribe: (() => void) | null = null;
let agentDetectedUnsubscribe: (() => void) | null = null;
let agentExitedUnsubscribe: (() => void) | null = null;
let activityUnsubscribe: (() => void) | null = null;
let trashedUnsubscribe: (() => void) | null = null;
let restoredUnsubscribe: (() => void) | null = null;
let exitUnsubscribe: (() => void) | null = null;
let flowStatusUnsubscribe: (() => void) | null = null;
let backendCrashedUnsubscribe: (() => void) | null = null;
let backendReadyUnsubscribe: (() => void) | null = null;
let spawnResultUnsubscribe: (() => void) | null = null;
let reduceScrollbackUnsubscribe: (() => void) | null = null;
let restoreScrollbackUnsubscribe: (() => void) | null = null;
let resourceMetricsUnsubscribe: (() => void) | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let beforeUnloadHandler: (() => void) | null = null;

const activityBuffer = new Map<string, TerminalActivityPayload>();
let activityRafId: number | null = null;

function flushActivityBuffer(): void {
  activityRafId = null;
  if (activityBuffer.size === 0) return;
  const store = useTerminalStore.getState();
  for (const data of activityBuffer.values()) {
    store.updateActivity(
      data.terminalId,
      data.headline,
      data.status,
      data.type,
      data.timestamp,
      data.lastCommand
    );
  }
  activityBuffer.clear();
}

function cancelActivityBuffer(): void {
  if (activityRafId !== null) {
    cancelAnimationFrame(activityRafId);
    activityRafId = null;
  }
  activityBuffer.clear();
}

import {
  clearAllRestartGuards,
  isTerminalRestarting,
  clearTerminalRestartGuard,
} from "./restartExitSuppression";

export function cleanupTerminalStoreListeners() {
  clearAllRestartGuards();
  cancelActivityBuffer();
  if (agentStateUnsubscribe) {
    agentStateUnsubscribe();
    agentStateUnsubscribe = null;
  }
  if (agentDetectedUnsubscribe) {
    agentDetectedUnsubscribe();
    agentDetectedUnsubscribe = null;
  }
  if (agentExitedUnsubscribe) {
    agentExitedUnsubscribe();
    agentExitedUnsubscribe = null;
  }
  if (activityUnsubscribe) {
    activityUnsubscribe();
    activityUnsubscribe = null;
  }
  if (trashedUnsubscribe) {
    trashedUnsubscribe();
    trashedUnsubscribe = null;
  }
  if (restoredUnsubscribe) {
    restoredUnsubscribe();
    restoredUnsubscribe = null;
  }
  if (exitUnsubscribe) {
    exitUnsubscribe();
    exitUnsubscribe = null;
  }
  if (flowStatusUnsubscribe) {
    flowStatusUnsubscribe();
    flowStatusUnsubscribe = null;
  }
  if (backendCrashedUnsubscribe) {
    backendCrashedUnsubscribe();
    backendCrashedUnsubscribe = null;
  }
  if (backendReadyUnsubscribe) {
    backendReadyUnsubscribe();
    backendReadyUnsubscribe = null;
  }
  if (spawnResultUnsubscribe) {
    spawnResultUnsubscribe();
    spawnResultUnsubscribe = null;
  }
  if (reduceScrollbackUnsubscribe) {
    reduceScrollbackUnsubscribe();
    reduceScrollbackUnsubscribe = null;
  }
  if (restoreScrollbackUnsubscribe) {
    restoreScrollbackUnsubscribe();
    restoreScrollbackUnsubscribe = null;
  }
  if (resourceMetricsUnsubscribe) {
    resourceMetricsUnsubscribe();
    resourceMetricsUnsubscribe = null;
  }
  if (recoveryTimer) {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
  }
  if (beforeUnloadHandler) {
    window.removeEventListener("beforeunload", beforeUnloadHandler);
    beforeUnloadHandler = null;
  }
}

export function setupTerminalStoreListeners() {
  if (typeof window === "undefined") return () => {};

  // Idempotent: return early if already setup to prevent event loss window and overlapping cleanup
  if (exitUnsubscribe !== null) {
    return cleanupTerminalStoreListeners;
  }

  agentStateUnsubscribe = terminalRegistryController.onAgentStateChanged(
    (data: AgentStateChangePayload) => {
      const { terminalId, state, timestamp, trigger, confidence, waitingReason, sessionCost } =
        data;

      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
        logWarn("Invalid timestamp in agent state event", { data });
        return;
      }

      if (!terminalId) {
        logWarn("Missing terminalId in agent state event", { data });
        return;
      }

      const clampedConfidence = Math.max(0, Math.min(1, confidence || 0));

      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === terminalId);

      if (!terminal) {
        return;
      }

      if (terminal.isRestarting) {
        return;
      }

      if (terminal.lastStateChange && timestamp < terminal.lastStateChange) {
        return;
      }

      terminalInstanceService.setAgentState(terminalId, state);

      if (terminal.agentState === "directing" && state === "waiting") {
        return;
      }

      useTerminalStore
        .getState()
        .updateAgentState(
          terminalId,
          state,
          undefined,
          timestamp,
          trigger,
          clampedConfidence,
          waitingReason,
          sessionCost
        );

      if (state === "waiting" || state === "idle") {
        useTerminalStore.getState().processQueue(terminalId);
      }
    }
  );

  agentDetectedUnsubscribe = terminalRegistryController.onAgentDetected((data) => {
    const { terminalId, processIconId } = data;
    if (!terminalId || !processIconId) return;

    useTerminalStore.setState((state) => {
      const terminal = state.terminals.find((t) => t.id === terminalId);
      if (!terminal || terminal.detectedProcessId === processIconId) return state;
      return {
        terminals: state.terminals.map((t) =>
          t.id === terminalId ? { ...t, detectedProcessId: processIconId } : t
        ),
      };
    });
  });

  agentExitedUnsubscribe = terminalRegistryController.onAgentExited((data) => {
    const { terminalId } = data;
    if (!terminalId) return;

    useTerminalStore.setState((state) => {
      const terminal = state.terminals.find((t) => t.id === terminalId);
      if (!terminal || !terminal.detectedProcessId) return state;
      return {
        terminals: state.terminals.map((t) =>
          t.id === terminalId ? { ...t, detectedProcessId: undefined } : t
        ),
      };
    });
  });

  activityUnsubscribe = terminalRegistryController.onActivity((data: TerminalActivityPayload) => {
    activityBuffer.set(data.terminalId, data);
    if (activityRafId === null) {
      activityRafId = requestAnimationFrame(flushActivityBuffer);
    }
  });

  trashedUnsubscribe = terminalRegistryController.onTrashed(
    (data: { id: string; expiresAt: number }) => {
      const { id, expiresAt } = data;
      const state = useTerminalStore.getState();
      const terminal = state.terminals.find((t) => t.id === id);
      const originalLocation: "dock" | "grid" = terminal?.location === "dock" ? "dock" : "grid";
      state.markAsTrashed(id, expiresAt, originalLocation);

      const updates: Partial<PanelGridState> = {};
      if (state.focusedId === id) {
        const activeWt = useWorktreeSelectionStore.getState().activeWorktreeId ?? undefined;
        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt
        );
        updates.focusedId = gridTerminals[0]?.id ?? null;
      }
      if (state.maximizedId === id) {
        updates.maximizedId = null;
      }
      if (Object.keys(updates).length > 0) {
        useTerminalStore.setState(updates);
      }
    }
  );

  restoredUnsubscribe = terminalRegistryController.onRestored((data: { id: string }) => {
    const { id } = data;
    useTerminalStore.getState().markAsRestored(id);
    useTerminalStore.setState({ focusedId: id });
  });

  exitUnsubscribe = terminalRegistryController.onExit((id, exitCode) => {
    // Check synchronous restart guard FIRST - this handles the race condition where
    // the store's isRestarting flag hasn't propagated yet during bulk restarts
    if (isTerminalRestarting(id)) {
      return;
    }

    const state = useTerminalStore.getState();
    const terminal = state.terminals.find((t) => t.id === id);

    if (!terminal) return;

    // Also check store flag for safety (handles edge cases)
    if (terminal.isRestarting) {
      return;
    }

    // Clean up resource metrics for exited terminal
    useResourceMonitoringStore.getState().removeTerminal(id);

    // Store exit code on the terminal before applying exit behavior
    useTerminalStore.setState((s) => ({
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, exitCode } : t)),
    }));

    state.setRuntimeStatus(id, "exited");

    // If already trashed, this is TTL expiry cleanup - permanently remove
    if (terminal.location === "trash") {
      state.removeTerminal(id);
      return;
    }

    // Non-zero exit codes always preserve terminal for debugging, regardless of exitBehavior
    // This ensures failures are visible for review
    if (exitCode !== 0) {
      return;
    }

    // Respect explicit exitBehavior if set (only honored on successful exit)
    if (terminal.exitBehavior === "remove") {
      state.removeTerminal(id);
      return;
    }

    if (terminal.exitBehavior === "trash") {
      state.trashTerminal(id);
      return;
    }

    if (terminal.exitBehavior === "keep" || terminal.exitBehavior === "restart") {
      // "keep": preserve terminal for review
      // "restart": preserve terminal; TerminalPane triggers the restart via its exit effect
      // Note: non-zero exits are already preserved above, so this only matters for exit code 0
      return;
    }

    // exitBehavior undefined - use default behavior based on terminal type
    // Preserve dev-preview panels so users can inspect stopped/error states
    if (terminal.kind === "dev-preview") {
      return;
    }

    // Preserve successfully completed agent terminals to enable reboot and output review
    if (isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId)) {
      return;
    }

    // Auto-trash non-agent terminals on exit (preserves history for review, consistent with manual close)
    state.trashTerminal(id);
  });

  flowStatusUnsubscribe = terminalRegistryController.onStatus((data: TerminalStatusPayload) => {
    const { id, status, timestamp } = data;
    useTerminalStore.getState().updateFlowStatus(id, status, timestamp);
  });

  backendCrashedUnsubscribe = terminalRegistryController.onBackendCrashed((details) => {
    logError("Backend crashed", undefined, { details });

    // Cancel any pending recovery timer
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    useTerminalStore.setState({
      backendStatus: "disconnected",
      lastCrashType: normalizeCrashType(details?.crashType),
    });
  });

  backendReadyUnsubscribe = terminalRegistryController.onBackendReady(() => {
    logInfo("Backend recovered, resetting renderers...");

    // Cancel any pending recovery timer from previous crash
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    useTerminalStore.setState({ backendStatus: "recovering" });

    // Reset all xterm instances to fix white text
    terminalInstanceService.handleBackendRecovery();

    // Mark as connected after a short delay to show recovery state
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      useTerminalStore.setState({ backendStatus: "connected", lastCrashType: null });
    }, 500);
  });

  spawnResultUnsubscribe = terminalRegistryController.onSpawnResult((id, result) => {
    if (!result.success) {
      if (result.error) {
        logError(`Spawn failed for terminal ${id}`, undefined, { error: result.error });
        useTerminalStore.getState().setSpawnError(id, result.error);
      } else {
        // Spawn failed but no error details provided - set generic error
        logError(`Spawn failed for terminal ${id} with no error details`);
        useTerminalStore.getState().setSpawnError(id, {
          code: "UNKNOWN",
          message: "Failed to start terminal process",
        });
      }
    } else {
      // Spawn succeeded - clear any previous spawn error
      const terminal = useTerminalStore.getState().terminals.find((t) => t.id === id);
      if (terminal?.spawnError) {
        useTerminalStore.getState().clearSpawnError(id);
      }
    }
  });

  reduceScrollbackUnsubscribe = terminalRegistryController.onReduceScrollback(
    ({ terminalIds, targetLines }) => {
      for (const id of terminalIds) {
        terminalInstanceService.reduceScrollback(id, targetLines);
      }
    }
  );

  restoreScrollbackUnsubscribe = terminalRegistryController.onRestoreScrollback(
    ({ terminalIds }) => {
      for (const id of terminalIds) {
        terminalInstanceService.restoreScrollback(id);
      }
    }
  );

  // Resource metrics listener
  resourceMetricsUnsubscribe = window.electron.terminal.onResourceMetrics((data) => {
    const rmStore = useResourceMonitoringStore.getState();
    if (rmStore.enabled) {
      rmStore.updateMetrics(data.metrics);
    }
  });

  // Flush pending terminal persistence on window close to prevent data loss
  beforeUnloadHandler = () => {
    flushTerminalPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);

  return cleanupTerminalStoreListeners;
}
