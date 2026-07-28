import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { TrashExpiryHelpers } from "./trash";
import { getNarrowPanel } from "./selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import {
  panelKindHasPty,
  normalizeDockLocation,
  normalizeGroupDockLocation,
} from "@shared/config/panelKindRegistry";
import { isDevPreviewPanel, isPtyPanel, type PanelKind } from "@shared/types/panel";
import { TRASH_TTL_MS } from "@shared/config/trash";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { cancelReconnectErrorDebounce } from "./browser";
import {
  stopDevPreviewByPanelId,
  dissolvePanelFromGroup,
  computeRestoredTabGroup,
} from "./helpers";
import { logError } from "@/utils/logger";
import { transferBetweenWorktreeIndex } from "./worktreeIndex";
import { getWorktreeSelectionSnapshot } from "@/store/storeAccessors";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

export const createTrashActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer, scheduleTrashExpiry }: TrashExpiryHelpers
): Pick<
  PanelRegistrySlice,
  | "trashPanel"
  | "trashPanelGroup"
  | "restoreTerminal"
  | "restoreTrashedGroup"
  | "markAsTrashed"
  | "markAsRestored"
  | "isInTrash"
> => {
  const trashPanel: PanelRegistrySlice["trashPanel"] = (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;

    // Drop any pending reconnect-error debounce so a stale write can't land on
    // a panel that's been moved to trash (and reappear when the user undoes).
    cancelReconnectErrorDebounce(id);

    // Remove-on-exit panels (e.g. the help-panel assistant terminal) are bound
    // to a transient UI surface and must never linger in trash for the TTL
    // window — they bypass the trash flow and are removed outright. Dialog
    // panels are ephemeral on the same grounds: trashing one would record a
    // bogus "grid" restore target below and leave it undoable back into the
    // grid after its modal is gone.
    if (
      (isPtyPanel(terminal) && terminal.removeOnExit === true) ||
      terminal.location === "dialog"
    ) {
      get().removePanel(id);
      return;
    }

    const expiresAt = Date.now() + TRASH_TTL_MS;

    if (isDevPreviewPanel(terminal)) {
      stopDevPreviewByPanelId(id);
    }

    // Resolve original location: if backgrounded, use stored original; otherwise use current
    const backgroundedInfo = get().backgroundedTerminals.get(id);
    const originalLocation: "dock" | "grid" = backgroundedInfo
      ? backgroundedInfo.originalLocation
      : terminal.location === "dock"
        ? "dock"
        : "grid";

    // Only call PTY operations for PTY-backed terminals
    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalClient.trash(id).catch((error) => {
        logError("Failed to trash terminal", error);
      });
    }

    set((state) => {
      const existing = state.panelsById[id];
      if (!existing) return state;
      const newById: Record<string, CarrierPanel> = {
        ...state.panelsById,
        [id]: { ...existing, location: "trash" as const },
      };
      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.set(id, { id, expiresAt, originalLocation });

      const dissolved = dissolvePanelFromGroup(state.tabGroups, id);
      const newTabGroups = dissolved.tabGroups;
      if (dissolved.dissolved) {
        saveTabGroups(newTabGroups);
      }

      // Clear backgrounded metadata if trashing from background
      let newBackgrounded = state.backgroundedTerminals;
      if (state.backgroundedTerminals.has(id)) {
        newBackgrounded = new Map(state.backgroundedTerminals);
        newBackgrounded.delete(id);
      }

      saveNormalized(newById, state.panelIds);
      return {
        panelsById: newById,
        trashedTerminals: newTrashed,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    scheduleTrashExpiry(id, expiresAt);

    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      return;
    }
  };

  const trashPanelGroup: PanelRegistrySlice["trashPanelGroup"] = (panelId) => {
    // Find the group this panel belongs to
    const group = get().getPanelGroup(panelId);

    // If no group, fall back to single panel trash. Call the registry's own
    // implementation directly — `get().trashPanel` resolves to the wrapped
    // store-level dispatch, which would re-fire the undo toast already
    // emitted by the wrapped `trashPanelGroup` caller.
    if (!group) {
      trashPanel(panelId);
      return;
    }

    const expiresAt = Date.now() + TRASH_TTL_MS;
    const groupRestoreId = `group-${crypto.randomUUID()}`;
    const panelIds = [...group.panelIds];
    const activeTabId = group.activeTabId ?? panelIds[0] ?? "";
    const state = get();

    // Filter to existing panels and validate at least one exists
    const existingPanelIds = panelIds.filter((id) => state.panelsById[id]);
    if (existingPanelIds.length === 0) {
      set((state) => {
        const newTabGroups = new Map(state.tabGroups);
        newTabGroups.delete(group.id);
        saveTabGroups(newTabGroups);
        return { tabGroups: newTabGroups };
      });
      return;
    }

    const trashPanelIds = existingPanelIds;

    for (const id of trashPanelIds) {
      cancelReconnectErrorDebounce(id);
    }

    const resolvedActiveTabId = trashPanelIds.includes(activeTabId)
      ? activeTabId
      : (trashPanelIds[0] ?? "");

    const originalLocation: "dock" | "grid" = group.location === "dock" ? "dock" : "grid";
    const worktreeId = group.worktreeId ?? null;

    // Trash PTY processes for all PTY-backed panels
    for (const id of trashPanelIds) {
      const terminal = state.panelsById[id];
      if (terminal && isDevPreviewPanel(terminal)) {
        stopDevPreviewByPanelId(id);
        continue;
      }
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalClient.trash(id).catch((error) => {
          logError("Failed to trash terminal", error);
        });
      }
    }

    set((state) => {
      const newById: Record<string, CarrierPanel> = { ...state.panelsById };
      for (const tid of trashPanelIds) {
        const current = newById[tid];
        if (current) {
          newById[tid] = { ...current, location: "trash" as const };
        }
      }

      const newTrashed = new Map(state.trashedTerminals);

      // Store groupMetadata on every member, not just an anchor. If any single
      // member is removed before restore (expiry, individual deletion, hydration
      // loss), the surviving members still carry the full restore metadata so
      // ordering and the active tab are preserved. See issue #8944.
      for (const id of trashPanelIds) {
        newTrashed.set(id, {
          id,
          expiresAt,
          originalLocation,
          groupRestoreId,
          groupMetadata: {
            panelIds: [...trashPanelIds],
            activeTabId: resolvedActiveTabId,
            location: group.location,
            worktreeId,
          },
        });
      }

      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.delete(group.id);
      saveTabGroups(newTabGroups);

      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, trashedTerminals: newTrashed, tabGroups: newTabGroups };
    });

    for (const id of trashPanelIds) {
      scheduleTrashExpiry(id, expiresAt);
    }

    for (const id of trashPanelIds) {
      const terminal = state.panelsById[id];
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    }
  };

  return {
    trashPanel,
    trashPanelGroup,

    restoreTerminal: (id, targetWorktreeId) => {
      clearTrashExpiryTimer(id);
      const trashedInfo = get().trashedTerminals.get(id);
      const rawRestoreLocation = trashedInfo?.originalLocation ?? "grid";
      const terminal = get().panelsById[id];
      // Normalize a persisted dock location to grid if the kind is no longer
      // dockable (#11375) — the dock filters it out, so it would strand while
      // `location:"dock"` also keeps it out of the grid. `restoreTerminal`'s
      // wrapper (panelStore.ts) then correctly treats a rescued panel as a
      // visible grid panel for focus, instead of focusing an invisible one.
      const restoreLocation = normalizeDockLocation(terminal?.kind, rawRestoreLocation);
      const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalClient.restore(id).catch((error) => {
          logError("Failed to restore terminal", error);
        });
      }

      set((state) => {
        const t = state.panelsById[id];
        if (!t) return state;
        // A worktree-less panel rescued dock→grid adopts the active worktree so
        // it lands in a visible bucket rather than the global-only one (#11290).
        const rescuedToGrid = restoreLocation === "grid" && rawRestoreLocation === "dock";
        const nextWorktreeId =
          targetWorktreeId !== undefined
            ? targetWorktreeId
            : rescuedToGrid && t.worktreeId == null && activeWorktreeId !== null
              ? activeWorktreeId
              : t.worktreeId;
        const newById = {
          ...state.panelsById,
          [id]: {
            ...t,
            location: restoreLocation,
            worktreeId: nextWorktreeId,
          },
        };
        const newIndex = transferBetweenWorktreeIndex(
          state.panelIdsByWorktreeId,
          t.worktreeId,
          nextWorktreeId,
          id
        );
        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);
        saveNormalized(newById, state.panelIds);
        return {
          panelsById: newById,
          panelIdsByWorktreeId: newIndex,
          trashedTerminals: newTrashed,
        };
      });

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

      const groupPanels: Array<{
        id: string;
        trashed: ReturnType<typeof trashedTerminals.get>;
      }> = [];
      let anchorPanel: ReturnType<typeof trashedTerminals.get> | undefined;

      for (const [id, trashed] of trashedTerminals.entries()) {
        if (trashed.groupRestoreId === groupRestoreId) {
          groupPanels.push({ id, trashed });
          // Metadata is replicated identically across all members (#8944); take
          // the first one found so the restore source is deterministic.
          if (!anchorPanel && trashed.groupMetadata) {
            anchorPanel = trashed;
          }
        }
      }

      if (groupPanels.length === 0) {
        return;
      }

      for (const { id } of groupPanels) {
        clearTrashExpiryTimer(id);
        const terminal = get().panelsById[id];
        if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
          terminalClient.restore(id).catch((error) => {
            logError("Failed to restore terminal", error);
          });
        }
      }

      // A tab group is atomic — normalize a persisted dock location to grid when
      // ANY live member's kind is no longer dockable (#11375), moving the whole
      // group rather than splitting it. Adopt the active worktree when a rescued
      // worktree-less group would otherwise land in the global-only bucket.
      const rawGroupLocation: "grid" | "dock" =
        (anchorPanel?.groupMetadata?.location ?? groupPanels[0]?.trashed?.originalLocation) ===
        "dock"
          ? "dock"
          : "grid";
      const groupMemberKinds: (PanelKind | undefined)[] = [];
      for (const { id } of groupPanels) {
        const t = get().panelsById[id];
        if (t) groupMemberKinds.push(t.kind);
      }
      const restoreLocation = normalizeGroupDockLocation(groupMemberKinds, rawGroupLocation);
      const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;
      const rescuedToGrid = restoreLocation === "grid" && rawGroupLocation === "dock";
      const worktreeId =
        targetWorktreeId !== undefined
          ? targetWorktreeId
          : (anchorPanel?.groupMetadata?.worktreeId ??
            (rescuedToGrid && activeWorktreeId !== null ? activeWorktreeId : undefined));

      set((state) => {
        const panelIdsInGroup = new Set(groupPanels.map(({ id }) => id));
        const newById = { ...state.panelsById };
        let newIndex = state.panelIdsByWorktreeId;
        for (const pid of panelIdsInGroup) {
          const t = newById[pid];
          if (t) {
            const nextWorktreeId = worktreeId ?? t.worktreeId;
            newById[pid] = {
              ...t,
              location: restoreLocation as "dock" | "grid",
              worktreeId: nextWorktreeId,
            };
            newIndex = transferBetweenWorktreeIndex(newIndex, t.worktreeId, nextWorktreeId, pid);
          }
        }

        const newTrashed = new Map(state.trashedTerminals);
        for (const { id } of groupPanels) {
          newTrashed.delete(id);
        }

        saveNormalized(newById, state.panelIds);
        return {
          panelsById: newById,
          panelIdsByWorktreeId: newIndex,
          trashedTerminals: newTrashed,
        };
      });

      // Recreate the tab group if we have multiple panels
      const restoredPanelIds = groupPanels.map(({ id }) => id);
      const existingIds = new Set(get().panelIds);
      const validPanelIds = restoredPanelIds.filter((id) => existingIds.has(id));

      const groupResult = computeRestoredTabGroup(validPanelIds, anchorPanel?.groupMetadata);
      if (groupResult) {
        get().createTabGroup(
          restoreLocation as "dock" | "grid",
          worktreeId,
          groupResult.orderedPanelIds,
          groupResult.activeTabId
        );
      }

      for (const { id } of groupPanels) {
        const terminal = get().panelsById[id];
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
      const terminal = get().panelsById[id];
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
        if (terminal && terminal.location !== "trash") {
          return state;
        }

        const newTrashed = new Map(state.trashedTerminals);
        const existingTrashed = state.trashedTerminals.get(id);
        const location = existingTrashed?.originalLocation ?? originalLocation;
        newTrashed.set(id, {
          id,
          expiresAt,
          originalLocation: location,
          ...(existingTrashed?.groupRestoreId && {
            groupRestoreId: existingTrashed.groupRestoreId,
          }),
          ...(existingTrashed?.groupMetadata && { groupMetadata: existingTrashed.groupMetadata }),
        });
        const existing = state.panelsById[id];
        if (!existing) {
          saveNormalized(state.panelsById, state.panelIds);
          return { trashedTerminals: newTrashed };
        }
        const newById: Record<string, CarrierPanel> = {
          ...state.panelsById,
          [id]: { ...existing, location: "trash" as const },
        };
        saveNormalized(newById, state.panelIds);
        return { trashedTerminals: newTrashed, panelsById: newById };
      });

      scheduleTrashExpiry(id, expiresAt);

      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    },

    markAsRestored: (id) => {
      clearTrashExpiryTimer(id);
      const terminal = get().panelsById[id];

      const trashedInfo = get().trashedTerminals.get(id);
      const rawRestoreLocation =
        terminal && terminal.location !== "trash"
          ? terminal.location
          : (trashedInfo?.originalLocation ?? "grid");
      // Final defensive boundary (#11375): normalize a dock location to grid if
      // the kind is no longer dockable, adopting the active worktree when a
      // rescued worktree-less panel would otherwise strand in the grid.
      const restoreLocation = normalizeDockLocation(terminal?.kind, rawRestoreLocation);
      const activeWorktreeId = getWorktreeSelectionSnapshot()?.activeWorktreeId ?? null;

      set((state) => {
        const newTrashed = new Map(state.trashedTerminals);
        newTrashed.delete(id);
        const t = state.panelsById[id];
        if (!t) return { trashedTerminals: newTrashed };
        const rescuedToGrid = restoreLocation === "grid" && rawRestoreLocation === "dock";
        const nextWorktreeId =
          rescuedToGrid && t.worktreeId == null && activeWorktreeId !== null
            ? activeWorktreeId
            : t.worktreeId;
        const newById = {
          ...state.panelsById,
          [id]: { ...t, location: restoreLocation, worktreeId: nextWorktreeId },
        };
        const newIndex =
          nextWorktreeId !== t.worktreeId
            ? transferBetweenWorktreeIndex(
                state.panelIdsByWorktreeId,
                t.worktreeId,
                nextWorktreeId,
                id
              )
            : state.panelIdsByWorktreeId;
        saveNormalized(newById, state.panelIds);
        return {
          trashedTerminals: newTrashed,
          panelsById: newById,
          panelIdsByWorktreeId: newIndex,
        };
      });

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
  };
};
