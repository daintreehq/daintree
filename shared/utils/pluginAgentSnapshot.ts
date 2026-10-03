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
  terminalId?: string;
  state: AgentState;
  previousState: AgentState;
  waitingReason?: WaitingReason;
  sessionCost?: number;
  sessionTokens?: number;
  timestamp: number;
}

/** Host-resolved context the payload itself does not carry. */
export interface PluginAgentSnapshotContext {
  /** Owning workspace of the payload's terminal, as the PTY layer records it. */
  workspaceId?: string | null;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * Project an internal `agent:state-changed` payload down to the read-only
 * {@link PluginAgentSnapshot} allowlist, then freeze it.
 *
 * Explicit field assignment — do NOT spread. The terminal id and the owning
 * workspace id are exposed so a plugin can tell where a transition came from
 * and join it to `agents.list()`; `worktreeId`, `cwd` and the activity-detector
 * internals (`trigger`, `confidence`, `temperature`, `heatAdded`,
 * `changedChars`) stay out. Optional fields are only assigned when present so
 * the frozen shape mirrors the payload (no `undefined`-valued keys).
 */
export function toPluginAgentSnapshot(
  payload: AgentStateChangePayload,
  context: PluginAgentSnapshotContext = {}
): PluginAgentSnapshot {
  const projection: {
    agentId?: string;
    terminalId?: string;
    workspaceId?: string;
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
  if (isNonEmptyString(payload.terminalId)) projection.terminalId = payload.terminalId;
  if (isNonEmptyString(context.workspaceId)) projection.workspaceId = context.workspaceId;
  if (payload.waitingReason !== undefined) projection.waitingReason = payload.waitingReason;
  if (payload.sessionCost !== undefined) projection.sessionCost = payload.sessionCost;
  if (payload.sessionTokens !== undefined) projection.sessionTokens = payload.sessionTokens;

  return Object.freeze(projection);
}
