import type { AgentState, WaitingReason } from "../types/agent.js";
import type { RunCanopyRefinement } from "../types/ipc/fleet.js";
import { isHandBackStop } from "./runHandBack.js";

/**
 * The Canopy refinement that places a run now, or undefined when the run lands
 * by the free rules alone.
 *
 * A verdict is held for the turn it was read in, so it can outlive the state it
 * was read against by the moment it takes the next turn to count. Each kind
 * applies only to the observed state it refines:
 *
 * - `asked` only to a stop the free rules file as a hand-back — a finished
 *   turn, or a bare prompt. A wait that already names what it wants is
 *   already a demand.
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
      return isHandBackStop(agentState, waitingReason) ? refinement : undefined;
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
