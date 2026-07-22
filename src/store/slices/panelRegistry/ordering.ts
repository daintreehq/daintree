import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import { saveNormalized, saveTabGroups } from "./persistence";
import { optimizeForDock } from "./layout";
import { deriveRuntimeStatus, removePanelIdsFromTabGroups } from "./helpers";
import { buildWorktreeIndex, panelMatchesWorktreeScope } from "./worktreeIndex";
import { getNarrowPanel } from "./selectors";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

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
      // Location-aware scope: a worktree's dock renders global (worktree-less)
      // panels too, so the commit-side list must include them or the indices
      // diverge from the rendered order (#11289). Grid stays worktree-exact.
      const matchesWorktree = (t: CarrierPanel) =>
        !hasWorktreeFilter || panelMatchesWorktreeScope(t.worktreeId, worktreeId, location);
      const matchesLocation = (t: CarrierPanel) =>
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
      // Rebuild bucket order so per-worktree selectors observe the new order
      // (issue #7451). Reorder is user-gesture rate, so a full rebuild is fine.
      return {
        panelIds: newIds,
        panelIdsByWorktreeId: buildWorktreeIndex(newIds, state.panelsById),
      };
    });
  },

  moveTerminalToPosition: (id, toIndex, location, worktreeId) => {
    let backfilledWorktreeId: string | null = null;

    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      // Adoption target for worktree-less panels promoted to the grid (#11290).
      const targetWorktreeId =
        worktreeId !== undefined ? worktreeId : (terminal.worktreeId ?? null);
      const hasWorktreeFilter = worktreeId !== undefined;
      // Same location-aware scope as reorderTerminals (#11289): a dock target
      // must count global panels when computing the insertion slot.
      const matchesWorktree = (t: CarrierPanel) =>
        !hasWorktreeFilter || panelMatchesWorktreeScope(t.worktreeId, worktreeId, location);
      const matchesLocation = (t: CarrierPanel) =>
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
      const ptyTerminal = isPtyPanel(terminal) ? terminal : undefined;
      // A worktree-less dock panel dropped into the grid adopts the drop
      // target's worktree — the grid renders only that worktree's index
      // bucket, so an unset worktreeId would strand it off-screen (#11290).
      // The rebuild below re-buckets the panel; a real attribution is kept.
      const adoptedWorktreeId =
        location === "grid" && terminal.worktreeId == null && targetWorktreeId != null
          ? targetWorktreeId
          : null;
      backfilledWorktreeId = adoptedWorktreeId;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- spread preserves the panel's discriminant; overrides are base-field-compatible
      const updatedTerminal = {
        ...terminal,
        ...(adoptedWorktreeId !== null && { worktreeId: adoptedWorktreeId }),
        location,
        isVisible,
        runtimeStatus: deriveRuntimeStatus(
          isVisible,
          ptyTerminal?.flowStatus,
          ptyTerminal?.runtimeStatus
        ),
      } as PanelInstance;

      // Insert at the right position
      const newIds = [...filteredIds];
      newIds.splice(insertAt, 0, id);
      const newById = { ...state.panelsById, [id]: updatedTerminal };
      const groupPrune = removePanelIdsFromTabGroups(state.tabGroups, new Set([id]));

      saveNormalized(newById, newIds);
      if (groupPrune.changed) {
        saveTabGroups(groupPrune.tabGroups);
      }
      // Rebuild bucket order so per-worktree selectors observe the new order
      // (issue #7451) and any adopted worktreeId lands in the right bucket.
      return {
        panelsById: newById,
        panelIds: newIds,
        panelIdsByWorktreeId: buildWorktreeIndex(newIds, newById),
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
      // Rebuild bucket order so per-worktree selectors observe the restored
      // order on hydration (issue #7451).
      return {
        panelIds: newIds,
        panelIdsByWorktreeId: buildWorktreeIndex(newIds, state.panelsById),
      };
    });
  },
});
