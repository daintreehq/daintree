/** How long the user must leave the panel alone before the list may re-rank. */
export const CANOPY_RANK_IDLE_MS = 5_000;
/** The least time between two re-ranks the user didn't ask for. */
export const CANOPY_RANK_SPACING_MS = 10_000;
/** The longest an opening list waits for the cards it is owed before it paints. */
export const CANOPY_OPEN_SETTLE_MS = 4_000;

/** One scope's order: each scope ranks its own runs, so switching never buries another's. */
export interface CanopyOrder {
  ids: readonly string[];
  /** The snapshot's `refreshedAt` this order was ranked for. */
  rankedFor: number | null;
  /** The runs that were urgent when it was ranked: a run urgent since is placed at once. */
  urgent: readonly string[];
}

export interface CanopyRankInput {
  /** Every run, in the order the readers rank them now. */
  fresh: readonly string[];
  /** Each run's priority now, which a re-rank sorts by. */
  priorities: ReadonlyMap<string, number>;
  /** The runs that page the user now. */
  urgent: readonly string[];
  refreshedAt: number | null;
  now: number;
  /** The panel is opening, or switching scope: the user's own move. */
  opening: boolean;
  /** The user pressed Refresh since the last rank. */
  requested: boolean;
  /** A press is under way: the row under it must not move between down and up. */
  pressing: boolean;
  pointerInList: boolean;
  lastInteractionAt: number;
  lastRankAt: number;
}

export type CanopyRankStep =
  /** Leave the list as it is. */
  | { kind: "hold" }
  /** Nothing to do until then; ask again after `ms`. */
  | { kind: "wait"; ms: number }
  /** Take this order, and count it as just ranked when `ranked`. */
  | { kind: "set"; order: CanopyOrder; ranked: boolean };

/**
 * Where the list goes next. It opens in the order it was left, ranked afresh
 * before its first paint only when something was read while it was closed.
 * While open it re-ranks after a scan that read something new, once the user
 * has been idle a while and not more often than every few seconds, never under
 * the pointer, and at once when they press Refresh. The clock never moves it.
 * A run new since the last rank goes after the ranked ones, in the order it
 * arrived, and an ask newly urgent moves up to its place alone, leaving every
 * other row where it is.
 */
export function nextCanopyOrder(order: CanopyOrder | null, input: CanopyRankInput): CanopyRankStep {
  const ranked: CanopyOrder = {
    ids: order === null ? input.fresh : rerank(order.ids, input.fresh, input.priorities),
    rankedFor: input.refreshedAt,
    urgent: input.urgent,
  };
  const stale = order === null || order.rankedFor !== input.refreshedAt;
  if (input.opening) return stale ? { kind: "set", order: ranked, ranked: true } : { kind: "hold" };
  if (order === null || input.requested) return { kind: "set", order: ranked, ranked: true };

  // Runs that left are dropped before anything is placed against them.
  const live = new Set(input.fresh);
  const kept = order.ids.filter((id) => live.has(id));
  const placed = new Set(kept);
  const arrived = input.fresh.filter((id) => !placed.has(id));
  // What is urgent now, so an ask that stops and asks again is placed again;
  // under a press nothing is promoted, and the promotion waits for its release.
  const wasUrgent = new Set(order.urgent);
  const newlyUrgent = input.pressing ? [] : input.urgent.filter((id) => !wasUrgent.has(id));
  const urgent = input.pressing ? order.urgent : input.urgent;
  const urgentLeft = !input.pressing && order.urgent.some((id) => !input.urgent.includes(id));
  if (
    newlyUrgent.length > 0 ||
    arrived.length > 0 ||
    kept.length !== order.ids.length ||
    urgentLeft
  ) {
    return {
      kind: "set",
      order: {
        ...order,
        ids: promote([...kept, ...arrived], newlyUrgent, input.fresh),
        urgent,
      },
      ranked: false,
    };
  }

  if (!stale || input.pointerInList || input.pressing) return { kind: "hold" };
  const wait = Math.max(
    input.lastInteractionAt + CANOPY_RANK_IDLE_MS - input.now,
    input.lastRankAt + CANOPY_RANK_SPACING_MS - input.now
  );
  return wait <= 0 ? { kind: "set", order: ranked, ranked: true } : { kind: "wait", ms: wait };
}

/**
 * The list ranked again with as little movement as the new priorities allow:
 * rows pass one another only where one's priority now beats the other's, and
 * rows that tie keep the places they had. New runs join in the readers' order
 * before the sort places them.
 */
function rerank(
  current: readonly string[],
  fresh: readonly string[],
  priorities: ReadonlyMap<string, number>
): string[] {
  const live = new Set(fresh);
  const placed = new Set(current);
  const rows = [...current.filter((id) => live.has(id)), ...fresh.filter((id) => !placed.has(id))];
  return rows
    .map((id, index) => ({ id, index, priority: priorities.get(id) ?? 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((row) => row.id);
}

/**
 * Moves each of `ids` up to just before the first row the readers now rank
 * below it, or leaves it where it is when nothing above it ranks below it.
 */
function promote(
  current: readonly string[],
  ids: readonly string[],
  fresh: readonly string[]
): string[] {
  const rank = new Map(fresh.map((id, index) => [id, index]));
  let out = [...current];
  for (const id of ids) {
    const own = rank.get(id);
    const from = out.indexOf(id);
    if (own === undefined || from === -1) continue;
    const to = out.findIndex(
      (other, index) => index < from && (rank.get(other) ?? Number.POSITIVE_INFINITY) > own
    );
    if (to === -1) continue;
    out = out.filter((other) => other !== id);
    out.splice(to, 0, id);
  }
  return out;
}
