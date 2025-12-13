/**
 * Use atomic selectors to prevent unnecessary re-renders.
 * @see src/hooks/useTerminalSelectors.ts for optimized selector hooks
 */

import { create } from "zustand";
import type { AgentState } from "@/types";
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

export type { TerminalInstance, AddTerminalOptions, QueuedCommand };
export { isAgentReady };

export function getTerminalRefreshTier(
  terminal: TerminalInstance | undefined,
  isFocused: boolean
): TerminalRefreshTier {
  if (!terminal) {
    return TerminalRefreshTier.BACKGROUND;
  }

  // Always use maximum refresh rate when agent is working to prevent render jitter
  if (terminal.agentState === "working") {
    return TerminalRefreshTier.FOCUSED;
  }

  if (isFocused) {
    return TerminalRefreshTier.FOCUSED;
  }

  if (terminal.location === "dock" || terminal.location === "trash") {
    return TerminalRefreshTier.BACKGROUND;
  }

  if (terminal.isVisible) {
    return TerminalRefreshTier.VISIBLE;
  }

  return TerminalRefreshTier.BACKGROUND;
}

export type BackendStatus = "connected" | "disconnected" | "recovering";

export interface TerminalGridState
  extends
    TerminalRegistrySlice,
    TerminalFocusSlice,
    TerminalCommandQueueSlice,
    TerminalBulkActionsSlice {
  backendStatus: BackendStatus;
  setBackendStatus: (status: BackendStatus) => void;
  reset: () => Promise<void>;
  resetWithoutKilling: () => Promise<void>;
  restoreLastTrashed: () => void;
}

export const useTerminalStore = create<TerminalGridState>()((set, get, api) => {
  const getTerminals = () => get().terminals;
  const getTerminal = (id: string) => get().terminals.find((t) => t.id === id);

  const registrySlice = createTerminalRegistrySlice({
    onTerminalRemoved: (id, removedIndex, remainingTerminals) => {
      get().clearQueue(id);
      get().handleTerminalRemoved(id, remainingTerminals, removedIndex);
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
    setBackendStatus: (status: BackendStatus) => set({ backendStatus: status }),

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

      const updates: Partial<TerminalGridState> = {};

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

      const updates: Partial<TerminalGridState> = {};

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

    moveTerminalToPosition: (id: string, toIndex: number, location: "grid" | "dock") => {
      const state = get();
      registrySlice.moveTerminalToPosition(id, toIndex, location);

      if (location === "grid") {
        set({ focusedId: id, activeDockTerminalId: null });
      } else if (state.focusedId === id) {
        const gridTerminals = state.terminals.filter((t) => t.id !== id && t.location === "grid");
        set({ focusedId: gridTerminals[0]?.id ?? null });
      }
    },

    reset: async () => {
      const state = get();

      const { terminalInstanceService } = await import("@/services/TerminalInstanceService");
      for (const terminal of state.terminals) {
        try {
          terminalInstanceService.destroy(terminal.id);
        } catch (error) {
          console.warn(`Failed to destroy terminal instance ${terminal.id}:`, error);
        }
      }

      const killPromises = state.terminals.map((terminal) =>
        terminalClient.kill(terminal.id).catch((error) => {
          console.error(`Failed to kill terminal ${terminal.id}:`, error);
        })
      );

      await Promise.all(killPromises);

      set({
        terminals: [],
        trashedTerminals: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        commandQueue: [],
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
          console.warn(`Failed to destroy terminal instance ${terminal.id}:`, error);
        }
      }

      // DO NOT send kill commands to backend - processes stay alive from Phase 1
      console.log(
        `[TerminalStore] Reset UI state for ${state.terminals.length} terminals (processes preserved)`
      );

      set({
        terminals: [],
        trashedTerminals: new Map(),
        focusedId: null,
        maximizedId: null,
        activeDockTerminalId: null,
        commandQueue: [],
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
let recoveryTimer: NodeJS.Timeout | null = null;
let beforeUnloadHandler: (() => void) | null = null;

export function cleanupTerminalStoreListeners() {
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
    const { agentId, state, timestamp, trigger, confidence } = data;

    const validStates: AgentState[] = [
      "idle",
      "working",
      "running",
      "waiting",
      "completed",
      "failed",
    ];
    if (!validStates.includes(state as AgentState)) {
      console.warn(`Invalid agent state received: ${state} for terminal ${agentId}`);
      return;
    }

    // Update terminal instance service (enables state-aware rendering in XtermAdapter)
    terminalInstanceService.setAgentState(agentId, state as AgentState);

    useTerminalStore
      .getState()
      .updateAgentState(agentId, state as AgentState, undefined, timestamp, trigger, confidence);

    if (state === "waiting" || state === "idle") {
      useTerminalStore.getState().processQueue(agentId);
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

    const updates: Partial<TerminalGridState> = {};
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

  exitUnsubscribe = terminalClient.onExit((id) => {
    const state = useTerminalStore.getState();
    const terminal = state.terminals.find((t) => t.id === id);

    if (!terminal) return;

    // Ignore exit events during restart - the exit is expected from killing the old PTY
    if (terminal.isRestarting) {
      return;
    }

    // If already trashed, this is TTL expiry cleanup - permanently remove
    if (terminal.location === "trash") {
      state.removeTerminal(id);
      return;
    }

    // Auto-trash on exit preserves history for review (consistent with manual close)
    state.trashTerminal(id);
  });

  flowStatusUnsubscribe = terminalClient.onStatus((data) => {
    const { id, status, timestamp } = data;
    useTerminalStore.getState().updateFlowStatus(id, status, timestamp);
  });

  backendCrashedUnsubscribe = terminalClient.onBackendCrashed((details) => {
    console.error("[TerminalStore] Backend crashed:", details);

    // Cancel any pending recovery timer
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }

    useTerminalStore.setState({ backendStatus: "disconnected" });
  });

  backendReadyUnsubscribe = terminalClient.onBackendReady(() => {
    console.log("[TerminalStore] Backend recovered, resetting renderers...");

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
      useTerminalStore.setState({ backendStatus: "connected" });
    }, 500);
  });

  // Flush pending terminal persistence on window close to prevent data loss
  beforeUnloadHandler = () => {
    flushTerminalPersistence();
  };
  window.addEventListener("beforeunload", beforeUnloadHandler);

  return cleanupTerminalStoreListeners;
}
