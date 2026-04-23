import type { BuiltInAgentId } from "../../shared/config/agentIds.js";
import type { AgentId } from "../../shared/types/agent.js";

type MaybeAgentId = BuiltInAgentId | AgentId | string | undefined;

/**
 * Resolve the effective agent identity for panel chrome (icons, badges, labels).
 *
 * Prefers the runtime-detected agent (`detectedAgentId`) so chrome follows
 * mid-session agent switches (e.g., plain shell starts Claude) and, when
 * detection clears on exit, falls back to the launch-time `agentId`. This
 * helper resolves identity only — it does not claim the session is live. Use
 * `isRuntimeAgentTerminal` (in `terminalType.ts`) when the decision depends on
 * whether the agent is currently running.
 */
export function resolveEffectiveAgentId(
  detectedAgentId: MaybeAgentId,
  agentId: MaybeAgentId
): string | undefined {
  return detectedAgentId ?? agentId ?? undefined;
}
