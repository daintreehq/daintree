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
  "backgroundTerminal" | "restoreBackgroundTerminal" | "isInBackground"
> => ({
  backgroundTerminal: (id) => {
    const terminal = get().terminals.find((t) => t.id === id);
    if (!terminal) return;
    if (terminal.location === "trash" || terminal.location === "background") return;

    const originalLocation: "dock" | "grid" = terminal.location === "dock" ? "dock" : "grid";

    set((state) => {
      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, location: "background" as const } : t
      );
      const newBackgrounded = new Map(state.backgroundedTerminals);
      newBackgrounded.set(id, { id, originalLocation });

      // Remove panel from tab group (same dissolve logic as trashTerminal)
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

  restoreBackgroundTerminal: (id, targetWorktreeId) => {
    const backgroundedInfo = get().backgroundedTerminals.get(id);
    const restoreLocation = backgroundedInfo?.originalLocation ?? "grid";
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

  isInBackground: (id) => {
    return get().backgroundedTerminals.has(id);
  },
});
