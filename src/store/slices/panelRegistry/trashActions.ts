import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { TrashExpiryHelpers } from "./trash";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { TRASH_TTL_MS } from "@shared/config/trash";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { stopDevPreviewByPanelId } from "./helpers";

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
> => ({
  trashPanel: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;

    const expiresAt = Date.now() + TRASH_TTL_MS;

    if (terminal.kind === "dev-preview") {
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
        console.error("Failed to trash terminal:", error);
      });
    }

    set((state) => {
      const newById = {
        ...state.panelsById,
        [id]: { ...state.panelsById[id], location: "trash" as const },
      };
      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.set(id, { id, expiresAt, originalLocation });

      // Remove panel from tab group
      let newTabGroups = state.tabGroups;
      for (const group of state.tabGroups.values()) {
        if (group.panelIds.includes(id)) {
          newTabGroups = new Map(state.tabGroups);
          const newPanelIds = group.panelIds.filter((pid) => pid !== id);

          if (newPanelIds.length <= 1) {
            newTabGroups.delete(group.id);
          } else {
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
  },

  trashPanelGroup: (panelId) => {
    // Find the group this panel belongs to
    const group = get().getPanelGroup(panelId);

    // If no group, fall back to single panel trash
    if (!group) {
      get().trashPanel(panelId);
      return;
    }

    const expiresAt = Date.now() + TRASH_TTL_MS;
    const groupRestoreId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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

    const resolvedActiveTabId = trashPanelIds.includes(activeTabId)
      ? activeTabId
      : (trashPanelIds[0] ?? "");

    const originalLocation: "dock" | "grid" = group.location === "dock" ? "dock" : "grid";
    const worktreeId = group.worktreeId ?? null;

    // Trash PTY processes for all PTY-backed panels
    for (const id of trashPanelIds) {
      const terminal = state.panelsById[id];
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
      const newById = { ...state.panelsById };
      for (const tid of trashPanelIds) {
        if (newById[tid]) {
          newById[tid] = { ...newById[tid], location: "trash" as const };
        }
      }

      const newTrashed = new Map(state.trashedTerminals);

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
  },

  restoreTerminal: (id, targetWorktreeId) => {
    clearTrashExpiryTimer(id);
    const trashedInfo = get().trashedTerminals.get(id);
    const restoreLocation = trashedInfo?.originalLocation ?? "grid";
    const terminal = get().panelsById[id];

    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalClient.restore(id).catch((error) => {
        console.error("Failed to restore terminal:", error);
      });
    }

    set((state) => {
      const t = state.panelsById[id];
      if (!t) return state;
      const newById = {
        ...state.panelsById,
        [id]: {
          ...t,
          location: restoreLocation,
          worktreeId: targetWorktreeId !== undefined ? targetWorktreeId : t.worktreeId,
        },
      };
      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.delete(id);
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, trashedTerminals: newTrashed };
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
        if (trashed.groupMetadata) {
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
          console.error("Failed to restore terminal:", error);
        });
      }
    }

    const restoreLocation =
      anchorPanel?.groupMetadata?.location ?? groupPanels[0]?.trashed?.originalLocation ?? "grid";
    const worktreeId =
      targetWorktreeId !== undefined
        ? targetWorktreeId
        : (anchorPanel?.groupMetadata?.worktreeId ?? undefined);

    set((state) => {
      const panelIdsInGroup = new Set(groupPanels.map(({ id }) => id));
      const newById = { ...state.panelsById };
      for (const pid of panelIdsInGroup) {
        const t = newById[pid];
        if (t) {
          newById[pid] = {
            ...t,
            location: restoreLocation as "dock" | "grid",
            worktreeId: worktreeId ?? t.worktreeId,
          };
        }
      }

      const newTrashed = new Map(state.trashedTerminals);
      for (const { id } of groupPanels) {
        newTrashed.delete(id);
      }

      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, trashedTerminals: newTrashed };
    });

    // Recreate the tab group if we have multiple panels
    const restoredPanelIds = groupPanels.map(({ id }) => id);
    const existingIds = new Set(get().panelIds);
    const validPanelIds = restoredPanelIds.filter((id) => existingIds.has(id));

    if (validPanelIds.length > 1) {
      let orderedPanelIds = validPanelIds;
      let activeTabId = validPanelIds[0];

      if (anchorPanel?.groupMetadata) {
        const { panelIds, activeTabId: metadataActiveTabId } = anchorPanel.groupMetadata;
        orderedPanelIds = panelIds.filter((id) => validPanelIds.includes(id));
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
      const newById = {
        ...state.panelsById,
        [id]: { ...state.panelsById[id], location: "trash" as const },
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
    const restoreLocation =
      terminal && terminal.location !== "trash"
        ? terminal.location
        : (trashedInfo?.originalLocation ?? "grid");

    set((state) => {
      const newTrashed = new Map(state.trashedTerminals);
      newTrashed.delete(id);
      const t = state.panelsById[id];
      if (!t) return { trashedTerminals: newTrashed };
      const newById = {
        ...state.panelsById,
        [id]: { ...t, location: restoreLocation },
      };
      saveNormalized(newById, state.panelIds);
      return { trashedTerminals: newTrashed, panelsById: newById };
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
});
