/** How long the user must leave the panel alone before the list may re-rank. */
export const CANOPY_RANK_IDLE_MS = 5_000;
/** The least time between two re-ranks the user didn't ask for. */
export const CANOPY_RANK_SPACING_MS = 10_000;
/**
 * The longest an opening list keeps placing runs as their scores land, before
 * it holds still like any other: long enough for the readings an open sets off.
 */
export const CANOPY_REVEAL_MS = 15_000;

/**
 * How far one run's priority must beat another's to pass it. The readers
 * refine a score by a few points as they write words — on the traces, most
 * refinements land within this of the score the background read gave, and
 * those that land further change what the run needs — so a smaller difference
 * is noise to hold still through, not a reason to move.
 */
export const CANOPY_RANK_MARGIN = 10;

/** One scope's order: each scope ranks its own runs, so switching never buries another's. */
export interface CanopyOrder {
  ids: readonly string[];
  /** The snapshot's `refreshedAt` this order was ranked for. */
  rankedFor: number | null;
  /** The runs that were urgent when it was ranked: a run urgent since is placed at once. */
  urgent: readonly string[];
  /**
   * The runs in the Needs you band: those that needed the user when it was
   * ranked, and asks urgent since. A run joins or leaves only when the order
   * may move, so a reading or a reply never shifts the rows under the user.
   */
  band: readonly string[];
}

export interface CanopyRankInput {
  /** Every run, in the order the readers rank them now. */
  fresh: readonly string[];
  /** Each run's priority now, which a re-rank sorts by. */
  priorities: ReadonlyMap<string, number>;
  /** The runs that page the user now. */
  urgent: readonly string[];
  /** The runs that need the user now: the band a re-rank gives. */
  needsYou: readonly string[];
  /** The run the panel has selected: never taken out of the band under the user. */
  selected: string | null;
  refreshedAt: number | null;
  now: number;
  /** The panel is opening, or switching scope: the user's own move. */
  opening: boolean;
  /**
   * Just opened, and readings it set off are still landing: the list shows
   * every run at once in its last known order and moves each to its place as
   * its score arrives, rather than holding still for a pause — unless the
   * pointer is over the list.
   */
  revealing?: boolean;
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
 * other row where it is. The Needs you band moves with the list: a run joins
 * or leaves it only at a rank, save an ask newly urgent, which joins it as it
 * is placed — and the selected run stays in it while it is selected.
 */
export function nextCanopyOrder(order: CanopyOrder | null, input: CanopyRankInput): CanopyRankStep {
  // A rank records what is urgent now, so an ask newly urgent is placed by it
  // as it would be by the promotion below — the margin holds near scores, not
  // an ask the user is paged for.
  const ranked: CanopyOrder = {
    ids:
      order === null
        ? input.fresh
        : promote(
            rerank(order.ids, input.fresh, input.priorities),
            input.urgent.filter((id) => !order.urgent.includes(id)),
            input.fresh
          ),
    rankedFor: input.refreshedAt,
    urgent: input.urgent,
    band: rankedBand(order, input),
  };
  // A scan read something new, or who needs the user changed without one: a
  // reply, or what Daintree itself saw of a run.
  const stale =
    order === null ||
    order.rankedFor !== input.refreshedAt ||
    !sameMembers(ranked.band, order.band);
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
    // The band holds while the list does: only an ask newly urgent joins it now.
    const needs = new Set(input.needsYou);
    const joined = newlyUrgent.filter((id) => needs.has(id) && !order.band.includes(id));
    return {
      kind: "set",
      order: {
        ...order,
        ids: promote([...kept, ...arrived], newlyUrgent, input.fresh),
        urgent,
        band: [...order.band.filter((id) => live.has(id)), ...joined],
      },
      ranked: false,
    };
  }

  if (input.pressing) return { kind: "hold" };
  // Revealing, every score that lands moves its run at once — a classification
  // lands well before the scan that asked for it ends, so this goes by the
  // priorities themselves rather than the scan's mark. The pointer over the
  // list holds it even then: the user is reading where things are.
  if (input.revealing && !input.pointerInList) {
    return sameIds(ranked.ids, order.ids) && !stale
      ? { kind: "hold" }
      : { kind: "set", order: ranked, ranked: true };
  }
  if (!stale || input.pointerInList) return { kind: "hold" };
  const wait = Math.max(
    input.lastInteractionAt + CANOPY_RANK_IDLE_MS - input.now,
    input.lastRankAt + CANOPY_RANK_SPACING_MS - input.now
  );
  return wait <= 0 ? { kind: "set", order: ranked, ranked: true } : { kind: "wait", ms: wait };
}

/**
 * A scan read something new since the list was ranked and placing it would
 * move rows, or a run would join or leave the Needs you band, but the list is
 * holding still: the reorder the user can apply now. The clock alone never
 * makes one, and neither does a score within the margin.
 */
export function canopyReorderWaiting(
  order: CanopyOrder | null,
  input: Pick<CanopyRankInput, "fresh" | "priorities" | "refreshedAt" | "needsYou" | "selected">
): boolean {
  if (order === null) return false;
  if (!sameMembers(rankedBand(order, input), order.band)) return true;
  if (order.rankedFor === input.refreshedAt) return false;
  return !sameIds(rerank(order.ids, input.fresh, input.priorities), order.ids);
}

/**
 * The band a rank gives: every run that needs the user now, and the selected
 * run if it was in the band — a reply reads as replied where it is, and the
 * run leaves at a rank once the user has moved off it.
 */
function rankedBand(
  order: CanopyOrder | null,
  input: Pick<CanopyRankInput, "fresh" | "needsYou" | "selected">
): string[] {
  const selected = input.selected;
  const kept = selected !== null && order?.band.includes(selected) === true ? selected : null;
  const needs = new Set(input.needsYou);
  return input.fresh.filter((id) => needs.has(id) || id === kept);
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => b[index] === id);
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  const members = new Set(a);
  return a.length === b.length && b.every((id) => members.has(id));
}

/**
 * The list ranked again with as little movement as the new priorities allow:
 * a row moves only when it beats a row above it by `CANOPY_RANK_MARGIN` or
 * more, and no row is left below one that beats it by that much. Rows nearer
 * than that keep their places — unless a row moving past a clearly lower one
 * has to pass them on the way, since holding every near pair would leave a
 * run below one it clearly outranks, through a chain of small steps. New runs
 * join in the readers' order before they are placed.
 *
 * Highest first, each row moves up to just above the highest row it clearly
 * beats. A row placed earlier ranks at least as high, so it beats whatever a
 * later row beats and is already above it: no later move passes it, and no
 * row ends up below one that clearly beats it.
 */
function rerank(
  current: readonly string[],
  fresh: readonly string[],
  priorities: ReadonlyMap<string, number>
): string[] {
  const live = new Set(fresh);
  const placed = new Set(current);
  let rows = [...current.filter((id) => live.has(id)), ...fresh.filter((id) => !placed.has(id))];
  const priority = (id: string) => priorities.get(id) ?? 0;
  const highestFirst = rows
    .map((id, index) => ({ id, index }))
    .sort((a, b) => priority(b.id) - priority(a.id) || a.index - b.index)
    .map((row) => row.id);
  for (const id of highestFirst) {
    const from = rows.indexOf(id);
    const to = rows.findIndex(
      (other, index) => index < from && priority(id) - priority(other) >= CANOPY_RANK_MARGIN
    );
    if (to === -1) continue;
    rows = rows.filter((other) => other !== id);
    rows.splice(to, 0, id);
  }
  return rows;
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
