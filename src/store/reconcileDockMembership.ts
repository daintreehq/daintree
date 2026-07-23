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
 * isn't stranded in the global-only grid bucket), whole-group moves, and
 * renderer policy — so affected panels land visibly in the grid.
 *
 * Robustness details:
 * - Scans `panelsById` keys, NOT `panelIds`: hydration/spawn batches commit a
 *   panel to `panelsById` before the deferred `panelIds` flush, so a flip that
 *   lands mid-batch would otherwise miss it and never be reconciled again.
 * - Re-checks `location === "dock"` before each move: `moveTerminalToGrid`
 *   delegates a grouped panel to a single whole-group move, so a later stranded
 *   member of the same group is already in the grid — skip it rather than
 *   re-run the group move (and its focus side effects) a second time.
 * - Restores the pre-reconcile focus. This is a background reconciliation (a
 *   plugin flipped a flag), not a user gesture, so `moveTerminalToGrid`'s
 *   focus-steal must not stick — unless focus was itself on a relocated panel.
 */
export function reconcileDockMembership(): void {
  const before = usePanelStore.getState();
  const stranded: string[] = [];
  const strandedSet = new Set<string>();
  for (const id of Object.keys(before.panelsById)) {
    const panel = before.panelsById[id];
    if (panel && panel.location === "dock" && !panelKindIsDockable(panel.kind ?? "terminal")) {
      stranded.push(id);
      strandedSet.add(id);
    }
  }
  if (stranded.length === 0) return;

  const focusBefore = before.focusedId;
  for (const id of stranded) {
    if (usePanelStore.getState().panelsById[id]?.location === "dock") {
      usePanelStore.getState().moveTerminalToGrid(id);
    }
  }

  const after = usePanelStore.getState();
  if (
    focusBefore &&
    focusBefore !== after.focusedId &&
    !strandedSet.has(focusBefore) &&
    after.panelsById[focusBefore]
  ) {
    usePanelStore.setState({ focusedId: focusBefore });
  }
}
