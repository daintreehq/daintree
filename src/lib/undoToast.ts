/**
 * How long a toast offering Undo for a small reversible change stays up. The
 * toast is the only way back once it goes, so every such site shares one
 * window rather than each picking its own.
 */
export const UNDO_TOAST_DURATION_MS = 5_000;

/** The label every Undo action uses, and the one `notify()` keys urgency on. */
export const UNDO_ACTION_LABEL = "Undo";

/** Where a removed item sat: the list's order at the moment it went. */
export interface RemovedPosition {
  order: readonly string[];
}

// The order each recent removal saw, by item id. Two removals undone in either
// order need each other's view: the one removed first never saw the second go.
const removalOrders = new Map<string, readonly string[]>();
const REMOVAL_ORDER_CAP = 200;

export function positionOf<T extends { id: string }>(
  list: readonly T[],
  id: string
): RemovedPosition {
  const order = list.map((item) => item.id);
  removalOrders.delete(id);
  removalOrders.set(id, order);
  if (removalOrders.size > REMOVAL_ORDER_CAP) {
    removalOrders.delete(removalOrders.keys().next().value!);
  }
  return { order };
}

/** Whether `a` came before `b` in some removal's view of the list. */
function precedes(a: string, b: string, orders: ReadonlyArray<readonly string[] | undefined>) {
  for (const order of orders) {
    const ai = order?.indexOf(a) ?? -1;
    const bi = order?.indexOf(b) ?? -1;
    if (ai >= 0 && bi >= 0) return ai < bi;
  }
  return undefined;
}

/**
 * Puts a removed item back between the nearest items around it that are still
 * there — never at a stored index — so several removals undone in any order
 * land where they were. Items between those two that its own view never saw
 * (another removal, undone first) are ordered by that removal's view. Returns
 * the list unchanged when the item is already back.
 */
export function reinsert<T extends { id: string }>(
  list: readonly T[],
  item: T,
  position: RemovedPosition
): T[] {
  const next = [...list];
  if (next.some((entry) => entry.id === item.id)) return next;
  const { order } = position;
  const at = order.indexOf(item.id);
  if (at < 0) return [...next, item];
  const indexOfId = (id: string | undefined) => next.findIndex((entry) => entry.id === id);

  let low = 0;
  for (let i = at - 1; i >= 0; i--) {
    const found = indexOfId(order[i]);
    if (found >= 0) {
      low = found + 1;
      break;
    }
  }
  let high = next.length;
  for (let i = at + 1; i < order.length; i++) {
    const found = indexOfId(order[i]);
    if (found >= 0) {
      high = found;
      break;
    }
  }
  let slot = low;
  while (slot < high) {
    const other = next[slot]!.id;
    const itemFirst = precedes(item.id, other, [order, removalOrders.get(other)]);
    if (itemFirst !== false) break;
    slot++;
  }
  next.splice(slot, 0, item);
  return next;
}

const latestUndo = new Map<string, symbol>();

/**
 * Registers an Undo for `key` (an entity id, or one per reset) and returns a
 * guard that runs `restore` only while it is still the newest Undo for that
 * key. Removing, restoring and removing an item again leaves two toasts up; the
 * first must not bring back the snapshot the second one replaced.
 */
export function latestUndoOnly<R>(key: string, restore: () => R): () => R | undefined {
  const token = Symbol(key);
  latestUndo.set(key, token);
  return () => {
    if (latestUndo.get(key) !== token) return undefined;
    latestUndo.delete(key);
    return restore();
  };
}
