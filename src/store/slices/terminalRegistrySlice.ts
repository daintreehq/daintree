import type { StateCreator } from "zustand";
import type {
  TerminalInstance as TerminalInstanceType,
  TerminalRestartError,
  AgentState,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
} from "@/types";
import { terminalClient, agentSettingsClient } from "@/clients";
import { generateClaudeFlags, generateGeminiFlags, generateCodexFlags } from "@shared/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { terminalPersistence } from "../persistence/terminalPersistence";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";

export const MAX_GRID_TERMINALS = 16;

const DOCK_WIDTH = 700;
const DOCK_HEIGHT = 500;
const HEADER_HEIGHT = 32;
const PADDING_X = 24;
const PADDING_Y = 24;

const DOCK_TERM_WIDTH = DOCK_WIDTH - PADDING_X;
const DOCK_TERM_HEIGHT = DOCK_HEIGHT - HEADER_HEIGHT - PADDING_Y;

export type TerminalInstance = TerminalInstanceType;

export interface AddTerminalOptions {
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
  /** If provided, reconnect to existing backend process instead of spawning */
  existingId?: string;
  /** Store command on instance but don't execute it on spawn */
  skipCommandExecution?: boolean;
}

const TYPE_TITLES: Record<TerminalType, string> = {
  terminal: "Terminal",
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
};

function getDefaultTitle(type: TerminalType, agentId?: string): string {
  // If agentId is provided, try to get the title from the registry
  if (agentId) {
    const config = getAgentConfig(agentId);
    if (config) {
      return config.name;
    }
  }
  // Fall back to type-based titles
  return TYPE_TITLES[type] || "Terminal";
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

  moveTerminalToDock: (id: string) => void;
  moveTerminalToGrid: (id: string) => boolean;
  toggleTerminalLocation: (id: string) => void;

  trashTerminal: (id: string) => void;
  restoreTerminal: (id: string) => void;
  markAsTrashed: (id: string, expiresAt: number, originalLocation: "dock" | "grid") => void;
  markAsRestored: (id: string) => void;
  isInTrash: (id: string) => boolean;

  reorderTerminals: (fromIndex: number, toIndex: number, location?: "grid" | "dock") => void;
  moveTerminalToPosition: (id: string, toIndex: number, location: "grid" | "dock") => void;

  restartTerminal: (id: string) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
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
  terminalClient.setBuffering(id, true).catch((error) => {
    console.error("Failed to enable terminal buffering:", error);
  });

  terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);

  const dims = terminalInstanceService.resize(id, DOCK_TERM_WIDTH, DOCK_TERM_HEIGHT);
  if (dims) {
    terminalClient.resize(id, dims.cols, dims.rows);
  }
};

export const createTerminalRegistrySlice =
  (
    middleware?: TerminalRegistryMiddleware
  ): StateCreator<TerminalRegistrySlice, [], [], TerminalRegistrySlice> =>
  (set, get) => ({
    terminals: [],
    trashedTerminals: new Map(),

    addTerminal: async (options) => {
      const type = options.type || "terminal";
      // Derive agentId: explicit option, or from type if it's a registered agent
      const agentId = options.agentId ?? (isRegisteredAgent(type) ? type : undefined);
      const title = options.title || getDefaultTitle(type, agentId);

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
            cwd: options.cwd,
            shell: options.shell,
            cols: 80,
            rows: 24,
            command: commandToExecute,
            type,
            title,
            worktreeId: options.worktreeId,
          });
        }

        // Determine if this is an agent terminal (by agentId or legacy type)
        const isAgent = !!agentId || isRegisteredAgent(type);

        const agentState = options.agentState ?? (isAgent ? "idle" : undefined);
        const lastStateChange =
          options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined);
        const terminal: TerminalInstance = {
          id,
          type,
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
        };

        set((state) => {
          const newTerminals = [...state.terminals, terminal];
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        if (location === "dock") {
          optimizeForDock(id);
        }

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
        // Delay flush to ensure the UI has subscribed to onData
        terminalClient
          .setBuffering(id, false)
          .then(() => {
            setTimeout(() => {
              terminalClient.flush(id).catch((error) => {
                console.error("Failed to flush terminal buffer:", error);
              });
            }, 100);
          })
          .catch((error) => {
            console.error("Failed to disable terminal buffering:", error);
          });

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

      terminalClient.setBuffering(id, true).catch((error) => {
        console.error("Failed to enable terminal buffering:", error);
      });

      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    },

    restoreTerminal: (id) => {
      const trashedInfo = get().trashedTerminals.get(id);
      const restoreLocation = trashedInfo?.originalLocation ?? "grid";

      terminalClient.restore(id).catch((error) => {
        console.error("Failed to restore terminal:", error);
      });

      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: restoreLocation } : t
        );
        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals, trashedTerminals: newTrashed };
      });

      if (restoreLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalClient
          .setBuffering(id, false)
          .then(() => {
            setTimeout(() => {
              terminalClient.flush(id).catch((error) => {
                console.error("Failed to flush terminal buffer:", error);
              });
            }, 100);
          })
          .catch((error) => {
            console.error("Failed to disable terminal buffering:", error);
          });
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

      terminalClient.setBuffering(id, true).catch((error) => {
        console.error("Failed to enable terminal buffering:", error);
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
        terminalClient
          .setBuffering(id, false)
          .then(() => {
            setTimeout(() => {
              terminalClient.flush(id).catch((error) => {
                console.error("Failed to flush terminal buffer:", error);
              });
            }, 100);
          })
          .catch((error) => {
            console.error("Failed to disable terminal buffering:", error);
          });
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
        terminalClient
          .setBuffering(id, false)
          .then(() => {
            setTimeout(() => {
              terminalClient.flush(id).catch((error) => {
                console.error("Failed to flush terminal buffer:", error);
              });
            }, 100);
          })
          .catch((error) => {
            console.error("Failed to disable terminal buffering:", error);
          });

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
        (isRegisteredAgent(currentTerminal.type) ? currentTerminal.type : undefined);
      const isAgent = !!effectiveAgentId;

      if (isAgent && effectiveAgentId) {
        try {
          const agentSettings = await agentSettingsClient.get();
          if (agentSettings) {
            const agentConfig = getAgentConfig(effectiveAgentId);
            const baseCommand = agentConfig?.command || effectiveAgentId;
            let flags: string[] = [];
            switch (effectiveAgentId) {
              case "claude":
                flags = generateClaudeFlags(agentSettings.claude);
                break;
              case "gemini":
                flags = generateGeminiFlags(agentSettings.gemini);
                break;
              case "codex":
                flags = generateCodexFlags(agentSettings.codex);
                break;
            }
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
        // Enable buffering to capture output from new PTY before XtermAdapter remounts
        await terminalClient.setBuffering(id, true);

        // Kill the old PTY backend (but don't remove from store)
        await terminalClient.kill(id);

        let spawnCols = currentTerminal.cols || 80;
        let spawnRows = currentTerminal.rows || 24;
        if (targetLocation === "dock") {
          const dims = terminalInstanceService.resize(id, DOCK_TERM_WIDTH, DOCK_TERM_HEIGHT);
          if (dims) {
            spawnCols = dims.cols;
            spawnRows = dims.rows;
          }
        }

        // Spawn a new PTY with the SAME ID - output goes to buffer
        await terminalClient.spawn({
          id, // Reuse the same ID
          cwd: currentTerminal.cwd,
          cols: spawnCols,
          rows: spawnRows,
          type: currentTerminal.type,
          title: currentTerminal.title,
          worktreeId: currentTerminal.worktreeId,
          command: commandToRun,
        });

        // Now safe to destroy old xterm - spawn succeeded
        terminalInstanceService.destroy(id);

        // Update terminal in store: increment restartKey, reset agent state, update location
        // This triggers XtermAdapter remount with new xterm instance
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
                  isRestarting: false,
                  restartError: undefined,
                }
              : t
          );
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        // Allow XtermAdapter to remount and set up data listeners
        await new Promise((resolve) => setTimeout(resolve, 100));

        if (targetLocation === "dock") {
          optimizeForDock(id);
        } else {
          await terminalClient.setBuffering(id, false);
          terminalClient.flush(id).catch((error) => {
            console.error("Failed to flush terminal buffer:", error);
          });
        }
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

        // Re-enable normal mode if restart failed
        terminalClient.setBuffering(id, false).catch(() => {});
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
  });
