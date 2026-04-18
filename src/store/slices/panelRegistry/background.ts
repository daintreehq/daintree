import type { PanelRegistryStoreApi, PanelRegistrySlice, TerminalInstance } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

export const createBackgroundActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  | "backgroundTerminal"
  | "backgroundPanelGroup"
  | "restoreBackgroundTerminal"
  | "restoreBackgroundGroup"
  | "isInBackground"
> => ({
  backgroundTerminal: (id) => {
    const terminal = get().panelsById[id];
    if (!terminal) return;
    if (terminal.location === "trash" || terminal.location === "background") return;

    const originalLocation: "dock" | "grid" = terminal.location === "dock" ? "dock" : "grid";

    // Capture group metadata BEFORE set() dissolves the group
    const group = get().getPanelGroup(id);
    let groupRestoreId: string | undefined;
    let groupMetadata: import("./types").TrashedTerminalGroupMetadata | undefined;

    if (group) {
      groupRestoreId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      groupMetadata = {
        panelIds: [...group.panelIds],
        activeTabId: group.activeTabId ?? group.panelIds[0] ?? "",
        location: group.location,
        worktreeId: group.worktreeId ?? null,
      };
    }

    set((state) => {
      const existing = state.panelsById[id];
      if (!existing) return state;
      const newById: Record<string, TerminalInstance> = {
        ...state.panelsById,
        [id]: { ...existing, location: "background" as const },
      };
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.set(id, {
        id,
        originalLocation,
        ...(groupRestoreId && { groupRestoreId }),
        ...(groupMetadata && { groupMetadata }),
      });

      // Remove panel from tab group (same dissolve logic as trashPanel)
      let newTabGroups = state.tabGroups;
      for (const g of state.tabGroups.values()) {
        if (g.panelIds.includes(id)) {
          newTabGroups = new Map(state.tabGroups);
          const newPanelIds = g.panelIds.filter((pid) => pid !== id);

          if (newPanelIds.length <= 1) {
            newTabGroups.delete(g.id);
          } else {
            const newActiveTabId = g.activeTabId === id ? (newPanelIds[0] ?? "") : g.activeTabId;
            newTabGroups.set(g.id, {
              ...g,
              panelIds: newPanelIds,
              activeTabId: newActiveTabId,
            });
          }
          saveTabGroups(newTabGroups);
          break;
        }
      }

      saveNormalized(newById, state.panelIds);
      return {
        panelsById: newById,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    }
  },

  backgroundPanelGroup: (panelId) => {
    const group = get().getPanelGroup(panelId);

    if (!group) {
      get().backgroundTerminal(panelId);
      return;
    }

    const groupRestoreId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const panelIds = [...group.panelIds];
    const activeTabId = group.activeTabId ?? panelIds[0] ?? "";
    const state = get();

    const existingPanelIds = panelIds.filter((id) => state.panelsById[id]);
    if (existingPanelIds.length === 0) {
      set((s) => {
        const newTabGroups = new Map(s.tabGroups);
        newTabGroups.delete(group.id);
        saveTabGroups(newTabGroups);
        return { tabGroups: newTabGroups };
      });
      return;
    }

    const bgPanelIds = existingPanelIds;
    const resolvedActiveTabId = bgPanelIds.includes(activeTabId)
      ? activeTabId
      : (bgPanelIds[0] ?? "");
    const originalLocation: "dock" | "grid" = group.location === "dock" ? "dock" : "grid";
    const worktreeId = group.worktreeId ?? null;

    set((s) => {
      const newById = { ...s.panelsById };
      for (const bid of bgPanelIds) {
        if (newById[bid]) {
          newById[bid] = { ...newById[bid], location: "background" as const };
        }
      }

      const newBackgrounded = new Map(s.backgroundedTerminals);
      for (let i = 0; i < bgPanelIds.length; i++) {
        const bid = bgPanelIds[i]!;
        const isAnchor = i === 0;
        newBackgrounded.set(bid, {
          id: bid,
          originalLocation,
          groupRestoreId,
          ...(isAnchor && {
            groupMetadata: {
              panelIds: bgPanelIds,
              activeTabId: resolvedActiveTabId,
              location: group.location,
              worktreeId,
            },
          }),
        });
      }

      const newTabGroups = new Map(s.tabGroups);
      newTabGroups.delete(group.id);
      saveTabGroups(newTabGroups);

      saveNormalized(newById, s.panelIds);
      return {
        panelsById: newById,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    for (const bid of bgPanelIds) {
      const terminal = state.panelsById[bid];
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(bid, TerminalRefreshTier.BACKGROUND);
      }
    }
  },

  restoreBackgroundTerminal: (id, targetWorktreeId) => {
    const backgroundedInfo = get().backgroundedTerminals.get(id);
    if (!backgroundedInfo) return;

    if (backgroundedInfo.groupRestoreId) {
      get().restoreBackgroundGroup(backgroundedInfo.groupRestoreId, targetWorktreeId);
      return;
    }

    const restoreLocation = backgroundedInfo.originalLocation ?? "grid";
    const terminal = get().panelsById[id];

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
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.delete(id);
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, backgroundedTerminals: newBackgrounded };
    });

    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      if (restoreLocation === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    }
  },

  restoreBackgroundGroup: (groupRestoreId, targetWorktreeId) => {
    const backgroundedTerminals = get().backgroundedTerminals;

    const groupPanels: Array<{
      id: string;
      backgrounded: NonNullable<ReturnType<typeof backgroundedTerminals.get>>;
    }> = [];
    let anchorPanel: NonNullable<ReturnType<typeof backgroundedTerminals.get>> | undefined;

    for (const [id, backgrounded] of backgroundedTerminals.entries()) {
      if (backgrounded.groupRestoreId === groupRestoreId) {
        groupPanels.push({ id, backgrounded });
        if (backgrounded.groupMetadata) {
          anchorPanel = backgrounded;
        }
      }
    }

    if (groupPanels.length === 0) return;

    const restoreLocation =
      anchorPanel?.groupMetadata?.location ??
      groupPanels[0]?.backgrounded?.originalLocation ??
      "grid";
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

      const newBackgrounded = new Map(state.backgroundedTerminals);
      for (const { id } of groupPanels) {
        newBackgrounded.delete(id);
      }

      saveNormalized(newById, state.panelIds);
      return { panelsById: newById, backgroundedTerminals: newBackgrounded };
    });

    // Recreate the tab group if we have multiple valid panels
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

  isInBackground: (id) => {
    return get().backgroundedTerminals.has(id);
  },
});
