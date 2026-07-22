import type { PanelRegistryStoreApi, PanelRegistrySlice, PanelRegistryMiddleware } from "./types";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance, PanelTitleMode } from "@shared/types/panel";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isDevPreviewPanel } from "@shared/types/panel";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { cancelReconnectErrorDebounce } from "./browser";
import {
  deriveRuntimeStatus,
  getDefaultTitle,
  removePanelIdsFromTabGroups,
  stopDevPreviewByPanelId,
} from "./helpers";
import type { TrashExpiryHelpers } from "./trash";
import { logError, logWarn } from "@/utils/logger";
import {
  beginBatch,
  beginSpawnBatch,
  consumeActiveSpawnBatch,
  consumeBatch,
} from "./hydrationBatch";
import type { HydrationBatchToken } from "./types";
import { removeFromWorktreeIndex, transferBetweenWorktreeIndex } from "./worktreeIndex";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";
import { countPanelsTowardLimit } from "./panelCount";
import { usePanelLimitStore } from "@/store/panelLimitStore";
import { notify } from "@/lib/notify";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

/**
 * Close out a panel's ledger generation on a user-final removal. Marks
 * exactly-once per generation; a spawn still in flight for this incarnation
 * will see the entry closed and route through the compensating-kill path.
 */
function recordLedgerClose(id: string, reason: string): void {
  const generation = agentLifecycleLedger.currentGeneration(id);
  if (generation !== undefined) {
    agentLifecycleLedger.recordClose(id, generation, reason);
  }
}

/**
 * Reveal a batch's collected panel ids in `panelIds` and persist once. The
 * filter drops ids that never landed in `panelsById` (failed addPanel) or are
 * already present (reconnect path).
 */
function commitPendingIds(set: Set, pendingIds: string[]): void {
  if (pendingIds.length === 0) return;

  set((state) => {
    const existing = new Set(state.panelIds);
    const additions = pendingIds.filter(
      (id) => !existing.has(id) && state.panelsById[id] !== undefined
    );
    if (additions.length === 0) return {};
    const newIds = [...state.panelIds, ...additions];
    saveNormalized(state.panelsById, newIds);
    return { panelIds: newIds };
  });
}

/**
 * Close a batch via `consumeBatch` and reveal its panel ids. Shared by both
 * the hydration and spawn batch flushes — the deferred `panelIds` reveal +
 * one-time persist is identical; only how the batch was opened differs. A
 * token mismatch (superseded or already flushed, or a `null` token from
 * `beginSpawnBatch` declining to open a nested batch) is a no-op.
 */
function applyBatchFlush(set: Set, token: HydrationBatchToken | null): void {
  const pendingIds = consumeBatch(token);
  if (pendingIds === null) return;
  commitPendingIds(set, pendingIds);
}

export const createCorePanelActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer }: TrashExpiryHelpers,
  middleware?: PanelRegistryMiddleware
): Pick<
  PanelRegistrySlice,
  | "beginHydrationBatch"
  | "flushHydrationBatch"
  | "beginSpawnBatch"
  | "flushSpawnBatch"
  | "removePanel"
  | "updateTitle"
  | "updateLastObservedTitle"
  | "updateAgentState"
  | "updateActivity"
  | "updateLastCommand"
  | "updateVisibility"
  | "stampLastActive"
  | "getTerminal"
  | "moveTerminalToDock"
  | "moveTerminalToGrid"
  | "promoteDialogPanelToGrid"
  | "toggleTerminalLocation"
  | "emptyTrash"
> => ({
  beginHydrationBatch: () => {
    // If a spawn batch is mid-flight when hydration starts (e.g. a recipe
    // running during a project switch), commit its collected ids first.
    // Otherwise the new hydration token would invalidate the spawn token —
    // the spawn caller's `flushSpawnBatch` would see the mismatch and no-op,
    // leaving the spawn's panels orphaned in `panelsById`. A stale prior
    // hydration is intentionally NOT inherited (its panels came from a
    // project the user is leaving — see #5196). The cross-project case is
    // safe: `clearTerminalStoreForSwitch` calls `resetBatchState` first, so
    // any pending ids drop out at the `panelsById[id] !== undefined` filter
    // in `commitPendingIds`. (#9165)
    const orphaned = consumeActiveSpawnBatch();
    if (orphaned !== null) commitPendingIds(set, orphaned);
    return beginBatch();
  },

  flushHydrationBatch: (token) => applyBatchFlush(set, token),

  beginSpawnBatch: () => beginSpawnBatch(),

  flushSpawnBatch: (token) => applyBatchFlush(set, token),

  removePanel: (id) => {
    clearTrashExpiryTimer(id);
    cancelReconnectErrorDebounce(id);
    const state = get();
    const removedIndex = state.panelIds.indexOf(id);
    const terminal = state.panelsById[id];

    if (terminal?.kind === "dev-preview") {
      stopDevPreviewByPanelId(id);
    }

    // Only call PTY operations for PTY-backed terminals
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      recordLedgerClose(id, "removed");
      terminalClient.kill(id).catch((error) => {
        logError("[TerminalStore] Failed to kill terminal", error);
      });

      terminalInstanceService.destroy(id);
    }

    set((state) => {
      const { [id]: _, ...restById } = state.panelsById;
      const newIds = state.panelIds.filter((tid) => tid !== id);
      const newIndex = removeFromWorktreeIndex(
        state.panelIdsByWorktreeId,
        terminal?.worktreeId,
        id
      );

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
        panelIdsByWorktreeId: newIndex,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    const remainingIds = get().panelIds;
    middleware?.onTerminalRemoved?.(id, removedIndex, remainingIds, terminal);
  },

  emptyTrash: (ids) => {
    if (ids.length === 0) return;

    const idSet = new Set(ids);
    const state = get();

    for (const id of idSet) {
      clearTrashExpiryTimer(id);
      cancelReconnectErrorDebounce(id);
      const terminal = state.panelsById[id];
      if (!terminal) continue;

      if (isDevPreviewPanel(terminal)) {
        stopDevPreviewByPanelId(id);
      }

      if (panelKindHasPty(terminal.kind ?? "terminal")) {
        recordLedgerClose(id, "trash-emptied");
        terminalClient.kill(id).catch((error) => {
          logError("[TerminalStore] Failed to kill terminal", error);
        });
        terminalInstanceService.destroy(id);
      }
    }

    set((state) => {
      const newById = { ...state.panelsById };
      for (const id of idSet) {
        delete newById[id];
      }

      const newIds = state.panelIds.filter((tid) => !idSet.has(tid));

      let newWorktreeIndex = state.panelIdsByWorktreeId;
      for (const id of idSet) {
        const terminal = state.panelsById[id];
        if (terminal) {
          newWorktreeIndex = removeFromWorktreeIndex(newWorktreeIndex, terminal.worktreeId, id);
        }
      }

      const newTrashed = new Map(state.trashedTerminals);
      for (const id of idSet) {
        newTrashed.delete(id);
      }

      const newBackgrounded = new Map(state.backgroundedTerminals);
      for (const id of idSet) {
        newBackgrounded.delete(id);
      }

      const { tabGroups: newTabGroups } = removePanelIdsFromTabGroups(state.tabGroups, idSet);

      saveNormalized(newById, newIds);
      saveTabGroups(newTabGroups);
      return {
        panelsById: newById,
        panelIds: newIds,
        panelIdsByWorktreeId: newWorktreeIndex,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    for (const id of idSet) {
      const removedIndex = state.panelIds.indexOf(id);
      middleware?.onTerminalRemoved?.(id, removedIndex, get().panelIds, state.panelsById[id]);
    }
  },

  updateTitle: (id, newTitle, source = "user") => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      // Ownership ladder: a human-set title ("user") outranks automation
      // (MCP/assistant renames), which outranks identity-derived defaults.
      const currentMode = terminal.titleMode ?? "default";
      if (source === "automation" && currentMode === "user") return state;

      const trimmed = newTitle.trim();
      // Empty rename resets to the identity-derived default and unlocks.
      const nextMode: PanelTitleMode = trimmed
        ? source === "user"
          ? "user"
          : "custom"
        : "default";
      const effectiveTitle = trimmed || getDefaultTitle(terminal.kind, terminal);
      if (terminal.title === effectiveTitle && currentMode === nextMode) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, title: effectiveTitle, titleMode: nextMode },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  updateLastObservedTitle: (id, title) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
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
      if (!isPtyPanel(terminal)) return state;

      // Equality short-circuit: skip the write (and crucially `lastStateChange`)
      // when no user-visible field changed. `lastStateChange` gates the
      // window-blur badge filter (useTerminalSelectors) and the elapsed-time
      // header display (TerminalHeaderContent) — bumping it on duplicate
      // events would falsely reset both. `stateChangeTrigger` is included
      // because the optimistic controller path (TerminalAgentStateController
      // onEnterPressed) writes `agentState:"working"` with no trigger, then the
      // backend confirmation arrives with `trigger:"input"`; without comparing
      // trigger here the confirmation would be suppressed and HybridInputBar
      // would never see `agentHasLifecycleEvent === true`. See #8592.
      const nextWaitingReason = agentState === "waiting" ? waitingReason : undefined;
      if (
        terminal.agentState === agentState &&
        terminal.error === error &&
        terminal.waitingReason === nextWaitingReason &&
        terminal.stateChangeTrigger === trigger
      ) {
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
            waitingReason: nextWaitingReason,
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

  updateActivity: (id, headline, status, type, lastCommand) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;

      if (
        terminal.activityHeadline === headline &&
        terminal.activityStatus === status &&
        terminal.activityType === type &&
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
            lastCommand,
          },
        },
      };
    });
  },

  updateLastCommand: (id, lastCommand) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      if (terminal.lastCommand === lastCommand) return state;

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

      if (isPtyPanel(terminal)) {
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
      }

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, isVisible },
        },
      };
    });
  },

  stampLastActive: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, lastActiveAt: Date.now() },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  getTerminal: (id) => {
    return get().panelsById[id];
  },

  moveTerminalToDock: (id) => {
    // Overlay panels (the Daintree Assistant) self-manage their placement and
    // must never be relocated into the dock by a layout action (#9699).
    // Dialog panels are owned by their modal host on the same grounds.
    const dockSourceLocation = get().panelsById[id]?.location;
    if (dockSourceLocation === "overlay" || dockSourceLocation === "dialog") return;

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
      const updatedPanel = isPtyPanel(terminal)
        ? {
            ...terminal,
            location: "dock" as const,
            isVisible: false,
            runtimeStatus: deriveRuntimeStatus(false, terminal.flowStatus, terminal.runtimeStatus),
          }
        : { ...terminal, location: "dock" as const, isVisible: false };
      const newById = { ...state.panelsById, [id]: updatedPanel };
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
    // Overlay panels (the Daintree Assistant) self-manage their placement and
    // must never be relocated into the grid by a layout action (#9699).
    // Dialog panels are ephemeral and uncounted, so promoting one is an
    // admission decision, not a move: it goes through
    // `promoteDialogPanelToGrid`, which re-checks the panel limit.
    const gridSourceLocation = get().panelsById[id]?.location;
    if (gridSourceLocation === "overlay" || gridSourceLocation === "dialog") return false;

    // Check if panel is in a group - if so, move the entire group
    const group = get().getPanelGroup(id);
    if (group) {
      return get().moveTabGroupToLocation(group.id, "grid");
    }

    // Single ungrouped panel - move just this panel
    let moveSucceeded = false;
    let terminal: PanelInstance | undefined;

    // A worktree-less dock panel is visible in every worktree's dock, but the
    // grid renders only the active worktree's index bucket — landing there
    // without a worktreeId strands it off-screen (#11290). Promotion adopts
    // the active worktree; a real existing attribution is never changed.
    const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
    let backfilledWorktreeId: string | null = null;

    set((state) => {
      terminal = state.panelsById[id];
      if (!terminal || terminal.location === "grid") return state;

      // Scrollable grid (#8805): no screen-fit cap — moves to grid always
      // succeed, the grid scrolls vertically to absorb additional panels.
      moveSucceeded = true;
      const groupPrune = removePanelIdsFromTabGroups(state.tabGroups, new Set([id]));
      const t = terminal!;
      const adoptedWorktreeId =
        t.worktreeId == null && activeWorktreeId !== null ? activeWorktreeId : null;
      backfilledWorktreeId = adoptedWorktreeId;
      const updatedPanel = isPtyPanel(t)
        ? {
            ...t,
            ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
            location: "grid" as const,
            isVisible: true,
            runtimeStatus: deriveRuntimeStatus(true, t.flowStatus, t.runtimeStatus),
          }
        : {
            ...t,
            ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
            location: "grid" as const,
            isVisible: true,
          };
      const newById = { ...state.panelsById, [id]: updatedPanel };
      saveNormalized(newById, state.panelIds);
      if (groupPrune.changed) {
        saveTabGroups(groupPrune.tabGroups);
      }
      return {
        panelsById: newById,
        ...(adoptedWorktreeId !== null && {
          panelIdsByWorktreeId: transferBetweenWorktreeIndex(
            state.panelIdsByWorktreeId,
            t.worktreeId,
            adoptedWorktreeId,
            id
          ),
        }),
        ...(groupPrune.changed && { tabGroups: groupPrune.tabGroups }),
      };
    });

    // A user-initiated promotion is explicit worktree attribution — recorded
    // so later cwd-based inference can never silently re-home the panel.
    if (backfilledWorktreeId !== null) {
      const ledgerGeneration = agentLifecycleLedger.currentGeneration(id);
      if (ledgerGeneration !== undefined) {
        agentLifecycleLedger.recordWorktreeAttribution(
          id,
          ledgerGeneration,
          backfilledWorktreeId,
          "explicit"
        );
      }
    }

    // Only apply renderer policy for PTY-backed panels if move succeeded
    if (moveSucceeded && terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
    }

    return moveSucceeded;
  },

  promoteDialogPanelToGrid: (id) => {
    // Read the ceiling before the updater so the commit stays synchronous and
    // the whole promotion lands in one atomic `set()` (#6596): a create-then-
    // activate split lets a reconciler observe the half-formed record.
    const { hardLimit } = usePanelLimitStore.getState();
    let promoted = false;
    let atLimit = false;

    set((state) => {
      // Re-read inside the updater: the panel may have been closed or already
      // promoted between the host's click handler and this commit.
      const panel = state.panelsById[id];
      if (!panel || panel.location !== "dialog") return state;

      // The dialog panel was never counted, so promoting it admits a genuinely
      // new panel — the same hard ceiling `addPanel` enforces applies. Only the
      // hard tier blocks: the confirm band is reserved for batch spawns
      // (#10547), and a single promotion is one click to undo.
      if (hardLimit > 0 && countPanelsTowardLimit(state.panelsById, state.panelIds) >= hardLimit) {
        atLimit = true;
        return state;
      }

      // Drop `excludeFromPersistence` rather than setting it false: the field is
      // optional, and a lingering `false` would read as a deliberate opt-in.
      const { excludeFromPersistence: _ephemeral, ...persistable } = panel;
      const updatedPanel = {
        ...persistable,
        location: "grid" as const,
        isVisible: true,
      } as PanelInstance;

      const newById = { ...state.panelsById, [id]: updatedPanel };
      saveNormalized(newById, state.panelIds);
      promoted = true;
      return { panelsById: newById };
    });

    if (atLimit) {
      notify({
        type: "warning",
        priority: "high",
        title: "Panel limit reached",
        message: `Maximum of ${hardLimit} panels reached. Close some panels before opening this file as a panel.`,
        duration: 5000,
        // Direct feedback on a click the user just made — it has to reach them
        // where they are, which is the open dialog.
        context: { eventKind: "uiFeedback" },
      });
    }

    return promoted;
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
