import { isDockPanel, type PanelInstance } from "@shared/types/panel";

export interface DockPanelScope {
  /** Structural so both the store's trash `Map` and a plain `Set` satisfy it. */
  trashedTerminals: { has: (id: string) => boolean };
  helpTerminalId: string | null;
  activeWorktreeId: string | null;
}

/**
 * Whether the dock currently renders a chip for this panel — and therefore
 * whether its popover can be on screen at all.
 *
 * `activeDockTerminalId` alone does not answer that. The offscreen container's
 * watchdog deliberately keeps the pointer alive whenever the panel still exists
 * in `panelsById` (#7278), so it survives a worktree switch that filters the
 * panel out of the dock — the popover reopens when you switch back. Callers that
 * need "a popover is really open right now" must intersect the pointer with this
 * predicate; treating a stale pointer as live focus strands focus on an
 * unrendered panel (#11065).
 *
 * Mirrors the filters in `ContentDock` and `DockPanelOffscreenContainer`, which
 * inline these conditions across a store selector (panel fields) and a memo
 * (help/worktree stores a store selector cannot read).
 */
export function isDockPanelRendered(
  panel: PanelInstance | undefined,
  { trashedTerminals, helpTerminalId, activeWorktreeId }: DockPanelScope
): boolean {
  if (!panel || !isDockPanel(panel)) return false;
  if (panel.location !== "dock") return false;
  if (trashedTerminals.has(panel.id)) return false;
  if (panel.id === helpTerminalId) return false;
  // Global panels (no worktree) ride along with every worktree.
  return panel.worktreeId == null || panel.worktreeId === activeWorktreeId;
}
