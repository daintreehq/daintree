import type { TerminalRegistryStoreApi, TerminalRegistrySlice } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveTerminals, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createBackgroundActions = (
  set: Set,
  get: Get
): Pick<
  TerminalRegistrySlice,
  | "backgroundTerminal"
  | "backgroundPanelGroup"
  | "restoreBackgroundTerminal"
  | "restoreBackgroundGroup"
  | "isInBackground"
> => ({
  backgroundTerminal: (id) => {
    const terminal = get().terminals.find((t) => t.id === id);
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
      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, location: "background" as const } : t
      );
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.set(id, {
        id,
        originalLocation,
        ...(groupRestoreId && { groupRestoreId }),
        ...(groupMetadata && { groupMetadata }),
      });

      // Remove panel from tab group (same dissolve logic as trashTerminal)
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

      saveTerminals(newTerminals);
      return {
        terminals: newTerminals,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    // Apply background render tier for PTY-backed panels (keep PTY alive but suppress visual streaming)
    if (panelKindHasPty(terminal.kind ?? "terminal")) {
      terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
    }
  },

  backgroundPanelGroup: (panelId) => {
    const group = get().getPanelGroup(panelId);

    // If no group, fall back to single panel background
    if (!group) {
      get().backgroundTerminal(panelId);
      return;
    }

    const groupRestoreId = `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const panelIds = [...group.panelIds];
    const activeTabId = group.activeTabId ?? panelIds[0] ?? "";
    const terminals = get().terminals;

    const existingPanelIds = panelIds.filter((id) => terminals.some((t) => t.id === id));
    if (existingPanelIds.length === 0) {
      set((state) => {
        const newTabGroups = new Map(state.tabGroups);
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

    set((state) => {
      const newTerminals = state.terminals.map((t) =>
        bgPanelIds.includes(t.id) ? { ...t, location: "background" as const } : t
      );

      const newBackgrounded = new Map(state.backgroundedTerminals);
      for (let i = 0; i < bgPanelIds.length; i++) {
        const id = bgPanelIds[i];
        const isAnchor = i === 0;
        newBackgrounded.set(id, {
          id,
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

      const newTabGroups = new Map(state.tabGroups);
      newTabGroups.delete(group.id);
      saveTabGroups(newTabGroups);

      saveTerminals(newTerminals);
      return {
        terminals: newTerminals,
        backgroundedTerminals: newBackgrounded,
        tabGroups: newTabGroups,
      };
    });

    // Apply background renderer policy for PTY-backed panels
    for (const id of bgPanelIds) {
      const terminal = terminals.find((t) => t.id === id);
      if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.BACKGROUND);
      }
    }
  },

  restoreBackgroundTerminal: (id, targetWorktreeId) => {
    const backgroundedInfo = get().backgroundedTerminals.get(id);
    if (!backgroundedInfo) return;

    // If panel has a group, delegate to restoreBackgroundGroup
    if (backgroundedInfo.groupRestoreId) {
      get().restoreBackgroundGroup(backgroundedInfo.groupRestoreId, targetWorktreeId);
      return;
    }

    const restoreLocation = backgroundedInfo.originalLocation ?? "grid";
    const terminal = get().terminals.find((t) => t.id === id);

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
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.delete(id);
      saveTerminals(newTerminals);
      return { terminals: newTerminals, backgroundedTerminals: newBackgrounded };
    });

    // Restore render tier for PTY-backed panels
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
      const newTerminals = state.terminals.map((t) =>
        panelIdsInGroup.has(t.id)
          ? {
              ...t,
              location: restoreLocation as "dock" | "grid",
              worktreeId: worktreeId ?? t.worktreeId,
            }
          : t
      );

      const newBackgrounded = new Map(state.backgroundedTerminals);
      for (const { id } of groupPanels) {
        newBackgrounded.delete(id);
      }

      saveTerminals(newTerminals);
      return { terminals: newTerminals, backgroundedTerminals: newBackgrounded };
    });

    // Recreate the tab group if we have multiple valid panels
    const restoredPanelIds = groupPanels.map(({ id }) => id);
    const existingIds = new Set(get().terminals.map((t) => t.id));
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

  isInBackground: (id) => {
    return get().backgroundedTerminals.has(id);
  },
});
