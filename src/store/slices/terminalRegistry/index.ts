import type { StateCreator } from "zustand";
import type { TerminalRuntimeStatus, TerminalLocation, TabGroup, TabGroupLocation } from "@/types";
import { terminalClient, agentSettingsClient, projectClient } from "@/clients";
import { generateAgentCommand } from "@shared/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { validateTerminalConfig } from "@/utils/terminalValidation";
import { isRegisteredAgent, getAgentConfig } from "@/config/agents";
import { panelKindHasPty, panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { getTerminalThemeFromCSS } from "@/utils/terminalTheme";
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@/config/terminalFont";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { markTerminalRestarting, unmarkTerminalRestarting } from "@/store/restartExitSuppression";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";

import type { TerminalRegistrySlice, TerminalRegistryMiddleware, TerminalInstance } from "./types";
import {
  deriveRuntimeStatus,
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
} from "./helpers";
import { saveTerminals, saveTabGroups } from "./persistence";
import { createTrashExpiryHelpers } from "./trash";
import { optimizeForDock } from "./layout";

function stopDevPreviewByPanelId(panelId: string): void {
  if (typeof window === "undefined") return;
  const stopByPanel = window.electron?.devPreview?.stopByPanel;
  if (!stopByPanel) return;

  void stopByPanel({ panelId }).catch((error) => {
    console.error(
      `[TerminalStore] Failed to stop dev preview session for panel ${panelId}:`,
      error
    );
  });
}

// Re-exports for backward compatibility
export type {
  TerminalInstance,
  AddTerminalOptions,
  TrashedTerminal,
  TrashedTerminalGroupMetadata,
  TerminalRegistrySlice,
  TerminalRegistryMiddleware,
  TerminalRegistryStoreApi,
} from "./types";
export { MAX_GRID_TERMINALS, deriveRuntimeStatus, getDefaultTitle } from "./helpers";
export { flushTerminalPersistence } from "./persistence";

export const createTerminalRegistrySlice =
  (
    middleware?: TerminalRegistryMiddleware
  ): StateCreator<TerminalRegistrySlice, [], [], TerminalRegistrySlice> =>
  (set, get) =>
    (({ clearTrashExpiryTimer, scheduleTrashExpiry }) => ({
      terminals: [],
      trashedTerminals: new Map(),
      tabGroups: new Map(),

      addTerminal: async (options) => {
        const requestedKind = options.kind ?? (options.agentId ? "agent" : "terminal");
        const legacyType = options.type || "terminal";

        // Handle panels that use custom UI (browser, notes, dev-preview, extensions) separately
        if (!panelKindUsesTerminalUi(requestedKind)) {
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
          const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
          const isInActiveWorktree = (options.worktreeId ?? null) === (activeWorktreeId ?? null);
          const shouldBackground =
            location === "dock" || (location === "grid" && !isInActiveWorktree);
          const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

          let terminal: TerminalInstance;
          if (requestedKind === "browser") {
            terminal = {
              id,
              kind: "browser",
              title,
              worktreeId: options.worktreeId,
              location,
              isVisible: location === "grid",
              runtimeStatus,
              browserUrl: options.browserUrl || "http://localhost:3000",
              browserHistory: options.browserHistory,
              browserZoom: options.browserZoom,
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
              runtimeStatus,
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
            // Dev-preview panels manage their own ephemeral PTYs via useDevServer hook
            terminal = {
              id,
              kind: "dev-preview",
              title,
              worktreeId: options.worktreeId,
              location,
              isVisible: location === "grid",
              runtimeStatus,
              cwd: options.cwd ?? "",
              devCommand: options.devCommand,
              browserUrl: options.browserUrl,
              browserHistory: options.browserHistory,
              browserZoom: options.browserZoom,
              devServerStatus: options.devServerStatus,
              devServerUrl: options.devServerUrl ?? undefined,
              devServerError: options.devServerError ?? undefined,
              devServerTerminalId: options.devServerTerminalId ?? undefined,
              devPreviewConsoleOpen: options.devPreviewConsoleOpen,
              exitBehavior: options.exitBehavior,
              type: "terminal" as const,
              cols: 80,
              rows: 24,
            };
          } else {
            // Generic non-PTY panel fallback for extensions
            terminal = {
              id,
              kind: requestedKind,
              title,
              worktreeId: options.worktreeId,
              location,
              isVisible: location === "grid",
              runtimeStatus,
              type: "terminal" as const,
              cwd: "",
              cols: 80,
              rows: 24,
            };
          }

          set((state) => {
            // Check for duplicate - if panel with this ID exists, update it instead of appending
            const existingIndex = state.terminals.findIndex((t) => t.id === id);
            let newTerminals: TerminalInstance[];
            if (existingIndex >= 0) {
              console.log(`[TerminalStore] Panel ${id} already exists, updating instead of adding`);
              newTerminals = state.terminals.map((t, i) => (i === existingIndex ? terminal : t));
            } else {
              newTerminals = [...state.terminals, terminal];
            }
            saveTerminals(newTerminals);
            return { terminals: newTerminals };
          });

          return id;
        }

        // PTY panels: terminal/agent/dev-preview
        // Derive agentId: explicit option, or from legacy type if it's a registered agent
        const agentId = options.agentId ?? (isRegisteredAgent(legacyType) ? legacyType : undefined);
        // Determine kind for PTY handling (dev-preview keeps its own kind)
        const kind: "terminal" | "agent" | "dev-preview" =
          requestedKind === "dev-preview"
            ? "dev-preview"
            : agentId || requestedKind === "agent"
              ? "agent"
              : "terminal";
        const title = options.title || getDefaultTitle(kind, legacyType, agentId);

        // Auto-dock if grid is full and user requested grid location
        // Use dynamic capacity based on current viewport dimensions
        const targetWorktreeId = options.worktreeId ?? null;
        const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
        const currentGridGroupCount = (() => {
          // Count unique groups in grid (each group = 1 slot)
          // Groups come from two sources: explicit TabGroups and ungrouped panels
          const gridTerminals = get().terminals.filter(
            (t) =>
              (t.location === "grid" || t.location === undefined) &&
              (t.worktreeId ?? null) === targetWorktreeId
          );
          const tabGroups = get().tabGroups;
          const panelsInGroups = new Set<string>();
          const explicitGroups = new Set<string>();

          // Count explicit groups in this location/worktree
          for (const group of tabGroups.values()) {
            if (group.location === "grid" && (group.worktreeId ?? null) === targetWorktreeId) {
              explicitGroups.add(group.id);
              group.panelIds.forEach((id) => panelsInGroups.add(id));
            }
          }

          // Count ungrouped panels (each is its own virtual group)
          let ungroupedCount = 0;
          for (const t of gridTerminals) {
            if (!panelsInGroups.has(t.id)) {
              ungroupedCount++;
            }
          }

          return explicitGroups.size + ungroupedCount;
        })();
        const requestedLocation = options.location || "grid";
        const location =
          requestedLocation === "grid" && currentGridGroupCount >= maxCapacity
            ? "dock"
            : requestedLocation;
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        const isInActiveWorktree = (options.worktreeId ?? null) === (activeWorktreeId ?? null);
        const shouldBackground =
          location === "dock" || (location === "grid" && !isInActiveWorktree);
        const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

        // Fetch project environment variables and merge with spawn options
        // Precedence: spawn-time env > project env (spawn-time overrides project)
        let mergedEnv: Record<string, string> | undefined = options.env;
        try {
          const currentProject = await projectClient.getCurrent();
          if (currentProject?.id) {
            const projectSettings = await projectClient.getSettings(currentProject.id);
            if (
              projectSettings?.environmentVariables &&
              Object.keys(projectSettings.environmentVariables).length > 0
            ) {
              // Merge: project env as base, spawn-time env overrides
              mergedEnv = { ...projectSettings.environmentVariables, ...options.env };
            }
          }
        } catch (error) {
          // Failed to fetch project env - continue with spawn-time env only
          console.warn("[TerminalStore] Failed to fetch project environment variables:", error);
        }

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
              env: mergedEnv,
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
          const isReconnect = !!options.existingId;

          // For reconnects, use the backend's state directly - don't default to "working".
          // For new spawns, start with "working" in UI to show spinner immediately during boot.
          const agentState = isReconnect
            ? options.agentState
            : (options.agentState ?? (isAgent ? "working" : undefined));
          const lastStateChange = isReconnect
            ? options.lastStateChange
            : (options.lastStateChange ?? (agentState !== undefined ? Date.now() : undefined));

          const terminal: TerminalInstance = {
            id,
            kind,
            type: legacyType,
            agentId,
            title,
            worktreeId: options.worktreeId,
            cwd: options.cwd ?? "",
            cols: 80,
            rows: 24,
            agentState,
            lastStateChange,
            location,
            command: options.command,
            // Initialize grid terminals as visible to avoid initial under-throttling
            // IntersectionObserver will update this once mounted
            isVisible: location === "grid" ? true : false,
            runtimeStatus,
            isInputLocked: options.isInputLocked,
            exitBehavior: options.exitBehavior,
            // Dev-preview specific fields
            ...(kind === "dev-preview" && {
              devCommand: options.devCommand,
              browserUrl: options.browserUrl,
              browserHistory: options.browserHistory,
              browserZoom: options.browserZoom,
              devServerStatus: options.devServerStatus,
              devServerUrl: options.devServerUrl,
              devServerError: options.devServerError,
              devServerTerminalId: options.devServerTerminalId,
              devPreviewConsoleOpen: options.devPreviewConsoleOpen,
            }),
          };

          set((state) => {
            // Check for duplicate - if terminal with this ID exists, update it instead of appending
            const existingIndex = state.terminals.findIndex((t) => t.id === id);
            let newTerminals: TerminalInstance[];
            if (existingIndex >= 0) {
              // Update existing terminal in place (reconnection case or double hydration)
              console.log(
                `[TerminalStore] Terminal ${id} already exists, updating instead of adding`
              );
              const existing = state.terminals[existingIndex];
              // Preserve existing agentState/lastStateChange/exitBehavior if new values are undefined
              const preservedTerminal = isReconnect
                ? {
                    ...terminal,
                    agentState: terminal.agentState ?? existing.agentState,
                    lastStateChange: terminal.lastStateChange ?? existing.lastStateChange,
                    exitBehavior: terminal.exitBehavior ?? existing.exitBehavior,
                  }
                : terminal;
              newTerminals = state.terminals.map((t, i) =>
                i === existingIndex ? preservedTerminal : t
              );
            } else {
              newTerminals = [...state.terminals, terminal];
            }
            saveTerminals(newTerminals);
            return { terminals: newTerminals };
          });

          // Determine if terminal should start backgrounded:
          // 1. Dock terminals are always backgrounded (offscreen)
          // 2. Grid terminals in inactive worktrees should also be backgrounded
          //    since they won't mount until the worktree becomes active
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

        if (terminal?.kind === "dev-preview") {
          stopDevPreviewByPanelId(id);
        }

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

          // Remove panel from any tab group on permanent deletion
          const newTabGroups = new Map(state.tabGroups);
          for (const [groupId, group] of newTabGroups) {
            if (group.panelIds.includes(id)) {
              const filteredPanelIds = group.panelIds.filter((panelId) => panelId !== id);
              if (filteredPanelIds.length <= 1) {
                // Group has 0 or 1 panels remaining - delete it
                newTabGroups.delete(groupId);
              } else {
                // Update group without this panel
                const newActiveTabId =
                  group.activeTabId === id ? (filteredPanelIds[0] ?? "") : group.activeTabId;
                newTabGroups.set(groupId, {
                  ...group,
                  panelIds: filteredPanelIds,
                  activeTabId: newActiveTabId,
                });
              }
              break;
            }
          }

          saveTerminals(newTerminals);
          saveTabGroups(newTabGroups);
          return { terminals: newTerminals, trashedTerminals: newTrashed, tabGroups: newTabGroups };
        });

        const remainingTerminals = get().terminals;
        middleware?.onTerminalRemoved?.(id, removedIndex, remainingTerminals, terminal);
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

          saveTerminals(newTerminals);
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

          const runtimeStatus = deriveRuntimeStatus(
            isVisible,
            terminal.flowStatus,
            terminal.runtimeStatus
          );
          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, isVisible, runtimeStatus } : t
          );

          return { terminals: newTerminals };
        });
      },

      getTerminal: (id) => {
        return get().terminals.find((t) => t.id === id);
      },

      moveTerminalToDock: (id) => {
        // Check if panel is in a group - if so, move the entire group
        const group = get().getPanelGroup(id);
        if (group) {
          get().moveTabGroupToLocation(group.id, "dock");
          return;
        }

        // Single ungrouped panel - move just this panel
        const terminal = get().terminals.find((t) => t.id === id);

        set((state) => {
          if (!terminal || terminal.location === "dock") return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, location: "dock" as const } : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });

        // Only optimize PTY-backed panels
        if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
          optimizeForDock(id);
        }
      },

      moveTerminalToGrid: (id) => {
        // Check if panel is in a group - if so, move the entire group
        const group = get().getPanelGroup(id);
        if (group) {
          return get().moveTabGroupToLocation(group.id, "grid");
        }

        // Single ungrouped panel - move just this panel
        let moveSucceeded = false;
        let terminal: TerminalInstance | undefined;

        set((state) => {
          terminal = state.terminals.find((t) => t.id === id);
          if (!terminal || terminal.location === "grid") return state;

          const targetWorktreeId = terminal.worktreeId ?? null;
          const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
          // Check grid capacity - count unique groups (each group = 1 slot)
          const gridTerminals = state.terminals.filter(
            (t) =>
              (t.location === "grid" || t.location === undefined) &&
              (t.worktreeId ?? null) === targetWorktreeId
          );

          // Count groups using TabGroup data
          const panelsInGroups = new Set<string>();
          let explicitGroupCount = 0;
          for (const group of state.tabGroups.values()) {
            if (group.location === "grid" && (group.worktreeId ?? null) === targetWorktreeId) {
              explicitGroupCount++;
              group.panelIds.forEach((pid) => panelsInGroups.add(pid));
            }
          }
          // Count ungrouped panels
          let ungroupedCount = 0;
          for (const t of gridTerminals) {
            if (!panelsInGroups.has(t.id)) {
              ungroupedCount++;
            }
          }
          if (explicitGroupCount + ungroupedCount >= maxCapacity) {
            return state;
          }

          moveSucceeded = true;
          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, location: "grid" as const } : t
          );

          saveTerminals(newTerminals);
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

        if (terminal.kind === "dev-preview") {
          stopDevPreviewByPanelId(id);
        }

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

          // Remove panel from tab group (auto-delete group if ≤1 panels remain)
          // Panel membership is unique (enforced by addPanelToGroup), so break after first match
          let newTabGroups = state.tabGroups;
          for (const group of state.tabGroups.values()) {
            if (group.panelIds.includes(id)) {
              newTabGroups = new Map(state.tabGroups);
              const newPanelIds = group.panelIds.filter((pid) => pid !== id);

              if (newPanelIds.length <= 1) {
                // Group has 0 or 1 panels remaining - delete the group
                newTabGroups.delete(group.id);
              } else {
                // Update the group with remaining panels
                const newActiveTabId =
                  group.activeTabId === id ? (newPanelIds[0] ?? "") : group.activeTabId;
                newTabGroups.set(group.id, {
                  ...group,
                  panelIds: newPanelIds,
                  activeTabId: newActiveTabId,
                });
              }
              saveTabGroups(newTabGroups);
              break;
            }
          }

          saveTerminals(newTerminals);
          return { terminals: newTerminals, trashedTerminals: newTrashed, tabGroups: newTabGroups };
        });

        scheduleTrashExpiry(id, expiresAt);

        if (panelKindHasPty(terminal.kind ?? "terminal")) {
          terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
          return;
        }
      },

      trashPanelGroup: (panelId) => {
        // Find the group this panel belongs to
        const group = get().getPanelGroup(panelId);

        // If no group, fall back to single panel trash
        if (!group) {
          get().trashTerminal(panelId);
          return;
        }

        const expiresAt = Date.now() + 120000;
        const groupRestoreId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const panelIds = [...group.panelIds];
        const activeTabId = group.activeTabId ?? panelIds[0] ?? "";
        const terminals = get().terminals;

        // Filter to existing panels and validate at least one exists
        const existingPanelIds = panelIds.filter((id) => terminals.some((t) => t.id === id));
        if (existingPanelIds.length === 0) {
          // No panels exist, just delete the group
          set((state) => {
            const newTabGroups = new Map(state.tabGroups);
            newTabGroups.delete(group.id);
            saveTabGroups(newTabGroups);
            return { tabGroups: newTabGroups };
          });
          return;
        }

        const trashPanelIds = existingPanelIds;

        const resolvedActiveTabId = trashPanelIds.includes(activeTabId)
          ? activeTabId
          : (trashPanelIds[0] ?? "");

        // Use group's location and worktreeId as canonical source
        const originalLocation: "dock" | "grid" = group.location === "dock" ? "dock" : "grid";
        const worktreeId = group.worktreeId ?? null;

        // Trash PTY processes for all PTY-backed panels
        for (const id of trashPanelIds) {
          const terminal = terminals.find((t) => t.id === id);
          if (terminal?.kind === "dev-preview") {
            stopDevPreviewByPanelId(id);
            continue;
          }
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            terminalClient.trash(id).catch((error) => {
              console.error("Failed to trash terminal:", error);
            });
          }
        }

        set((state) => {
          // Move all existing panels to trash
          const newTerminals = state.terminals.map((t) =>
            trashPanelIds.includes(t.id) ? { ...t, location: "trash" as const } : t
          );

          const newTrashed = new Map(state.trashedTerminals);

          // Add all existing panels to trash with shared groupRestoreId
          // The first existing panel (anchor) gets the groupMetadata
          for (let i = 0; i < trashPanelIds.length; i++) {
            const id = trashPanelIds[i];
            const isAnchor = i === 0;
            newTrashed.set(id, {
              id,
              expiresAt,
              originalLocation,
              groupRestoreId,
              ...(isAnchor && {
                groupMetadata: {
                  panelIds: trashPanelIds,
                  activeTabId: resolvedActiveTabId,
                  location: group.location,
                  worktreeId,
                },
              }),
            });
          }

          // Delete the tab group since all panels are trashed
          const newTabGroups = new Map(state.tabGroups);
          newTabGroups.delete(group.id);
          saveTabGroups(newTabGroups);

          saveTerminals(newTerminals);
          return { terminals: newTerminals, trashedTerminals: newTrashed, tabGroups: newTabGroups };
        });

        // Schedule expiry for all existing panels
        for (const id of trashPanelIds) {
          scheduleTrashExpiry(id, expiresAt);
        }

        // Apply renderer policies for PTY-backed panels
        for (const id of trashPanelIds) {
          const terminal = terminals.find((t) => t.id === id);
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
          }
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
          saveTerminals(newTerminals);
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

      restoreTrashedGroup: (groupRestoreId, targetWorktreeId) => {
        const trashedTerminals = get().trashedTerminals;

        // Find all panels with the same groupRestoreId
        const groupPanels: Array<{
          id: string;
          trashed: ReturnType<typeof trashedTerminals.get>;
        }> = [];
        let anchorPanel: ReturnType<typeof trashedTerminals.get> | undefined;

        for (const [id, trashed] of trashedTerminals.entries()) {
          if (trashed.groupRestoreId === groupRestoreId) {
            groupPanels.push({ id, trashed });
            if (trashed.groupMetadata) {
              anchorPanel = trashed;
            }
          }
        }

        if (groupPanels.length === 0) {
          return;
        }

        // Clear expiry timers and restore PTY processes for all panels
        for (const { id } of groupPanels) {
          clearTrashExpiryTimer(id);
          const terminal = get().terminals.find((t) => t.id === id);
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            terminalClient.restore(id).catch((error) => {
              console.error("Failed to restore terminal:", error);
            });
          }
        }

        // Determine restore location - prefer metadata, fallback to originalLocation from any panel
        const restoreLocation =
          anchorPanel?.groupMetadata?.location ??
          groupPanels[0]?.trashed?.originalLocation ??
          "grid";
        const worktreeId =
          targetWorktreeId !== undefined
            ? targetWorktreeId
            : (anchorPanel?.groupMetadata?.worktreeId ?? undefined);

        // Restore all panels in the group
        set((state) => {
          const panelIdsInGroup = new Set(groupPanels.map(({ id }) => id));
          const newTerminals = state.terminals.map((t) =>
            panelIdsInGroup.has(t.id)
              ? {
                  ...t,
                  location: restoreLocation as "dock" | "grid",
                  worktreeId: worktreeId ?? t.worktreeId,
                }
              : t
          );

          const newTrashed = new Map(state.trashedTerminals);
          for (const { id } of groupPanels) {
            newTrashed.delete(id);
          }

          saveTerminals(newTerminals);
          return { terminals: newTerminals, trashedTerminals: newTrashed };
        });

        // Recreate the tab group if we have multiple panels (best-effort even without metadata)
        const restoredPanelIds = groupPanels.map(({ id }) => id);
        // Filter to only include panels that actually exist in state.terminals
        const existingIds = new Set(get().terminals.map((t) => t.id));
        const validPanelIds = restoredPanelIds.filter((id) => existingIds.has(id));

        if (validPanelIds.length > 1) {
          let orderedPanelIds = validPanelIds;
          let activeTabId = validPanelIds[0];

          // If we have metadata, use its order and active tab
          if (anchorPanel?.groupMetadata) {
            const { panelIds, activeTabId: metadataActiveTabId } = anchorPanel.groupMetadata;
            // Preserve original order from metadata
            orderedPanelIds = panelIds.filter((id) => validPanelIds.includes(id));
            // Add any panels not in metadata (shouldn't happen, but be safe)
            for (const id of validPanelIds) {
              if (!orderedPanelIds.includes(id)) {
                orderedPanelIds.push(id);
              }
            }
            activeTabId = orderedPanelIds.includes(metadataActiveTabId)
              ? metadataActiveTabId
              : orderedPanelIds[0];
          }

          if (orderedPanelIds.length > 1) {
            get().createTabGroup(
              restoreLocation as "dock" | "grid",
              worktreeId,
              orderedPanelIds,
              activeTabId
            );
          }
        }

        // Apply renderer policies for PTY-backed panels
        for (const { id } of groupPanels) {
          const terminal = get().terminals.find((t) => t.id === id);
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            if (restoreLocation === "dock") {
              optimizeForDock(id);
            } else {
              terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
            }
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
          // Preserve existing fields if already set (from trashTerminal/trashPanelGroup call)
          const existingTrashed = state.trashedTerminals.get(id);
          const location = existingTrashed?.originalLocation ?? originalLocation;
          newTrashed.set(id, {
            id,
            expiresAt,
            originalLocation: location,
            // Preserve group restore metadata if present
            ...(existingTrashed?.groupRestoreId && {
              groupRestoreId: existingTrashed.groupRestoreId,
            }),
            ...(existingTrashed?.groupMetadata && { groupMetadata: existingTrashed.groupMetadata }),
          });
          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, location: "trash" as const } : t
          );
          saveTerminals(newTerminals);
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
          saveTerminals(newTerminals);
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

          saveTerminals(newTerminals);
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
          const trashTerminals = state.terminals.filter(
            (t) => t.id !== id && t.location === "trash"
          );

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

          saveTerminals(newTerminals);
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
            t.id === id
              ? {
                  ...t,
                  restartError: undefined,
                  reconnectError: undefined,
                  spawnError: undefined,
                  isRestarting: true,
                }
              : t
          ),
        }));

        // Validate configuration before attempting restart
        let validation;
        try {
          validation = await validateTerminalConfig(terminal);
        } catch (error) {
          // Validation itself failed (e.g., IPC error)
          const restartError = {
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
          const primaryError =
            validation.errors.find((e) => !e.recoverable) || validation.errors[0];

          const restartError = {
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
          console.warn(
            `[TerminalStore] Restart validation failed for terminal ${id}:`,
            restartError
          );
          return;
        }

        // Re-read terminal from state in case it was modified during async validation
        const currentState = get();
        const currentTerminal = currentState.terminals.find((t) => t.id === id);

        if (!currentTerminal || currentTerminal.location === "trash") {
          // Terminal was removed or trashed while we were validating
          unmarkTerminalRestarting(id);
          set((state) => ({
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, isRestarting: false } : t
            ),
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
              commandToRun = generateAgentCommand(
                baseCommand,
                agentSettings.agents?.[effectiveAgentId] ?? {},
                effectiveAgentId
              );
            }
          } catch (error) {
            console.warn(
              "[TerminalStore] Failed to load agent settings for restart, using saved command:",
              error
            );
          }
        }

        const spawnCommand = commandToRun;

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
                    command: spawnCommand,
                    isRestarting: true,
                    restartError: undefined,
                  }
                : t
            );
            saveTerminals(newTerminals);
            return { terminals: newTerminals };
          });

          await terminalInstanceService.waitForInstance(id, { timeoutMs: 5000 });

          // Fetch project environment variables for restart
          let restartEnv: Record<string, string> | undefined;
          try {
            const currentProject = await projectClient.getCurrent();
            if (currentProject?.id) {
              const projectSettings = await projectClient.getSettings(currentProject.id);
              if (
                projectSettings?.environmentVariables &&
                Object.keys(projectSettings.environmentVariables).length > 0
              ) {
                restartEnv = projectSettings.environmentVariables;
              }
            }
          } catch (error) {
            console.warn("[TerminalStore] Failed to fetch project env for restart:", error);
          }

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
            command: spawnCommand,
            restore: false,
            env: restartEnv,
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
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, isRestarting: false } : t
            ),
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

          const restartError = {
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

          console.error(
            `[TerminalStore] Failed to restart terminal ${id} during ${phase}:`,
            error,
            {
              cwd: currentTerminal.cwd,
              command: commandToRun,
              isAgent,
              agentId: effectiveAgentId,
            }
          );
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
            t.id === id ? { ...t, cwd, restartError: undefined, spawnError: undefined } : t
          );
          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      moveTerminalToWorktree: (id, worktreeId) => {
        console.log(`[TERM_DEBUG] moveTerminalToWorktree id=${id} worktree=${worktreeId}`);

        const terminal = get().terminals.find((t) => t.id === id);
        if (!terminal) {
          console.warn(`Cannot move terminal ${id}: terminal not found`);
          return;
        }

        if (terminal.worktreeId === worktreeId) {
          return;
        }

        // Check if terminal belongs to a group
        const group = get().getPanelGroup(id);
        if (group) {
          // Move entire group to maintain worktree invariant
          console.log(
            `[TabGroup] Panel ${id} is in group ${group.id}, moving entire group to worktree ${worktreeId}`
          );
          const success = get().moveTabGroupToWorktree(group.id, worktreeId);
          if (!success) {
            console.warn(
              `[TabGroup] Failed to move group ${group.id} to worktree ${worktreeId} (likely capacity exceeded)`
            );
          }
          return;
        }

        // Terminal is not in a group - move it individually
        let movedToLocation: TerminalLocation | null = null;

        set((state) => {
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
                  runtimeStatus: deriveRuntimeStatus(
                    newLocation === "grid",
                    t.flowStatus,
                    t.runtimeStatus
                  ),
                }
              : t
          );
          saveTerminals(newTerminals);
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

          const runtimeStatus = deriveRuntimeStatus(
            terminal.isVisible,
            status,
            terminal.runtimeStatus
          );

          return {
            terminals: state.terminals.map((t) =>
              t.id === id
                ? { ...t, flowStatus: status, flowStatusTimestamp: timestamp, runtimeStatus }
                : t
            ),
          };
        });
      },

      setRuntimeStatus: (id, status) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          if (terminal.runtimeStatus === status) {
            return state;
          }

          return {
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, runtimeStatus: status } : t
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

          saveTerminals(updated.terminals);
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

          saveTerminals(updated.terminals);
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
              commandToRun = generateAgentCommand(
                baseCommand,
                agentSettings.agents?.[effectiveAgentId] ?? {},
                effectiveAgentId
              );
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
            saveTerminals(newTerminals);
            return { terminals: newTerminals };
          });

          await new Promise((resolve) => setTimeout(resolve, 50));

          // Fetch project environment variables for conversion
          let convertEnv: Record<string, string> | undefined;
          try {
            const currentProject = await projectClient.getCurrent();
            if (currentProject?.id) {
              const projectSettings = await projectClient.getSettings(currentProject.id);
              if (
                projectSettings?.environmentVariables &&
                Object.keys(projectSettings.environmentVariables).length > 0
              ) {
                convertEnv = projectSettings.environmentVariables;
              }
            }
          } catch (error) {
            console.warn("[TerminalStore] Failed to fetch project env for conversion:", error);
          }

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
            env: convertEnv,
          });

          await new Promise((resolve) => setTimeout(resolve, 50));

          if (terminal.location === "dock") {
            optimizeForDock(id);
          } else {
            terminalInstanceService.fit(id);
          }

          unmarkTerminalRestarting(id);
          set((state) => ({
            terminals: state.terminals.map((t) =>
              t.id === id ? { ...t, isRestarting: false } : t
            ),
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const errorCode = (error as { code?: string })?.code;

          const restartError = {
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
          if (!terminal) return state;

          const kind = terminal.kind ?? "terminal";
          if (panelKindUsesTerminalUi(kind)) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, browserUrl: url } : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      setBrowserHistory: (id, history) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const kind = terminal.kind ?? "terminal";
          if (panelKindUsesTerminalUi(kind)) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, browserHistory: history } : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      setBrowserZoom: (id, zoom) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const kind = terminal.kind ?? "terminal";
          if (panelKindUsesTerminalUi(kind)) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, browserZoom: zoom } : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      setDevPreviewConsoleOpen: (id, isOpen) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;
          if (terminal.kind !== "dev-preview") return state;
          if (terminal.devPreviewConsoleOpen === isOpen) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, devPreviewConsoleOpen: isOpen } : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      setDevServerState: (id, status, url, error, terminalId) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;
          if (terminal.kind !== "dev-preview") return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id
              ? {
                  ...t,
                  devServerStatus: status,
                  devServerUrl: url ?? undefined,
                  devServerError: error ?? undefined,
                  devServerTerminalId: terminalId ?? undefined,
                }
              : t
          );

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      setSpawnError: (id, error) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, spawnError: error, runtimeStatus: "error" as const } : t
          );

          return { terminals: newTerminals };
        });
      },

      clearSpawnError: (id) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, spawnError: undefined, runtimeStatus: undefined } : t
          );

          return { terminals: newTerminals };
        });
      },

      setReconnectError: (id, error) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, reconnectError: error, runtimeStatus: "error" as const } : t
          );

          return { terminals: newTerminals };
        });
      },

      clearReconnectError: (id) => {
        set((state) => {
          const terminal = state.terminals.find((t) => t.id === id);
          if (!terminal) return state;

          const newTerminals = state.terminals.map((t) =>
            t.id === id ? { ...t, reconnectError: undefined, runtimeStatus: undefined } : t
          );

          return { terminals: newTerminals };
        });
      },

      // Tab Group Methods - TabGroup is the single source of truth
      // Panels do NOT store tabGroupId/orderInGroup - membership is defined by TabGroup.panelIds

      getPanelGroup: (panelId) => {
        const tabGroups = get().tabGroups;
        for (const group of tabGroups.values()) {
          if (group.panelIds.includes(panelId)) {
            return group;
          }
        }
        return undefined;
      },

      createTabGroup: (location, worktreeId, panelIds, activeTabId) => {
        const groupId = `tabgroup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const group: TabGroup = {
          id: groupId,
          location,
          worktreeId,
          activeTabId: activeTabId ?? panelIds[0] ?? "",
          panelIds,
        };

        set((state) => {
          const newTabGroups = new Map(state.tabGroups);
          newTabGroups.set(groupId, group);
          saveTabGroups(newTabGroups);
          return { tabGroups: newTabGroups };
        });

        return groupId;
      },

      addPanelToGroup: (groupId, panelId, index) => {
        set((state) => {
          const group = state.tabGroups.get(groupId);
          if (!group) {
            console.warn(`[TabGroup] Cannot add panel: group ${groupId} not found`);
            return state;
          }

          // Don't add if already in this group
          if (group.panelIds.includes(panelId)) {
            return state;
          }

          // Enforce worktree invariant - panel must match group's worktree
          const panel = state.terminals.find((t) => t.id === panelId);
          if (!panel) {
            console.warn(`[TabGroup] Cannot add panel ${panelId}: panel not found`);
            return state;
          }

          if ((panel.worktreeId ?? undefined) !== (group.worktreeId ?? undefined)) {
            console.warn(
              `[TabGroup] Cannot add panel ${panelId} to group ${groupId}: worktree mismatch (panel: ${panel.worktreeId}, group: ${group.worktreeId})`
            );
            return state;
          }

          // CRITICAL: Enforce unique membership - remove from any existing group first
          const newTabGroups = new Map(state.tabGroups);
          for (const [existingGroupId, existingGroup] of newTabGroups) {
            if (existingGroup.panelIds.includes(panelId)) {
              const filteredPanelIds = existingGroup.panelIds.filter((id) => id !== panelId);
              if (filteredPanelIds.length <= 1) {
                // Group has 0 or 1 panels remaining - delete it
                newTabGroups.delete(existingGroupId);
              } else {
                // Update group without this panel
                const newActiveTabId =
                  existingGroup.activeTabId === panelId
                    ? (filteredPanelIds[0] ?? "")
                    : existingGroup.activeTabId;
                newTabGroups.set(existingGroupId, {
                  ...existingGroup,
                  panelIds: filteredPanelIds,
                  activeTabId: newActiveTabId,
                });
              }
              break; // Panel can only be in one group
            }
          }

          // Now add to the target group
          const targetGroup = newTabGroups.get(groupId);
          if (!targetGroup) {
            console.warn(`[TabGroup] Target group ${groupId} was deleted during cleanup`);
            return state;
          }

          const newPanelIds = [...targetGroup.panelIds];
          if (index !== undefined && index >= 0 && index <= newPanelIds.length) {
            newPanelIds.splice(index, 0, panelId);
          } else {
            newPanelIds.push(panelId);
          }

          newTabGroups.set(groupId, { ...targetGroup, panelIds: newPanelIds });
          saveTabGroups(newTabGroups);
          return { tabGroups: newTabGroups };
        });
      },

      removePanelFromGroup: (panelId) => {
        set((state) => {
          let groupToUpdate: TabGroup | undefined;
          for (const group of state.tabGroups.values()) {
            if (group.panelIds.includes(panelId)) {
              groupToUpdate = group;
              break;
            }
          }

          if (!groupToUpdate) {
            return state; // Panel not in any group
          }

          const newPanelIds = groupToUpdate.panelIds.filter((id) => id !== panelId);
          const newTabGroups = new Map(state.tabGroups);

          if (newPanelIds.length <= 1) {
            // Group has 0 or 1 panels remaining - delete the group
            newTabGroups.delete(groupToUpdate.id);
          } else {
            // Update the group with remaining panels
            const newActiveTabId =
              groupToUpdate.activeTabId === panelId
                ? (newPanelIds[0] ?? "")
                : groupToUpdate.activeTabId;
            const newGroup: TabGroup = {
              ...groupToUpdate,
              panelIds: newPanelIds,
              activeTabId: newActiveTabId,
            };
            newTabGroups.set(groupToUpdate.id, newGroup);
          }

          saveTabGroups(newTabGroups);
          return { tabGroups: newTabGroups };
        });
      },

      reorderPanelsInGroup: (groupId, panelIds) => {
        set((state) => {
          const group = state.tabGroups.get(groupId);
          if (!group) {
            console.warn(`[TabGroup] Cannot reorder: group ${groupId} not found`);
            return state;
          }

          // Verify all panel IDs are in the group
          const existingSet = new Set(group.panelIds);
          const newSet = new Set(panelIds);
          if (existingSet.size !== newSet.size || !group.panelIds.every((id) => newSet.has(id))) {
            console.warn(`[TabGroup] Reorder mismatch: panels don't match group ${groupId}`);
            return state;
          }

          const newGroup: TabGroup = { ...group, panelIds };
          const newTabGroups = new Map(state.tabGroups);
          newTabGroups.set(groupId, newGroup);
          saveTabGroups(newTabGroups);
          return { tabGroups: newTabGroups };
        });
      },

      deleteTabGroup: (groupId) => {
        set((state) => {
          if (!state.tabGroups.has(groupId)) {
            return state;
          }
          const newTabGroups = new Map(state.tabGroups);
          newTabGroups.delete(groupId);
          saveTabGroups(newTabGroups);
          return { tabGroups: newTabGroups };
        });
      },

      getTabGroupPanels: (groupId, _location) => {
        // Note: location parameter is deprecated and ignored - group location is stored in TabGroup
        const terminals = get().terminals;
        const trashedTerminals = get().trashedTerminals;
        const tabGroups = get().tabGroups;

        // Check if this is an explicit tab group
        const group = tabGroups.get(groupId);
        if (group) {
          // Return panels in the order defined by group.panelIds
          return group.panelIds
            .map((id) => terminals.find((t) => t.id === id))
            .filter(
              (t): t is TerminalInstance =>
                t !== undefined && t.location !== "trash" && !trashedTerminals.has(t.id)
            );
        }

        // Not an explicit group - check if it's a single ungrouped panel
        const panel = terminals.find((t) => t.id === groupId);
        if (panel && panel.location !== "trash" && !trashedTerminals.has(panel.id)) {
          // Verify this panel isn't in any explicit group
          for (const g of tabGroups.values()) {
            if (g.panelIds.includes(groupId)) {
              return []; // Panel is in an explicit group, not standalone
            }
          }
          return [panel];
        }

        return [];
      },

      getTabGroups: (location, worktreeId) => {
        const terminals = get().terminals;
        const trashedTerminals = get().trashedTerminals;
        const tabGroups = get().tabGroups;

        // Collect explicit groups for this location/worktree
        const explicitGroups: TabGroup[] = [];
        const panelsInExplicitGroups = new Set<string>();

        for (const group of tabGroups.values()) {
          if (group.location === location && (group.worktreeId ?? undefined) === worktreeId) {
            // Filter out trashed panels from the group
            const validPanelIds = group.panelIds.filter((id) => {
              const panel = terminals.find((t) => t.id === id);
              return panel && panel.location !== "trash" && !trashedTerminals.has(id);
            });

            if (validPanelIds.length > 0) {
              explicitGroups.push({
                ...group,
                panelIds: validPanelIds,
                activeTabId: validPanelIds.includes(group.activeTabId)
                  ? group.activeTabId
                  : (validPanelIds[0] ?? ""),
              });
              validPanelIds.forEach((id) => panelsInExplicitGroups.add(id));
            }
          }
        }

        // Find ungrouped panels (single-panel "virtual" groups)
        const ungroupedPanels = terminals.filter((t) => {
          if (t.location === "trash" || trashedTerminals.has(t.id)) return false;
          const effectiveLocation = t.location ?? "grid";
          if (effectiveLocation !== location) return false;
          if ((t.worktreeId ?? undefined) !== worktreeId) return false;
          return !panelsInExplicitGroups.has(t.id);
        });

        // Create virtual single-panel groups for ungrouped panels
        const virtualGroups: TabGroup[] = ungroupedPanels.map((panel) => ({
          id: panel.id, // Use panel ID as group ID for virtual groups
          location,
          worktreeId,
          activeTabId: panel.id,
          panelIds: [panel.id],
        }));

        // Sort explicit groups by their earliest terminal index in the terminals array
        // This makes group order follow terminal array order (which reorderTabGroups manipulates)
        explicitGroups.sort((a, b) => {
          const aFirstIndex = Math.min(
            ...a.panelIds
              .map((id) => terminals.findIndex((t) => t.id === id))
              .filter((i) => i !== -1)
          );
          const bFirstIndex = Math.min(
            ...b.panelIds
              .map((id) => terminals.findIndex((t) => t.id === id))
              .filter((i) => i !== -1)
          );
          return aFirstIndex - bFirstIndex;
        });

        // Return explicit groups first (sorted by terminal order), then virtual groups
        return [...explicitGroups, ...virtualGroups];
      },

      moveTabGroupToLocation: (groupId, location) => {
        const group = get().tabGroups.get(groupId);
        if (!group) {
          console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
          return false;
        }

        // Already at target location
        if (group.location === location) {
          return true;
        }

        // Check capacity if moving to grid
        if (location === "grid") {
          const targetWorktreeId = group.worktreeId ?? null;
          const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();

          // Count current grid groups (each group = 1 slot)
          const gridTerminals = get().terminals.filter(
            (t) =>
              (t.location === "grid" || t.location === undefined) &&
              (t.worktreeId ?? null) === targetWorktreeId
          );

          const panelsInGroups = new Set<string>();
          let explicitGroupCount = 0;
          for (const g of get().tabGroups.values()) {
            if (
              g.id !== groupId &&
              g.location === "grid" &&
              (g.worktreeId ?? null) === targetWorktreeId
            ) {
              explicitGroupCount++;
              g.panelIds.forEach((pid) => panelsInGroups.add(pid));
            }
          }

          // Count ungrouped panels (excluding panels in the moving group)
          let ungroupedCount = 0;
          const movingPanelIds = new Set(group.panelIds);
          for (const t of gridTerminals) {
            if (!panelsInGroups.has(t.id) && !movingPanelIds.has(t.id)) {
              ungroupedCount++;
            }
          }

          // The moving group will occupy 1 slot
          if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
            console.warn(
              `[TabGroup] Cannot move group ${groupId} to grid: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
            );
            return false;
          }
        }

        // Update group location and all member panel locations (skip trashed)
        set((state) => {
          const newTabGroups = new Map(state.tabGroups);
          const updatedGroup: TabGroup = { ...group, location };
          newTabGroups.set(groupId, updatedGroup);

          // Update all non-trashed panels in the group to the new location
          const panelIdSet = new Set(group.panelIds);
          const newTerminals = state.terminals.map((t) => {
            if (!panelIdSet.has(t.id)) return t;
            // Skip trashed panels - they should remain trashed
            if (t.location === "trash" || state.trashedTerminals.has(t.id)) return t;
            return { ...t, location };
          });

          saveTerminals(newTerminals);
          saveTabGroups(newTabGroups);
          return { terminals: newTerminals, tabGroups: newTabGroups };
        });

        // Apply appropriate renderer policies for PTY-backed panels
        for (const panelId of group.panelIds) {
          const terminal = get().terminals.find((t) => t.id === panelId);
          if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
            if (location === "dock") {
              optimizeForDock(panelId);
            } else {
              terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.VISIBLE);
            }
          }
        }

        return true;
      },

      moveTabGroupToWorktree: (groupId, worktreeId) => {
        const group = get().tabGroups.get(groupId);
        if (!group) {
          console.warn(`[TabGroup] Cannot move: group ${groupId} not found`);
          return false;
        }

        // Already at target worktree
        if (group.worktreeId === worktreeId) {
          return true;
        }

        // Check capacity if moving to grid location
        if (group.location === "grid") {
          const targetWorktreeId = worktreeId ?? null;
          const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();

          // Count current grid groups (each group = 1 slot)
          const gridTerminals = get().terminals.filter(
            (t) =>
              (t.location === "grid" || t.location === undefined) &&
              (t.worktreeId ?? null) === targetWorktreeId
          );

          const panelsInGroups = new Set<string>();
          let explicitGroupCount = 0;
          for (const g of get().tabGroups.values()) {
            if (
              g.id !== groupId &&
              g.location === "grid" &&
              (g.worktreeId ?? null) === targetWorktreeId
            ) {
              explicitGroupCount++;
              g.panelIds.forEach((pid) => panelsInGroups.add(pid));
            }
          }

          // Count ungrouped panels (excluding panels in the moving group)
          let ungroupedCount = 0;
          const movingPanelIds = new Set(group.panelIds);
          for (const t of gridTerminals) {
            if (!panelsInGroups.has(t.id) && !movingPanelIds.has(t.id)) {
              ungroupedCount++;
            }
          }

          // The moving group will occupy 1 slot
          if (explicitGroupCount + ungroupedCount + 1 > maxCapacity) {
            console.warn(
              `[TabGroup] Cannot move group ${groupId} to worktree ${worktreeId}: capacity exceeded (${explicitGroupCount + ungroupedCount + 1} > ${maxCapacity})`
            );
            return false;
          }
        }

        // Determine location for panels after the move
        const targetLocation: TabGroupLocation = group.location === "grid" ? "grid" : "dock";

        // Update group worktreeId and all member panel worktreeIds (skip trashed)
        set((state) => {
          const newTabGroups = new Map(state.tabGroups);
          const updatedGroup: TabGroup = { ...group, worktreeId };
          newTabGroups.set(groupId, updatedGroup);

          // Update all non-trashed panels in the group to the new worktree
          const panelIdSet = new Set(group.panelIds);
          const newTerminals = state.terminals.map((t) => {
            if (!panelIdSet.has(t.id)) return t;
            // Skip trashed panels - they should remain trashed
            if (t.location === "trash" || state.trashedTerminals.has(t.id)) return t;
            return {
              ...t,
              worktreeId,
              location: targetLocation,
              isVisible: targetLocation === "grid",
              runtimeStatus: deriveRuntimeStatus(
                targetLocation === "grid",
                t.flowStatus,
                t.runtimeStatus
              ),
            };
          });

          saveTerminals(newTerminals);
          saveTabGroups(newTabGroups);
          return { terminals: newTerminals, tabGroups: newTabGroups };
        });

        // Apply appropriate renderer policies for PTY-backed panels (skip trashed)
        for (const panelId of group.panelIds) {
          const terminal = get().terminals.find((t) => t.id === panelId);
          if (
            terminal &&
            terminal.location !== "trash" &&
            !get().trashedTerminals.has(panelId) &&
            panelKindHasPty(terminal.kind ?? "terminal")
          ) {
            if (targetLocation === "dock") {
              optimizeForDock(panelId);
            } else {
              terminalInstanceService.applyRendererPolicy(panelId, TerminalRefreshTier.VISIBLE);
            }
          }
        }

        return true;
      },

      reorderTabGroups: (fromGroupIndex, toGroupIndex, location, worktreeId) => {
        if (fromGroupIndex === toGroupIndex) return;

        set((state) => {
          const targetWorktreeId = worktreeId ?? null;

          // Get current tab groups for this location/worktree
          // Use getTabGroups which returns both explicit and virtual (single-panel) groups
          const allGroups = get().getTabGroups(location, worktreeId ?? undefined);

          if (fromGroupIndex < 0 || fromGroupIndex >= allGroups.length) return state;
          if (toGroupIndex < 0 || toGroupIndex > allGroups.length) return state;

          // Reorder the groups
          const reorderedGroups = [...allGroups];
          const [movedGroup] = reorderedGroups.splice(fromGroupIndex, 1);
          reorderedGroups.splice(toGroupIndex, 0, movedGroup);

          // Now we need to reorder the terminals array to match the new group order
          // The terminals array order determines display order
          // Each group's panels should be contiguous and in the same order as the group's panelIds

          // Separate terminals by location
          const gridTerminals = state.terminals.filter(
            (t) => t.location === "grid" || t.location === undefined
          );
          const dockTerminals = state.terminals.filter((t) => t.location === "dock");
          const trashTerminals = state.terminals.filter((t) => t.location === "trash");

          // Get terminals in the target location/worktree
          const terminalsInLocation = location === "grid" ? gridTerminals : dockTerminals;

          // Build new terminal list for this location by walking the reordered groups
          // and preserving order of terminals within each group
          const newLocationTerminals: TerminalInstance[] = [];
          const processedIds = new Set<string>();

          // Process terminals in the new group order
          for (const group of reorderedGroups) {
            // Get panels for this group in their proper order, filtering by location
            const groupPanels = state.terminals.filter((t) => {
              if (!group.panelIds.includes(t.id)) return false;
              if ((t.worktreeId ?? null) !== targetWorktreeId) return false;
              if (t.location === "trash") return false;
              // Ensure panel is in the target location
              const effectiveLocation = t.location ?? "grid";
              return effectiveLocation === location;
            });

            // Sort by the order in group.panelIds
            groupPanels.sort((a, b) => group.panelIds.indexOf(a.id) - group.panelIds.indexOf(b.id));

            for (const panel of groupPanels) {
              if (!processedIds.has(panel.id)) {
                newLocationTerminals.push(panel);
                processedIds.add(panel.id);
              }
            }
          }

          // Add any terminals in other worktrees (preserve their relative order)
          for (const terminal of terminalsInLocation) {
            if (
              !processedIds.has(terminal.id) &&
              (terminal.worktreeId ?? null) !== targetWorktreeId
            ) {
              newLocationTerminals.push(terminal);
              processedIds.add(terminal.id);
            }
          }

          // Reconstruct the full terminals array
          const newTerminals =
            location === "grid"
              ? [...newLocationTerminals, ...dockTerminals, ...trashTerminals]
              : [...gridTerminals, ...newLocationTerminals, ...trashTerminals];

          saveTerminals(newTerminals);
          return { terminals: newTerminals };
        });
      },

      hydrateTabGroups: (tabGroups, options) => {
        const terminals = get().terminals;
        const terminalIdSet = new Set(terminals.map((t) => t.id));
        const trashedTerminals = get().trashedTerminals;

        // Sanitize tab groups during hydration:
        // 1. Deduplicate group IDs (keep first occurrence)
        // 2. Drop panelIds that no longer exist or are trashed (check both trashedTerminals AND location)
        // 3. Deduplicate panelIds within each group
        // 4. Delete groups with <= 1 unique panel
        // 5. Validate group location is "grid" or "dock"
        // 6. Normalize member locations to match group location
        // 7. Repair worktree mismatches (enforce worktree invariant)
        const sanitizedGroups = new Map<string, TabGroup>();
        const panelsAlreadyInGroups = new Set<string>();
        const seenGroupIds = new Set<string>();

        for (const group of tabGroups) {
          // Validate shape: skip malformed groups that would crash during sanitation
          if (!group || typeof group.id !== "string" || !Array.isArray(group.panelIds)) {
            console.warn(`[TabGroup] Hydration: Skipping malformed group`, group);
            continue;
          }

          // Deduplicate group IDs - keep first occurrence
          if (seenGroupIds.has(group.id)) {
            console.log(`[TabGroup] Hydration: Dropping duplicate group ID ${group.id}`);
            continue;
          }
          seenGroupIds.add(group.id);

          // Validate group location
          const groupLocation = group.location === "dock" ? "dock" : "grid";

          // Filter to only valid, non-trashed panels (check both trashedTerminals map AND location field)
          const validPanelIds = group.panelIds.filter((id) => {
            if (!terminalIdSet.has(id)) return false;
            if (trashedTerminals.has(id)) return false;
            const terminal = terminals.find((t) => t.id === id);
            if (terminal?.location === "trash") return false;
            return true;
          });

          // Deduplicate panel IDs (preserve first occurrence)
          const uniquePanelIds = Array.from(new Set(validPanelIds));

          // Enforce unique membership: skip panels already assigned to another group
          const finalPanelIds = uniquePanelIds.filter((id) => !panelsAlreadyInGroups.has(id));

          if (finalPanelIds.length <= 1) {
            console.log(
              `[TabGroup] Hydration: Dropping group ${group.id} with ${finalPanelIds.length} valid unique panels`
            );
            continue;
          }

          // Check worktree consistency - all panels must have the same worktreeId as the group
          const panelWorktrees = new Map<string | undefined, number>();
          for (const panelId of finalPanelIds) {
            const terminal = terminals.find((t) => t.id === panelId);
            if (terminal) {
              const count = panelWorktrees.get(terminal.worktreeId) || 0;
              panelWorktrees.set(terminal.worktreeId, count + 1);
            }
          }

          // If there's a worktree mismatch, repair it
          let repairedWorktreeId = group.worktreeId;
          if (panelWorktrees.size > 1 || !panelWorktrees.has(group.worktreeId)) {
            // Find the most common worktreeId among panels (majority wins)
            let maxCount = 0;
            for (const [worktreeId, count] of panelWorktrees.entries()) {
              if (count > maxCount) {
                maxCount = count;
                repairedWorktreeId = worktreeId;
              }
            }
            console.warn(
              `[TabGroup] Hydration: Repairing worktree mismatch in group ${group.id} (group: ${group.worktreeId}, repaired to: ${repairedWorktreeId})`
            );
          }

          // Mark these panels as assigned
          finalPanelIds.forEach((id) => panelsAlreadyInGroups.add(id));

          // Ensure activeTabId is valid
          const activeTabId = finalPanelIds.includes(group.activeTabId)
            ? group.activeTabId
            : finalPanelIds[0];

          sanitizedGroups.set(group.id, {
            ...group,
            location: groupLocation,
            worktreeId: repairedWorktreeId,
            panelIds: finalPanelIds,
            activeTabId,
          });
        }

        // Normalize panel locations and worktreeIds to match their group (skip trashed panels)
        set((state) => {
          let terminalsUpdated = false;
          const newTerminals = state.terminals.map((t) => {
            // Skip trashed panels - they should not be normalized
            if (t.location === "trash" || state.trashedTerminals.has(t.id)) {
              return t;
            }

            // Find which group this panel belongs to
            for (const group of sanitizedGroups.values()) {
              if (group.panelIds.includes(t.id)) {
                // Panel is in a group - ensure location and worktreeId match
                const needsLocationUpdate = t.location !== group.location;
                const needsWorktreeUpdate =
                  (t.worktreeId ?? undefined) !== (group.worktreeId ?? undefined);

                if (needsLocationUpdate || needsWorktreeUpdate) {
                  terminalsUpdated = true;
                  if (needsLocationUpdate) {
                    console.log(
                      `[TabGroup] Hydration: Normalizing panel ${t.id} location from ${t.location} to ${group.location}`
                    );
                  }
                  if (needsWorktreeUpdate) {
                    console.log(
                      `[TabGroup] Hydration: Normalizing panel ${t.id} worktreeId from ${t.worktreeId} to ${group.worktreeId}`
                    );
                  }
                  return {
                    ...t,
                    location: group.location,
                    worktreeId: group.worktreeId,
                    isVisible: group.location === "grid",
                    runtimeStatus: deriveRuntimeStatus(
                      group.location === "grid",
                      t.flowStatus,
                      t.runtimeStatus
                    ),
                  };
                }
                break;
              }
            }
            return t;
          });

          if (terminalsUpdated) {
            saveTerminals(newTerminals);
          }
          // Skip persistence if this is an error-recovery clear
          if (!options?.skipPersist) {
            saveTabGroups(sanitizedGroups);
          }
          return { terminals: newTerminals, tabGroups: sanitizedGroups };
        });

        console.log(`[TabGroup] Hydration complete: ${sanitizedGroups.size} groups restored`);
      },

      // @deprecated - kept for backward compatibility during migration
      setTabGroupInfo: (_id, _tabGroupId, _orderInGroup) => {
        console.warn(
          "[TabGroup] setTabGroupInfo is deprecated. Use createTabGroup/addPanelToGroup instead."
        );
        // This method is now a no-op as we've normalized the data model
        // The UI should use createTabGroup and addPanelToGroup
      },
    }))(createTrashExpiryHelpers(get, set));
