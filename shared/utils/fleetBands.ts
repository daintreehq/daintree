import type { FleetRunRow, RunCanopyRefinement } from "../types/ipc/fleet.js";
import { isHandBackStop, isHandBackUnseen, isWaitUnseen } from "./runHandBack.js";
import { canopyPlacement } from "./canopyRefinement.js";

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

/**
 * What {@link bandForRun} reads of a run. A fleet row is one; main's
 * per-project counts build one from the same records, so the switcher and the
 * fleet can't place a run differently.
 */
export type BandableRun = Pick<
  FleetRunRow,
  "agentState" | "waitingReason" | "handBack" | "wait" | "canopy" | "quietSince"
> & {
  /** Read for presence alone, like the snooze. */
  park?: unknown;
  snooze?: unknown;
};

/**
 * Which band a run belongs to.
 *
 * A stop is a hand-back only when main watched the run do the work before it:
 * that record carries the run's own seen state, so `review` against `done` is
 * the user's look at this run rather than a workspace-wide watermark. A stop
 * main never saw work before — a restored session, a flicker under the work
 * bar, a shell sitting at its prompt — has handed nothing back and reads as
 * `idle`, not as the agent asking for something.
 *
 * `needs-you` is Canopy's alone: a reading of the run's current turn that says
 * it asks the user something, which the user hasn't had in front of them
 * since. Looking answers nothing, but an ask already seen is no longer news,
 * and it lands where an idle run does — never `done`, since the run hasn't
 * finished. Without a reading, an approval or question wait is the patterns'
 * guess: unread (`review`) until looked at, then idle, and never a demand. An
 * error wait is `blocked` either way.
 *
 * A park beats every state, including `blocked`. Parking is the user saying
 * "this one does not need me until further notice", and an attention model
 * that second-guesses that promise the moment something looks urgent is a
 * model the user has to keep re-checking — the exact cost parking exists to
 * remove. The release paths (manual unpark, gate coming free, gate closed)
 * are the only ways back above the fold, and all of them are the user's own
 * rules firing.
 */
export function bandForRun(run: BandableRun): FleetBand {
  if (run.park !== undefined) return "parked";
  // Presence alone, deliberately: main strips expired snoozes before the row is
  // built, so this needs no clock. A run carrying both records reads as parked
  // — the stronger, indefinite decision wins, matching FLEET_BANDS' order.
  if (run.snooze !== undefined) return "snoozed";
  // Canopy's reading refines the free rules below and sits under the user's
  // own decisions above. Whether an ask was seen is Canopy's read mark for its
  // turn, not the hand-back's: a hand-back record is about a stop, and the ask
  // may be a later one. Seen, it is still unanswered, so never `done`.
  const canopy = runCanopyPlacement(run);
  if (canopy?.kind === "asked") return canopy.seen ? "idle" : "needs-you";
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
      // What is left is an approval or question wait no reading placed: news
      // until looked at, then nothing more than an idle run.
      if (run.waitingReason === "error") return "blocked";
      return isWaitUnseen(run.wait) ? "review" : "idle";
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
export function runCanopyPlacement(
  run: Pick<FleetRunRow, "agentState" | "waitingReason" | "canopy" | "quietSince">
): RunCanopyRefinement | undefined {
  return canopyPlacement(
    run.agentState,
    run.waitingReason,
    run.canopy,
    run.quietSince !== undefined
  );
}
