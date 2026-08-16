import type { AgentState, WaitingReason } from "../../shared/types/agent.js";
import type { PanelKind } from "../../shared/types/panel.js";
import { getAgentAvailabilityStore } from "./AgentAvailabilityStore.js";

/** Per-project agent tallies derived from the live terminal list. */
export interface ProjectAgentCounts {
  active: number;
  waiting: number;
  /** Waiting agents blocked on an error — a subset of {@link waiting}. */
  blocked: number;
  /** Earliest transition into `waiting`, or null when nothing is waiting. */
  oldestWaitingSince: number | null;
  /** Agents settled in `completed` — work finished, awaiting human review. */
  completed: number;
  /**
   * Completed agents whose completion the user has not seen yet: their
   * transition into `completed` postdates the project's acknowledgement
   * watermark. A subset of {@link completed}. Terminals in `completed` with no
   * recorded transition time can never clear a timestamp watermark, so they
   * count toward {@link completed} only.
   */
  unacknowledgedCompleted: number;
  /** Earliest unacknowledged completion, or null when everything was seen. */
  oldestUnacknowledgedCompletionAt: number | null;
  /** Latest unacknowledged completion, or null when everything was seen. */
  latestUnacknowledgedCompletionAt: number | null;
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
   * from one with nothing in it.
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
   * no live assistant PTY (#11806).
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
export type RunExclusionReason = "trashed" | "help" | "dev-preview" | "no-pty" | "not-an-agent";

/**
 * The single definition of "this terminal is an agent run".
 *
 * Shared by the per-project tallies and by the fleet snapshot so the two can
 * never disagree about what counts. They previously answered this question
 * independently and drifted — the assistant PTY showed up as a working agent on
 * one surface and not the other. A second copy of these five rules is a bug
 * waiting to be written, so there is exactly one.
 */
export function classifyRun(
  terminal: CountableTerminal,
  isHelpTerminal: (id: string) => boolean
): RunExclusionReason | null {
  if (terminal.isTrashed) return "trashed";

  // The assistant help terminal is a real PTY but tooling-internal: it never
  // counts as an agent. Named rather than silently dropped so callers can net
  // it out of a process count the host already included it in, and so its
  // state can be carried as presence instead of vanishing (#11806).
  if (terminal.id !== undefined && isHelpTerminal(terminal.id)) return "help";

  if (terminal.kind === "dev-preview") return "dev-preview";
  if (terminal.hasPty === false) return "no-pty";

  // Runtime identity wins; launch intent is only a boot-window fallback before
  // detection has ever committed. Demoted ex-agents must not count just because
  // they were launched as agents.
  const hasLiveOrBootAgent =
    Boolean(terminal.detectedAgentId) ||
    (Boolean(terminal.launchAgentId) && terminal.everDetectedAgent !== true);
  if (!hasLiveOrBootAgent) return "not-an-agent";

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
 * Liveness rank for picking which assistant record speaks for a project.
 * Lower wins: actively doing something, then waiting, then settled.
 */
function assistantLiveness(state: AgentState | undefined): number {
  if (state === "working" || state === "directing") return 0;
  if (state === "waiting") return 1;
  return 2;
}

/**
 * Whether `candidate` should replace `incumbent` as the project's reported
 * assistant.
 *
 * `HelpSessionService` enforces at most one assistant PTY per project, so in
 * steady state there is nothing to choose between. The window this exists for
 * is displacement: a new backend is provisioned while the old one is still
 * being killed, and for those moments two terminals answer to the same
 * project. The newest transition wins that tie, because the record still
 * moving is the live session and the one left behind is the corpse.
 *
 * Terminal id breaks a dead-heat so the answer can never depend on the order
 * the host happened to list terminals in.
 */
function beatsIncumbent(
  candidate: CountableTerminal,
  incumbent: CountableTerminal | null
): boolean {
  if (incumbent === null) return true;

  const candidateRank = assistantLiveness(candidate.agentState);
  const incumbentRank = assistantLiveness(incumbent.agentState);
  if (candidateRank !== incumbentRank) return candidateRank < incumbentRank;

  const candidateSince = candidate.lastStateChange ?? 0;
  const incumbentSince = incumbent.lastStateChange ?? 0;
  if (candidateSince !== incumbentSince) return candidateSince > incumbentSince;

  return (candidate.id ?? "") < (incumbent.id ?? "");
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
  activeSnoozes?: ReadonlyMap<string, { snoozedUntil?: number }>
): Map<string, ProjectAgentCounts> {
  const counts = new Map<string, ProjectAgentCounts>();
  for (const id of projectIds) counts.set(id, empty());

  const availability = getAgentAvailabilityStore();
  // Which assistant terminal currently speaks for each project. Held aside
  // rather than written straight into `counts` so the winner is decided by
  // `beatsIncumbent` alone and never by which terminal happened to come first.
  const assistantByProject = new Map<string, CountableTerminal>();

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
        if (beatsIncumbent(terminal, assistantByProject.get(terminal.projectId) ?? null)) {
          assistantByProject.set(terminal.projectId, terminal);
        }
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

    if (terminal.agentState === "waiting") {
      // A snoozed wait is withheld from every attention tally — waiting, its
      // blocked subset, and the age that dates them. The run is still there and
      // still waiting; the user has said it does not need them yet.
      if (!isSnoozed) {
        entry.waiting += 1;
        // `"error"` means the agent settled after a blocking failure, where input
        // may not unblock it — a materially different ask than an empty prompt.
        // Counted as a subset of `waiting`, never in addition to it.
        if (terminal.waitingReason === "error") entry.blocked += 1;

        // Age the wait from the transition into `waiting`. Terminals that haven't
        // recorded one yet still count toward `waiting` but can't contribute an age.
        const since = terminal.lastStateChange;
        if (typeof since === "number" && since > 0) {
          entry.oldestWaitingSince =
            entry.oldestWaitingSince === null ? since : Math.min(entry.oldestWaitingSince, since);
        }
      }
    } else if (terminal.agentState === "working") {
      entry.active += 1;
      const since = terminal.lastStateChange;
      if (typeof since === "number" && since > 0) {
        entry.latestWorkingSince = Math.max(entry.latestWorkingSince ?? 0, since);
      }
    } else if (terminal.agentState === "completed") {
      entry.completed += 1;
      const at = terminal.lastStateChange;
      if (typeof at === "number" && at > 0) {
        entry.latestCompletionAt = Math.max(entry.latestCompletionAt ?? 0, at);
        // Unacknowledged = finished after the user last saw this project.
        // Deliberately no elapsed-time cutoff: a completion that happened
        // while the user was away must stay surfaced until actually seen.
        // A snoozed completion is exempt: the hand-back is real, but the user
        // has already said they don't want to be reminded of it yet.
        const seenUpTo = lastCompletionSeenAt?.get(terminal.projectId) ?? 0;
        if (!isSnoozed && at > seenUpTo) {
          entry.unacknowledgedCompleted += 1;
          entry.oldestUnacknowledgedCompletionAt = Math.min(
            entry.oldestUnacknowledgedCompletionAt ?? Number.POSITIVE_INFINITY,
            at
          );
          entry.latestUnacknowledgedCompletionAt = Math.max(
            entry.latestUnacknowledgedCompletionAt ?? 0,
            at
          );
        }
      }
    }
  }

  // Assistant presence, written last so it can never be mistaken for a tally
  // that accumulated alongside the worker states above.
  for (const [projectId, assistant] of assistantByProject) {
    const entry = counts.get(projectId);
    if (!entry) continue;
    entry.assistantState = assistant.agentState ?? null;
    entry.assistantWaitingReason =
      assistant.agentState === "waiting" ? (assistant.waitingReason ?? null) : null;
    const since = assistant.lastStateChange;
    entry.assistantStateSince = typeof since === "number" && since > 0 ? since : null;
  }

  return counts;
}
