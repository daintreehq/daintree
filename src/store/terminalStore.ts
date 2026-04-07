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
  selectOrderedTerminals,
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
import type { TerminalInstance, TerminalRefreshTier } from "@shared/types";
import { TerminalRefreshTier as TerminalRefreshTierEnum } from "@/types";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import type { CrashType } from "@shared/types/pty-host";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { clearTerminalRestartGuard } from "./restartExitSuppression";
import { buildPanelSnapshotOptions } from "@/services/terminal/panelDuplicationService";

export type { TerminalInstance, AddTerminalOptions, QueuedCommand, CrashType };
export { isAgentReady };
export type { TerminalMruSlice, WatchedPanelsSlice };

const PROJECT_SWITCH_RESIZE_SUPPRESSION_MS = 10_000;

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

  // Active agent terminals stay at VISIBLE minimum to preserve live output.
  // Completed agents drop to BACKGROUND so they can be hibernated to free memory.
  if (
    isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId) &&
    terminal.agentState !== "completed" &&
    terminal.agentState !== "exited"
  ) {
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
  lastClosedConfig: AddTerminalOptions | null;
  restoreLastTrashed: () => void;
}

export const useTerminalStore = create<PanelGridState>()((set, get, api) => {
  const getTerminals = () => selectOrderedTerminals(get().terminalsById, get().terminalIds);
  const getTerminal = (id: string) => get().terminalsById[id];

  const registrySlice = createTerminalRegistrySlice({
    onTerminalRemoved: (id, removedIndex, remainingIds, _removedTerminal) => {
      clearTerminalRestartGuard(id);
      get().clearQueue(id);
      // Build remaining terminals array for the focus slice
      const state = get();
      const remainingTerminals = remainingIds
        .map((tid) => state.terminalsById[tid])
        .filter(Boolean);
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
    lastClosedConfig: null as AddTerminalOptions | null,
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
        const gridTerminals: TerminalInstance[] = [];
        for (const tid of state.terminalIds) {
          const t = state.terminalsById[tid];
          if (t && t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt)
            gridTerminals.push(t);
        }
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
      const terminalToTrash = state.terminalsById[id];
      if (terminalToTrash && terminalToTrash.location !== "trash") {
        set({ lastClosedConfig: buildPanelSnapshotOptions(terminalToTrash) });
      }

      registrySlice.trashTerminal(id);

      // Clear watch when panel is trashed (onTerminalRemoved only fires on full removal)
      get().unwatchPanel(id);

      const updates: Partial<PanelGridState> = {};

      if (state.focusedId === id) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const gridTerminals: TerminalInstance[] = [];
        for (const tid of state.terminalIds) {
          const t = state.terminalsById[tid];
          if (t && t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt)
            gridTerminals.push(t);
        }
        const trashedTerminal = state.terminalsById[id];
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
      const group = registrySlice.getPanelGroup(panelId);
      const panelIdsInGroup = group?.panelIds ?? [panelId];

      const snapshotSourceId =
        group && panelIdsInGroup.includes(state.focusedId ?? "") ? state.focusedId! : panelId;
      const snapshotSource = state.terminalsById[snapshotSourceId];
      if (snapshotSource && snapshotSource.location !== "trash") {
        set({ lastClosedConfig: buildPanelSnapshotOptions(snapshotSource) });
      }

      registrySlice.trashPanelGroup(panelId);

      const updates: Partial<PanelGridState> = {};

      if (panelIdsInGroup.includes(state.focusedId ?? "")) {
        const activeWt = getActiveWorktreeId() ?? undefined;
        const groupSet = new Set(panelIdsInGroup);
        const gridTerminals: TerminalInstance[] = [];
        for (const tid of state.terminalIds) {
          const t = state.terminalsById[tid];
          if (
            t &&
            !groupSet.has(t.id) &&
            t.location === "grid" &&
            (t.worktreeId ?? undefined) === activeWt
          )
            gridTerminals.push(t);
        }
        const focusedTerminal = state.terminalsById[state.focusedId!];
        const wasAgent =
          focusedTerminal &&
          isAgentTerminal(focusedTerminal.kind ?? focusedTerminal.type, focusedTerminal.agentId);
        const nextAgent = wasAgent
          ? gridTerminals.find((t) => isAgentTerminal(t.kind ?? t.type, t.agentId))
          : undefined;
        updates.focusedId = nextAgent?.id ?? gridTerminals[0]?.id ?? null;
      }

      if (state.maximizedId && panelIdsInGroup.includes(state.maximizedId)) {
        updates.maximizedId = null;
      }

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

      if (groupPanelIds.length === 0) return;

      registrySlice.restoreTrashedGroup(groupRestoreId, targetWorktreeId);

      const focusId =
        anchorPanel?.groupMetadata?.activeTabId &&
        groupPanelIds.includes(anchorPanel.groupMetadata.activeTabId)
          ? anchorPanel.groupMetadata.activeTabId
          : groupPanelIds[0];
      set({ focusedId: focusId, activeDockTerminalId: null });

      const group = get().getPanelGroup(focusId);
      if (group) {
        get().setActiveTab(group.id, focusId);
      }
    },

    restoreLastTrashed: () => {
      const trashedTerminals = get().trashedTerminals;
      const trashedIds = Array.from(trashedTerminals.keys());
      if (trashedIds.length === 0) return;

      const lastId = trashedIds[trashedIds.length - 1];
      const lastTrashed = trashedTerminals.get(lastId);

      if (lastTrashed?.groupRestoreId) {
        get().restoreTrashedGroup(lastTrashed.groupRestoreId);
      } else {
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
        const gridTerminals: TerminalInstance[] = [];
        for (const tid of state.terminalIds) {
          const t = state.terminalsById[tid];
          if (t && t.id !== id && t.location === "grid" && (t.worktreeId ?? undefined) === activeWt)
            gridTerminals.push(t);
        }
        set({ focusedId: gridTerminals[0]?.id ?? null });
      }
    },

    focusNext: () => {
      focusSlice.focusNext();
      const focusedId = get().focusedId;
      if (focusedId) {
        const terminal = get().terminalsById[focusedId];
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
        const terminal = get().terminalsById[focusedId];
        if (terminal?.location === "dock") {
          const group = get().getPanelGroup(focusedId);
          if (group) get().setActiveTab(group.id, focusedId);
        }
      }
    },

    reset: async () => {
      const state = get();

      for (const tid of state.terminalIds) {
        try {
          terminalInstanceService.destroy(tid);
        } catch (error) {
          logWarn(`Failed to destroy terminal instance ${tid}`, { error });
        }
      }

      const killPromises = state.terminalIds.map((tid) =>
        terminalRegistryController.kill(tid).catch((error) => {
          logError(`Failed to kill terminal ${tid}`, error);
        })
      );

      await Promise.all(killPromises);

      const { useTerminalInputStore: inputStore } = await import("./terminalInputStore");
      inputStore.getState().clearAllDraftInputs();

      set({
        terminalsById: {},
        terminalIds: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        commandQueueCountById: {},
        backendStatus: "connected",
        lastCrashType: null,
        lastClosedConfig: null,
        mruList: [],
      });
    },

    resetWithoutKilling: async (_options) => {
      const state = get();

      flushTerminalPersistence();

      const allTerminalIds = [...state.terminalIds];
      terminalInstanceService.suppressResizesDuringProjectSwitch(
        allTerminalIds,
        PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
      );

      for (const tid of state.terminalIds) {
        try {
          terminalInstanceService.detachForProjectSwitch(tid);
        } catch (error) {
          logWarn(`Failed to detach terminal instance ${tid}`, { error });
        }
      }

      logInfo(
        `Detached ${state.terminalIds.length} terminal instances for project switch (processes preserved)`
      );

      set({
        terminalsById: {},
        terminalIds: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        commandQueueCountById: {},
        backendStatus: "connected",
        lastCrashType: null,
        lastClosedConfig: null,
        mruList: [],
      });
    },

    detachTerminalsForProjectSwitch: () => {
      const state = get();

      flushTerminalPersistence();

      const allTerminalIds = [...state.terminalIds];
      terminalInstanceService.suppressResizesDuringProjectSwitch(
        allTerminalIds,
        PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
      );

      for (const tid of state.terminalIds) {
        try {
          terminalInstanceService.detachForProjectSwitch(tid);
        } catch (error) {
          logWarn(`Failed to detach terminal instance ${tid}`, { error });
        }
      }

      logInfo(
        `Detached ${state.terminalIds.length} terminal instances for project switch (processes preserved, state retained)`
      );
    },

    clearTerminalStoreForSwitch: () => {
      set({
        terminalsById: {},
        terminalIds: [],
        trashedTerminals: new Map(),
        backgroundedTerminals: new Map(),
        tabGroups: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        commandQueueCountById: {},
        backendStatus: "connected",
        lastCrashType: null,
        lastClosedConfig: null,
        mruList: [],
      });
    },
  };
});

export {
  setupTerminalStoreListeners,
  cleanupTerminalStoreListeners,
} from "./terminalStoreListeners";
