import type {
  PanelRegistryStoreApi,
  PanelRegistrySlice,
  PanelRegistryMiddleware,
  TerminalInstance,
} from "./types";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { useLayoutConfigStore } from "@/store/layoutConfigStore";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import {
  deriveRuntimeStatus,
  getDefaultTitle,
  removePanelIdsFromTabGroups,
  stopDevPreviewByPanelId,
} from "./helpers";
import type { TrashExpiryHelpers } from "./trash";
import { logError, logWarn } from "@/utils/logger";
import { beginBatch, consumeBatch } from "./hydrationBatch";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

export const createCorePanelActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer }: TrashExpiryHelpers,
  middleware?: PanelRegistryMiddleware
): Pick<
  PanelRegistrySlice,
  | "beginHydrationBatch"
  | "flushHydrationBatch"
  | "removePanel"
  | "updateTitle"
  | "updateLastObservedTitle"
  | "updateAgentState"
  | "updateActivity"
  | "updateLastCommand"
  | "updateVisibility"
  | "getTerminal"
  | "moveTerminalToDock"
  | "moveTerminalToGrid"
  | "toggleTerminalLocation"
> => ({
  beginHydrationBatch: () => beginBatch(),

  flushHydrationBatch: (token) => {
    const pendingIds = consumeBatch(token);
    // Token mismatch means the batch was superseded or already flushed — ignore.
    if (pendingIds === null) return;

    set((state) => {
      // `panelsById` was already updated per panel during the batch, so this
      // final `set` only reveals `panelIds` to subscribers and persists once.
      // Filter: reconnect ids are already in `panelIds`, and a failed addPanel
      // might have been collected but never landed in `panelsById`.
      const existing = new Set(state.panelIds);
      const additions = pendingIds.filter(
        (id) => !existing.has(id) && state.panelsById[id] !== undefined
      );
      const newIds = additions.length > 0 ? [...state.panelIds, ...additions] : state.panelIds;
      saveNormalized(state.panelsById, newIds);
      return additions.length > 0 ? { panelIds: newIds } : {};
    });
  },

  removePanel: (id) => {
    clearTrashExpiryTimer(id);
    const state = get();
    const removedIndex = state.panelIds.indexOf(id);
    const terminal = state.panelsById[id];

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
      const { [id]: _, ...restById } = state.panelsById;
      const newIds = state.panelIds.filter((tid) => tid !== id);

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
        panelsById: restById,
        panelIds: newIds,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    const remainingIds = get().panelIds;
    middleware?.onTerminalRemoved?.(id, removedIndex, remainingIds, terminal);
  },

  updateTitle: (id, newTitle) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const effectiveTitle = newTitle.trim() || getDefaultTitle(terminal.kind, terminal);
      const newById = { ...state.panelsById, [id]: { ...terminal, title: effectiveTitle } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  updateLastObservedTitle: (id, title) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      const trimmed = title.trim();
      if (!trimmed || terminal.lastObservedTitle === trimmed) return state;
      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, lastObservedTitle: trimmed },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
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
      const terminal = state.panelsById[id];
      if (!terminal) {
        logWarn("[TerminalStore] Cannot update agent state: terminal not found", { id });
        return state;
      }

      return {
        panelsById: {
          ...state.panelsById,
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
      const terminal = state.panelsById[id];
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
        panelsById: {
          ...state.panelsById,
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
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, lastCommand },
        },
      };
    });
  },

  updateVisibility: (id, isVisible) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.isVisible === isVisible) return state;

      const runtimeStatus = deriveRuntimeStatus(
        isVisible,
        terminal.flowStatus,
        terminal.runtimeStatus
      );

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, isVisible, runtimeStatus },
        },
      };
    });
  },

  getTerminal: (id) => {
    return get().panelsById[id];
  },

  moveTerminalToDock: (id) => {
    // Check if panel is in a group - if so, move the entire group
    const group = get().getPanelGroup(id);
    if (group) {
      get().moveTabGroupToLocation(group.id, "dock");
      return;
    }

    // Single ungrouped panel - move just this panel
    const terminal = get().panelsById[id];

    set((state) => {
      if (!terminal || terminal.location === "dock") return state;

      const groupPrune = removePanelIdsFromTabGroups(state.tabGroups, new Set([id]));
      const newById = {
        ...state.panelsById,
        [id]: {
          ...terminal,
          location: "dock" as const,
          isVisible: false,
          runtimeStatus: deriveRuntimeStatus(false, terminal.flowStatus, terminal.runtimeStatus),
        },
      };
      saveNormalized(newById, state.panelIds);
      if (groupPrune.changed) {
        saveTabGroups(groupPrune.tabGroups);
      }
      return {
        panelsById: newById,
        ...(groupPrune.changed && { tabGroups: groupPrune.tabGroups }),
      };
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
      terminal = state.panelsById[id];
      if (!terminal || terminal.location === "grid") return state;

      const targetWorktreeId = terminal.worktreeId ?? null;
      const maxCapacity = useLayoutConfigStore.getState().getMaxGridCapacity();
      // Check grid capacity - count unique groups (each group = 1 slot)
      const gridTerminalIds: string[] = [];
      for (const tid of state.panelIds) {
        const t = state.panelsById[tid];
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
      const groupPrune = removePanelIdsFromTabGroups(state.tabGroups, new Set([id]));
      const newById = {
        ...state.panelsById,
        [id]: {
          ...terminal!,
          location: "grid" as const,
          isVisible: true,
          runtimeStatus: deriveRuntimeStatus(true, terminal!.flowStatus, terminal!.runtimeStatus),
        },
      };
      saveNormalized(newById, state.panelIds);
      if (groupPrune.changed) {
        saveTabGroups(groupPrune.tabGroups);
      }
      return {
        panelsById: newById,
        ...(groupPrune.changed && { tabGroups: groupPrune.tabGroups }),
      };
    });

    // Only apply renderer policy for PTY-backed panels if move succeeded
    if (moveSucceeded && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }

    return moveSucceeded;
  },

  toggleTerminalLocation: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;

    if (terminal.location === "dock") {
      get().moveTerminalToGrid(id);
    } else {
      get().moveTerminalToDock(id);
    }
  },
});
