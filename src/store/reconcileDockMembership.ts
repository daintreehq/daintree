import { usePanelStore, type PanelGridState } from "@/store/panelStore";
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
 * - Restores the foreground focus / dock-activation / maximize tuple. This is a
 *   BACKGROUND reconciliation (a plugin flipped a flag), not a user gesture, but
 *   `moveTerminalToGrid` steals focus, closes the dock popover, and exits
 *   maximize as foreground side effects. Restoring the pre-reconcile tuple keeps
 *   the user's view untouched — only a dock activation that pointed at a
 *   now-relocated panel legitimately changes (that panel left the dock).
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

  const {
    focusedId,
    previousFocusedId,
    activeDockTerminalId,
    maximizedId,
    maximizeTarget,
    preMaximizeLayout,
  } = before;

  for (const id of stranded) {
    if (usePanelStore.getState().panelsById[id]?.location === "dock") {
      usePanelStore.getState().moveTerminalToGrid(id);
    }
  }

  const after = usePanelStore.getState();
  const restore: Partial<
    Pick<
      PanelGridState,
      | "focusedId"
      | "previousFocusedId"
      | "activeDockTerminalId"
      | "maximizedId"
      | "maximizeTarget"
      | "preMaximizeLayout"
    >
  > = {};
  // Restore verbatim (including a null value): a relocated stranded panel is now
  // a visible grid panel, so a focus/maximize pointer at it stays valid.
  if (after.focusedId !== focusedId) restore.focusedId = focusedId;
  if (after.previousFocusedId !== previousFocusedId) restore.previousFocusedId = previousFocusedId;
  if (after.maximizedId !== maximizedId) restore.maximizedId = maximizedId;
  if (after.maximizeTarget !== maximizeTarget) restore.maximizeTarget = maximizeTarget;
  if (after.preMaximizeLayout !== preMaximizeLayout) restore.preMaximizeLayout = preMaximizeLayout;
  // The dock popover only survives if its panel is still in the dock; a
  // relocated stranded panel left it, so keep the cleared value in that case.
  if (
    after.activeDockTerminalId !== activeDockTerminalId &&
    activeDockTerminalId != null &&
    !strandedSet.has(activeDockTerminalId)
  ) {
    restore.activeDockTerminalId = activeDockTerminalId;
  }
  if (Object.keys(restore).length > 0) usePanelStore.setState(restore);
}
