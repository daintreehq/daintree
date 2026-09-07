import { isDockPanel, type PanelInstance } from "@shared/types/panel";

export interface DockPanelScope {
  /** Structural so both the store's trash `Map` and a plain `Set` satisfy it. */
  trashedTerminals: { has: (id: string) => boolean };
  /**
   * Every live assistant lane's terminal (#12108). All of them are rendered by
   * `HelpPanel` rather than the dock, so all of them must be filtered out —
   * carrying only the focused lane would leak a background assistant into the
   * dock as a stray chip.
   */
  helpTerminalIds: ReadonlySet<string>;
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
 *
 * One condition stays with the caller: both dock surfaces iterate `panelIds`, so
 * a panel must also be registered there. That lives on the store state rather
 * than the panel, so callers resolve `panel` through `panelIds` and pass
 * `undefined` for an unregistered id.
 */
export function isDockPanelRendered(
  panel: PanelInstance | undefined,
  { trashedTerminals, helpTerminalIds, activeWorktreeId }: DockPanelScope
): boolean {
  if (!panel || !isDockPanel(panel)) return false;
  if (panel.location !== "dock") return false;
  if (trashedTerminals.has(panel.id)) return false;
  if (helpTerminalIds.has(panel.id)) return false;
  // Global panels (no worktree) ride along with every worktree.
  return panel.worktreeId == null || panel.worktreeId === activeWorktreeId;
}

/** The panel-store fields the pointer derivation reads, structurally. */
export interface DockPopoverPointerState {
  activeDockTerminalId: string | null;
  panelIds: string[];
  panelsById: Record<string, PanelInstance>;
  trashedTerminals: { has: (id: string) => boolean };
}

/**
 * Which dock popover is genuinely on screen, or null.
 *
 * The pointer alone can't answer that — see `isDockPanelRendered` — so this
 * intersects it with what the dock actually renders. Kept as one exported
 * derivation because two callers now need the same answer for different
 * reasons (maximized-group focus enforcement, and dialog z-tier promotion in
 * #11505); a paraphrase in either would drift from the render predicate.
 *
 * Returns the id rather than a boolean so selector consumers compare a
 * primitive and short-circuit the re-render on unrelated store writes.
 */
export function selectOpenDockPopoverId(
  state: DockPopoverPointerState,
  { helpTerminalIds, activeWorktreeId }: Omit<DockPanelScope, "trashedTerminals">
): string | null {
  const id = state.activeDockTerminalId;
  if (id === null) return null;
  // Both dock surfaces render from `panelIds`; a panel that lingers in
  // `panelsById` without being registered there has no chip, hence no popover.
  const panel = state.panelIds.includes(id) ? state.panelsById[id] : undefined;
  return isDockPanelRendered(panel, {
    trashedTerminals: state.trashedTerminals,
    helpTerminalIds,
    activeWorktreeId,
  })
    ? id
    : null;
}
