import type { TerminalRuntimeStatus } from "@/types";
import type {
  TerminalRegistryStoreApi,
  TerminalRegistrySlice,
  TerminalRegistryMiddleware,
  TerminalInstance,
} from "./types";
import { terminalClient, projectClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { isRegisteredAgent } from "@/config/agents";
import { panelKindHasPty, panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { useScrollbackStore } from "@/store/scrollbackStore";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { usePerformanceModeStore } from "@/store/performanceModeStore";
import { useTerminalFontStore } from "@/store/terminalFontStore";
import { getScrollbackForType, PERFORMANCE_MODE_SCROLLBACK } from "@/utils/scrollbackConfig";
import { getXtermOptions } from "@/config/xtermConfig";
import { useScreenReaderStore } from "@/store/screenReaderStore";
import { useTerminalColorSchemeStore } from "@/store/terminalColorSchemeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { usePanelLimitStore, evaluatePanelLimit } from "@/store/panelLimitStore";
import { useNotificationStore } from "@/store/notificationStore";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import {
  deriveRuntimeStatus,
  getDefaultTitle,
  DOCK_TERM_WIDTH,
  DOCK_TERM_HEIGHT,
  DOCK_PREWARM_WIDTH_PX,
  DOCK_PREWARM_HEIGHT_PX,
  stopDevPreviewByPanelId,
} from "./helpers";
import type { TrashExpiryHelpers } from "./trash";
import { logDebug, logWarn, logError } from "@/utils/logger";

// Lazy accessor to break circular dependency: core -> projectStore -> terminalPersistence -> core.
// Resolved on first call (after app init), then cached.
let _cachedProjectStore: typeof import("@/store/projectStore").useProjectStore | null = null;
async function resolveProjectStore() {
  if (!_cachedProjectStore) {
    const mod = await import("@/store/projectStore");
    _cachedProjectStore = mod.useProjectStore;
  }
  return _cachedProjectStore;
}

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

function countNonTrashTerminals(state: TerminalRegistrySlice): number {
  let count = 0;
  for (const id of state.terminalIds) {
    if (state.terminalsById[id]?.location !== "trash") count++;
  }
  return count;
}

function countGridTerminals(state: TerminalRegistrySlice, targetWorktreeId: string | null): number {
  let count = 0;
  for (const id of state.terminalIds) {
    const t = state.terminalsById[id];
    if (
      t &&
      (t.location === "grid" || t.location === undefined) &&
      (t.worktreeId ?? null) === targetWorktreeId
    )
      count++;
  }
  return count;
}

export const createCorePanelActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer }: TrashExpiryHelpers,
  middleware?: TerminalRegistryMiddleware
): Pick<
  TerminalRegistrySlice,
  | "addTerminal"
  | "removeTerminal"
  | "updateTitle"
  | "updateAgentState"
  | "updateActivity"
  | "updateLastCommand"
  | "updateVisibility"
  | "getTerminal"
  | "moveTerminalToDock"
  | "moveTerminalToGrid"
  | "toggleTerminalLocation"
> => ({
  addTerminal: async (options) => {
    // Panel limit enforcement (Tier 2: confirmation, Tier 3: hard block)
    if (!options.bypassLimits) {
      const {
        softWarningLimit,
        confirmationLimit,
        hardLimit,
        warningsDisabled,
        requestConfirmation,
      } = usePanelLimitStore.getState();
      const globalCount = countNonTrashTerminals(get());
      const tier = evaluatePanelLimit(globalCount, {
        softWarningLimit,
        confirmationLimit,
        hardLimit,
      });

      if (tier === "hard") {
        useNotificationStore.getState().addNotification({
          type: "warning",
          priority: "high",
          title: "Panel limit reached",
          message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
          duration: 5000,
        });
        return null;
      }

      if (tier === "confirm" && !warningsDisabled) {
        let memoryMB: number | null = null;
        try {
          const metrics = await import("@/clients").then((m) => m.systemClient.getAppMetrics());
          memoryMB = metrics.totalMemoryMB;
        } catch {
          // Memory info unavailable
        }

        const confirmed = await requestConfirmation(globalCount, memoryMB);
        if (!confirmed) return null;

        // Re-check count after confirmation in case panels were closed during the dialog
        const postConfirmCount = countNonTrashTerminals(get());
        if (postConfirmCount >= hardLimit) {
          useNotificationStore.getState().addNotification({
            type: "warning",
            priority: "high",
            title: "Panel limit reached",
            message: `Maximum of ${hardLimit} panels reached. Close some panels before adding new ones.`,
            duration: 5000,
          });
          return null;
        }
      }
    }

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
      const currentGridCount = countGridTerminals(get(), targetWorktreeId);
      const requestedLocation = options.location || "grid";
      const location =
        requestedLocation === "grid" && currentGridCount >= maxCapacity
          ? "dock"
          : requestedLocation;
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      const isInActiveWorktree = (options.worktreeId ?? null) === (activeWorktreeId ?? null);
      const shouldBackground = location === "dock" || (location === "grid" && !isInActiveWorktree);
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
          extensionState: options.extensionState,
          browserUrl: options.browserUrl || "http://localhost:3000",
          browserHistory: options.browserHistory,
          browserZoom: options.browserZoom,
          browserConsoleOpen: options.browserConsoleOpen,
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
          extensionState: options.extensionState,
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
          extensionState: options.extensionState,
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
          extensionState: options.extensionState,
          type: "terminal" as const,
          cwd: "",
          cols: 80,
          rows: 24,
        };
      }

      set((state) => {
        const existing = state.terminalsById[id];
        if (existing) {
          logDebug("[TerminalStore] Panel already exists, updating instead of adding", { id });
          const newById = { ...state.terminalsById, [id]: terminal };
          saveNormalized(newById, state.terminalIds);
          return { terminalsById: newById };
        }
        const newById = { ...state.terminalsById, [id]: terminal };
        const newIds = [...state.terminalIds, id];
        saveNormalized(newById, newIds);
        return { terminalsById: newById, terminalIds: newIds };
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
      const state = get();
      const gridTerminalIds: string[] = [];
      for (const tid of state.terminalIds) {
        const t = state.terminalsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }
      const tabGroups = state.tabGroups;
      const panelsInGroups = new Set<string>();
      const explicitGroups = new Set<string>();

      // Count explicit groups in this location/worktree
      for (const group of tabGroups.values()) {
        if (group.location === "grid" && (group.worktreeId ?? null) === targetWorktreeId) {
          explicitGroups.add(group.id);
          group.panelIds.forEach((gid) => panelsInGroups.add(gid));
        }
      }

      // Count ungrouped panels (each is its own virtual group)
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid)) {
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
    // When activeWorktreeId is null (worktree store not yet hydrated — common during
    // project switch), treat the terminal as being in the active worktree to avoid
    // incorrectly backgrounding it. applyWorktreeTerminalPolicy will reconcile
    // tiers once the worktree is set.
    const isInActiveWorktree =
      activeWorktreeId === null || (options.worktreeId ?? null) === (activeWorktreeId ?? null);
    const shouldBackground = location === "dock" || (location === "grid" && !isInActiveWorktree);
    const runtimeStatus: TerminalRuntimeStatus = shouldBackground ? "background" : "running";

    // Capture project ID synchronously before any async work to avoid race conditions
    // if the user switches projects during async operations (issue #3690).
    // resolveProjectStore() is cached after first call, so subsequent calls resolve immediately.
    const projectStore = await resolveProjectStore();
    const capturedProjectId = projectStore.getState().currentProject?.id;

    // Fetch project environment variables and merge with spawn options
    // Precedence: spawn-time env > project env (spawn-time overrides project)
    let mergedEnv: Record<string, string> | undefined = options.env;
    try {
      if (capturedProjectId) {
        const projectSettings = await projectClient.getSettings(capturedProjectId);
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
      logWarn("[TerminalStore] Failed to fetch project environment variables", { error });
    }

    try {
      let id: string;

      if (options.existingId) {
        // Reconnecting to existing backend process - don't spawn new
        id = options.existingId;
        logDebug("[TerminalStore] Reconnecting to existing terminal", { id });
      } else {
        // Spawn new process - only execute command if not skipping
        const commandToExecute = options.skipCommandExecution ? undefined : options.command;
        id = await terminalClient.spawn({
          id: options.requestedId,
          projectId: capturedProjectId,
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
          restore: options.restore,
          agentLaunchFlags: options.agentLaunchFlags,
          agentModelId: options.agentModelId,
        });
      }

      // Prewarm renderer-side xterm immediately so we never drop startup output/ANSI while hidden.
      // For docked terminals, also open + fit offscreen so the PTY starts with correct dimensions.
      try {
        const { scrollbackLines } = useScrollbackStore.getState();
        const { performanceMode } = usePerformanceModeStore.getState();
        const { fontSize, fontFamily } = useTerminalFontStore.getState();

        // Project-level scrollback override for non-agent terminals
        const projectScrollback =
          kind !== "agent"
            ? useProjectSettingsStore.getState().settings?.terminalSettings?.scrollbackLines
            : undefined;

        const effectiveScrollback = performanceMode
          ? PERFORMANCE_MODE_SCROLLBACK
          : getScrollbackForType(legacyType, projectScrollback ?? scrollbackLines);

        const { getEffectiveTheme } = useTerminalColorSchemeStore.getState();
        const screenReaderMode = useScreenReaderStore.getState().resolvedScreenReaderEnabled();
        const terminalOptions = getXtermOptions({
          fontSize,
          fontFamily,
          scrollback: effectiveScrollback,
          performanceMode,
          theme: getEffectiveTheme(),
          screenReaderMode,
        });

        // Prewarm ALL terminal types to ensure managed instance exists.
        // This is critical for terminals in inactive worktrees - they need a managed
        // instance for proper BACKGROUND→VISIBLE tier transitions when worktree activates.
        const currentActiveWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        // When activeWorktreeId is null (hydration in progress), don't treat the
        // terminal as offscreen — it would be prewarmed in the offscreen container
        // at -20000px and backgrounded, suppressing data flow from the pty-host.
        const offscreenOrInactive =
          location === "dock" ||
          (currentActiveWorktreeId !== null &&
            (options.worktreeId ?? null) !== (currentActiveWorktreeId ?? null));

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

          // For offscreen/inactive agents, prewarmTerminal's fit() already handles
          // initial PTY resize through settled strategy. Only send explicit resize
          // for active grid spawns where fit() is skipped.
          if (!offscreenOrInactive) {
            const cellWidth = Math.max(6, Math.floor(fontSize * 0.6));
            const cellHeight = Math.max(10, Math.floor(fontSize * 1.1));
            const cols = Math.max(20, Math.min(500, Math.floor(widthPx / cellWidth)));
            const rows = Math.max(10, Math.min(200, Math.floor(heightPx / cellHeight)));
            terminalInstanceService.sendPtyResize(id, cols, rows);
          }
        }
      } catch (error) {
        logWarn("[TerminalStore] Failed to prewarm terminal", { id, error });
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
        agentSessionId: options.agentSessionId,
        agentLaunchFlags: options.agentLaunchFlags,
        agentModelId: options.agentModelId,
        extensionState: options.extensionState,
        spawnedBy: options.spawnedBy,
        startedAt: Date.now(),
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
        const existing = state.terminalsById[id];
        if (existing) {
          // Update existing terminal in place (reconnection case or double hydration)
          logDebug("[TerminalStore] Terminal already exists, updating instead of adding", { id });
          // Preserve existing agentState/lastStateChange/exitBehavior if new values are undefined
          const preservedTerminal = isReconnect
            ? {
                ...terminal,
                agentState: terminal.agentState ?? existing.agentState,
                lastStateChange: terminal.lastStateChange ?? existing.lastStateChange,
                exitBehavior: terminal.exitBehavior ?? existing.exitBehavior,
                extensionState: terminal.extensionState ?? existing.extensionState,
              }
            : terminal;
          const newById = { ...state.terminalsById, [id]: preservedTerminal };
          saveNormalized(newById, state.terminalIds);
          return { terminalsById: newById };
        }
        const newById = { ...state.terminalsById, [id]: terminal };
        const newIds = [...state.terminalIds, id];
        saveNormalized(newById, newIds);
        return { terminalsById: newById, terminalIds: newIds };
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
      logError("[TerminalStore] Failed to spawn terminal", error);
      throw error;
    }
  },

  removeTerminal: (id) => {
    clearTrashExpiryTimer(id);
    const state = get();
    const removedIndex = state.terminalIds.indexOf(id);
    const terminal = state.terminalsById[id];

    if (terminal?.kind === "dev-preview") {
      stopDevPreviewByPanelId(id);
    }

    // Only call PTY operations for PTY-backed terminals
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalClient.kill(id).catch((error) => {
        logError("[TerminalStore] Failed to kill terminal", error);
      });

      terminalInstanceService.destroy(id);
    }

    set((state) => {
      const { [id]: _, ...restById } = state.terminalsById;
      const newIds = state.terminalIds.filter((tid) => tid !== id);

      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.delete(id);

      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.delete(id);

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

      saveNormalized(restById, newIds);
      saveTabGroups(newTabGroups);
      return {
        terminalsById: restById,
        terminalIds: newIds,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    const remainingIds = get().terminalIds;
    middleware?.onTerminalRemoved?.(id, removedIndex, remainingIds, terminal);
  },

  updateTitle: (id, newTitle) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      const effectiveTitle =
        newTitle.trim() || getDefaultTitle(terminal.kind, terminal.type, terminal.agentId);
      const newById = { ...state.terminalsById, [id]: { ...terminal, title: effectiveTitle } };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  updateAgentState: (
    id,
    agentState,
    error,
    lastStateChange,
    trigger,
    confidence,
    waitingReason,
    sessionCost,
    sessionTokens
  ) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) {
        logWarn("[TerminalStore] Cannot update agent state: terminal not found", { id });
        return state;
      }

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: {
            ...terminal,
            agentState,
            error,
            lastStateChange: lastStateChange ?? Date.now(),
            stateChangeTrigger: trigger,
            stateChangeConfidence: confidence,
            waitingReason: agentState === "waiting" ? waitingReason : undefined,
            sessionCost:
              (agentState === "completed" || agentState === "exited") && sessionCost != null
                ? sessionCost
                : agentState === "working"
                  ? undefined
                  : terminal.sessionCost,
            sessionTokens:
              (agentState === "completed" || agentState === "exited") && sessionTokens != null
                ? sessionTokens
                : agentState === "working"
                  ? undefined
                  : terminal.sessionTokens,
          },
        },
      };
    });
  },

  updateActivity: (id, headline, status, type, timestamp, lastCommand) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      if (
        terminal.activityHeadline === headline &&
        terminal.activityStatus === status &&
        terminal.activityType === type &&
        terminal.activityTimestamp === timestamp &&
        terminal.lastCommand === lastCommand
      ) {
        return state;
      }

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: {
            ...terminal,
            activityHeadline: headline,
            activityStatus: status,
            activityType: type,
            activityTimestamp: timestamp,
            lastCommand,
          },
        },
      };
    });
  },

  updateLastCommand: (id, lastCommand) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, lastCommand },
        },
      };
    });
  },

  updateVisibility: (id, isVisible) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;
      if (terminal.isVisible === isVisible) return state;

      const runtimeStatus = deriveRuntimeStatus(
        isVisible,
        terminal.flowStatus,
        terminal.runtimeStatus
      );

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, isVisible, runtimeStatus },
        },
      };
    });
  },

  getTerminal: (id) => {
    return get().terminalsById[id];
  },

  moveTerminalToDock: (id) => {
    // Check if panel is in a group - if so, move the entire group
    const group = get().getPanelGroup(id);
    if (group) {
      get().moveTabGroupToLocation(group.id, "dock");
      return;
    }

    // Single ungrouped panel - move just this panel
    const terminal = get().terminalsById[id];

    set((state) => {
      if (!terminal || terminal.location === "dock") return state;

      const newById = {
        ...state.terminalsById,
        [id]: {
          ...terminal,
          location: "dock" as const,
          isVisible: false,
          runtimeStatus: deriveRuntimeStatus(false, terminal.flowStatus, terminal.runtimeStatus),
        },
      };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
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
      terminal = state.terminalsById[id];
      if (!terminal || terminal.location === "grid") return state;

      const targetWorktreeId = terminal.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      // Check grid capacity - count unique groups (each group = 1 slot)
      const gridTerminalIds: string[] = [];
      for (const tid of state.terminalIds) {
        const t = state.terminalsById[tid];
        if (
          t &&
          (t.location === "grid" || t.location === undefined) &&
          (t.worktreeId ?? null) === targetWorktreeId
        )
          gridTerminalIds.push(tid);
      }

      // Count groups using TabGroup data
      const panelsInGroups = new Set<string>();
      let explicitGroupCount = 0;
      for (const g of state.tabGroups.values()) {
        if (g.location === "grid" && (g.worktreeId ?? null) === targetWorktreeId) {
          explicitGroupCount++;
          g.panelIds.forEach((pid) => panelsInGroups.add(pid));
        }
      }
      // Count ungrouped panels
      let ungroupedCount = 0;
      for (const tid of gridTerminalIds) {
        if (!panelsInGroups.has(tid)) {
          ungroupedCount++;
        }
      }
      if (explicitGroupCount + ungroupedCount >= maxCapacity) {
        return state;
      }

      moveSucceeded = true;
      const newById = {
        ...state.terminalsById,
        [id]: {
          ...terminal!,
          location: "grid" as const,
          isVisible: true,
          runtimeStatus: deriveRuntimeStatus(true, terminal!.flowStatus, terminal!.runtimeStatus),
        },
      };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });

    // Only apply renderer policy for PTY-backed panels if move succeeded
    if (moveSucceeded && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }

    return moveSucceeded;
  },

  toggleTerminalLocation: (id) => {
    const terminal = get().terminalsById[id];
    if (!terminal) return;

    if (terminal.location === "dock") {
      get().moveTerminalToGrid(id);
    } else {
      get().moveTerminalToDock(id);
    }
  },
});
