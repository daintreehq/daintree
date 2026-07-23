import { usePanelStore } from "@/store/panelStore";
import { panelKindIsDockable } from "@shared/config/panelKindRegistry";

/**
 * Relocate every docked panel whose kind is no longer dockable back to the grid
 * (#11375). Run after the plugin panel-kind registry reconciles: a
 * `dockable:true→false` flip or a plugin unregister leaves docked panels of that
 * kind stranded — the dock filters them out via `isDockPanel`, while the grid
 * excludes them because their stored `location` is still `"dock"`.
 *
 * Delegates each move to the store's `moveTerminalToGrid`, which already handles
 * worktree adoption (a worktree-less panel adopts the active worktree so it
 * isn't stranded in the global-only grid bucket), whole-group moves, focus
 * reconciliation, and renderer policy — so affected panels land visibly in the
 * grid. Panels already in the grid are skipped, and `moveTerminalToGrid`
 * early-returns for the second member of a group already relocated by the first.
 *
 * Snapshot the target list before mutating: `moveTerminalToGrid` changes the
 * store, so iterate a captured id list rather than a live one.
 */
export function reconcileDockMembership(): void {
  const state = usePanelStore.getState();
  const stranded = state.panelIds.filter((id) => {
    const panel = state.panelsById[id];
    return !!panel && panel.location === "dock" && !panelKindIsDockable(panel.kind ?? "terminal");
  });
  if (stranded.length === 0) return;
  for (const id of stranded) {
    usePanelStore.getState().moveTerminalToGrid(id);
  }
}
