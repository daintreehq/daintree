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
  if (panel.excludeFromPersistence === true) return false;
  return true;
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
