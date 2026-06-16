import type { PluginAgentSnapshot } from "../types/plugin.js";
import type { AgentState, WaitingReason } from "../types/agent.js";
import { ACTIVE_AGENT_STATES } from "../types/agent.js";

/**
 * The subset of the internal `agent:state-changed` event payload that the agent
 * snapshot projection reads. Declared structurally (not imported from
 * `electron/services/events.ts`) so this helper stays in `shared/` and is usable
 * from both processes without pulling a main-process module across the boundary.
 */
export interface AgentStateChangePayload {
  agentId?: string;
  state: AgentState;
  previousState: AgentState;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
  timestamp: number;
}

/**
 * Project an internal `agent:state-changed` payload down to the read-only
 * {@link PluginAgentSnapshot} allowlist, then freeze it.
 *
 * Explicit field assignment — do NOT spread. Internal routing identifiers
 * (`terminalId`, `worktreeId`, `cwd`) and activity-detector internals
 * (`trigger`, `confidence`, `temperature`, `heatAdded`, `changedChars`) are
 * deliberately omitted: a plugin holding only `agent:read` must not be able to
 * cross-reference PTY/worktree internals it has no capability to access.
 * Optional fields are only assigned when present so the frozen shape mirrors the
 * payload (no `undefined`-valued keys).
 */
export function toPluginAgentSnapshot(payload: AgentStateChangePayload): PluginAgentSnapshot {
  const projection: {
    agentId?: string;
    state: AgentState;
    previousState: AgentState;
    running: boolean;
    waitingReason?: WaitingReason;
    sessionCost?: number;
    sessionTokens?: number;
    timestamp: number;
  } = {
    state: payload.state,
    previousState: payload.previousState,
    running: ACTIVE_AGENT_STATES.has(payload.state),
    timestamp: payload.timestamp,
  };

  if (payload.agentId !== undefined) projection.agentId = payload.agentId;
  if (payload.waitingReason !== undefined) projection.waitingReason = payload.waitingReason;
  if (payload.sessionCost !== undefined) projection.sessionCost = payload.sessionCost;
  if (payload.sessionTokens !== undefined) projection.sessionTokens = payload.sessionTokens;

  return Object.freeze(projection);
}
