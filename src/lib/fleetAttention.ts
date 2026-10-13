import type { FleetRunRow, RunCanopyRefinement } from "@shared/types/ipc/fleet";
import { isHandBackStop, isHandBackUnseen } from "@shared/utils/runHandBack";
import { canopyPlacement } from "@shared/utils/canopyRefinement";

/**
 * Attention bands, worst-first.
 *
 * The order is the product decision: a run that has stopped and may not restart
 * on input outranks one merely asking a question, which outranks finished work,
 * which outranks work still in flight. Everything else is context rather than a
 * demand, and lives below the fold.
 *
 * Deliberately the same ordering the project switcher's status line already
 * implies (`src/lib/projectRowStatus.ts`), one grain finer. Two surfaces
 * disagreeing about which agent is most urgent is worse than either ordering
 * being individually wrong.
 *
 * `quiet` sits directly under `needs-you`. A run that is nominally working but
 * has been silent past main's stall threshold is the second question this
 * surface exists to answer, and while it is not a demand — nobody is asking
 * the user for anything — it outranks finished work, because a stall that goes
 * unseen costs the rest of the morning and a hand-back costs a minute. It sat
 * inside `running` until #11957, where the only trace of it was an annotation
 * on one row: the fleet counts, the filter bar and the group summaries all
 * reported it as ordinary work in flight, so the one run worth finding was the
 * one nothing pointed at.
 *
 * `parked` sits between `done` and `idle`: the user has explicitly shelved the
 * run, so it must never read as a demand — but unlike an idle shell it carries
 * intent (a note, maybe a gate) worth finding above the dead rows.
 *
 * `snoozed` sits just below `parked`, and the order encodes which decision is
 * the stronger one rather than which is the more recent. A park is indefinite
 * and carries a note; a snooze is a ceiling the user expects to lapse. Ranking
 * park above snooze also keeps this list agreeing with `bandForRun`, which
 * checks the park record first — an ordering that disagreed with the
 * precedence check would be a bug nobody could see from either site alone.
 */
export const FLEET_BANDS = [
  "blocked",
  "needs-you",
  "quiet",
  "review",
  "running",
  "done",
  "parked",
  "snoozed",
  "idle",
] as const;

export type FleetBand = (typeof FLEET_BANDS)[number];

/** Bands that constitute a demand on the user — the ones an idle fleet has none of. */
const DEMAND_BANDS: ReadonlySet<FleetBand> = new Set<FleetBand>(["blocked", "needs-you", "review"]);

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

/**
 * Which band a run belongs to.
 *
 * A stop is a hand-back only when main watched the run do the work before it:
 * that record carries the run's own seen state, so `review` against `done` is
 * the user's look at this run rather than a workspace-wide watermark. A stop
 * main never saw work before — a restored session, a flicker under the work
 * bar, a shell sitting at its prompt — has handed nothing back and reads as
 * `idle`, not as the agent asking for something. Only a wait that names what
 * it wants (an approval, a question, an error) is a demand.
 *
 * A park beats every state, including `blocked`. Parking is the user saying
 * "this one does not need me until further notice", and an attention model
 * that second-guesses that promise the moment something looks urgent is a
 * model the user has to keep re-checking — the exact cost parking exists to
 * remove. The release paths (manual unpark, gate coming free, gate closed)
 * are the only ways back above the fold, and all of them are the user's own
 * rules firing.
 */
export function bandForRun(run: FleetRunRow): FleetBand {
  if (run.park !== undefined) return "parked";
  // Presence alone, deliberately: main strips expired snoozes before the row is
  // built, so this needs no clock. A run carrying both records reads as parked
  // — the stronger, indefinite decision wins, matching FLEET_BANDS' order.
  if (run.snooze !== undefined) return "snoozed";
  // Canopy's reading refines the free rules below and sits under the user's
  // own decisions above. Seeing a question answers nothing, so an ask holds
  // whatever the hand-back's seen state says — the seen mark itself is left
  // alone, and comes back into force the moment the turn moves on.
  const canopy = runCanopyPlacement(run);
  if (canopy?.kind === "asked") return "needs-you";
  if (canopy?.kind === "not-asking") {
    // A question wait is never recorded as a hand-back, so the run's record is
    // from an earlier stop and says nothing about this one. The wait is the
    // stop, and whether the user has read it is Canopy's mark for its turn.
    return canopy.seen ? "done" : "review";
  }
  // A stop main watched the run make after work it saw is a hand-back, and
  // whether the user has had it in front of them since is main's to say — so
  // it holds through the slide from `completed` into a generic `waiting`. The
  // same stop with no record handed nothing back: a prompt is not a question.
  if (run.agentState !== undefined && isHandBackStop(run.agentState, run.waitingReason)) {
    if (run.handBack === undefined) return "idle";
    return isHandBackUnseen(run.handBack) ? "review" : "done";
  }
  switch (run.agentState) {
    case "waiting":
      return run.waitingReason === "error" ? "blocked" : "needs-you";
    case "working":
    case "directing":
      // Presence alone, like the park and snooze records above: main only puts
      // `quietSince` on the wire once the silence has crossed its stall
      // threshold, so this needs no clock and no threshold of its own.
      return run.quietSince !== undefined || canopy?.kind === "stalled" ? "quiet" : "running";
    default:
      return "idle";
  }
}

/** The Canopy refinement placing this run now, if any; see `canopyPlacement`. */
export function runCanopyPlacement(run: FleetRunRow): RunCanopyRefinement | undefined {
  return canopyPlacement(
    run.agentState,
    run.waitingReason,
    run.canopy,
    run.quietSince !== undefined
  );
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
export function bandLabel(band: FleetBand, run: FleetRunRow): string {
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
      // Dated from the stop itself, not the slide into `waiting` after it. A
      // question wait Canopy read as asking nothing is its own stop; the
      // record, if any, is an earlier one.
      if (runCanopyPlacement(run)?.kind === "not-asking") return run.since;
      return run.handBack?.stoppedAt ?? run.since;
    case "needs-you":
      // An ask Canopy read on a hand-back is as old as the stop it was asked
      // at: the slide from `completed` into a prompt wait would otherwise make
      // an outstanding question look new and sort it under fresher demands.
      return runCanopyPlacement(run)?.kind === "asked"
        ? (run.handBack?.stoppedAt ?? run.since)
        : run.since;
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
