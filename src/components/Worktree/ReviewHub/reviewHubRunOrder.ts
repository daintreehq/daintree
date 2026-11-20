interface HasPanelId {
  readonly panelId: string;
}

/**
 * The visit's order with every run it hasn't placed yet appended, in the order
 * given. Returns `order` itself when nothing arrived, so a caller can tell by
 * identity whether to store a new one. One membership set for the whole call:
 * a run list of any length costs a pass over it, not a scan of the order per run.
 */
export function appendArrivals(
  order: readonly string[],
  runs: readonly HasPanelId[]
): readonly string[] {
  const placed = new Set(order);
  let next: string[] | null = null;
  for (const { panelId } of runs) {
    if (placed.has(panelId)) continue;
    placed.add(panelId);
    (next ??= [...order]).push(panelId);
  }
  return next ?? order;
}

/**
 * The runs in the visit's order. An id with no run now (a run that left) is
 * skipped but stays in the order, so one that comes back takes its old place.
 * A panel id is unique, so each id names at most one run.
 */
export function orderRuns<T extends HasPanelId>(order: readonly string[], runs: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const run of runs) byId.set(run.panelId, run);
  const ordered: T[] = [];
  for (const id of order) {
    const run = byId.get(id);
    if (run) ordered.push(run);
  }
  return ordered;
}
