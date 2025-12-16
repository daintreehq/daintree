import type { StateCreator } from "zustand";
import type {
  TerminalInstance as TerminalInstanceType,
  TerminalRestartError,
  AgentState,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
  TerminalFlowStatus,
  TerminalViewMode,
} from "@/types";
import { terminalClient, agentSettingsClient } from "@/clients";
import { generateAgentFlags } from "@shared/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { terminalPersistence } from "../persistence/terminalPersistence";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";

export const MAX_GRID_TERMINALS = 16;

const DOCK_WIDTH = 700;
const DOCK_HEIGHT = 500;
const HEADER_HEIGHT = 32;
const PADDING_X = 24;
const PADDING_Y = 24;

const DOCK_TERM_WIDTH = DOCK_WIDTH - PADDING_X;
const DOCK_TERM_HEIGHT = DOCK_HEIGHT - HEADER_HEIGHT - PADDING_Y;

// Reliability: keep PTY geometry optimistic even when docked to avoid hard-wrapping output.
// Dock previews are clipped rather than driving PTY resizes.
const DOCK_PREWARM_WIDTH_PX = 1200;
const DOCK_PREWARM_HEIGHT_PX = 800;

export type TerminalInstance = TerminalInstanceType;

export interface AddTerminalOptions {
  kind?: "terminal" | "agent";
  type?: TerminalType;
  /** Agent ID when type is an agent - enables extensibility for new agents */
  agentId?: string;
  title?: string;
  worktreeId?: string;
  cwd: string;
  shell?: string;
  command?: string;
  location?: TerminalLocation;
  agentState?: AgentState;
  lastStateChange?: number;
  /** If provided, request a stable ID when spawning a new backend process */
  requestedId?: string;
  /** If provided, reconnect to existing backend process instead of spawning */
  existingId?: string;
  /** Store command on instance but don't execute it on spawn */
  skipCommandExecution?: boolean;
  /** Restore input lock state (read-only monitor mode) */
  isInputLocked?: boolean;
  /** Terminal rendering mode (experiment) */
  viewMode?: TerminalViewMode;
}

function getDefaultTitle(type?: TerminalType, agentId?: string): string {
  // If agentId is provided, try to get the title from the registry
  if (agentId) {
    const config = getAgentConfig(agentId);
    if (config) {
      return config.name;
    }
  }
  // Fall back to checking type as agent ID (backward compat)
  if (type && type !== "terminal") {
    const config = getAgentConfig(type);
    if (config) {
      return config.name;
    }
  }
  return "Terminal";
}

export interface TrashedTerminal {
  id: string;
  expiresAt: number;
  originalLocation: "dock" | "grid";
}

export interface TerminalRegistrySlice {
  terminals: TerminalInstance[];
  trashedTerminals: Map<string, TrashedTerminal>;

  addTerminal: (options: AddTerminalOptions) => Promise<string>;
  removeTerminal: (id: string) => void;
  updateTitle: (id: string, newTitle: string) => void;
  updateAgentState: (
    id: string,
    agentState: AgentState,
    error?: string,
    lastStateChange?: number,
    trigger?: AgentStateChangeTrigger,
    confidence?: number
  ) => void;
  updateActivity: (
    id: string,
    headline: string,
    status: "working" | "waiting" | "success" | "failure",
    type: "interactive" | "background" | "idle",
    timestamp: number,
    lastCommand?: string
  ) => void;
  updateLastCommand: (id: string, lastCommand: string) => void;
  updateVisibility: (id: string, isVisible: boolean) => void;
  getTerminal: (id: string) => TerminalInstance | undefined;
  setViewMode: (id: string, viewMode: TerminalViewMode) => void;

  moveTerminalToDock: (id: string) => void;
  moveTerminalToGrid: (id: string) => boolean;
  toggleTerminalLocation: (id: string) => void;

  trashTerminal: (id: string) => void;
  restoreTerminal: (id: string, targetWorktreeId?: string) => void;
  markAsTrashed: (id: string, expiresAt: number, originalLocation: "dock" | "grid") => void;
  markAsRestored: (id: string) => void;
  isInTrash: (id: string) => boolean;

  reorderTerminals: (fromIndex: number, toIndex: number, location?: "grid" | "dock") => void;
  moveTerminalToPosition: (id: string, toIndex: number, location: "grid" | "dock") => void;

  restartTerminal: (id: string) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
  moveTerminalToWorktree: (id: string, worktreeId: string) => void;
  updateFlowStatus: (id: string, status: TerminalFlowStatus, timestamp: number) => void;
  setInputLocked: (id: string, locked: boolean) => void;
  toggleInputLocked: (id: string) => void;
}

// Flush pending persistence - call on app quit to prevent data loss
export function flushTerminalPersistence(): void {
  terminalPersistence.flush();
}

export type TerminalRegistryMiddleware = {
  onTerminalRemoved?: (
    id: string,
    removedIndex: number,
    remainingTerminals: TerminalInstance[]
  ) => void;
};

const optimizeForDock = (id: string) => {
  terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
};

export const createTerminalRegistrySlice =
  (
    middleware?: TerminalRegistryMiddleware
  ): StateCreator<TerminalRegistrySlice, [], [], TerminalRegistrySlice> =>
  (set, get) => ({
    terminals: [],
    trashedTerminals: new Map(),

    addTerminal: async (options) => {
      const requestedKind = options.kind ?? (options.agentId ? "agent" : "terminal");
      const legacyType = options.type || "terminal";
      // Derive agentId: explicit option, or from legacy type if it's a registered agent
      const agentId = options.agentId ?? (isRegisteredAgent(legacyType) ? legacyType : undefined);
      const kind: "terminal" | "agent" = agentId ? "agent" : requestedKind;
      const title = options.title || getDefaultTitle(legacyType, agentId);

      // Auto-dock if grid is full and user requested grid location
      const currentGridCount = get().terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      ).length;
      const requestedLocation = options.location || "grid";
      const location =
        requestedLocation === "grid" && currentGridCount >= MAX_GRID_TERMINALS
          ? "dock"
          : requestedLocation;

      try {
        let id: string;

        if (options.existingId) {
          // Reconnecting to existing backend process - don't spawn new
          id = options.existingId;
          console.log(`[TerminalStore] Reconnecting to existing terminal: ${id}`);
        } else {
          // Spawn new process - only execute command if not skipping
          const commandToExecute = options.skipCommandExecution ? undefined : options.command;
          id = await terminalClient.spawn({
            id: options.requestedId,
            cwd: options.cwd,
            shell: options.shell,
            cols: 80,
            rows: 24,
            command: commandToExecute,
            kind,
            type: legacyType,
            agentId,
            title,
            worktreeId: options.worktreeId,
          });
        }

        // Prewarm renderer-side xterm immediately so we never drop startup output/ANSI while hidden.
        // For docked terminals, also open + fit offscreen so the PTY starts with correct dimensions.
        try {
          const { scrollbackLines } = useScrollbackStore.getState();
          const { performanceMode } = usePerformanceModeStore.getState();
          const { fontSize, fontFamily } = useTerminalFontStore.getState();

          const effectiveScrollback = performanceMode
            ? PERFORMANCE_MODE_SCROLLBACK
            : getScrollbackForType(legacyType, scrollbackLines);

          const terminalOptions = {
            cursorBlink: true,
            cursorStyle: "block" as const,
            cursorInactiveStyle: "block" as const,
            fontSize,
            lineHeight: 1.1,
            letterSpacing: 0,
            fontFamily: fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
            fontLigatures: false,
            fontWeight: "normal" as const,
            fontWeightBold: "700" as const,
            theme: getTerminalThemeFromCSS(),
            allowProposedApi: true,
            smoothScrollDuration: performanceMode ? 0 : 0,
            scrollback: effectiveScrollback,
            macOptionIsMeta: true,
            scrollOnUserInput: false,
            fastScrollModifier: "alt" as const,
            fastScrollSensitivity: 5,
            scrollSensitivity: 1.5,
          };

          terminalInstanceService.prewarmTerminal(id, legacyType, terminalOptions, {
            offscreen: location === "dock",
            widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
            heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
          });
        } catch (error) {
          console.warn(`[TerminalStore] Failed to prewarm terminal ${id}:`, error);
        }

        // Determine if this is an agent terminal (by agentId or legacy type)
        const isAgent = kind === "agent";

        const agentState = options.agentState ?? (isAgent ? "idle" : undefined);
        const lastStateChange =
          options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined);

        const experimentEnabled = terminalClient.isSnapshotStreamingExperimentEnabled();
        const isSnapshotDefaultAgent =
          agentId === "claude" ||
          agentId === "gemini" ||
          legacyType === "claude" ||
          legacyType === "gemini";
        const defaultViewMode =
          experimentEnabled && isSnapshotDefaultAgent ? ("snapshot" as const) : ("live" as const);
        const viewMode = options.viewMode ?? defaultViewMode;

        const terminal: TerminalInstance = {
          id,
          kind,
          type: legacyType,
          agentId,
          title,
          worktreeId: options.worktreeId,
          cwd: options.cwd,
          cols: 80,
          rows: 24,
          agentState,
          lastStateChange,
          location,
          command: options.command,
          // Initialize grid terminals as visible to avoid initial under-throttling
          // IntersectionObserver will update this once mounted
          isVisible: location === "grid" ? true : false,
          isInputLocked: options.isInputLocked,
          viewMode: experimentEnabled ? viewMode : "live",
        };

        set((state) => {
          const newTerminals = [...state.terminals, terminal];
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        if (location === "dock") {
          // Terminal is already sized via offscreen fit; keep background policy.
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
        }

        terminalInstanceService.setInputLocked(id, !!options.isInputLocked);

        return id;
      } catch (error) {
        console.error("Failed to spawn terminal:", error);
        throw error;
      }
    },

    removeTerminal: (id) => {
      const currentTerminals = get().terminals;
      const removedIndex = currentTerminals.findIndex((t) => t.id === id);

      terminalClient.kill(id).catch((error) => {
        console.error("Failed to kill terminal:", error);
      });

      terminalInstanceService.destroy(id);

      set((state) => {
        const newTerminals = state.terminals.filter((t) => t.id !== id);

        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals, trashedTerminals: newTrashed };
      });

      const remainingTerminals = get().terminals;
      middleware?.onTerminalRemoved?.(id, removedIndex, remainingTerminals);
    },

    updateTitle: (id, newTitle) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const effectiveTitle = newTitle.trim() || getDefaultTitle(terminal.type, terminal.agentId);
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, title: effectiveTitle } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },

    updateAgentState: (id, agentState, error, lastStateChange, trigger, confidence) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          console.warn(`Cannot update agent state: terminal ${id} not found`);
          return state;
        }

        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                agentState,
                error,
                lastStateChange: lastStateChange ?? Date.now(),
                stateChangeTrigger: trigger,
                stateChangeConfidence: confidence,
              }
            : t
        );

        return { terminals: newTerminals };
      });
    },

    updateActivity: (id, headline, status, type, timestamp, lastCommand) => {
      console.log(`[TerminalRegistrySlice] updateActivity for ${id}: lastCommand=${lastCommand}`);
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          return state;
        }

        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                activityHeadline: headline,
                activityStatus: status,
                activityType: type,
                activityTimestamp: timestamp,
                lastCommand,
              }
            : t
        );

        return { terminals: newTerminals };
      });
    },

    updateLastCommand: (id, lastCommand) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          return state;
        }

        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                lastCommand,
              }
            : t
        );

        return { terminals: newTerminals };
      });
    },

    updateVisibility: (id, isVisible) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          return state;
        }

        if (terminal.isVisible === isVisible) {
          return state;
        }

        const newTerminals = state.terminals.map((t) => (t.id === id ? { ...t, isVisible } : t));

        return { terminals: newTerminals };
      });
    },

    setViewMode: (id, viewMode) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const newTerminals = state.terminals.map((t) => (t.id === id ? { ...t, viewMode } : t));
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },

    getTerminal: (id) => {
      return get().terminals.find((t) => t.id === id);
    },

    moveTerminalToDock: (id) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal || terminal.location === "dock") return state;

        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "dock" as const } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      optimizeForDock(id);
    },

    moveTerminalToGrid: (id) => {
      let moveSucceeded = false;

      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal || terminal.location === "grid") return state;

        // Check grid capacity (count both "grid" and undefined as grid)
        const gridCount = state.terminals.filter(
          (t) => t.location === "grid" || t.location === undefined
        ).length;
        if (gridCount >= MAX_GRID_TERMINALS) {
          return state;
        }

        moveSucceeded = true;
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "grid" as const } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      // Only apply side effects if the move succeeded
      if (moveSucceeded) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }

      return moveSucceeded;
    },

    toggleTerminalLocation: (id) => {
      const terminal = get().terminals.find((t) => t.id === id);
      if (!terminal) return;

      if (terminal.location === "dock") {
        get().moveTerminalToGrid(id);
      } else {
        get().moveTerminalToDock(id);
      }
    },

    trashTerminal: (id) => {
      const terminal = get().terminals.find((t) => t.id === id);
      if (!terminal) return;

      // Only 'dock' or 'grid' are valid original locations - treat undefined as 'grid'
      const originalLocation: "dock" | "grid" = terminal.location === "dock" ? "dock" : "grid";

      terminalClient.trash(id).catch((error) => {
        console.error("Failed to trash terminal:", error);
      });

      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "trash" as const } : t
        );
        const newTrashed = new Map(state.trashedTerminals);
        // Use placeholder expiresAt - will be updated when IPC event arrives
        newTrashed.set(id, { id, expiresAt: Date.now() + 120000, originalLocation });
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals, trashedTerminals: newTrashed };
      });

      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    },

    restoreTerminal: (id, targetWorktreeId) => {
      const trashedInfo = get().trashedTerminals.get(id);
      const restoreLocation = trashedInfo?.originalLocation ?? "grid";

      terminalClient.restore(id).catch((error) => {
        console.error("Failed to restore terminal:", error);
      });

      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                location: restoreLocation,
                worktreeId: targetWorktreeId !== undefined ? targetWorktreeId : t.worktreeId,
              }
            : t
        );
        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals, trashedTerminals: newTrashed };
      });

      if (restoreLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    },

    markAsTrashed: (id, expiresAt, originalLocation) => {
      set((state) => {
        // Ignore stale trashed events if terminal was already restored
        const terminal = state.terminals.find((t) => t.id === id);
        if (terminal && terminal.location !== "trash") {
          return state;
        }

        const newTrashed = new Map(state.trashedTerminals);
        // Preserve existing originalLocation if already set (from trashTerminal call)
        const existingTrashed = state.trashedTerminals.get(id);
        const location = existingTrashed?.originalLocation ?? originalLocation;
        newTrashed.set(id, { id, expiresAt, originalLocation: location });
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "trash" as const } : t
        );
        terminalPersistence.save(newTerminals);
        return { trashedTerminals: newTrashed, terminals: newTerminals };
      });
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    },

    markAsRestored: (id) => {
      const terminal = get().terminals.find((t) => t.id === id);

      // If terminal is no longer in trash, respect its current location (set by restoreTerminal)
      const trashedInfo = get().trashedTerminals.get(id);
      const restoreLocation =
        terminal && terminal.location !== "trash"
          ? terminal.location
          : (trashedInfo?.originalLocation ?? "grid");

      set((state) => {
        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: restoreLocation } : t
        );
        terminalPersistence.save(newTerminals);
        return { trashedTerminals: newTrashed, terminals: newTerminals };
      });

      if (restoreLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    },

    isInTrash: (id) => {
      return get().trashedTerminals.has(id);
    },

    reorderTerminals: (fromIndex, toIndex, location = "grid") => {
      if (fromIndex === toIndex) return;

      set((state) => {
        const terminalsInLocation = state.terminals.filter(
          (t) => t.location === location || (location === "grid" && t.location === undefined)
        );

        if (fromIndex < 0 || fromIndex >= terminalsInLocation.length) return state;
        if (toIndex < 0 || toIndex > terminalsInLocation.length) return state;

        const terminalToMove = terminalsInLocation[fromIndex];
        if (!terminalToMove) return state;

        const reorderedInLocation = [...terminalsInLocation];
        reorderedInLocation.splice(fromIndex, 1);
        reorderedInLocation.splice(toIndex, 0, terminalToMove);

        const trashedTerminals = state.terminals.filter((t) => t.location === "trash");
        let newTerminals: TerminalInstance[];
        if (location === "grid") {
          const dockTerminals = state.terminals.filter((t) => t.location === "dock");
          newTerminals = [...reorderedInLocation, ...dockTerminals, ...trashedTerminals];
        } else {
          const gridTerminals = state.terminals.filter(
            (t) => t.location === "grid" || t.location === undefined
          );
          newTerminals = [...gridTerminals, ...reorderedInLocation, ...trashedTerminals];
        }

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },

    moveTerminalToPosition: (id, toIndex, location) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const terminalsInTargetLocation = state.terminals.filter(
          (t) =>
            t.id !== id &&
            (t.location === location || (location === "grid" && t.location === undefined))
        );

        const clampedIndex = Math.max(0, Math.min(toIndex, terminalsInTargetLocation.length));

        const otherTerminals = state.terminals.filter(
          (t) =>
            t.id !== id &&
            !(t.location === location || (location === "grid" && t.location === undefined))
        );

        const updatedTerminal: TerminalInstance = {
          ...terminal,
          location,
        };

        const reorderedTargetLocation = [...terminalsInTargetLocation];
        reorderedTargetLocation.splice(clampedIndex, 0, updatedTerminal);

        const trashedTerminals = otherTerminals.filter((t) => t.location === "trash");
        let newTerminals: TerminalInstance[];
        if (location === "grid") {
          const dockTerminals = otherTerminals.filter((t) => t.location === "dock");
          newTerminals = [...reorderedTargetLocation, ...dockTerminals, ...trashedTerminals];
        } else {
          const gridTerminals = otherTerminals.filter(
            (t) => t.location === "grid" || t.location === undefined
          );
          newTerminals = [...gridTerminals, ...reorderedTargetLocation, ...trashedTerminals];
        }

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      if (location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    },

    restartTerminal: async (id) => {
      const state = get();
      const terminal = state.terminals.find((t) => t.id === id);

      if (!terminal) {
        console.warn(`[TerminalStore] Cannot restart: terminal ${id} not found`);
        return;
      }

      // Guard against concurrent restart attempts
      if (terminal.isRestarting) {
        console.warn(`[TerminalStore] Terminal ${id} is already restarting, ignoring`);
        return;
      }

      // Clear any previous restart error and mark as restarting
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, restartError: undefined, isRestarting: true } : t
        ),
      }));

      // Validate configuration before attempting restart
      let validation;
      try {
        validation = await validateTerminalConfig(terminal);
      } catch (error) {
        // Validation itself failed (e.g., IPC error)
        const restartError: TerminalRestartError = {
          message: "Failed to validate terminal configuration",
          timestamp: Date.now(),
          recoverable: false,
          context: {
            failedCwd: terminal.cwd,
            validationError: error instanceof Error ? error.message : String(error),
          },
        };

        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isRestarting: false, restartError } : t
          ),
        }));
        console.error(`[TerminalStore] Validation error for terminal ${id}:`, error);
        return;
      }

      if (!validation.valid) {
        // Set error state instead of attempting doomed restart
        // Use the first non-recoverable error's code, or the first error's code
        const primaryError = validation.errors.find((e) => !e.recoverable) || validation.errors[0];

        const restartError: TerminalRestartError = {
          message: validation.errors.map((e) => e.message).join("; "),
          code: primaryError?.code,
          timestamp: Date.now(),
          recoverable: validation.errors.every((e) => e.recoverable),
          context: {
            failedCwd: terminal.cwd,
            errors: validation.errors,
          },
        };

        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isRestarting: false, restartError } : t
          ),
        }));
        console.warn(`[TerminalStore] Restart validation failed for terminal ${id}:`, restartError);
        return;
      }

      // Re-read terminal from state in case it was modified during async validation
      const currentState = get();
      const currentTerminal = currentState.terminals.find((t) => t.id === id);

      if (!currentTerminal || currentTerminal.location === "trash") {
        // Terminal was removed or trashed while we were validating
        set((state) => ({
          terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
        }));
        console.warn(`[TerminalStore] Terminal ${id} no longer exists or was trashed`);
        return;
      }

      let targetLocation = currentTerminal.location;
      if (terminal.location === "trash") {
        const trashedInfo = currentState.trashedTerminals.get(id);
        targetLocation = trashedInfo?.originalLocation ?? "grid";
      }

      // For agent terminals, regenerate command from current settings
      // For other terminals, use the saved command
      let commandToRun = currentTerminal.command;
      // Get effective agentId - handles both new agentId and legacy type-based detection
      const effectiveAgentId =
        currentTerminal.agentId ??
        (currentTerminal.type && isRegisteredAgent(currentTerminal.type)
          ? currentTerminal.type
          : undefined);
      const isAgent = !!effectiveAgentId;

      if (isAgent && effectiveAgentId) {
        try {
          const agentSettings = await agentSettingsClient.get();
          if (agentSettings) {
            const agentConfig = getAgentConfig(effectiveAgentId);
            const baseCommand = agentConfig?.command || effectiveAgentId;
            let flags: string[] = [];
            flags = generateAgentFlags(
              agentSettings.agents?.[effectiveAgentId] ?? {},
              effectiveAgentId
            );
            commandToRun = flags.length > 0 ? `${baseCommand} ${flags.join(" ")}` : baseCommand;
          }
        } catch (error) {
          console.warn(
            "[TerminalStore] Failed to load agent settings for restart, using saved command:",
            error
          );
        }
      }

      try {
        // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
        // The old frontend must stop listening before new PTY data starts flowing
        terminalInstanceService.destroy(id);

        // Suppress the expected exit event from killing the old PTY.
        // The exit can arrive after the new xterm mounts, which would incorrectly show "[exit 0]".
        terminalInstanceService.suppressNextExit(id);

        // Kill the old PTY backend
        await terminalClient.kill(id);

        // Calculate spawn dimensions
        const spawnCols = currentTerminal.cols || 80;
        const spawnRows = currentTerminal.rows || 24;
        // Do not shrink geometry for dock; dock previews are clipped instead.

        // Update terminal in store: increment restartKey, reset agent state, update location
        // This triggers XtermAdapter remount with new xterm instance
        // Keep isRestarting: true to prevent onExit race
        set((state) => {
          const newTerminals = state.terminals.map((t) =>
            t.id === id
              ? {
                  ...t,
                  location: targetLocation,
                  restartKey: (t.restartKey ?? 0) + 1,
                  agentState: isAgent ? ("idle" as const) : undefined,
                  lastStateChange: isAgent ? Date.now() : undefined,
                  command: commandToRun,
                  isRestarting: true,
                  restartError: undefined,
                }
              : t
          );
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        // Allow React to process state update and begin remounting XtermAdapter
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Spawn new PTY - output will buffer in OS pipe until new frontend attaches
        await terminalClient.spawn({
          id,
          cwd: currentTerminal.cwd,
          cols: spawnCols,
          rows: spawnRows,
          kind: currentTerminal.kind ?? (isAgent ? "agent" : "terminal"),
          type: currentTerminal.type,
          agentId: currentTerminal.agentId,
          title: currentTerminal.title,
          worktreeId: currentTerminal.worktreeId,
          command: commandToRun,
        });

        // Allow XtermAdapter to finish mounting and set up data listeners
        await new Promise((resolve) => setTimeout(resolve, 50));

        if (targetLocation === "dock") {
          optimizeForDock(id);
        } else {
          // Force resize sync to ensure PTY dimensions match the container
          // performFit() in XtermAdapter may run before the container is laid out
          terminalInstanceService.fit(id);
        }

        // Restart complete - clear isRestarting flag
        set((state) => ({
          terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
        }));
      } catch (error) {
        // Set error state instead of trashing the terminal
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as { code?: string })?.code;

        const restartError: TerminalRestartError = {
          message: errorMessage,
          code: errorCode,
          timestamp: Date.now(),
          recoverable: errorCode === "ENOENT",
          context: {
            failedCwd: currentTerminal.cwd,
            command: commandToRun,
          },
        };

        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isRestarting: false, restartError } : t
          ),
        }));

        console.error(`[TerminalStore] Failed to restart terminal ${id}:`, error);
      }
    },

    clearTerminalError: (id) => {
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, restartError: undefined } : t
        ),
      }));
    },

    updateTerminalCwd: (id, cwd) => {
      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, cwd, restartError: undefined } : t
        );
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },

    moveTerminalToWorktree: (id, worktreeId) => {
      let movedToLocation: TerminalLocation | null = null;

      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          console.warn(`Cannot move terminal ${id}: terminal not found`);
          return state;
        }

        if (terminal.worktreeId === worktreeId) {
          return state;
        }

        const targetGridCount = state.terminals.filter(
          (t) =>
            t.worktreeId === worktreeId &&
            t.location !== "trash" &&
            (t.location === "grid" || t.location === undefined)
        ).length;

        const newLocation: TerminalLocation =
          targetGridCount >= MAX_GRID_TERMINALS ? "dock" : "grid";
        movedToLocation = newLocation;

        const newTerminals = state.terminals.map((t) =>
          t.id === id
            ? {
                ...t,
                worktreeId,
                location: newLocation,
                isVisible: newLocation === "grid" ? true : false,
              }
            : t
        );
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      if (!movedToLocation) return;

      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      if ((activeWorktreeId ?? null) !== (worktreeId ?? null)) {
        terminalClient.setActivityTier(id, "background");
      }

      if (movedToLocation === "dock") {
        optimizeForDock(id);
        return;
      }

      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    },

    updateFlowStatus: (id, status, timestamp) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const prevTs = terminal.flowStatusTimestamp;
        if (prevTs !== undefined && timestamp < prevTs) return state;

        if (terminal.flowStatus === status && terminal.flowStatusTimestamp === timestamp) {
          return state;
        }

        return {
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, flowStatus: status, flowStatusTimestamp: timestamp } : t
          ),
        };
      });
    },

    setInputLocked: (id, locked) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        if (terminal.isInputLocked === locked) return state;

        const updated = {
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isInputLocked: locked } : t
          ),
        };

        terminalPersistence.save(updated.terminals);
        terminalInstanceService.setInputLocked(id, locked);

        return updated;
      });
    },

    toggleInputLocked: (id) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const locked = !terminal.isInputLocked;

        const updated = {
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isInputLocked: locked } : t
          ),
        };

        terminalPersistence.save(updated.terminals);
        terminalInstanceService.setInputLocked(id, locked);

        return updated;
      });
    },
  });
