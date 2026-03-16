import type { TerminalRegistryStoreApi, TerminalRegistrySlice, TerminalInstance } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveTerminals } from "./persistence";
import { optimizeForDock } from "./layout";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createOrderingActions = (
  set: Set,
  get: Get
): Pick<TerminalRegistrySlice, "reorderTerminals" | "moveTerminalToPosition"> => ({
  reorderTerminals: (fromIndex, toIndex, location = "grid", worktreeId) => {
    if (fromIndex === toIndex) return;

    set((state) => {
      const hasWorktreeFilter = worktreeId !== undefined;
      const targetWorktreeId = worktreeId ?? null;
      const matchesWorktree = (t: TerminalInstance) =>
        !hasWorktreeFilter || (t.worktreeId ?? null) === targetWorktreeId;

      const gridTerminals = state.terminals.filter(
        (t) => t.location === "grid" || t.location === undefined
      );
      const dockTerminals = state.terminals.filter((t) => t.location === "dock");
      const trashTerminals = state.terminals.filter((t) => t.location === "trash");
      const backgroundTerminals = state.terminals.filter((t) => t.location === "background");

      const terminalsInLocation = location === "grid" ? gridTerminals : dockTerminals;
      const scopedTerminals = terminalsInLocation.filter(matchesWorktree);

      if (fromIndex < 0 || fromIndex >= scopedTerminals.length) return state;
      if (toIndex < 0 || toIndex > scopedTerminals.length) return state;

      const terminalToMove = scopedTerminals[fromIndex];
      if (!terminalToMove) return state;

      const reorderedScoped = [...scopedTerminals];
      reorderedScoped.splice(fromIndex, 1);
      reorderedScoped.splice(toIndex, 0, terminalToMove);

      let scopedIndex = 0;
      const updatedLocation = terminalsInLocation.map((terminal) => {
        if (!matchesWorktree(terminal)) {
          return terminal;
        }
        const next = reorderedScoped[scopedIndex];
        scopedIndex += 1;
        return next ?? terminal;
      });

      const newTerminals =
        location === "grid"
          ? [...updatedLocation, ...dockTerminals, ...trashTerminals, ...backgroundTerminals]
          : [...gridTerminals, ...updatedLocation, ...trashTerminals, ...backgroundTerminals];

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  moveTerminalToPosition: (id, toIndex, location, worktreeId) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const targetWorktreeId =
        worktreeId !== undefined ? worktreeId : (terminal.worktreeId ?? null);
      const hasWorktreeFilter = worktreeId !== undefined;
      const matchesWorktree = (t: TerminalInstance) =>
        !hasWorktreeFilter || (t.worktreeId ?? null) === (targetWorktreeId ?? null);

      const gridTerminals = state.terminals.filter(
        (t) => t.id !== id && (t.location === "grid" || t.location === undefined)
      );
      const dockTerminals = state.terminals.filter((t) => t.id !== id && t.location === "dock");
      const trashTerminals = state.terminals.filter(
        (t) => t.id !== id && t.location === "trash"
      );
      const backgroundTerminals = state.terminals.filter(
        (t) => t.id !== id && t.location === "background"
      );

      const targetList = location === "grid" ? gridTerminals : dockTerminals;
      const scopedIndices: number[] = [];
      for (let idx = 0; idx < targetList.length; idx += 1) {
        if (matchesWorktree(targetList[idx])) {
          scopedIndices.push(idx);
        }
      }

      const scopedCount = scopedIndices.length;
      const clampedIndex = Math.max(0, Math.min(toIndex, scopedCount));

      const insertAt =
        scopedCount === 0
          ? targetList.length
          : clampedIndex <= 0
            ? scopedIndices[0]
            : clampedIndex >= scopedCount
              ? scopedIndices[scopedCount - 1] + 1
              : scopedIndices[clampedIndex];

      const updatedTerminal: TerminalInstance = {
        ...terminal,
        location,
      };

      const updatedTargetList = [...targetList];
      updatedTargetList.splice(insertAt, 0, updatedTerminal);

      const newTerminals =
        location === "grid"
          ? [...updatedTargetList, ...dockTerminals, ...trashTerminals, ...backgroundTerminals]
          : [...gridTerminals, ...updatedTargetList, ...trashTerminals, ...backgroundTerminals];

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });

    const terminal = get().terminals.find((t) => t.id === id);
    if (terminal && panelKindHasPty(terminal.kind ?? "terminal")) {
      if (location === "dock") {
        optimizeForDock(id);
      } else {
        terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
      }
    }
  },
});
