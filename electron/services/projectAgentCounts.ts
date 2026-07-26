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

function empty(): ProjectAgentCounts {
  return { active: 0, waiting: 0, blocked: 0, oldestWaitingSince: null, helpTerminals: 0 };
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
  terminals: readonly CountableTerminal[]
): Map<string, ProjectAgentCounts> {
  const counts = new Map<string, ProjectAgentCounts>();
  for (const id of projectIds) counts.set(id, empty());

  const availability = getAgentAvailabilityStore();

  for (const terminal of terminals) {
    if (!terminal.projectId) continue;
    const entry = counts.get(terminal.projectId);
    if (!entry) continue;
    if (terminal.isTrashed) continue;

    // The assistant help terminal is a real PTY but tooling-internal: it never
    // counts as an agent, and is recorded here only so callers can net it out
    // of a process count the host already included it in.
    if (terminal.id !== undefined && availability.isHelpTerminal(terminal.id)) {
      if (terminal.hasPty !== false) entry.helpTerminals += 1;
      continue;
    }

    if (terminal.kind === "dev-preview") continue;
    if (terminal.hasPty === false) continue;

    // Runtime identity wins; launch intent is only a boot-window fallback before
    // detection has ever committed. Demoted ex-agents must not inflate counts
    // just because they were launched as agents.
    const hasLiveOrBootAgent =
      Boolean(terminal.detectedAgentId) ||
      (Boolean(terminal.launchAgentId) && terminal.everDetectedAgent !== true);
    if (!hasLiveOrBootAgent) continue;

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
    }
  }

  return counts;
}
