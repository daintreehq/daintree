import type { TerminalRegistryStoreApi, TerminalRegistrySlice } from "./types";
import type { TrashExpiryHelpers } from "./trash";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { TRASH_TTL_MS } from "@shared/config/trash";
import { saveTerminals, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { stopDevPreviewByPanelId } from "./helpers";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createTrashActions = (
  set: Set,
  get: Get,
  { clearTrashExpiryTimer, scheduleTrashExpiry }: TrashExpiryHelpers
): Pick<
  TerminalRegistrySlice,
  | "trashTerminal"
  | "trashPanelGroup"
  | "restoreTerminal"
  | "restoreTrashedGroup"
  | "markAsTrashed"
  | "markAsRestored"
  | "isInTrash"
> => ({
  trashTerminal: (id) => {
    const terminal = get().terminals.find((t) => t.id === id);
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

      // Clear backgrounded metadata if trashing from background
      let newBackgrounded = state.backgroundedTerminals;
      if (state.backgroundedTerminals.has(id)) {
        newBackgrounded = new Map(state.backgroundedTerminals);
        newBackgrounded.delete(id);
      }

      saveTerminals(newTerminals);
      return {
        terminals: newTerminals,
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
      get().trashTerminal(panelId);
      return;
    }

    const expiresAt = Date.now() + TRASH_TTL_MS;
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
});
