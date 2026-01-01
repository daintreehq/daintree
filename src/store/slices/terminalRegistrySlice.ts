import type { StateCreator, StoreApi } from "zustand";
import type {
  TerminalInstance as TerminalInstanceType,
  TerminalRestartError,
  AgentState,
  TerminalType,
  TerminalLocation,
  AgentStateChangeTrigger,
  TerminalFlowStatus,
} from "@/types";
import { terminalClient, agentSettingsClient } from "@/clients";
import { generateAgentFlags } from "@shared/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { terminalPersistence } from "../persistence/terminalPersistence";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { getDefaultPanelTitle, panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { PanelKind } from "@/types";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { ABSOLUTE_MAX_GRID_TERMINALS } from "@/lib/terminalLayout";

// Re-export for backward compatibility
export const MAX_GRID_TERMINALS = ABSOLUTE_MAX_GRID_TERMINALS;

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
  kind?: PanelKind;
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
  /** Initial URL for browser panes (kind === 'browser') */
  browserUrl?: string;
  /** Path to note file (kind === 'notes') */
  notePath?: string;
  /** Note ID (kind === 'notes') */
  noteId?: string;
  /** Note scope (kind === 'notes') */
  scope?: "worktree" | "project";
  /** Note creation timestamp (kind === 'notes') */
  createdAt?: number;
  /** Dev server command override for dev-preview panels (kind === 'dev-preview') */
  devCommand?: string;
}

function getDefaultTitle(kind?: PanelKind, type?: TerminalType, agentId?: string): string {
  // Use panel kind registry for proper title resolution
  const effectiveKind = kind ?? (agentId ? "agent" : "terminal");
  return getDefaultPanelTitle(effectiveKind, agentId ?? (type !== "terminal" ? type : undefined));
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
  restoreTerminal: (id: string, targetWorktreeId?: string) => void;
  markAsTrashed: (id: string, expiresAt: number, originalLocation: "dock" | "grid") => void;
  markAsRestored: (id: string) => void;
  isInTrash: (id: string) => boolean;

  reorderTerminals: (
    fromIndex: number,
    toIndex: number,
    location?: "grid" | "dock",
    worktreeId?: string | null
  ) => void;
  moveTerminalToPosition: (
    id: string,
    toIndex: number,
    location: "grid" | "dock",
    worktreeId?: string | null
  ) => void;

  restartTerminal: (id: string) => Promise<void>;
  clearTerminalError: (id: string) => void;
  updateTerminalCwd: (id: string, cwd: string) => void;
  moveTerminalToWorktree: (id: string, worktreeId: string) => void;
  updateFlowStatus: (id: string, status: TerminalFlowStatus, timestamp: number) => void;
  setInputLocked: (id: string, locked: boolean) => void;
  toggleInputLocked: (id: string) => void;
  convertTerminalType: (id: string, newType: TerminalType, newAgentId?: string) => Promise<void>;
  setBrowserUrl: (id: string, url: string) => void;
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

type TerminalRegistryStoreApi = StoreApi<TerminalRegistrySlice>;

const createTrashExpiryHelpers = (
  get: TerminalRegistryStoreApi["getState"],
  set: TerminalRegistryStoreApi["setState"]
) => {
  const trashExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearTrashExpiryTimer = (id: string) => {
    const timer = trashExpiryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    trashExpiryTimers.delete(id);
  };

  const scheduleTrashExpiry = (id: string, expiresAt: number) => {
    clearTrashExpiryTimer(id);
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      clearTrashExpiryTimer(id);
      const state = get();
      const trashedInfo = state.trashedTerminals.get(id);
      if (!trashedInfo || trashedInfo.expiresAt !== expiresAt) return;

      const terminal = state.terminals.find((t) => t.id === id);
      if (terminal?.location === "trash") {
        state.removeTerminal(id);
      } else if (!terminal) {
        set((state) => {
          if (!state.trashedTerminals.has(id)) return state;
          const newTrashed = new Map(state.trashedTerminals);
          newTrashed.delete(id);
          return { trashedTerminals: newTrashed };
        });
      }
    }, delay);
    trashExpiryTimers.set(id, timer);
  };

  return { clearTrashExpiryTimer, scheduleTrashExpiry };
};

const optimizeForDock = (id: string) => {
  terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
};

export const createTerminalRegistrySlice =
  (
    middleware?: TerminalRegistryMiddleware
  ): StateCreator<TerminalRegistrySlice, [], [], TerminalRegistrySlice> =>
  (set, get) => (({ clearTrashExpiryTimer, scheduleTrashExpiry }) => ({
    terminals: [],
    trashedTerminals: new Map(),

    addTerminal: async (options) => {
      const requestedKind = options.kind ?? (options.agentId ? "agent" : "terminal");
      const legacyType = options.type || "terminal";

      // Handle non-terminal panels (browser, notes, dev-preview, extensions) separately
      // dev-preview has hasPty=true but needs its own UI component, not terminal UI
      if (!panelKindHasPty(requestedKind) || requestedKind === "dev-preview") {
        const id =
          options.requestedId ||
          `${requestedKind}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const title = options.title || getDefaultTitle(requestedKind);

        const targetWorktreeId = options.worktreeId ?? null;
        const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
        const currentGridCount = get().terminals.filter(
          (t) =>
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? null) === targetWorktreeId
        ).length;
        const requestedLocation = options.location || "grid";
        const location =
          requestedLocation === "grid" && currentGridCount >= maxCapacity
            ? "dock"
            : requestedLocation;

        let terminal: TerminalInstance;
        if (requestedKind === "browser") {
          terminal = {
            id,
            kind: "browser",
            title,
            worktreeId: options.worktreeId,
            location,
            isVisible: location === "grid",
            browserUrl: options.browserUrl || "http://localhost:3000",
            type: "terminal" as const,
            cwd: "",
            cols: 80,
            rows: 24,
          };
        } else if (requestedKind === "notes") {
          terminal = {
            id,
            kind: "notes",
            title,
            worktreeId: options.worktreeId,
            location,
            isVisible: location === "grid",
            notePath: options.notePath ?? "",
            noteId: options.noteId ?? "",
            scope: options.scope ?? "project",
            createdAt: options.createdAt ?? Date.now(),
            type: "terminal" as const,
            cwd: "",
            cols: 80,
            rows: 24,
          };
        } else if (requestedKind === "dev-preview") {
          terminal = {
            id,
            kind: "dev-preview",
            title,
            worktreeId: options.worktreeId,
            location,
            isVisible: location === "grid",
            type: "terminal" as const,
            cwd: options.cwd || "",
            cols: 80,
            rows: 24,
            devCommand: options.devCommand,
          };
        } else {
          terminal = {
            id,
            kind: requestedKind,
            title,
            worktreeId: options.worktreeId,
            location,
            isVisible: location === "grid",
            type: "terminal" as const,
            cwd: "",
            cols: 80,
            rows: 24,
          };
        }

        set((state) => {
          const newTerminals = [...state.terminals, terminal];
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        return id;
      }

      // PTY panels: terminal/agent
      // Derive agentId: explicit option, or from legacy type if it's a registered agent
      const agentId = options.agentId ?? (isRegisteredAgent(legacyType) ? legacyType : undefined);
      // Narrow kind to terminal|agent for PTY handling
      const kind: "terminal" | "agent" =
        agentId || requestedKind === "agent" ? "agent" : "terminal";
      const title = options.title || getDefaultTitle(kind, legacyType, agentId);

      // Auto-dock if grid is full and user requested grid location
      // Use dynamic capacity based on current viewport dimensions
      const targetWorktreeId = options.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      const currentGridCount = get().terminals.filter(
        (t) =>
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
      ).length;
      const requestedLocation = options.location || "grid";
      const location =
        requestedLocation === "grid" && currentGridCount >= maxCapacity
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

          // Prewarm ALL terminal types to ensure managed instance exists.
          // This is critical for terminals in inactive worktrees - they need a managed
          // instance for proper BACKGROUND→VISIBLE tier transitions when worktree activates.
          const offscreenOrInactive =
            location === "dock" ||
            (options.worktreeId ?? null) !==
              (useWorktreeSelectionStore.getState().activeWorktreeId ?? null);

          if (kind !== "agent") {
            terminalInstanceService.prewarmTerminal(id, legacyType, terminalOptions, {
              offscreen: offscreenOrInactive,
              widthPx: location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH,
              heightPx: location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT,
            });
          } else {
            // Agent terminals also need prewarm for proper tier management.
            // This ensures they can receive wake signals when their worktree activates.
            const widthPx = location === "dock" ? DOCK_PREWARM_WIDTH_PX : DOCK_TERM_WIDTH;
            const heightPx = location === "dock" ? DOCK_PREWARM_HEIGHT_PX : DOCK_TERM_HEIGHT;

            terminalInstanceService.prewarmTerminal(id, legacyType, terminalOptions, {
              offscreen: offscreenOrInactive,
              widthPx,
              heightPx,
            });

            // Also set initial PTY geometry for agent TUI initialization
            const cellWidth = Math.max(6, Math.floor(fontSize * 0.6));
            const cellHeight = Math.max(10, Math.floor(fontSize * 1.1));
            const cols = Math.max(20, Math.min(500, Math.floor(widthPx / cellWidth)));
            const rows = Math.max(10, Math.min(200, Math.floor(heightPx / cellHeight)));
            terminalClient.resize(id, cols, rows);
          }
        } catch (error) {
          console.warn(`[TerminalStore] Failed to prewarm terminal ${id}:`, error);
        }

        const isAgent = kind === "agent";

        // Start with "working" in UI to show spinner immediately during boot
        const agentState = options.agentState ?? (isAgent ? "working" : undefined);
        const lastStateChange =
          options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined);

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
        };

        set((state) => {
          const newTerminals = [...state.terminals, terminal];
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        // Determine if terminal should start backgrounded:
        // 1. Dock terminals are always backgrounded (offscreen)
        // 2. Grid terminals in inactive worktrees should also be backgrounded
        //    since they won't mount until the worktree becomes active
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        const isInActiveWorktree = (options.worktreeId ?? null) === (activeWorktreeId ?? null);
        const shouldBackground =
          location === "dock" || (location === "grid" && !isInActiveWorktree);

        if (shouldBackground) {
          // Terminal is either in dock or in an inactive worktree.
          // Apply BACKGROUND policy to prevent renderer updates for unmounted terminals.
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
      clearTrashExpiryTimer(id);
      const currentTerminals = get().terminals;
      const removedIndex = currentTerminals.findIndex((t) => t.id === id);
      const terminal = currentTerminals.find((t) => t.id === id);

      // Only call PTY operations for PTY-backed terminals
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalClient.kill(id).catch((error) => {
          console.error("Failed to kill terminal:", error);
        });

        terminalInstanceService.destroy(id);
      }

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

        const effectiveTitle =
          newTitle.trim() || getDefaultTitle(terminal.kind, terminal.type, terminal.agentId);
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
      const terminal = get().terminals.find((t) => t.id === id);

      set((state) => {
        if (!terminal || terminal.location === "dock") return state;

        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "dock" as const } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      // Only optimize PTY-backed panels
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        optimizeForDock(id);
      }
    },

    moveTerminalToGrid: (id) => {
      let moveSucceeded = false;
      let terminal: TerminalInstance | undefined;

      set((state) => {
        terminal = state.terminals.find((t) => t.id === id);
        if (!terminal || terminal.location === "grid") return state;

        const targetWorktreeId = terminal.worktreeId ?? null;
        const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
        // Check grid capacity (count both "grid" and undefined as grid)
        const gridCount = state.terminals.filter(
          (t) =>
            (t.location === "grid" || t.location === undefined) &&
            (t.worktreeId ?? null) === targetWorktreeId
        ).length;
        if (gridCount >= maxCapacity) {
          return state;
        }

        moveSucceeded = true;
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "grid" as const } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      // Only apply renderer policy for PTY-backed panels if move succeeded
      if (moveSucceeded && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
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

      const expiresAt = Date.now() + 120000;

      // Only 'dock' or 'grid' are valid original locations - treat undefined as 'grid'
      const originalLocation: "dock" | "grid" = terminal.location === "dock" ? "dock" : "grid";

      // Only call PTY operations for PTY-backed terminals
      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalClient.trash(id).catch((error) => {
          console.error("Failed to trash terminal:", error);
        });
      }

      set((state) => {
        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, location: "trash" as const } : t
        );
        const newTrashed = new Map(state.trashedTerminals);
        // Use placeholder expiresAt - will be updated when IPC event arrives
        newTrashed.set(id, { id, expiresAt, originalLocation });
        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals, trashedTerminals: newTrashed };
      });

      scheduleTrashExpiry(id, expiresAt);

      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        return;
      }
    },

    restoreTerminal: (id, targetWorktreeId) => {
      clearTrashExpiryTimer(id);
      const trashedInfo = get().trashedTerminals.get(id);
      const restoreLocation = trashedInfo?.originalLocation ?? "grid";
      const terminal = get().terminals.find((t) => t.id === id);

      // Only call PTY operations for PTY-backed terminals
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalClient.restore(id).catch((error) => {
          console.error("Failed to restore terminal:", error);
        });
      }

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

      // Only apply renderer policies for PTY-backed terminals
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (restoreLocation === "dock") {
          optimizeForDock(id);
        } else {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        }
      }
    },

    markAsTrashed: (id, expiresAt, originalLocation) => {
      const terminal = get().terminals.find((t) => t.id === id);
      if (!terminal) {
        clearTrashExpiryTimer(id);
        set((state) => {
          if (!state.trashedTerminals.has(id)) return state;
          const newTrashed = new Map(state.trashedTerminals);
          newTrashed.delete(id);
          return { trashedTerminals: newTrashed };
        });
        return;
      }

      set((state) => {
        // Ignore stale trashed events if terminal was already restored
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

      scheduleTrashExpiry(id, expiresAt);

      // Only apply renderer policy for PTY-backed panels
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    },

    markAsRestored: (id) => {
      clearTrashExpiryTimer(id);
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

      // Only apply renderer policies for PTY-backed panels
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (restoreLocation === "dock") {
          optimizeForDock(id);
        } else {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        }
      }
    },

    isInTrash: (id) => {
      return get().trashedTerminals.has(id);
    },

    reorderTerminals: (fromIndex, toIndex, location = "grid", worktreeId) => {
      if (fromIndex === toIndex) return;

      set((state) => {
        const hasWorktreeFilter = worktreeId !== undefined;
        const targetWorktreeId = worktreeId ?? null;
        const matchesWorktree = (t: TerminalInstance) =>
          !hasWorktreeFilter || (t.worktreeId ?? null) === targetWorktreeId;

        const gridTerminals = state.terminals.filter(
          (t) => t.location === "grid" || t.location === undefined
        );
        const dockTerminals = state.terminals.filter((t) => t.location === "dock");
        const trashTerminals = state.terminals.filter((t) => t.location === "trash");

        const terminalsInLocation = location === "grid" ? gridTerminals : dockTerminals;
        const scopedTerminals = terminalsInLocation.filter(matchesWorktree);

        if (fromIndex < 0 || fromIndex >= scopedTerminals.length) return state;
        if (toIndex < 0 || toIndex > scopedTerminals.length) return state;

        const terminalToMove = scopedTerminals[fromIndex];
        if (!terminalToMove) return state;

        const reorderedScoped = [...scopedTerminals];
        reorderedScoped.splice(fromIndex, 1);
        reorderedScoped.splice(toIndex, 0, terminalToMove);

        let scopedIndex = 0;
        const updatedLocation = terminalsInLocation.map((terminal) => {
          if (!matchesWorktree(terminal)) {
            return terminal;
          }
          const next = reorderedScoped[scopedIndex];
          scopedIndex += 1;
          return next ?? terminal;
        });

        const newTerminals =
          location === "grid"
            ? [...updatedLocation, ...dockTerminals, ...trashTerminals]
            : [...gridTerminals, ...updatedLocation, ...trashTerminals];

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },

    moveTerminalToPosition: (id, toIndex, location, worktreeId) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) return state;

        const targetWorktreeId =
          worktreeId !== undefined ? worktreeId : (terminal.worktreeId ?? null);
        const hasWorktreeFilter = worktreeId !== undefined;
        const matchesWorktree = (t: TerminalInstance) =>
          !hasWorktreeFilter || (t.worktreeId ?? null) === (targetWorktreeId ?? null);

        const gridTerminals = state.terminals.filter(
          (t) => t.id !== id && (t.location === "grid" || t.location === undefined)
        );
        const dockTerminals = state.terminals.filter((t) => t.id !== id && t.location === "dock");
        const trashTerminals = state.terminals.filter((t) => t.location === "trash");

        const targetList = location === "grid" ? gridTerminals : dockTerminals;
        const scopedIndices: number[] = [];
        for (let idx = 0; idx < targetList.length; idx += 1) {
          if (matchesWorktree(targetList[idx])) {
            scopedIndices.push(idx);
          }
        }

        const scopedCount = scopedIndices.length;
        const clampedIndex = Math.max(0, Math.min(toIndex, scopedCount));

        const insertAt =
          scopedCount === 0
            ? targetList.length
            : clampedIndex <= 0
              ? scopedIndices[0]
              : clampedIndex >= scopedCount
                ? scopedIndices[scopedCount - 1] + 1
                : scopedIndices[clampedIndex];

        const updatedTerminal: TerminalInstance = {
          ...terminal,
          location,
        };

        const updatedTargetList = [...targetList];
        updatedTargetList.splice(insertAt, 0, updatedTerminal);

        const newTerminals =
          location === "grid"
            ? [...updatedTargetList, ...dockTerminals, ...trashTerminals]
            : [...gridTerminals, ...updatedTargetList, ...trashTerminals];

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });

      const terminal = get().terminals.find((t) => t.id === id);
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        if (location === "dock") {
          optimizeForDock(id);
        } else {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
        }
      }
    },

    restartTerminal: async (id) => {
      const state = get();
      const terminal = state.terminals.find((t) => t.id === id);

      if (!terminal) {
        console.warn(`[TerminalStore] Cannot restart: terminal ${id} not found`);
        return;
      }

      // Non-PTY panels don't have PTY processes to restart
      if (!panelKindHasPty(terminal.kind ?? "terminal")) {
        console.warn(`[TerminalStore] Cannot restart non-PTY panel ${id}`);
        return;
      }

      // Guard against concurrent restart attempts
      if (terminal.isRestarting) {
        console.warn(`[TerminalStore] Terminal ${id} is already restarting, ignoring`);
        return;
      }

      // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
      // This is checked in the onExit handler before the store state.
      markTerminalRestarting(id);

      // Also set the store flag for UI and other consumers
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

        unmarkTerminalRestarting(id);
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

        unmarkTerminalRestarting(id);
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
        unmarkTerminalRestarting(id);
        set((state) => ({
          terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
        }));
        console.warn(`[TerminalStore] Terminal ${id} no longer exists or was trashed`);
        return;
      }

      const targetLocation = currentTerminal.location;

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
        // CAPTURE LIVE DIMENSIONS before destroying the frontend
        // The store's cols/rows may be stale (set on initial spawn).
        // The managed xterm instance has the actual current dimensions.
        const managedInstance = terminalInstanceService.get(id);
        let spawnCols = currentTerminal.cols || 80;
        let spawnRows = currentTerminal.rows || 24;
        if (managedInstance?.terminal) {
          spawnCols = managedInstance.terminal.cols || spawnCols;
          spawnRows = managedInstance.terminal.rows || spawnRows;
        }

        // AGGRESSIVE TEARDOWN: Destroy frontend FIRST to prevent race condition
        // The old frontend must stop listening before new PTY data starts flowing
        terminalInstanceService.destroy(id);

        terminalInstanceService.suppressNextExit(id, 10000);

        try {
          await terminalClient.kill(id);
        } catch (error) {
          console.warn(`[TerminalStore] kill(${id}) failed during restart; continuing:`, error);
        }

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
                  agentState: isAgent ? ("working" as const) : undefined,
                  lastStateChange: isAgent ? Date.now() : undefined,
                  stateChangeTrigger: undefined,
                  stateChangeConfidence: undefined,
                  command: commandToRun,
                  isRestarting: true,
                  restartError: undefined,
                }
              : t
          );
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

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
          restore: false,
        });

        if (targetLocation === "dock") {
          optimizeForDock(id);
        } else {
          // Force resize sync to ensure PTY dimensions match the container
          // performFit() in XtermAdapter may run before the container is laid out
          terminalInstanceService.fit(id);
        }

        unmarkTerminalRestarting(id);
        set((state) => ({
          terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as { code?: string })?.code;

        let phase = "unknown";
        if (errorMessage.includes("frontend readiness timeout")) {
          phase = "frontend-readiness";
        } else if (errorMessage.includes("spawn")) {
          phase = "pty-spawn";
        } else if (errorMessage.includes("kill")) {
          phase = "pty-kill";
        } else if (errorMessage.includes("destroy")) {
          phase = "frontend-destroy";
        }

        const restartError: TerminalRestartError = {
          message: errorMessage,
          code: errorCode,
          timestamp: Date.now(),
          recoverable: errorCode === "ENOENT" || phase === "frontend-readiness",
          context: {
            failedCwd: currentTerminal.cwd,
            command: commandToRun,
            phase,
            isAgent,
            agentId: effectiveAgentId,
          },
        };

        unmarkTerminalRestarting(id);
        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isRestarting: false, restartError } : t
          ),
        }));

        console.error(`[TerminalStore] Failed to restart terminal ${id} during ${phase}:`, error, {
          cwd: currentTerminal.cwd,
          command: commandToRun,
          isAgent,
          agentId: effectiveAgentId,
        });
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
      console.log(`[TERM_DEBUG] moveTerminalToWorktree id=${id} worktree=${worktreeId}`);

      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal) {
          console.warn(`Cannot move terminal ${id}: terminal not found`);
          return state;
        }

        if (terminal.worktreeId === worktreeId) {
          return state;
        }

        const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
        const targetGridCount = state.terminals.filter(
          (t) =>
            (t.worktreeId ?? null) === (worktreeId ?? null) &&
            t.location !== "trash" &&
            (t.location === "grid" || t.location === undefined)
        ).length;

        const newLocation: TerminalLocation = targetGridCount >= maxCapacity ? "dock" : "grid";
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

      if (movedToLocation === "dock") {
        optimizeForDock(id);
        return;
      }

      // All terminals stay visible - we don't background for reliability.
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
        if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
          terminalInstanceService.setInputLocked(id, locked);
        }

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
        if (panelKindHasPty(terminal.kind ?? "terminal")) {
          terminalInstanceService.setInputLocked(id, locked);
        }

        return updated;
      });
    },

    convertTerminalType: async (id, newType, newAgentId) => {
      const terminal = get().terminals.find((t) => t.id === id);
      if (!terminal) {
        console.warn(`[TerminalStore] Cannot convert: terminal ${id} not found`);
        return;
      }

      if (terminal.isRestarting) {
        console.warn(`[TerminalStore] Terminal ${id} is already restarting, ignoring convert`);
        return;
      }

      // Mark as restarting SYNCHRONOUSLY first to prevent exit event race condition.
      markTerminalRestarting(id);

      // Set store flag immediately to prevent overlapping operations
      set((state) => ({
        terminals: state.terminals.map((t) =>
          t.id === id ? { ...t, restartError: undefined, isRestarting: true } : t
        ),
      }));

      const effectiveAgentId = newAgentId ?? (isRegisteredAgent(newType) ? newType : undefined);
      const newKind: "terminal" | "agent" = effectiveAgentId ? "agent" : "terminal";
      const newTitle = getDefaultTitle(newKind, newType, effectiveAgentId);

      let commandToRun: string | undefined;
      if (effectiveAgentId) {
        try {
          const agentSettings = await agentSettingsClient.get();
          if (agentSettings) {
            const agentConfig = getAgentConfig(effectiveAgentId);
            const baseCommand = agentConfig?.command || effectiveAgentId;
            const flags = generateAgentFlags(
              agentSettings.agents?.[effectiveAgentId] ?? {},
              effectiveAgentId
            );
            commandToRun = flags.length > 0 ? `${baseCommand} ${flags.join(" ")}` : baseCommand;
          }
        } catch (error) {
          console.warn(
            "[TerminalStore] Failed to load agent settings for convert, using default:",
            error
          );
          const agentConfig = getAgentConfig(effectiveAgentId);
          commandToRun = agentConfig?.command || effectiveAgentId;
        }
      }

      try {
        const managedInstance = terminalInstanceService.get(id);
        let spawnCols = terminal.cols || 80;
        let spawnRows = terminal.rows || 24;
        if (managedInstance?.terminal) {
          spawnCols = managedInstance.terminal.cols || spawnCols;
          spawnRows = managedInstance.terminal.rows || spawnRows;
        }

        terminalInstanceService.destroy(id);
        terminalInstanceService.suppressNextExit(id);
        await terminalClient.kill(id);

        const isAgent = !!effectiveAgentId;

        set((state) => {
          const newTerminals = state.terminals.map((t) =>
            t.id === id
              ? {
                  ...t,
                  kind: newKind,
                  type: newType,
                  agentId: effectiveAgentId,
                  title: newTitle,
                  restartKey: (t.restartKey ?? 0) + 1,
                  agentState: isAgent ? ("working" as const) : undefined,
                  lastStateChange: isAgent ? Date.now() : undefined,
                  stateChangeTrigger: undefined,
                  stateChangeConfidence: undefined,
                  command: commandToRun,
                  isRestarting: true,
                  restartError: undefined,
                }
              : t
          );
          terminalPersistence.save(newTerminals);
          return { terminals: newTerminals };
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        await terminalClient.spawn({
          id,
          cwd: terminal.cwd,
          cols: spawnCols,
          rows: spawnRows,
          kind: newKind,
          type: newType,
          agentId: effectiveAgentId,
          title: newTitle,
          worktreeId: terminal.worktreeId,
          command: commandToRun,
          restore: false,
        });

        await new Promise((resolve) => setTimeout(resolve, 50));

        if (terminal.location === "dock") {
          optimizeForDock(id);
        } else {
          terminalInstanceService.fit(id);
        }

        unmarkTerminalRestarting(id);
        set((state) => ({
          terminals: state.terminals.map((t) => (t.id === id ? { ...t, isRestarting: false } : t)),
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as { code?: string })?.code;

        const restartError: TerminalRestartError = {
          message: errorMessage,
          code: errorCode,
          timestamp: Date.now(),
          recoverable: false,
          context: {
            failedCwd: terminal.cwd,
            command: commandToRun,
          },
        };

        unmarkTerminalRestarting(id);
        set((state) => ({
          terminals: state.terminals.map((t) =>
            t.id === id ? { ...t, isRestarting: false, restartError } : t
          ),
        }));

        console.error(`[TerminalStore] Failed to convert terminal ${id}:`, error);
      }
    },

    setBrowserUrl: (id, url) => {
      set((state) => {
        const terminal = state.terminals.find((t) => t.id === id);
        if (!terminal || panelKindHasPty(terminal.kind ?? "terminal")) return state;

        const newTerminals = state.terminals.map((t) =>
          t.id === id ? { ...t, browserUrl: url } : t
        );

        terminalPersistence.save(newTerminals);
        return { terminals: newTerminals };
      });
    },
  }))(createTrashExpiryHelpers(get, set));
