import type { DaintreeEventMap } from "../../services/events.js";

const STOPPED_STATES = new Set(["completed", "exited"]);

/** One agent's stop as this host reports it, before the link's timing is added. */
export interface AgentStopChange {
  terminalId: string;
  projectId: string | null;
  /** Null: a stop sent for this terminal no longer stands. */
  state: "completed" | "exited" | null;
  /** When the transition was seen, by this host's clock. */
  seenAt: number;
}

/**
 * What an attached Shell is told of one agent transition here (#17933),
 * judged as the owner computer judges its own panes for the phone (#17319):
 * a turn into `completed` or `exited` from outside them is a stop, unless
 * Daintree itself is closing the terminal or its run is put aside; a turn
 * out of them, or a close, takes back whatever stop was sent. `completed`
 * then `exited` is still the one stop. Null when there is nothing to say.
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
  if (!terminalId || state === previousState) return null;
  const stopped = STOPPED_STATES.has(state);
  const wasStopped = STOPPED_STATES.has(previousState);
  const closing = payload.terminalClosing === true;
  let next: AgentStopChange["state"];
  if (stopped && !closing) {
    if (wasStopped || facts.putAside(terminalId)) return null;
    next = state as "completed" | "exited";
  } else if (closing || wasStopped) {
    next = null;
  } else {
    // Working and waiting turns: no stop was sent for this terminal since its last one ended.
    return null;
  }
  return {
    terminalId,
    projectId: facts.getTerminalProjectId(terminalId),
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
