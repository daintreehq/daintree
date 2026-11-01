import type { FleetRunRow, FleetSnapshot } from "@shared/types/ipc/fleet";
import {
  FLEET_BANDS,
  bandForRun,
  runCanopyPlacement,
  type FleetBand,
} from "@shared/utils/fleetBands";
import { isHandBackStop } from "@shared/utils/runHandBack";

export { FLEET_BANDS, bandForRun, runCanopyPlacement, type FleetBand };

/** Bands that constitute a demand on the user — the ones an idle fleet has none of. */
export const DEMAND_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>([
  "blocked",
  "needs-you",
  "review",
]);

export function isDemandBand(band: FleetBand): boolean {
  return DEMAND_BANDS.has(band);
}

/**
 * Bands worth pointing at, which is a wider set than the demands.
 *
 * `quiet` is deliberately NOT a demand: nothing is asking the user for
 * anything, and folding it into the demand count would make "3 agents need
 * you" promise three conversations and deliver two — the exact overstatement
 * the per-run seen state exists to prevent. It is still the
 * thing a group header has to be able to point at, so the chip and the summary
 * read this set rather than the demand one.
 */
const ATTENTION_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>([...DEMAND_BANDS, "quiet"]);

export function isAttentionBand(band: FleetBand): boolean {
  return ATTENTION_BANDS.has(band);
}

/**
 * The bands behind the three state buckets every surface names the same way:
 * Pilot's segments and the worktree sidebar's quick-state filter read these
 * sets, so "Attention" or "Finished" cannot mean one set of agents in one place
 * and another set elsewhere. Narrower than {@link isAttentionBand} on purpose —
 * `review` is a hand-back, not something an agent is asking.
 */
export const ATTENTION_FILTER_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>([
  "blocked",
  "needs-you",
]);
export const WORKING_FILTER_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["running"]);
export const FINISHED_FILTER_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["review", "done"]);
/** The unread half of Finished: hand-backs nobody has had in front of them yet. */
export const UNREAD_FILTER_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["review"]);

const bandRunKeyCache = new WeakMap<FleetSnapshot, Map<ReadonlySet<FleetBand>, string>>();

/**
 * Every run in one of `bands`, as one sorted string of run ids (terminal ids).
 * A primitive, so a store selector over it only re-renders when membership
 * changes rather than on every fleet push. A snapshot not yet delivered holds
 * nobody: the park, snooze and hand-back facts are unknown, and guessing them
 * from the panel would count every prompt as a question.
 *
 * Cached per snapshot and band set, so `bands` must be a module constant.
 */
export function fleetBandRunKey(
  snapshot: FleetSnapshot | null,
  bands: ReadonlySet<FleetBand>
): string {
  if (snapshot === null) return "";
  let bySet = bandRunKeyCache.get(snapshot);
  if (bySet === undefined) {
    bySet = new Map();
    bandRunKeyCache.set(snapshot, bySet);
  }
  const cached = bySet.get(bands);
  if (cached !== undefined) return cached;
  const ids: string[] = [];
  for (const run of snapshot.runs) {
    if (bands.has(bandForRun(run))) ids.push(run.runId);
  }
  const key = ids.sort().join("\n");
  bySet.set(bands, key);
  return key;
}

/** The one band amber stands for: a Canopy reading of an ask the user hasn't seen. */
export const NEEDS_YOU_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["needs-you"]);

const bandIndexCache = new WeakMap<FleetSnapshot, Map<string, FleetBand>>();

/**
 * One run's band (`runId` is the terminal id). Undefined until the snapshot
 * arrives and for a run it doesn't hold: without the fleet's park, hand-back
 * and Canopy facts nothing can be placed, and a guess from the panel would
 * read every prompt as a question.
 */
export function fleetBandForRun(
  snapshot: FleetSnapshot | null,
  runId: string
): FleetBand | undefined {
  if (snapshot === null) return undefined;
  let index = bandIndexCache.get(snapshot);
  if (index === undefined) {
    index = new Map();
    for (const run of snapshot.runs) index.set(run.runId, bandForRun(run));
    bandIndexCache.set(snapshot, index);
  }
  return index.get(runId);
}

/**
 * The band's own name for what the run is doing.
 *
 * Derived from the band rather than re-read from `agentState` so the visible
 * label, the tone and the ordering can never disagree — a seen hand-back
 * must not still say "unread" while sorting as done.
 * `running` and `idle` split on state because they each cover two situations
 * the user can tell apart and would want to.
 *
 * These are STATE names, and they stay narrow. The filter segment above them
 * says "Attention", which is a BUCKET name and deliberately wider: it holds
 * `blocked` and `needs-you` together, so it cannot borrow either one's word
 * without making a claim about the other. A row is never ambiguous, so it gets
 * to be exact. The prose sentences elsewhere ("2 agents need you") are
 * sentences, not state labels, and keep their own phrasing again.
 */
export function bandLabel(band: FleetBand, run: Pick<FleetRunRow, "agentState">): string {
  switch (band) {
    case "blocked":
      return "Blocked";
    case "needs-you":
      return "Waiting";
    case "review":
      return "Unread";
    case "running":
      return run.agentState === "directing" ? "Directing" : "Working";
    case "quiet":
      return "Quiet";
    case "done":
      return "Finished";
    case "parked":
      return "Parked";
    case "snoozed":
      return "Snoozed";
    case "idle":
      return run.agentState === "exited" ? "Exited" : "Idle";
    default: {
      // Exhaustive: a new band must pick its words here, not inherit idle's.
      const exhaustive: never = band;
      return exhaustive;
    }
  }
}

/**
 * The moment a band is actually about.
 *
 * `since` is when the agent last changed STATE, which is the right clock for
 * most bands and the wrong one for the three whose band was decided by
 * something else entirely. A park is dated from the park, a snooze from the
 * snooze, and a silence from the silence — otherwise a run parked ten seconds
 * ago reads as three hours old because that is how long it waited first, and
 * two silent agents rank by how long they have been WORKING rather than by how
 * long they have said nothing.
 *
 * One function, read by the row's clock, by the within-band ordering and by
 * the initial cursor, so the number on screen, the position in the list and
 * the row Enter opens can never be measuring three different things.
 */
export function bandTimestamp(run: FleetRunRow, band: FleetBand): number | undefined {
  switch (band) {
    case "parked":
      return run.park?.parkedAt ?? run.since;
    case "snoozed":
      return run.snooze?.snoozedAt ?? run.since;
    case "quiet": {
      if (run.quietSince !== undefined) return run.quietSince;
      const canopy = runCanopyPlacement(run);
      return canopy?.kind === "stalled" ? canopy.stalledSince : run.since;
    }
    case "review":
    case "done":
    case "needs-you":
      // Dated from the stop itself, not the slide into `waiting` after it: an
      // outstanding question would otherwise look new and sort under fresher
      // demands. An approval or question wait is its own stop, and a hand-back
      // record the run carries then is an earlier one.
      if (run.agentState !== undefined && isHandBackStop(run.agentState, run.waitingReason)) {
        return run.handBack?.stoppedAt ?? run.since;
      }
      return run.wait?.stoppedAt ?? run.since;
    default:
      return run.since;
  }
}

/**
 * Sort key within a band: oldest demand first.
 *
 * Oldest-first rather than newest-first is the anti-starvation choice. A stream
 * of fresh completions must never bury the run that has been stuck for forty
 * minutes — that is the exact failure that teaches a user to stop trusting the
 * top of the list.
 *
 * A run with no timestamp sorts last within its band rather than first: an
 * unknown age is not evidence of urgency, and treating it as infinitely old
 * would let a pre-detection boot window outrank a genuine forty-minute block.
 *
 * `band` is required rather than re-derived: callers have already computed it
 * to decide that these two belong in the same bucket, and computing it twice
 * is a second chance for the ordering to disagree with the band it is ordering.
 */
export function compareWithinBand(a: FleetRunRow, b: FleetRunRow, band: FleetBand): number {
  const aSince = bandTimestamp(a, band);
  const bSince = bandTimestamp(b, band);
  if (aSince !== undefined && bSince !== undefined && aSince !== bSince) return aSince - bSince;
  // An unknown age sorts after a known one, and two unknowns fall through to
  // the id tiebreak — so the comparator stays a total order rather than
  // reporting an arbitrary winner for a pair it cannot actually rank.
  if (aSince === undefined && bSince !== undefined) return 1;
  if (bSince === undefined && aSince !== undefined) return -1;
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/**
 * Runs per band, for summary copy.
 *
 * Bands are counted rather than the raw run total because a raw total cannot be
 * described truthfully: a fleet of eight rows holding two working agents and six
 * exited ones is not "8 agents running", and a summary line that overstates what
 * is live is the fastest way to stop being believed.
 */
export type FleetBandCounts = Record<FleetBand, number>;

export function emptyBandCounts(): FleetBandCounts {
  return {
    blocked: 0,
    "needs-you": 0,
    quiet: 0,
    review: 0,
    running: 0,
    done: 0,
    parked: 0,
    snoozed: 0,
    idle: 0,
  };
}
