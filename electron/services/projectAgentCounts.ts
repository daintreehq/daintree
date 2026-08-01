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
   * Live Daintree Assistant PTYs. The PTY host tallies these into
   * `terminalCount`, but the assistant is tooling-internal, so callers must
   * subtract this from any process count they report (#10989).
   */
  helpTerminals: number;
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
 * Exported as a reason rather than a boolean because one caller has to act on
 * the distinction: `"help"` is the assistant PTY, which the host already
 * tallied into `terminalCount` and which therefore has to be netted back out
 * (#10989), while every other reason is simply "not an agent".
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
  // counts as an agent, and is reported here only so callers can net it out of
  // a process count the host already included it in.
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
    helpTerminals: 0,
  };
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
  lastCompletionSeenAt?: ReadonlyMap<string, number>
): Map<string, ProjectAgentCounts> {
  const counts = new Map<string, ProjectAgentCounts>();
  for (const id of projectIds) counts.set(id, empty());

  const availability = getAgentAvailabilityStore();

  for (const terminal of terminals) {
    if (!terminal.projectId) continue;
    const entry = counts.get(terminal.projectId);
    if (!entry) continue;
    const exclusion = classifyRun(terminal, (id) => availability.isHelpTerminal(id));
    if (exclusion === "help") {
      if (terminal.hasPty !== false) entry.helpTerminals += 1;
      continue;
    }
    if (exclusion !== null) continue;

    if (terminal.agentState === "waiting") {
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
        const seenUpTo = lastCompletionSeenAt?.get(terminal.projectId) ?? 0;
        if (at > seenUpTo) {
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

  return counts;
}
