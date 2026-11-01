import type { AgentState, WaitingReason } from "../types/agent.js";
import type { RunCanopyRefinement } from "../types/ipc/fleet.js";

/**
 * A stop a reading may find asking the user something: finished, or waiting
 * for anything but an error. An error wait is blocked whatever its screen says.
 */
export function isAskableStop(state: AgentState, waitingReason?: WaitingReason): boolean {
  return state === "completed" || (state === "waiting" && waitingReason !== "error");
}

/**
 * The Canopy refinement that places a run now, or undefined when the run lands
 * by the free rules alone.
 *
 * A verdict is held for the turn it was read in, so it can outlive the state it
 * was read against by the moment it takes the next turn to count. Each kind
 * applies only to the observed state it refines:
 *
 * - `asked` to any stop that could be asking: a finished turn, or any wait
 *   but an error. The reading, not the wait the patterns named, is what says
 *   the run asks something.
 * - `not-asking` only to a wait the patterns took for a question. An approval
 *   or an error Daintree observed itself is never cleared by a reading.
 * - `stalled` only to a working run, and only while Daintree's own silence
 *   check hasn't already called it quiet: then the free rules placed it, and
 *   crediting Canopy would claim a placement it didn't make.
 */
export function canopyPlacement(
  agentState: AgentState | undefined,
  waitingReason: WaitingReason | undefined,
  refinement: RunCanopyRefinement | undefined,
  quietByObservation = false
): RunCanopyRefinement | undefined {
  if (refinement === undefined || agentState === undefined) return undefined;
  switch (refinement.kind) {
    case "asked":
      return isAskableStop(agentState, waitingReason) ? refinement : undefined;
    case "not-asking":
      return agentState === "waiting" && waitingReason === "question" ? refinement : undefined;
    case "stalled":
      return (agentState === "working" || agentState === "directing") && !quietByObservation
        ? refinement
        : undefined;
    default: {
      const exhaustive: never = refinement;
      return exhaustive;
    }
  }
}
