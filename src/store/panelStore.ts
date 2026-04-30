/**
 * Use atomic selectors to prevent unnecessary re-renders.
 * @see src/hooks/useTerminalSelectors.ts for optimized selector hooks
 */

import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import {
  createPanelRegistrySlice,
  createTerminalFocusSlice,
  createTerminalCommandQueueSlice,
  createTerminalBulkActionsSlice,
  createTerminalMruSlice,
  createWatchedPanelsSlice,
  flushPanelPersistence,
  isHydrationBatchActive,
  selectOrderedTerminals,
  type PanelRegistrySlice,
  type TerminalFocusSlice,
  type TerminalCommandQueueSlice,
  type TerminalBulkActionsSlice,
  type TerminalMruSlice,
  type WatchedPanelsSlice,
  type AddPanelOptions,
  type QueuedCommand,
  isAgentReady,
} from "./slices";
import type { TerminalInstance, TerminalRefreshTier } from "@shared/types";
import { TerminalRefreshTier as TerminalRefreshTierEnum } from "@/types";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "./worktreeStore";
import type { CrashType } from "@shared/types/pty-host";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { clearTerminalRestartGuard } from "./restartExitSuppression";
import { buildPanelSnapshotOptions } from "@/services/terminal/panelDuplicationService";
import { setPanelStoreGetter } from "./projectStore";

export type { TerminalInstance, AddPanelOptions, QueuedCommand, CrashType };
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
  // Uses runtime-detected identity so panels that have left agent mode can hibernate.
  if (
    isRuntimeAgentTerminal(terminal) &&
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
    PanelRegistrySlice,
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
  lastClosedConfig: AddPanelOptions | null;
  restoreLastTrashed: () => void;
}

export const usePanelStore = create<PanelGridState>()(
  subscribeWithSelector((set, get, api) => {
    const getTerminals = () => selectOrderedTerminals(get().panelsById, get().panelIds);
    const getTerminal = (id: string) => get().panelsById[id];

    const registrySlice = createPanelRegistrySlice({
      onTerminalRemoved: (id, removedIndex, remainingIds, _removedTerminal) => {
        clearTerminalRestartGuard(id);
        get().clearQueue(id);
        // Build remaining terminals array for the focus slice
        const state = get();
        const remainingTerminals = remainingIds
          .map((tid) => state.panelsById[tid])
          .filter((t): t is NonNullable<typeof t> => Boolean(t));
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
      (id) => get().removePanel(id),
      (id) => get().restartTerminal(id),
      (id) => get().trashPanel(id),
      (id) => get().moveTerminalToDock(id),
      (id) => get().moveTerminalToGrid(id),
      () => get().focusedId,
      (id) => get().activateTerminal(id),
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
      lastClosedConfig: null as AddPanelOptions | null,
      setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),
      setLastCrashType: (crashType: CrashType | null) => set({ lastCrashType: crashType }),

      addPanel: async (options: AddPanelOptions) => {
        const id = await registrySlice.addPanel(options);
        if (id === null) return null;
        // Skip the per-panel focus mutation while a hydration batch is collecting panels:
        // firing `set({ focusedId })` here would schedule one extra render per panel and
        // defeat the batch's single-render guarantee. The arbitrary "last panel added"
        // focus also isn't meaningful during restore — focus is resolved elsewhere once
        // the active worktree is set.
        if ((!options.location || options.location === "grid") && !isHydrationBatchActive()) {
          const previousFocusedId = get().focusedId;
          if (previousFocusedId !== id) {
            set({ focusedId: id, previousFocusedId });
          } else {
            set({ focusedId: id });
          }
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
          for (const tid of state.panelIds) {
            const t = state.panelsById[tid];
            if (
              t &&
              t.id !== id &&
              t.location === "grid" &&
              (t.worktreeId ?? undefined) === activeWt
            )
              gridTerminals.push(t);
          }
          updates.focusedId = gridTerminals[0]?.id ?? null;
          // Auto-fallback focus from a moved-to-dock panel isn't a user
          // navigation event — clear the alternate pointer to avoid round-
          // tripping into a panel the user didn't choose.
          updates.previousFocusedId = null;
        }
        if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
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
          const previousFocusedId = get().focusedId;
          set({
            focusedId: id,
            activeDockTerminalId: null,
            ...(previousFocusedId !== id && { previousFocusedId }),
          });
        }
        return moveSucceeded;
      },

      moveTabGroupToLocation: (groupId, location) => {
        const groupBeforeMove = get().tabGroups.get(groupId);
        const moved = registrySlice.moveTabGroupToLocation(groupId, location);
        if (!moved || !groupBeforeMove) return moved;

        if (location === "grid") {
          const activeDockTerminalId = get().activeDockTerminalId;
          const previousFocusedId = get().focusedId;
          const nextFocusedId = groupBeforeMove.panelIds.includes(groupBeforeMove.activeTabId)
            ? groupBeforeMove.activeTabId
            : (groupBeforeMove.panelIds[0] ?? null);
          const shouldClearDock =
            activeDockTerminalId !== null &&
            groupBeforeMove.panelIds.includes(activeDockTerminalId);

          set({
            focusedId: nextFocusedId,
            ...(shouldClearDock && { activeDockTerminalId: null }),
            ...(nextFocusedId !== previousFocusedId && { previousFocusedId }),
          });
        } else {
          const focusedId = get().focusedId;
          if (focusedId && groupBeforeMove.panelIds.includes(focusedId)) {
            // The previously focused panel is now in the dock and `focusedId`
            // is being cleared as a side effect of the move, not a user
            // navigation. Clear the alternate pointer to keep round-trip
            // semantics tied to explicit focus changes.
            set({
              focusedId: null,
              activeDockTerminalId: groupBeforeMove.activeTabId,
              previousFocusedId: null,
            });
          }
        }

        return moved;
      },

      trashPanel: (id: string) => {
        const state = get();
        const terminalToTrash = state.panelsById[id];
        if (terminalToTrash && terminalToTrash.location !== "trash") {
          const snapshot = buildPanelSnapshotOptions(terminalToTrash);
          if (snapshot !== null) {
            set({ lastClosedConfig: snapshot });
          }
        }

        registrySlice.trashPanel(id);

        // Clear watch when panel is trashed (onTerminalRemoved only fires on full removal)
        get().unwatchPanel(id);

        const updates: Partial<PanelGridState> = {};

        if (state.focusedId === id) {
          const activeWt = getActiveWorktreeId() ?? undefined;
          const gridTerminals: TerminalInstance[] = [];
          for (const tid of state.panelIds) {
            const t = state.panelsById[tid];
            if (
              t &&
              t.id !== id &&
              t.location === "grid" &&
              (t.worktreeId ?? undefined) === activeWt
            )
              gridTerminals.push(t);
          }
          const trashedTerminal = state.panelsById[id];
          const wasAgent = trashedTerminal && isRuntimeAgentTerminal(trashedTerminal);
          const nextAgent = wasAgent
            ? gridTerminals.find((t) => isRuntimeAgentTerminal(t))
            : undefined;
          updates.focusedId = nextAgent?.id ?? gridTerminals[0]?.id ?? null;
          updates.previousFocusedId = null;
        } else if (state.previousFocusedId === id) {
          updates.previousFocusedId = null;
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
        const snapshotSource = state.panelsById[snapshotSourceId];
        if (snapshotSource && snapshotSource.location !== "trash") {
          const snapshot = buildPanelSnapshotOptions(snapshotSource);
          if (snapshot !== null) {
            set({ lastClosedConfig: snapshot });
          }
        }

        registrySlice.trashPanelGroup(panelId);

        const updates: Partial<PanelGridState> = {};

        if (panelIdsInGroup.includes(state.focusedId ?? "")) {
          const activeWt = getActiveWorktreeId() ?? undefined;
          const groupSet = new Set(panelIdsInGroup);
          const gridTerminals: TerminalInstance[] = [];
          for (const tid of state.panelIds) {
            const t = state.panelsById[tid];
            if (
              t &&
              !groupSet.has(t.id) &&
              t.location === "grid" &&
              (t.worktreeId ?? undefined) === activeWt
            )
              gridTerminals.push(t);
          }
          const focusedTerminal = state.panelsById[state.focusedId!];
          const wasAgent = focusedTerminal && isRuntimeAgentTerminal(focusedTerminal);
          const nextAgent = wasAgent
            ? gridTerminals.find((t) => isRuntimeAgentTerminal(t))
            : undefined;
          updates.focusedId = nextAgent?.id ?? gridTerminals[0]?.id ?? null;
          updates.previousFocusedId = null;
        } else if (
          state.previousFocusedId !== null &&
          panelIdsInGroup.includes(state.previousFocusedId)
        ) {
          updates.previousFocusedId = null;
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
        const previousFocusedId = get().focusedId;
        set({
          focusedId: id,
          activeDockTerminalId: null,
          ...(previousFocusedId !== id && { previousFocusedId }),
        });
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

        const focusId: string =
          anchorPanel?.groupMetadata?.activeTabId &&
          groupPanelIds.includes(anchorPanel.groupMetadata.activeTabId)
            ? anchorPanel.groupMetadata.activeTabId
            : groupPanelIds[0]!;
        const previousFocusedId = get().focusedId;
        set({
          focusedId: focusId,
          activeDockTerminalId: null,
          ...(previousFocusedId !== focusId && { previousFocusedId }),
        });

        const group = get().getPanelGroup(focusId);
        if (group) {
          get().setActiveTab(group.id, focusId);
        }
      },

      restoreLastTrashed: () => {
        const trashedTerminals = get().trashedTerminals;
        const trashedIds = Array.from(trashedTerminals.keys());
        if (trashedIds.length === 0) return;

        const lastId = trashedIds[trashedIds.length - 1]!;
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
          const previousFocusedId = state.focusedId;
          set({
            focusedId: id,
            activeDockTerminalId: null,
            ...(previousFocusedId !== id && { previousFocusedId }),
          });
        } else if (state.focusedId === id) {
          const activeWt = getActiveWorktreeId() ?? undefined;
          const gridTerminals: TerminalInstance[] = [];
          for (const tid of state.panelIds) {
            const t = state.panelsById[tid];
            if (
              t &&
              t.id !== id &&
              t.location === "grid" &&
              (t.worktreeId ?? undefined) === activeWt
            )
              gridTerminals.push(t);
          }
          // Auto-fallback focus when the focused panel is moved to dock —
          // not a user navigation, so the alternate pointer becomes stale.
          set({ focusedId: gridTerminals[0]?.id ?? null, previousFocusedId: null });
        }
      },

      focusNext: () => {
        focusSlice.focusNext();
        const focusedId = get().focusedId;
        if (focusedId) {
          const terminal = get().panelsById[focusedId];
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
          const terminal = get().panelsById[focusedId];
          if (terminal?.location === "dock") {
            const group = get().getPanelGroup(focusedId);
            if (group) get().setActiveTab(group.id, focusedId);
          }
        }
      },

      reset: async () => {
        const state = get();

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.destroy(tid);
          } catch (error) {
            logWarn(`Failed to destroy terminal instance ${tid}`, { error });
          }
        }

        const killPromises = state.panelIds.map((tid) =>
          terminalRegistryController.kill(tid).catch((error) => {
            logError(`Failed to kill terminal ${tid}`, error);
          })
        );

        await Promise.all(killPromises);

        const { useTerminalInputStore: inputStore } = await import("./terminalInputStore");
        inputStore.getState().clearAllDraftInputs();

        set({
          panelsById: {},
          panelIds: [],
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
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

        flushPanelPersistence();

        const allTerminalIds = [...state.panelIds];
        terminalInstanceService.suppressResizesDuringProjectSwitch(
          allTerminalIds,
          PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
        );

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.detachForProjectSwitch(tid);
          } catch (error) {
            logWarn(`Failed to detach terminal instance ${tid}`, { error });
          }
        }

        logInfo(
          `Detached ${state.panelIds.length} terminal instances for project switch (processes preserved)`
        );

        set({
          panelsById: {},
          panelIds: [],
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
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

        flushPanelPersistence();

        const allTerminalIds = [...state.panelIds];
        terminalInstanceService.suppressResizesDuringProjectSwitch(
          allTerminalIds,
          PROJECT_SWITCH_RESIZE_SUPPRESSION_MS
        );

        for (const tid of state.panelIds) {
          try {
            terminalInstanceService.detachForProjectSwitch(tid);
          } catch (error) {
            logWarn(`Failed to detach terminal instance ${tid}`, { error });
          }
        }

        logInfo(
          `Detached ${state.panelIds.length} terminal instances for project switch (processes preserved, state retained)`
        );
      },

      clearTerminalStoreForSwitch: () => {
        set({
          panelsById: {},
          panelIds: [],
          trashedTerminals: new Map(),
          backgroundedTerminals: new Map(),
          tabGroups: new Map(),
          focusedId: null,
          previousFocusedId: null,
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
          watchedPanels: new Set(),
        });
      },
    };
  })
);

// Break circular dependency: inject terminal store getter into projectStore
// so buildOutgoingState() can synchronously snapshot terminal state.
setPanelStoreGetter(() => {
  const s = usePanelStore.getState();
  return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
});

export { setupTerminalStoreListeners, cleanupTerminalStoreListeners } from "./panelStoreListeners";
