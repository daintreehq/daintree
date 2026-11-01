import type { AgentState, WaitingReason } from "../../shared/types/agent.js";
import type { PanelKind } from "../../shared/types/panel.js";
import type {
  RunCanopyRefinement,
  RunHandBackRecord,
  RunWaitRecord,
} from "../../shared/types/ipc/fleet.js";
import { isHandBackStop, isObservedAskWait } from "../../shared/utils/runHandBack.js";
import { canopyPlacement } from "../../shared/utils/canopyRefinement.js";
import { bandForRun } from "../../shared/utils/fleetBands.js";
import { isHostThrowawayWorkspaceId } from "../../shared/config/hostThrowaway.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";

/** Per-project agent tallies derived from the live terminal list. */
export interface ProjectAgentCounts {
  active: number;
  /**
   * Agents the fleet bands as needing the user: an ask Canopy read that the
   * user hasn't seen yet (`needs-you`), plus the error waits in {@link blocked}
   * (#16058). A stop with no reading is never one, whatever its wait reason.
   */
  waiting: number;
  /** Agents blocked on an error (the `blocked` band) — a subset of {@link waiting}. */
  blocked: number;
  /** Earliest transition into `waiting`, or null when nothing is waiting. */
  oldestWaitingSince: number | null;
  /**
   * Agents that handed work back: settled in `completed`, or stopped at a plain
   * prompt after work main watched. Seen or not — this is presence, and
   * {@link unacknowledgedCompleted} is the part that asks for attention.
   */
  completed: number;
  /**
   * Agents the fleet bands as unread (`review`): an unseen hand-back, a
   * question wait Canopy read as asking nothing, or an approval or question
   * wait no reading placed that the user hasn't had in front of them. A run
   * main never watched hand back is never one. A subset of {@link completed}.
   */
  unacknowledgedCompleted: number;
  /** Earliest unacknowledged completion, or null when everything was seen. */
  oldestUnacknowledgedCompletionAt: number | null;
  /** Latest unacknowledged completion, or null when everything was seen. */
  latestUnacknowledgedCompletionAt: number | null;
  /**
   * Latest completion with no hand-back record that the project watermark
   * hasn't covered yet. Null when there is none. Main-only — the completion
   * acknowledger stamps this, never {@link latestUnacknowledgedCompletionAt},
   * because a recorded hand-back answers only to its own seen state. It no
   * longer decides attention: such a completion is idle in the fleet (#16058).
   */
  latestWatermarkUnacknowledgedAt: number | null;
  /** Latest completion regardless of acknowledgement, for "finished 2h ago". */
  latestCompletionAt: number | null;
  /** Latest transition into `working`, or null. Orders the Running band. */
  latestWorkingSince: number | null;
  /**
   * Agents the user snoozed — counted whatever they are doing underneath, so
   * this is NOT a subset of any single state above.
   *
   * A snoozed run keeps contributing to {@link active} and {@link completed}
   * (snooze suppresses attention, not presence) but is withheld from
   * {@link waiting}, {@link blocked} and {@link unacknowledgedCompleted}, which
   * are the tallies that make a project read as needing someone. Without this
   * field a project whose every agent is snoozed would be indistinguishable
   * from one with nothing in it. A parked run is withheld from the same three
   * tallies, but is not counted here.
   */
  snoozed: number;
  /**
   * Earliest wake time among snoozed agents, or null when nothing is snoozed —
   * or when every snooze is the unlimited option, which has no wake time.
   *
   * Lets a row say "until 3:45 PM" instead of drawing a countdown, which is the
   * point: the wake time has to be discoverable without a ticking number
   * pulling the eye back to the run the user just shelved.
   */
  nextSnoozeWakeAt: number | null;
  /**
   * Live Daintree Assistant PTYs. The PTY host tallies these into
   * `terminalCount`, but the assistant is tooling-internal, so callers must
   * subtract this from any process count they report (#10989).
   */
  helpTerminals: number;
  /**
   * What the live Daintree Assistant is doing, or null when this project has
   * no live assistant PTY — or has one the user has hidden (#11806).
   *
   * Reported beside the tallies and never folded into them: the assistant is
   * not a run the user launched, so it must not read as one. It is here at all
   * because the `"help"` exclusion is what made a project whose assistant was
   * working indistinguishable from a dormant one on every cross-project
   * surface — the state was on the terminal record the whole time and simply
   * went unread.
   */
  assistantState: AgentState | null;
  /**
   * Why the assistant is waiting. Null unless {@link assistantState} is
   * `"waiting"` — a terminal record can carry a stale reason out of the state
   * it belonged to, and a working assistant holding a leftover `"error"` would
   * report as blocked.
   */
  assistantWaitingReason: WaitingReason | null;
  /** The assistant's transition into {@link assistantState}, or null. */
  assistantStateSince: number | null;
}

/**
 * The subset of a terminal record these tallies read.
 *
 * The state fields keep their real unions rather than widening to `string`: the
 * blocked-vs-waiting split turns entirely on `waitingReason === "error"`, and a
 * widened field would let that comparison quietly become dead code the day the
 * union is renamed.
 */
export interface CountableTerminal {
  id?: string;
  projectId?: string;
  kind?: PanelKind;
  isTrashed?: boolean;
  hasPty?: boolean;
  agentState?: AgentState;
  waitingReason?: WaitingReason;
  lastStateChange?: number;
  detectedAgentId?: string;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
  /** Sealed at spawn: this PTY backs the Daintree Assistant overlay (#12183). */
  isAssistantTerminal?: boolean;
  /**
   * When this PTY was spawned. Read only to tell one assistant session from
   * another during a displacement — `AgentStateService` already treats it as
   * the live-session identity token, so it is the fact that says which of two
   * overlapping records is the current one.
   */
  spawnedAt?: number;
  /**
   * Which assistant lane this help terminal serves (#12108), or undefined when
   * it serves none — an ordinary terminal, or a displaced assistant backend
   * whose record has already been dropped. Resolved from `HelpSessionService`
   * rather than stored on the panel, so it tracks displacement synchronously.
   */
  assistantSlot?: number;
}

/**
 * Why a terminal is not a countable agent run, or null when it is one.
 *
 * Exported as a reason rather than a boolean because callers have to act on
 * the distinction: `"help"` is the assistant PTY, which the host already
 * tallied into `terminalCount` and which therefore has to be netted back out
 * (#10989), and whose state is reported separately as presence (#11806).
 * Every other reason is simply "not an agent", with nothing left to say.
 */
export type RunExclusionReason =
  "trashed" | "help" | "throwaway" | "dev-preview" | "no-pty" | "not-an-agent";

/**
 * The single definition of "this terminal is an agent run".
 *
 * Shared by the per-project tallies and by the fleet snapshot so the two can
 * never disagree about what counts. They previously answered this question
 * independently and drifted — the assistant PTY showed up as a working agent on
 * one surface and not the other. A second copy of these five rules is a bug
 * waiting to be written, so there is exactly one.
 */
/** An agent gone within this long of its launch failed to start, rather than finished. */
export const LAUNCH_FAILURE_WINDOW_MS = 60_000;

/**
 * Launched as an agent, and the agent was gone within a minute: a crash, a
 * missing login or a broken install, with the reason on screen in the shell it
 * left behind. Still a run — the user asked for an agent and has none, which
 * they need to see — unlike an agent quit on purpose after doing its work.
 */
function diedAtLaunch(terminal: CountableTerminal): boolean {
  return (
    Boolean(terminal.launchAgentId) &&
    !terminal.detectedAgentId &&
    terminal.agentState === "exited" &&
    terminal.spawnedAt !== undefined &&
    terminal.lastStateChange !== undefined &&
    terminal.lastStateChange - terminal.spawnedAt <= LAUNCH_FAILURE_WINDOW_MS
  );
}

export function classifyRun(
  terminal: CountableTerminal,
  isHelpTerminal: (id: string) => boolean
): RunExclusionReason | null {
  if (terminal.isTrashed) return "trashed";

  // The assistant help terminal is a real PTY but tooling-internal: it never
  // counts as an agent. Named rather than silently dropped so callers can net
  // it out of a process count the host already included it in, and so its
  // state can be carried as presence instead of vanishing (#11806).
  //
  // The record stamp is checked first because the callback reads a mark the
  // renderer sends only after the spawn IPC returns, leaving a window where a
  // live assistant tallies as a working agent (#12183). Read inline rather
  // than through `isAssistantTerminalRecord` so this stays importable from the
  // pty-host, which has no availability store.
  if (terminal.isAssistantTerminal === true) return "help";
  if (terminal.id !== undefined && isHelpTerminal(terminal.id)) return "help";
  // A host's throwaway run (#14445) belongs to the Shell session that started
  // it: no tally, fleet row, directory entry or fleet send ever reaches it.
  if (isHostThrowawayWorkspaceId(terminal.projectId)) return "throwaway";

  if (terminal.kind === "dev-preview") return "dev-preview";
  if (terminal.hasPty === false) return "no-pty";

  // Runtime identity wins; launch intent is only a boot-window fallback before
  // detection has ever committed. Demoted ex-agents must not count just because
  // they were launched as agents.
  const hasLiveOrBootAgent =
    Boolean(terminal.detectedAgentId) ||
    (Boolean(terminal.launchAgentId) && terminal.everDetectedAgent !== true);
  if (!hasLiveOrBootAgent && !diedAtLaunch(terminal)) return "not-an-agent";

  return null;
}

function empty(): ProjectAgentCounts {
  return {
    active: 0,
    waiting: 0,
    blocked: 0,
    oldestWaitingSince: null,
    completed: 0,
    unacknowledgedCompleted: 0,
    oldestUnacknowledgedCompletionAt: null,
    latestUnacknowledgedCompletionAt: null,
    latestWatermarkUnacknowledgedAt: null,
    latestCompletionAt: null,
    latestWorkingSince: null,
    snoozed: 0,
    nextSnoozeWakeAt: null,
    helpTerminals: 0,
    assistantState: null,
    assistantWaitingReason: null,
    assistantStateSince: null,
  };
}

/**
 * A timestamp that can be compared and reported, or 0 when it cannot be.
 *
 * Zero, negatives, `NaN` and the infinities are all rejected together. `NaN`
 * in particular has to be screened before any comparison: every comparison
 * against it is false, so it would silently make "which record is newer"
 * depend on the order the host happened to list terminals in.
 */
function usableTimestamp(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Tally one unseen hand-back, dated when known. */
function noteUnacknowledged(entry: ProjectAgentCounts, at: number): void {
  entry.unacknowledgedCompleted += 1;
  if (at <= 0) return;
  entry.oldestUnacknowledgedCompletionAt = Math.min(
    entry.oldestUnacknowledgedCompletionAt ?? Number.POSITIVE_INFINITY,
    at
  );
  entry.latestUnacknowledgedCompletionAt = Math.max(
    entry.latestUnacknowledgedCompletionAt ?? 0,
    at
  );
}

/**
 * Liveness rank for picking which assistant record speaks for a project.
 * Lower wins: actively doing something, then waiting, then settled.
 */
function assistantLiveness(state: AgentState | undefined): number {
  if (state === "working" || state === "directing") return 0;
  if (state === "waiting") return 1;
  return 2;
}

/**
 * Whether `candidate` should replace `incumbent` WITHIN one lane.
 *
 * Two records answer for the same lane only during displacement: a new backend
 * is provisioned while the old one is still being killed. Spawn time decides
 * it, because that is the fact that actually identifies the session —
 * `AgentStateService` uses the same stamp to reject state updates from a
 * superseded run. Liveness cannot lead here: a displaced PTY whose kill has not
 * landed yet still reads `working`, so ranking activity first would let the
 * corpse keep reporting over a new session that is genuinely blocked.
 *
 * The remaining tie-breaks only matter when spawn times are missing or equal,
 * and terminal id closes the last gap, so the answer never depends on listing
 * order.
 */
function beatsWithinLane(candidate: CountableTerminal, incumbent: CountableTerminal): boolean {
  const candidateSpawn = usableTimestamp(candidate.spawnedAt);
  const incumbentSpawn = usableTimestamp(incumbent.spawnedAt);
  if (candidateSpawn !== incumbentSpawn) return candidateSpawn > incumbentSpawn;

  const candidateRank = assistantLiveness(candidate.agentState);
  const incumbentRank = assistantLiveness(incumbent.agentState);
  if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;

  return finalTieBreak(candidate, incumbent);
}

/**
 * Attention rank for picking BETWEEN lanes. Lower wins: blocked on the user,
 * then busy, then settled.
 *
 * Deliberately not {@link assistantLiveness}, which ranks `working` above
 * `waiting` — the right order inside a lane, where the question is "which of
 * these two records is the live session", but the wrong one across lanes,
 * where the question is "which of these sessions needs the user". A busy lane
 * must not silence a sibling that is waiting on an answer.
 */
function assistantAttention(state: AgentState | undefined): number {
  if (state === "waiting") return 0;
  if (state === "working" || state === "directing") return 1;
  return 2;
}

/**
 * Whether `candidate` should replace `incumbent` ACROSS lanes.
 *
 * Different lanes are concurrent sessions the user deliberately started, so
 * whichever one needs the user leads: the project row exists to surface
 * attention, and a busy lane must not silence a sibling that is blocked on a
 * question.
 */
function beatsAcrossLanes(candidate: CountableTerminal, incumbent: CountableTerminal): boolean {
  const candidateRank = assistantAttention(candidate.agentState);
  const incumbentRank = assistantAttention(incumbent.agentState);
  if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;

  const candidateSpawn = usableTimestamp(candidate.spawnedAt);
  const incumbentSpawn = usableTimestamp(incumbent.spawnedAt);
  if (candidateSpawn !== incumbentSpawn) return candidateSpawn > incumbentSpawn;

  return finalTieBreak(candidate, incumbent);
}

function finalTieBreak(candidate: CountableTerminal, incumbent: CountableTerminal): boolean {
  const candidateSince = usableTimestamp(candidate.lastStateChange);
  const incumbentSince = usableTimestamp(incumbent.lastStateChange);
  if (candidateSince !== incumbentSince) return candidateSince > incumbentSince;

  return (candidate.id ?? "") < (incumbent.id ?? "");
}

/**
 * The one assistant that speaks for a project, chosen from every live help
 * terminal it owns (#12108).
 *
 * Reduced in two stages rather than by one pairwise comparator, because the
 * two rules genuinely disagree: within a lane spawn time must lead (a mid-kill
 * corpse still reads `working`), across lanes liveness must lead (attention is
 * the whole point of the row). A single comparator mixing them is CYCLIC — with
 * A(lane 0, idle, t=300), B(lane 0, working, t=100) and C(lane 1, waiting,
 * t=200), A beats B, B beats C and C beats A — so the winner would depend on
 * the order the host happened to list terminals in.
 *
 * Unslotted records are displacement corpses whose session record has already
 * been dropped; they are reduced among themselves and only ever win when no
 * lane has a live representative at all.
 */
function pickProjectAssistant(candidates: CountableTerminal[]): CountableTerminal | null {
  const byLane = new Map<number, CountableTerminal>();
  let unslotted: CountableTerminal | null = null;

  for (const candidate of candidates) {
    if (candidate.assistantSlot === undefined) {
      if (unslotted === null || beatsWithinLane(candidate, unslotted)) unslotted = candidate;
      continue;
    }
    const incumbent = byLane.get(candidate.assistantSlot);
    if (incumbent === undefined || beatsWithinLane(candidate, incumbent)) {
      byLane.set(candidate.assistantSlot, candidate);
    }
  }

  let winner: CountableTerminal | null = null;
  // Ascending lane order so the reduction itself cannot depend on Map insertion
  // order, only on the comparator.
  for (const slot of [...byLane.keys()].sort((a, b) => a - b)) {
    const laneWinner = byLane.get(slot)!;
    if (winner === null || beatsAcrossLanes(laneWinner, winner)) winner = laneWinner;
  }

  return winner ?? unslotted;
}

/**
 * The single definition of what a project's agents are doing.
 *
 * Shared because two callers used to answer this question independently and
 * disagreed: the pushed status map excluded the assistant PTY and knew which
 * waits were error-blocked, while the bulk stats handler did neither. A
 * renderer seeded from bulk therefore showed the assistant as a working agent
 * and reported a blocked agent as merely waiting — and because the push service
 * suppresses unchanged payloads, nothing corrected it until agent state next
 * moved.
 */
export function computeProjectAgentCounts(
  projectIds: readonly string[],
  terminals: readonly CountableTerminal[],
  /**
   * Acknowledgement watermarks: project id → epoch ms up to which the user has
   * seen that project's completions (see `Project.lastCompletionSeenAt`). A
   * project absent from the map has seen nothing, so every timestamped
   * completion counts as unacknowledged. Omitting the map entirely means the
   * caller doesn't consume the acknowledgement split (same effect).
   */
  lastCompletionSeenAt?: ReadonlyMap<string, number>,
  /**
   * Runs the user has snoozed, keyed by terminal id, with expiry ALREADY
   * resolved by the caller — a lapsed snooze must simply be absent.
   *
   * Resolving expiry here would mean taking a clock, and this function is
   * deliberately pure: it is the one definition of what a project's agents are
   * doing, and two callers that disagreed about "now" would reintroduce exactly
   * the drift it exists to prevent. `RunAttentionService.getActiveSnoozes()` is
   * the intended source.
   */
  activeSnoozes?: ReadonlyMap<string, { snoozedUntil?: number }>,
  /**
   * Whether a workspace's assistant panel is currently on screen.
   * `HelpSessionService.isPanelOpen` is the intended source.
   *
   * A hidden assistant reports no state at all: closing the panel keeps the PTY
   * alive until the idle-hibernate timer fires, and a session the user has put
   * away is not something they can be asked to act on. Its PTY is still counted
   * into {@link ProjectAgentCounts.helpTerminals} — the host tallied the
   * process whether or not anyone is looking at it, and failing to net it back
   * out would resurrect the phantom process counts of #10989.
   *
   * Omitting the predicate means the caller doesn't consume the distinction and
   * every live assistant reports, which is what a harness computing raw tallies
   * wants.
   */
  isAssistantVisible?: (workspaceId: string) => boolean,
  /**
   * Which assistant lane a help terminal serves, or null when it serves none
   * (#12108). `HelpSessionService.getSlotForTerminal` is the intended source.
   *
   * Needed once a project can run concurrent assistants, because "two
   * terminals answer to this project" stops meaning "one is a corpse". See
   * {@link pickProjectAssistant}: without a lane, concurrent sessions are
   * ranked by spawn time and a freshly started one silences a sibling that is
   * blocked on the user.
   *
   * Omitting the resolver leaves every candidate unslotted, which is exactly
   * the pre-lane spawn-time ordering — the right answer for a harness
   * computing raw tallies, and for any caller that has no session service.
   */
  assistantSlotForTerminal?: (terminalId: string) => number | null,
  /**
   * The hand-back record main kept for a run, keyed by terminal id and checked
   * against its spawn time so a dead process's record cannot speak for a new
   * one. `RunHandBackService.getRecord` is the intended source.
   *
   * It is what makes a stop at the prompt a hand-back rather than an idle run.
   * Omitted, no stop is one.
   */
  handBackFor?: (terminalId: string, spawnedAt?: number) => RunHandBackRecord | undefined,
  /**
   * Runs the user has parked, keyed by terminal id.
   * `RunAttentionService.getAll()` is the intended source. A park is withheld
   * from every attention tally whatever the run is doing, as the fleet bands
   * it (`bandForRun`); it still counts as presence.
   */
  parkedRuns?: ReadonlyMap<string, unknown>,
  /**
   * Canopy's refinement for a run's incarnation, when it has one —
   * `canopyRefinementFor` is the intended source. An unseen ask it read is the
   * only thing that counts as waiting short of an error, and a question it read
   * as asking nothing is a hand-back of its own, as the fleet bands them; a
   * stall changes no tally here. Omitted, the free rules alone.
   */
  canopyFor?: (terminalId: string, spawnedAt: number) => RunCanopyRefinement | undefined,
  /**
   * The approval or question wait main tracks for a run, checked against its
   * spawn time like the hand-back. `RunHandBackService.getWait` is the
   * intended source. Read only: a wait with no record is unseen, which is the
   * answer the record would give before anyone looked. Omitted, every such wait
   * is unread.
   */
  waitFor?: (terminalId: string, spawnedAt?: number) => RunWaitRecord | undefined
): Map<string, ProjectAgentCounts> {
  const counts = new Map<string, ProjectAgentCounts>();
  for (const id of projectIds) counts.set(id, empty());

  const availability = getAgentAvailabilityStore();
  // Every live assistant terminal per project. Collected rather than reduced
  // inline so the winner is decided by `pickProjectAssistant` over the whole
  // set — the two ranking rules (within a lane, across lanes) cannot be
  // expressed as one pairwise comparator without introducing a cycle.
  const assistantsByProject = new Map<string, CountableTerminal[]>();

  for (const terminal of terminals) {
    if (!terminal.projectId) continue;
    const entry = counts.get(terminal.projectId);
    if (!entry) continue;
    const exclusion = classifyRun(terminal, (id) => availability.isHelpTerminal(id));
    if (exclusion === "help") {
      // Same liveness gate the process-count netting uses: a help terminal
      // with no PTY is a record, not a running assistant, and must neither be
      // subtracted from the host's count nor speak for the project.
      if (terminal.hasPty !== false) {
        entry.helpTerminals += 1;
        const slot =
          terminal.id !== undefined ? (assistantSlotForTerminal?.(terminal.id) ?? null) : null;
        const candidate: CountableTerminal =
          slot === null ? terminal : { ...terminal, assistantSlot: slot };
        const bucket = assistantsByProject.get(terminal.projectId);
        if (bucket) bucket.push(candidate);
        else assistantsByProject.set(terminal.projectId, [candidate]);
      }
      continue;
    }
    if (exclusion !== null) continue;

    // The user's own decision about this run, which outranks what the run is
    // doing when it comes to demanding their attention — and only then.
    const snooze =
      terminal.id !== undefined && activeSnoozes !== undefined
        ? activeSnoozes.get(terminal.id)
        : undefined;
    const isSnoozed = snooze !== undefined;
    const isParked = terminal.id !== undefined && parkedRuns?.has(terminal.id) === true;
    const isShelved = isSnoozed || isParked;
    if (isSnoozed) {
      entry.snoozed += 1;
      // An unlimited snooze carries no wake time and must not be allowed to
      // stand in for one — a project mixing unlimited and timed snoozes reports
      // the earliest real wake, and one holding only unlimited snoozes reports
      // none at all rather than a misleading soonest.
      if (snooze.snoozedUntil !== undefined) {
        entry.nextSnoozeWakeAt =
          entry.nextSnoozeWakeAt === null
            ? snooze.snoozedUntil
            : Math.min(entry.nextSnoozeWakeAt, snooze.snoozedUntil);
      }
    }

    // Attention is the fleet's band for the run, from the same records the
    // fleet row carries, so the switcher and the fleet can't disagree about
    // what is outstanding (#16058). Only presence is decided here.
    const id = terminal.id;
    const state = terminal.agentState;
    const handBackStop = state !== undefined && isHandBackStop(state, terminal.waitingReason);
    const handBack =
      id !== undefined && handBackStop ? handBackFor?.(id, terminal.spawnedAt) : undefined;
    // Only while the run shows the wait, as the fleet row carries it: the record
    // outlives the wait through its stop's slides.
    const wait =
      id !== undefined && state !== undefined && isObservedAskWait(state, terminal.waitingReason)
        ? waitFor?.(id, terminal.spawnedAt)
        : undefined;
    const refinement =
      id !== undefined && terminal.spawnedAt !== undefined
        ? canopyFor?.(id, terminal.spawnedAt)
        : undefined;
    const band = bandForRun({
      agentState: state,
      waitingReason: terminal.waitingReason,
      handBack,
      wait,
      canopy: refinement,
      park: isParked ? true : undefined,
      snooze,
    });
    const canopy = canopyPlacement(state, terminal.waitingReason, refinement);
    const unread = band === "review";

    if (band === "needs-you" || band === "blocked") {
      entry.waiting += 1;
      // `"error"` means the agent settled after a blocking failure, where input
      // may not unblock it — a materially different ask than a question.
      // Counted as a subset of `waiting`, never in addition to it.
      if (band === "blocked") entry.blocked += 1;

      // Age the wait from the transition into `waiting`. Terminals that haven't
      // recorded one yet still count toward `waiting` but can't contribute an age.
      // An ask Canopy read on a hand-back is as old as the stop it was asked at,
      // as the fleet dates it, not the slide from `completed` into a prompt.
      const since = usableTimestamp(handBack?.stoppedAt) || usableTimestamp(terminal.lastStateChange);
      if (since > 0) {
        entry.oldestWaitingSince =
          entry.oldestWaitingSince === null ? since : Math.min(entry.oldestWaitingSince, since);
      }
    }

    if (canopy?.kind === "not-asking") {
      // A question wait is never recorded as a hand-back, so a record the run
      // carries is from an earlier stop. The wait is the stop, unseen until
      // Canopy's read mark covers its turn, as the fleet bands it.
      entry.completed += 1;
      const at = usableTimestamp(terminal.lastStateChange);
      if (at > 0) entry.latestCompletionAt = Math.max(entry.latestCompletionAt ?? 0, at);
      if (unread) noteUnacknowledged(entry, at);
    } else if (canopy?.kind === "asked") {
      // An ask is no hand-back, whether or not the user has seen it: the run
      // hasn't finished. Counted above while unread, and nowhere once seen.
    } else if (handBack !== undefined) {
      // A stop main watched the run make after work it saw is a hand-back, and
      // whether the user has seen it is the record's to say — through the slide
      // from `completed` into a plain prompt wait (#13238).
      entry.completed += 1;
      const at = usableTimestamp(handBack.stoppedAt) || usableTimestamp(terminal.lastStateChange);
      if (at > 0) entry.latestCompletionAt = Math.max(entry.latestCompletionAt ?? 0, at);
      if (unread) noteUnacknowledged(entry, at);
    } else if (unread) {
      // An approval or question wait no reading placed: news until the user has
      // had it in front of them, then nothing more than an idle run. Counted
      // as finished only while it is unread, so the unread tally stays a
      // subset of the finished one.
      entry.completed += 1;
      const at = usableTimestamp(wait?.stoppedAt) || usableTimestamp(terminal.lastStateChange);
      if (at > 0) entry.latestCompletionAt = Math.max(entry.latestCompletionAt ?? 0, at);
      noteUnacknowledged(entry, at);
    } else if (state === "working") {
      entry.active += 1;
      const since = terminal.lastStateChange;
      if (typeof since === "number" && since > 0) {
        entry.latestWorkingSince = Math.max(entry.latestWorkingSince ?? 0, since);
      }
    } else if (state === "completed") {
      // Finished before main was watching, so nothing was handed back and the
      // fleet bands it idle: presence, never unread. The watermark is still
      // offered what it could clear, but no longer decides attention.
      entry.completed += 1;
      const at = terminal.lastStateChange;
      if (typeof at === "number" && at > 0) {
        entry.latestCompletionAt = Math.max(entry.latestCompletionAt ?? 0, at);
        const seenUpTo = lastCompletionSeenAt?.get(terminal.projectId) ?? 0;
        if (!isShelved && at > seenUpTo) {
          entry.latestWatermarkUnacknowledgedAt = Math.max(
            entry.latestWatermarkUnacknowledgedAt ?? 0,
            at
          );
        }
      }
    }
  }

  // Assistant presence, written last so it can never be mistaken for a tally
  // that accumulated alongside the worker states above.
  for (const [projectId, laneCandidates] of assistantsByProject) {
    const entry = counts.get(projectId);
    if (!entry) continue;
    const assistant = pickProjectAssistant(laneCandidates);
    if (!assistant) continue;
    // Out of sight, out of the tallies. Left as the `null` every state field
    // starts at, so a hidden assistant is indistinguishable from no assistant
    // — which is the point: every surface reading these fields asks the same
    // question of them, and one that only some of them honoured would put a
    // project in the attention band for a panel nobody can see.
    if (isAssistantVisible && !isAssistantVisible(projectId)) continue;
    entry.assistantState = assistant.agentState ?? null;
    entry.assistantWaitingReason =
      assistant.agentState === "waiting" ? (assistant.waitingReason ?? null) : null;
    // Same screen the selection used, so an unusable stamp can neither pick the
    // winner nor be reported as one. An infinite or wildly-future value would
    // read as a wait that began after every possible observation, holding the
    // row in the attention band while the age beside it rendered "just now".
    const since = usableTimestamp(assistant.lastStateChange);
    entry.assistantStateSince = since > 0 ? since : null;
  }

  return counts;
}
