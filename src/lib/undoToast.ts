/**
 * How long a toast offering Undo for a small reversible change stays up. The
 * toast is the only way back once it goes, so every such site shares one
 * window rather than each picking its own.
 */
export const UNDO_TOAST_DURATION_MS = 5_000;

/** The label every Undo action uses, and the one `notify()` keys urgency on. */
export const UNDO_ACTION_LABEL = "Undo";

/** Where a removed item sat, by its neighbours, so an Undo can put it back. */
export interface RemovedPosition {
  prevId: string | null;
  nextId: string | null;
  index: number;
}

export function positionOf<T extends { id: string }>(
  list: readonly T[],
  id: string
): RemovedPosition {
  const index = list.findIndex((item) => item.id === id);
  return {
    prevId: index > 0 ? list[index - 1]!.id : null,
    nextId: index >= 0 && index < list.length - 1 ? list[index + 1]!.id : null,
    index: index < 0 ? list.length : index,
  };
}

/**
 * Puts a removed item back beside the neighbour it had, not at its old index:
 * with several removals undone in any order, an index drifts and a neighbour
 * does not. Falls back to the index once both neighbours are gone too. Returns
 * the list unchanged when the item is already back.
 */
export function reinsert<T extends { id: string }>(
  list: readonly T[],
  item: T,
  position: RemovedPosition
): T[] {
  if (list.some((entry) => entry.id === item.id)) return [...list];
  const next = [...list];
  const nextAt = position.nextId === null ? -1 : next.findIndex((e) => e.id === position.nextId);
  if (nextAt >= 0) {
    next.splice(nextAt, 0, item);
    return next;
  }
  const prevAt = position.prevId === null ? -1 : next.findIndex((e) => e.id === position.prevId);
  if (prevAt >= 0) {
    next.splice(prevAt + 1, 0, item);
    return next;
  }
  next.splice(Math.min(position.index, next.length), 0, item);
  return next;
}
