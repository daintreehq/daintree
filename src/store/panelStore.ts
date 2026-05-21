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
import { isAssistantFocused } from "./macroFocusStore";
import { isMcpSpawnFocusSuppressed } from "./mcpSpawnFocusGuard";
import type { CrashType } from "@shared/types/pty-host";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";
import { clearTerminalRestartGuard } from "./restartExitSuppression";
import { buildPanelSnapshotOptions } from "@/services/terminal/panelDuplicationService";

export type { TerminalInstance, AddPanelOptions, QueuedCommand, CrashType };
export { isAgentReady };
export type { TerminalMruSlice, WatchedPanelsSlice };

const PROJECT_SWITCH_RESIZE_SUPPRESSION_MS = 10_000;

function isVisibleLivePtyTerminal(terminal: TerminalInstance): boolean {
  const location = terminal.location ?? "grid";
  if (location === "trash" || location === "background" || location === "dock") return false;
  if (terminal.isVisible === false) return false;
  if (terminal.hasPty === false) return false;
  if (terminal.runtimeStatus === "exited" || terminal.runtimeStatus === "error") return false;
  if (terminal.runtimeStatus === "background") return false;
  if (terminal.agentState === "completed" || terminal.agentState === "exited") return false;
  return true;
}

export function getTerminalRefreshTier(
  terminal: TerminalInstance | undefined,
  isFocused: boolean,
  options: { isFleetArmed?: boolean } = {}
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

  // Fleet input can target a terminal before runtime agent detection has
  // caught up. Keep armed live PTYs visible so broadcast responses stream
  // promptly instead of being parked in the background tier.
  if (
    options.isFleetArmed &&
    terminal.hasPty !== false &&
    terminal.location !== "trash" &&
    terminal.location !== "background" &&
    terminal.location !== "dock" &&
    terminal.runtimeStatus !== "exited" &&
    terminal.runtimeStatus !== "error"
  ) {
    return TerminalRefreshTierEnum.VISIBLE;
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

  // Visible live PTYs must keep streaming even when they are not focused.
  // The previous "working" guard was too dependent on activity heuristics:
  // if a long-running process was still classified as waiting/idle, the
  // renderer moved to BACKGROUND and output stopped until focus/wake.
  if (isVisibleLivePtyTerminal(terminal)) {
    return TerminalRefreshTierEnum.VISIBLE;
  }

  // Only explicitly hidden, completed/exited, errored, or PTY-less terminals
  // reach BACKGROUND now. Visible live terminals stay connected to the active
  // streaming path even when another pane has focus.
  return TerminalRefreshTierEnum.BACKGROUND;
}

export type BackendStatus = "connected" | "disconnected" | "recovering";

export type WatchdogStatus = "active" | "disabled";

export interface WatchdogDisabledInfo {
  attemptCount: number;
  lastExitCode: number | null;
  timestamp: number;
}

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
  watchdogStatus: WatchdogStatus;
  watchdogDisabledInfo: WatchdogDisabledInfo | null;
  setBackendStatus: (status: BackendStatus) => void;
  setLastCrashType: (crashType: CrashType | null) => void;
  setWatchdogDisabled: (info: WatchdogDisabledInfo) => void;
  clearWatchdogDisabled: () => void;
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
    const focusSlice = createTerminalFocusSlice(getTerminals, getActiveWorktreeId, (id) =>
      get().stampLastActive(id)
    )(set, get, api);
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
      watchdogStatus: "active" as WatchdogStatus,
      watchdogDisabledInfo: null as WatchdogDisabledInfo | null,
      lastClosedConfig: null as AddPanelOptions | null,
      setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),
      setLastCrashType: (crashType: CrashType | null) => set({ lastCrashType: crashType }),
      setWatchdogDisabled: (info: WatchdogDisabledInfo) =>
        set({ watchdogStatus: "disabled", watchdogDisabledInfo: info }),
      clearWatchdogDisabled: () => set({ watchdogStatus: "active", watchdogDisabledInfo: null }),

      addPanel: async (options: AddPanelOptions) => {
        // Capture the pre-create focus so we can restore previousFocusedId for the
        // dock-activation path (#6590). The registry slice atomically advances
        // focusedId to the new id when activateDockOnCreate is set, so by the
        // time it returns, we've lost the pre-create focus from the store.
        const focusedBeforeCreate = get().focusedId;
        // Read focus-steal gates synchronously, BEFORE the async registry call.
        // `document.activeElement` and the macro-focus store are mutable in
        // response to renderer DOM updates that can land during the await
        // boundary; capturing here pins them to the user's pre-create state
        // (#6959 — assistant focus theft when MCP launches an agent).
        const assistantHasFocus = isAssistantFocused();
        const suppressMcpSpawnFocus = options.spawnedBy === "mcp" || isMcpSpawnFocusSuppressed();
        const panelOptions =
          suppressMcpSpawnFocus && options.spawnedBy !== "mcp"
            ? ({ ...options, spawnedBy: "mcp" } as AddPanelOptions)
            : options;
        const id = await registrySlice.addPanel(panelOptions);
        if (id === null) return null;
        // Skip the per-panel focus mutation while a hydration batch is collecting panels:
        // firing `set({ focusedId })` here would schedule one extra render per panel and
        // defeat the batch's single-render guarantee. The arbitrary "last panel added"
        // focus also isn't meaningful during restore — focus is resolved elsewhere once
        // the active worktree is set.
        if ((!options.location || options.location === "grid") && !isHydrationBatchActive()) {
          // Suppress focus capture for MCP-initiated spawns or when the
          // Daintree Assistant currently owns keyboard focus. The new panel
          // still lands in the grid; the user keeps typing where they were.
          if (assistantHasFocus || suppressMcpSpawnFocus) {
            return id;
          }
          if (focusedBeforeCreate !== id) {
            set({ focusedId: id, previousFocusedId: focusedBeforeCreate });
          } else {
            set({ focusedId: id });
          }
        } else if (
          options.activateDockOnCreate &&
          options.location === "dock" &&
          !isHydrationBatchActive()
        ) {
          // The registry slice atomically advances `focusedId` to the new id
          // inside its commit for normal dock activations (#6590). When the
          // assistant currently owns input we issue a corrective set() to roll
          // keyboard focus back while leaving the dock popover open. MCP spawns
          // skip both registry focus and dock-popover activation entirely
          // (handled in `panelRegistry/addPanel.ts`), so no rollback is needed
          // for the MCP case.
          if (assistantHasFocus && !suppressMcpSpawnFocus) {
            set({ focusedId: focusedBeforeCreate });
          } else if (
            !suppressMcpSpawnFocus &&
            focusedBeforeCreate !== null &&
            focusedBeforeCreate !== id
          ) {
            // Best-effort previousFocusedId for the tmux-style alternate-pane toggle.
            // Updating in a follow-up set() is fine — previousFocusedId is metadata,
            // not load-bearing for dock visibility (which the watchdog effect cares
            // about and which is already covered by the registry's atomic commit).
            // MCP spawns skip this — they never participate in alternate-pane focus.
            set({ previousFocusedId: focusedBeforeCreate });
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
          panelIdsByWorktreeId: {},
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
          panelIdsByWorktreeId: {},
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
          panelIdsByWorktreeId: {},
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

/**
 * Non-hook alias for the panel store's vanilla API. Use this for imperative
 * `getState()`/`subscribe()` access inside React Compiler-processed code
 * (`"use memo"` components, `useMemo` bodies) where referencing the
 * `usePanelStore` hook as a value is disallowed.
 */
export const panelStoreApi = usePanelStore;

export { setupTerminalStoreListeners, cleanupTerminalStoreListeners } from "./panelStoreListeners";
