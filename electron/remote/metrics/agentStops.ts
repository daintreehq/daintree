import type { DaintreeEventMap } from "../../services/events.js";
import { MAX_METRICS_ID_CHARS } from "./linkMethods.js";

const STOPPED_STATES = new Set(["completed", "exited"]);

/** One agent's stop as this host reports it, before the link's timing is added. */
export interface AgentStopChange {
  terminalId: string;
  projectId: string | null;
  /** False: a stop sent for this terminal no longer stands. */
  stopped: boolean;
  /** Which stop, or null for one taken back. */
  state: "completed" | "exited" | null;
  /** When the transition was seen, by this host's clock. */
  seenAt: number;
}

/**
 * What an attached Shell is told of one agent transition here (#17933),
 * judged as the owner computer judges its own panes for the phone (#17319):
 * a turn into `completed` or `exited` from outside them is a stop, unless
 * Daintree itself is closing the terminal or its run is put aside; a turn
 * out of them, or a close, takes back whatever stop was sent, and so does a
 * turn out of `idle`, where a terminal starts again (a respawn after its
 * pty-host crashed) without leaving the stop it had. `completed` then
 * `exited` is still the one stop. Null when there is nothing to say, and for
 * a terminal id too long for the link to carry.
 */
export function agentStopChangeOf(
  payload: DaintreeEventMap["agent:state-changed"],
  facts: {
    getTerminalProjectId(id: string): string | null;
    /** Parked or snoozed here, so nothing pages for it. */
    putAside(id: string): boolean;
  }
): AgentStopChange | null {
  const { terminalId, state, previousState } = payload;
  if (!terminalId || terminalId.length > MAX_METRICS_ID_CHARS || state === previousState) {
    return null;
  }
  const stopped = STOPPED_STATES.has(state);
  const wasStopped = STOPPED_STATES.has(previousState);
  const closing = payload.terminalClosing === true;
  let next: AgentStopChange["state"];
  if (stopped && !closing) {
    if (wasStopped || facts.putAside(terminalId)) return null;
    next = state as "completed" | "exited";
  } else if (closing || wasStopped || previousState === "idle") {
    next = null;
  } else {
    // Working and waiting turns: no stop was sent for this terminal since its last one ended.
    return null;
  }
  const projectId = facts.getTerminalProjectId(terminalId);
  return {
    terminalId,
    projectId: projectId !== null && projectId.length <= MAX_METRICS_ID_CHARS ? projectId : null,
    stopped: next !== null,
    state: next,
    seenAt: payload.timestamp,
  };
}

/** One of a host's agents' stops as a Shell passes it on: taken, or taken back. */
export interface HeardAgentStop {
  terminalId: string;
  stopped: boolean;
}

export type AgentStopListener = (hostId: string, heard: HeardAgentStop) => void;
