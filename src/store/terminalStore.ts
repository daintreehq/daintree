/**
 * Use atomic selectors to prevent unnecessary re-renders.
 * @see src/hooks/useTerminalSelectors.ts for optimized selector hooks
 */

import { create } from "zustand";
import { TerminalRefreshTier } from "@/types";
import {
  createTerminalRegistrySlice,
  createTerminalFocusSlice,
  createTerminalCommandQueueSlice,
  createTerminalBulkActionsSlice,
  flushTerminalPersistence,
  type TerminalRegistrySlice,
  type TerminalFocusSlice,
  type TerminalCommandQueueSlice,
  type TerminalBulkActionsSlice,
  type TerminalInstance,
  type AddTerminalOptions,
  type QueuedCommand,
  isAgentReady,
} from "./slices";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useTerminalInputStore } from "./terminalInputStore";
import type { CrashType } from "@shared/types/pty-host";
import { isAgentTerminal } from "@/utils/terminalType";
import { logInfo, logWarn, logError } from "@/utils/logger";

export type { TerminalInstance, AddTerminalOptions, QueuedCommand, CrashType };
export { isAgentReady };

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
    return TerminalRefreshTier.VISIBLE;
  }

  // Always use maximum refresh rate when agent is working to prevent render jitter
  if (terminal.agentState === "working") {
    return TerminalRefreshTier.FOCUSED;
  }

  if (isFocused) {
    return TerminalRefreshTier.FOCUSED;
  }

  // All terminals stay at VISIBLE minimum - we don't use BACKGROUND for reliability.
  return TerminalRefreshTier.VISIBLE;
}

export type BackendStatus = "connected" | "disconnected" | "recovering";

export interface PanelGridState
  extends
    TerminalRegistrySlice,
    TerminalFocusSlice,
    TerminalCommandQueueSlice,
    TerminalBulkActionsSlice {
  backendStatus: BackendStatus;
  lastCrashType: CrashType | null;
  setBackendStatus: (status: BackendStatus) => void;
  setLastCrashType: (crashType: CrashType | null) => void;
  reset: () => Promise<void>;
  resetWithoutKilling: () => Promise<void>;
  restoreLastTrashed: () => void;
}

export const useTerminalStore = create<PanelGridState>()((set, get, api) => {
  const getTerminals = () => get().terminals;
  const getTerminal = (id: string) => get().terminals.find((t) => t.id === id);

  const registrySlice = createTerminalRegistrySlice({
    onTerminalRemoved: (id, removedIndex, remainingTerminals) => {
      clearTerminalRestartGuard(id);
      get().clearQueue(id);
      get().handleTerminalRemoved(id, remainingTerminals, removedIndex);
      useTerminalInputStore.getState().clearDraftInput(id);

      // Clean up stale tab group mappings
      const validPanelIds = new Set(remainingTerminals.map((t) => t.id));
      get().cleanupStaleTabs(validPanelIds);

      // Clean up worktree focus tracking if this was the last focused terminal
      const terminal = get().terminals.find((t) => t.id === id);
      if (terminal?.worktreeId) {
        void import("@/store/worktreeStore").then(({ useWorktreeSelectionStore }) => {
          const store = useWorktreeSelectionStore.getState();
          const lastFocused = store.lastFocusedTerminalByWorktree.get(terminal.worktreeId!);
          if (lastFocused === id) {
            store.clearWorktreeFocusTracking(terminal.worktreeId!);
          }
        });
      }
    },
  })(set, get, api);

  const focusSlice = createTerminalFocusSlice(getTerminals)(set, get, api);
  const commandQueueSlice = createTerminalCommandQueueSlice(getTerminal)(set, get, api);
  const bulkActionsSlice = createTerminalBulkActionsSlice(
    getTerminals,
    (id) => get().removeTerminal(id),
    (id) => get().restartTerminal(id),
    (id) => get().trashTerminal(id),
    (id) => get().moveTerminalToDock(id),
    (id) => get().moveTerminalToGrid(id),
    () => get().focusedId,
    (id) => set({ focusedId: id })
  )(set, get, api);

  return {
    ...registrySlice,
    ...focusSlice,
    ...commandQueueSlice,
    ...bulkActionsSlice,

    backendStatus: "connected" as BackendStatus,
    lastCrashType: null as CrashType | null,
    setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),
    setLastCrashType: (crashType: CrashType | null) => set({ lastCrashType: crashType }),

    addTerminal: async (options: AddTerminalOptions) => {
      const id = await registrySlice.addTerminal(options);
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
        const gridTerminals = state.terminals.filter((t) => t.id !== id && t.location === "grid");
        updates.focusedId = gridTerminals[0]?.id ?? null;
      }

      if (state.maximizedId === id) {
        updates.maximizedId = null;
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

      const updates: Partial<PanelGridState> = {};

      if (state.focusedId === id) {
        const gridTerminals = state.terminals.filter((t) => t.id !== id && t.location === "grid");
        updates.focusedId = gridTerminals[0]?.id ?? null;
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

    restoreTerminal: (id: string, targetWorktreeId?: string) => {
      registrySlice.restoreTerminal(id, targetWorktreeId);
      set({ focusedId: id, activeDockTerminalId: null });
    },

    restoreLastTrashed: () => {
      const trashedIds = Array.from(get().trashedTerminals.keys());
      if (trashedIds.length === 0) {
        return;
      }
      const lastId = trashedIds[trashedIds.length - 1];
      get().restoreTerminal(lastId);
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
        const gridTerminals = state.terminals.filter((t) => t.id !== id && t.location === "grid");
        set({ focusedId: gridTerminals[0]?.id ?? null });
      }
    },

    // Override setActiveTab to update both activeTabByGroup (focus slice) and TabGroup.activeTabId (registry)
    // This ensures the active tab selection is persisted and survives restart
    setActiveTab: (groupId: string, panelId: string) => {
      // First validate that this is a real group with the panel as a member
      const group = get().tabGroups.get(groupId);
      const isValidGroupMember = group && group.panelIds.includes(panelId);

      // Only update focus map if panel is in the group (prevents split-brain state)
      if (isValidGroupMember) {
        focusSlice.setActiveTab(groupId, panelId);
      } else {
        // For virtual groups (no explicit TabGroup), still update focus map for UI
        if (!group) {
          focusSlice.setActiveTab(groupId, panelId);
        }
        // If group exists but panel not in it, skip focus update to maintain consistency
        return;
      }

      // Also update the TabGroup.activeTabId in the registry for persistence
      set((state) => {
        const currentGroup = state.tabGroups.get(groupId);
        if (!currentGroup) {
          // Not an explicit tab group (virtual single-panel group)
          return state;
        }

        // Only update if the panel is actually in this group
        if (!currentGroup.panelIds.includes(panelId)) {
          return state;
        }

        // Update the group's activeTabId
        const newTabGroups = new Map(state.tabGroups);
        newTabGroups.set(groupId, { ...currentGroup, activeTabId: panelId });

        // Persist synchronously from latest state to avoid race conditions
        // Use get() to ensure we persist the most recent tabGroups, not a stale snapshot
        import("./slices/terminalRegistry/persistence").then(({ saveTabGroups }) => {
          saveTabGroups(get().tabGroups);
        });

        return { tabGroups: newTabGroups };
      });
    },

    // Override hydrateTabGroups to also seed activeTabByGroup from persisted TabGroup.activeTabId
    // This ensures the active tab state is restored after restart
    hydrateTabGroups: (tabGroups) => {
      // First, call the registry's hydrateTabGroups to sanitize and store the groups
      registrySlice.hydrateTabGroups(tabGroups);

      // Then seed activeTabByGroup from the hydrated TabGroup.activeTabId values
      const hydratedGroups = get().tabGroups;
      const newActiveTabByGroup = new Map<string, string>();
      for (const [groupId, group] of hydratedGroups) {
        if (group.activeTabId) {
          newActiveTabByGroup.set(groupId, group.activeTabId);
        }
      }

      // Update the focus slice's activeTabByGroup map
      set({ activeTabByGroup: newActiveTabByGroup });
    },

    reset: async () => {
      const state = get();

      const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.destroy(terminal.id);
        } catch (error) {
          logWarn(`Failed to destroy terminal instance ${terminal.id}`, { error });
        }
      }

      const killPromises = state.terminals.map((terminal) =>
        terminalClient.kill(terminal.id).catch((error) => {
          logError(`Failed to kill terminal ${terminal.id}`, error);
        })
      );

      await Promise.all(killPromises);

      useTerminalInputStore.getState().clearAllDraftInputs();

      set({
        terminals: [],
        trashedTerminals: new Map(),
        tabGroups: new Map(),
        activeTabByGroup: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        backendStatus: "connected",
        lastCrashType: null,
      });
    },

    resetWithoutKilling: async () => {
      const state = get();

      flushTerminalPersistence();

      // Destroy xterm.js instances (renderer-side cleanup only)
      const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.destroy(terminal.id);
        } catch (error) {
          logWarn(`Failed to destroy terminal instance ${terminal.id}`, { error });
        }
      }

      // DO NOT send kill commands to backend - processes stay alive from Phase 1
      logInfo(`Reset UI state for ${state.terminals.length} terminals (processes preserved)`);

      useTerminalInputStore.getState().clearAllDraftInputs();

      set({
        terminals: [],
        trashedTerminals: new Map(),
        tabGroups: new Map(),
        activeTabByGroup: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        pingedId: null,
        preMaximizeLayout: null,
        commandQueue: [],
        backendStatus: "connected",
        lastCrashType: null,
      });
    },
  };
});

let agentStateUnsubscribe: (() => void) | null = null;
let activityUnsubscribe: (() => void) | null = null;
let trashedUnsubscribe: (() => void) | null = null;
let restoredUnsubscribe: (() => void) | null = null;
let exitUnsubscribe: (() => void) | null = null;
let flowStatusUnsubscribe: (() => void) | null = null;
let backendCrashedUnsubscribe: (() => void) | null = null;
let backendReadyUnsubscribe: (() => void) | null = null;
let spawnResultUnsubscribe: (() => void) | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let beforeUnloadHandler: (() => void) | null = null;

import {
  clearAllRestartGuards,
  isTerminalRestarting,
  clearTerminalRestartGuard,
} from "./restartExitSuppression";

export function cleanupTerminalStoreListeners() {
  clearAllRestartGuards();
  if (agentStateUnsubscribe) {
    agentStateUnsubscribe();
    agentStateUnsubscribe = null;
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

  agentStateUnsubscribe = terminalClient.onAgentStateChanged((data) => {
    const { terminalId, state, timestamp, trigger, confidence } = data;

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

    useTerminalStore
      .getState()
      .updateAgentState(terminalId, state, undefined, timestamp, trigger, clampedConfidence);

    if (state === "waiting" || state === "idle") {
      useTerminalStore.getState().processQueue(terminalId);
    }
  });

  activityUnsubscribe = terminalClient.onActivity((data) => {
    const { terminalId, headline, status, type, timestamp, lastCommand } = data;
    useTerminalStore
      .getState()
      .updateActivity(terminalId, headline, status, type, timestamp, lastCommand);
  });

  trashedUnsubscribe = terminalClient.onTrashed((data) => {
    const { id, expiresAt } = data;
    const state = useTerminalStore.getState();
    const terminal = state.terminals.find((t) => t.id === id);
    const originalLocation: "dock" | "grid" = terminal?.location === "dock" ? "dock" : "grid";
    state.markAsTrashed(id, expiresAt, originalLocation);

    const updates: Partial<PanelGridState> = {};
    if (state.focusedId === id) {
      const gridTerminals = state.terminals.filter((t) => t.id !== id && t.location === "grid");
      updates.focusedId = gridTerminals[0]?.id ?? null;
    }
    if (state.maximizedId === id) {
      updates.maximizedId = null;
    }
    if (Object.keys(updates).length > 0) {
      useTerminalStore.setState(updates);
    }
  });

  restoredUnsubscribe = terminalClient.onRestored((data) => {
    const { id } = data;
    useTerminalStore.getState().markAsRestored(id);
    useTerminalStore.setState({ focusedId: id });
  });

  exitUnsubscribe = terminalClient.onExit((id, exitCode) => {
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

    if (terminal.exitBehavior === "keep") {
      // Explicit keep - preserve terminal regardless of type
      return;
    }

    // exitBehavior undefined - use default behavior based on terminal type
    // Preserve successfully completed agent terminals to enable reboot and output review
    if (isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId)) {
      return;
    }

    // Auto-trash non-agent terminals on exit (preserves history for review, consistent with manual close)
    state.trashTerminal(id);
  });

  flowStatusUnsubscribe = terminalClient.onStatus((data) => {
    const { id, status, timestamp } = data;
    useTerminalStore.getState().updateFlowStatus(id, status, timestamp);

    // Recover from stalled streaming states without requiring a focus change.
    if (status === "suspended" || status === "paused-backpressure") {
      terminalInstanceService.wake(id);
    }
  });

  backendCrashedUnsubscribe = terminalClient.onBackendCrashed((details) => {
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

  backendReadyUnsubscribe = terminalClient.onBackendReady(() => {
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

  spawnResultUnsubscribe = terminalClient.onSpawnResult((id, result) => {
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

  // Flush pending terminal persistence on window close to prevent data loss
  beforeUnloadHandler = () => {
    flushTerminalPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);

  return cleanupTerminalStoreListeners;
}
