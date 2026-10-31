// Row-keyed UI state for the dev-preview console. Row ids come from a
// process-wide counter in main and are never reused, so once a row ages out of
// the capped buffer its id can never match a live row again: anything keyed by
// it is dead weight, and keeping it would make every update scale with all the
// rows the page has ever logged instead of the rows the console can show.

interface RowRef {
  id: number;
  cdpType: string;
}

export interface ArrivedRows {
  tailId: number | null;
  collapsedIds: number[] | null;
}

/**
 * Finds the `startGroupCollapsed` rows that arrived after `lastSeenTailId`.
 * Keyed by the tail id rather than an index so it survives cap eviction, where
 * the buffer length stays the same but new ids land at the end.
 */
export function scanArrivedRows(
  rows: readonly RowRef[],
  lastSeenTailId: number | null
): ArrivedRows {
  const tail = rows.at(-1);
  if (tail === undefined) return { tailId: null, collapsedIds: null };
  if (tail.id === lastSeenTailId) return { tailId: tail.id, collapsedIds: null };

  let firstNewIdx = 0;
  if (lastSeenTailId !== null) {
    firstNewIdx = rows.length;
    while (firstNewIdx > 0 && rows[firstNewIdx - 1]!.id > lastSeenTailId) firstNewIdx--;
  }

  let collapsedIds: number[] | null = null;
  for (let i = firstNewIdx; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.cdpType === "startGroupCollapsed") (collapsedIds ??= []).push(row.id);
  }
  return { tailId: tail.id, collapsedIds };
}

function liveRowIds(rows: readonly RowRef[]): Set<number> {
  const live = new Set<number>();
  for (const row of rows) live.add(row.id);
  return live;
}

/**
 * Drops collapsed ids whose rows have left the buffer and adds newly arrived
 * ones, in one copy. Returns `prev` when nothing changed so React can bail out.
 */
export function reconcileCollapsedGroups(
  prev: Set<number>,
  rows: readonly RowRef[],
  arrived: readonly number[] | null
): Set<number> {
  const live = prev.size > 0 ? liveRowIds(rows) : null;
  let changed = false;
  if (live !== null) {
    for (const id of prev) {
      if (!live.has(id)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed && arrived !== null) changed = arrived.some((id) => !prev.has(id));
  if (!changed) return prev;

  const next = new Set<number>();
  if (live !== null) {
    for (const id of prev) if (live.has(id)) next.add(id);
  }
  if (arrived !== null) for (const id of arrived) next.add(id);
  return next;
}

/** Drops entries whose rows have left the buffer; returns `prev` when none have. */
export function pruneToLiveRows<V>(prev: Map<number, V>, rows: readonly RowRef[]): Map<number, V> {
  if (prev.size === 0) return prev;
  const live = liveRowIds(rows);
  let stale = false;
  for (const id of prev.keys()) {
    if (!live.has(id)) {
      stale = true;
      break;
    }
  }
  if (!stale) return prev;

  const next = new Map<number, V>();
  for (const [id, value] of prev) if (live.has(id)) next.set(id, value);
  return next;
}
