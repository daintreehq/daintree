/**
 * The one definition of "panels that count toward the panel limit".
 *
 * Three surfaces have to agree or the UI lies about the ceiling: the hard-limit
 * gate in `addPanel`, the batch preflight in `panelSpawning`, and the counter
 * `PanelPalette` renders against `hardLimit`. They previously each counted
 * "every non-trash panel" independently, which ignored `excludeFromPersistence`
 * despite that field's documented exclusion from "counts" — so the assistant
 * overlay silently consumed a limit slot, and a dialog-presented panel would
 * have too.
 */

/** A panel carrier entry — only the fields the count actually reads. */
interface CountablePanel {
  location?: string;
  excludeFromPersistence?: boolean;
}

/**
 * Whether a panel occupies a slot against the panel limit.
 *
 * Trashed panels are pending TTL cleanup, and `excludeFromPersistence` panels
 * (the Daintree Assistant overlay, every `location: "dialog"` panel) are not
 * part of the user's working set — neither should push the user toward a
 * ceiling they can't see.
 */
export function countsTowardPanelLimit(panel: CountablePanel | undefined): boolean {
  if (!panel) return false;
  if (panel.location === "trash") return false;
  return !isEphemeralPanel(panel);
}

/**
 * Whether a panel is ephemeral — present in the registry but not part of the
 * user's working set of panels.
 *
 * Covers dialog-presented panels and anything flagged `excludeFromPersistence`
 * (the Daintree Assistant, tooling-internal terminals). Use this anywhere a
 * surface enumerates "the user's panels": counts, switchers, bulk actions,
 * close-all/kill-all targets, and MCP-facing listings.
 *
 * Location is checked intrinsically rather than relying on the flag alone: a
 * dialog panel is ephemeral by virtue of where it lives, and making that depend
 * on a caller remembering to stamp the flag would be a silent trap.
 *
 * Deliberately NOT PTY-narrowed. `excludeFromPersistence` moved onto the base
 * panel shape precisely because non-PTY panels (a file viewer presented as a
 * dialog) rely on it; an `isPtyPanel(...) &&` guard here would silently ignore
 * the flag for them.
 */
export function isEphemeralPanel(panel: CountablePanel | undefined): boolean {
  if (!panel) return false;
  return panel.location === "dialog" || panel.excludeFromPersistence === true;
}

/** Count the panels occupying a limit slot across a normalized panel map. */
export function countPanelsTowardLimit(
  panelsById: Record<string, CountablePanel | undefined>,
  panelIds: string[]
): number {
  let count = 0;
  for (const id of panelIds) {
    if (countsTowardPanelLimit(panelsById[id])) count++;
  }
  return count;
}
