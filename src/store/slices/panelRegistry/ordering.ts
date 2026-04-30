import type { PanelRegistryStoreApi, PanelRegistrySlice, TerminalInstance } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus, removePanelIdsFromTabGroups } from "./helpers";

type Set = PanelRegistryStoreApi["setState"];
type Get = PanelRegistryStoreApi["getState"];

export const createOrderingActions = (
  set: Set,
  get: Get
): Pick<
  PanelRegistrySlice,
  "reorderTerminals" | "moveTerminalToPosition" | "restoreTerminalOrder"
> => ({
  reorderTerminals: (fromIndex, toIndex, location = "grid", worktreeId) => {
    if (fromIndex === toIndex) return;

    set((state) => {
      const hasWorktreeFilter = worktreeId !== undefined;
      const targetWorktreeId = worktreeId ?? null;
      const matchesWorktree = (t: TerminalInstance) =>
        !hasWorktreeFilter || (t.worktreeId ?? null) === targetWorktreeId;
      const matchesLocation = (t: TerminalInstance) =>
        location === "grid"
          ? t.location === "grid" || t.location === undefined
          : t.location === "dock";

      // Get scoped IDs (in this location + worktree)
      const scopedIds: string[] = [];
      for (const id of state.panelIds) {
        const t = state.panelsById[id];
        if (t && matchesLocation(t) && matchesWorktree(t)) {
          scopedIds.push(id);
        }
      }

      if (fromIndex < 0 || fromIndex >= scopedIds.length) return state;
      if (toIndex < 0 || toIndex > scopedIds.length) return state;

      const reorderedScoped = [...scopedIds];
      reorderedScoped.splice(fromIndex, 1);
      reorderedScoped.splice(toIndex, 0, scopedIds[fromIndex]!);

      // Build a mapping from old scoped position to new ID
      const scopedMapping = new Map<string, string>();
      for (let i = 0; i < scopedIds.length; i++) {
        scopedMapping.set(scopedIds[i]!, reorderedScoped[i]!);
      }

      // Rebuild panelIds with the reordered scoped IDs in place
      const newIds: string[] = [];
      for (const id of state.panelIds) {
        const t = state.panelsById[id];
        if (t && matchesLocation(t) && matchesWorktree(t)) {
          newIds.push(scopedMapping.get(id)!);
        } else {
          newIds.push(id);
        }
      }

      saveNormalized(state.panelsById, newIds);
      return { panelIds: newIds };
    });
  },

  moveTerminalToPosition: (id, toIndex, location, worktreeId) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const targetWorktreeId =
        worktreeId !== undefined ? worktreeId : (terminal.worktreeId ?? null);
      const hasWorktreeFilter = worktreeId !== undefined;
      const matchesWorktree = (t: TerminalInstance) =>
        !hasWorktreeFilter || (t.worktreeId ?? null) === (targetWorktreeId ?? null);
      const matchesLocation = (t: TerminalInstance) =>
        location === "grid"
          ? t.location === "grid" || t.location === undefined
          : t.location === "dock";

      // Remove id from current position
      const filteredIds = state.panelIds.filter((tid) => tid !== id);

      // Find scoped indices within the target location
      const scopedIndices: number[] = [];
      for (let i = 0; i < filteredIds.length; i++) {
        const t = state.panelsById[filteredIds[i]!];
        if (t && matchesLocation(t) && matchesWorktree(t)) {
          scopedIndices.push(i);
        }
      }

      const scopedCount = scopedIndices.length;
      const clampedIndex = Math.max(0, Math.min(toIndex, scopedCount));

      const insertAt =
        scopedCount === 0
          ? filteredIds.length
          : clampedIndex <= 0
            ? scopedIndices[0]!
            : clampedIndex >= scopedCount
              ? scopedIndices[scopedCount - 1]! + 1
              : scopedIndices[clampedIndex]!;

      const isVisible = location === "grid";
      const updatedTerminal: TerminalInstance = {
        ...terminal,
        location,
        isVisible,
        runtimeStatus: deriveRuntimeStatus(isVisible, terminal.flowStatus, terminal.runtimeStatus),
      };

      // Insert at the right position
      const newIds = [...filteredIds];
      newIds.splice(insertAt, 0, id);
      const newById = { ...state.panelsById, [id]: updatedTerminal };
      const groupPrune = removePanelIdsFromTabGroups(state.tabGroups, new Set([id]));

      saveNormalized(newById, newIds);
      if (groupPrune.changed) {
        saveTabGroups(groupPrune.tabGroups);
      }
      return {
        panelsById: newById,
        panelIds: newIds,
        ...(groupPrune.changed && { tabGroups: groupPrune.tabGroups }),
      };
    });

    const terminal = get().panelsById[id];
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      if (location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    }
  },

  restoreTerminalOrder: (orderedIds) => {
    if (orderedIds.length === 0) return;

    set((state) => {
      const indexMap = new Map(orderedIds.map((id, i) => [id, i]));
      const matched: string[] = [];
      const unmatched: string[] = [];

      for (const id of state.panelIds) {
        if (indexMap.has(id)) {
          matched.push(id);
        } else {
          unmatched.push(id);
        }
      }

      matched.sort((a, b) => indexMap.get(a)! - indexMap.get(b)!);
      const newIds = [...matched, ...unmatched];

      const orderChanged = newIds.some((id, i) => state.panelIds[i] !== id);
      if (!orderChanged) return state;

      saveNormalized(state.panelsById, newIds);
      return { panelIds: newIds };
    });
  },
});
