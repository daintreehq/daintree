import { isBuiltInAgentId, type BuiltInAgentId } from "../../config/agentIds.js";

/**
 * The two agent defaults a host owns (#13345): the agent the Daintree
 * Assistant runs on, and the default agent for new terminals. They live in the
 * host's main process beside the rest of `helpAssistant` and `agentSettings`,
 * so every window attached to a host sees that host's choice.
 *
 * A missing property means the host has never had a value, which is what
 * makes a one-time migration from this machine's localStorage eligible.
 * `null` is an explicit clear and is never overwritten by that migration.
 */
export interface AgentDefaultsSnapshot {
  assistantAgentId?: string | null;
  defaultAgent?: BuiltInAgentId | null;
}

/** Omitted leaves are left as they are; `null` clears one. */
export type AgentDefaultsPatch = AgentDefaultsSnapshot;

/**
 * Values read from the calling machine's localStorage. An omitted leaf had
 * nothing there, which is "no candidate", never "clear".
 */
export type AgentDefaultsLegacyCandidates = AgentDefaultsSnapshot;

const MAX_AGENT_ID_LENGTH = 128;

/**
 * Syntax only. A stored assistant agent has to survive its CLI being
 * uninstalled or its registry entry not loading yet, so the renderer can say
 * why it isn't being used instead of the host silently forgetting it.
 */
export function isStorableAssistantAgentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_AGENT_ID_LENGTH &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

export function isStorableDefaultAgent(value: unknown): value is BuiltInAgentId {
  return isBuiltInAgentId(value);
}
