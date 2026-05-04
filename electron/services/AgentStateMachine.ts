/**
 * Thin re-export wrapper around the canonical FSM in `shared/utils/agentFsm.ts`.
 * Both the main process and the renderer Web Worker share the same source of truth
 * to prevent drift between contexts.
 */

export {
  VALID_TRANSITIONS,
  isValidTransition,
  nextAgentState,
} from "../../shared/utils/agentFsm.js";
export type { AgentEvent } from "../../shared/utils/agentFsm.js";

export function getStateChangeTimestamp(): number {
  return Date.now();
}
