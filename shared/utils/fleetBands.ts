import type { FleetRunRow, RunCanopyRefinement } from "../types/ipc/fleet.js";
import {
  isHandBackStop,
  isHandBackUnseen,
  isObservedAskWait,
  isWaitUnseen,
} from "./runHandBack.js";
import { canopyPlacement, isAskableStop } from "./canopyRefinement.js";

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
  | "agentState"
  | "waitingReason"
  | "handBack"
  | "wait"
  | "handbackReport"
  | "canopy"
  | "quietSince"
  | "answerAttention"
  | "questionAttention"
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
 * `needs-you` has three sources, and none is a guess from the patterns:
 *
 * - The agent's own needs-you marker (#16190), while the run is still stopped.
 *   Daintree saw it printed, so it is an observation of the agent's claim, and
 *   it outranks Canopy's reading of the same stop either way. It holds once
 *   seen: a deploy URL someone glanced at and walked away from is exactly the
 *   one that sits for hours. It leaves when the terminal's handback clears, on
 *   the next prompt or a respawn, and a park or snooze sets it aside as it
 *   does every other state.
 * - What Daintree Decisions recorded for the run while its agent is still
 *   there: a question open in Needs you that the user hasn't cleared on this
 *   computer, or an answer whose delivery stopped for them to decide. It
 *   holds whatever the agent is doing, at work or stopped, since an agent
 *   told to carry on after asking still waits for the answer. It outranks a
 *   reading of the screen, and an error wait stays `blocked`, the worse band.
 * - A Canopy reading of the run's current turn that says it asks the user
 *   something, which the user hasn't had in front of them since. Looking
 *   answers nothing, but an ask already seen is no longer news, and it lands
 *   where an idle run does — never `done`, since the run hasn't finished.
 *
 * Without either, an approval or question wait is the patterns' guess: unread
 * (`review`) until looked at, then idle, and never a demand. An error wait is
 * `blocked` whatever the agent printed.
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
  // The agent's own word beats a model's reading of its screen, and seeing it
  // answers nothing, so no read mark is consulted.
  if (isAgentReportedNeed(run)) return "needs-you";
  // What Decisions recorded, so like the agent's word no read mark is consulted.
  if (isDecisionsNeed(run)) return "needs-you";
  // Canopy's reading refines the free rules below and sits under the user's
  // own decisions and the agent's word above. Whether an ask was seen is
  // Canopy's read mark for its turn, not the hand-back's: a hand-back record is
  // about a stop, and the ask may be a later one. Seen, it is still
  // unanswered, so never `done`.
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

/**
 * The run's handback marker says it needs the user, and the run is still
 * stopped where that could be so: finished, or waiting on anything but an
 * error. The report outlives the stop it was printed at until the next prompt
 * clears it, so a run that has gone back to work, or whose agent is gone, is
 * not placed by it — and is again if it settles before that prompt.
 */
export function isAgentReportedNeed(
  run: Pick<FleetRunRow, "agentState" | "waitingReason" | "handbackReport">
): boolean {
  return (
    run.handbackReport === "needs-you" &&
    run.agentState !== undefined &&
    isAskableStop(run.agentState, run.waitingReason)
  );
}

/**
 * Daintree Decisions holds something for the user on this run (an open
 * question they haven't cleared, or an answer whose delivery stopped) while
 * its agent is still there and not failed: an exited agent can't be asked
 * anything, and an error wait is `blocked`.
 */
export function isDecisionsNeed(
  run: Pick<FleetRunRow, "agentState" | "waitingReason" | "answerAttention" | "questionAttention">
): boolean {
  if ((run.answerAttention ?? 0) <= 0 && (run.questionAttention ?? 0) <= 0) return false;
  const state = run.agentState;
  if (state === undefined || state === "exited") return false;
  return !(state === "waiting" && run.waitingReason === "error");
}

/**
 * Whose ask an outstanding one is: the agent printed that it needs the user,
 * Canopy read the stop as asking, or the patterns observed an approval or
 * question wait no reading placed.
 */
export type UnseenAsk = "agent" | "canopy" | "observed";

/**
 * The run's current stop as an ask the full-pane amber edge marks: anything in
 * `needs-you` — the agent's own report, which holds once seen, or Canopy's
 * unread ask — or, where neither places the stop, an approval or question wait
 * the patterns observed and the user hasn't seen: `review` for that reason
 * alone, never for a hand-back or a question Canopy read as asking nothing.
 * Undefined otherwise.
 *
 * Read off the band, so the park, the snooze, the agent's report and Canopy
 * keep their precedence, and the look that marks a Canopy ask or an observed
 * wait seen drops it. Only the pane edge reads it: glyphs and counts keep to
 * the band, where an observed ask is unread news and never a demand. A run
 * Decisions alone placed has no ask on its screen to mark: the pane's own
 * Decisions chip says what is open.
 */
export function runUnseenAsk(
  run: BandableRun,
  band: FleetBand = bandForRun(run)
): UnseenAsk | undefined {
  if (band === "needs-you") {
    if (isAgentReportedNeed(run)) return "agent";
    const canopy = runCanopyPlacement(run);
    return canopy?.kind === "asked" && !canopy.seen ? "canopy" : undefined;
  }
  if (band !== "review" || run.agentState === undefined) return undefined;
  if (!isObservedAskWait(run.agentState, run.waitingReason)) return undefined;
  return runCanopyPlacement(run) === undefined ? "observed" : undefined;
}

/**
 * The Canopy reading that placed this run in `band`, or undefined when
 * something else did: a park or snooze, the agent's own needs-you report,
 * what Decisions recorded, or the free rules alone. Each of those outranks a reading in
 * {@link bandForRun}, so a refinement that would still apply to the observed
 * state isn't the run's placement while one of them holds.
 */
export function canopyPlacingRun(
  run: BandableRun,
  band: FleetBand = bandForRun(run)
): RunCanopyRefinement | undefined {
  if (band === "parked" || band === "snoozed" || isAgentReportedNeed(run) || isDecisionsNeed(run)) {
    return undefined;
  }
  return runCanopyPlacement(run);
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
