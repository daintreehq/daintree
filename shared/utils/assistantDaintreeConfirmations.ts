import type { HelpAssistantDaintreeConfirmations } from "../types/ipc/api.js";
import {
  isAgentBypassSupported,
  resolveDangerousMode,
  type AgentSettings,
} from "../types/agentSettings.js";

export function isHelpAssistantDaintreeConfirmations(
  value: unknown
): value is HelpAssistantDaintreeConfirmations {
  return value === "inherit" || value === "always-ask" || value === "never-ask";
}

/**
 * Where the assistant agent's effective "Skip permission prompts" came from:
 * set on the agent itself, inherited from the global switch, or inherited by an
 * agent that can't skip permission prompts, so the global never reaches it.
 */
export type AssistantAgentSkipSource = "agent" | "global" | "unsupported";

export interface AssistantAgentSkip {
  skips: boolean;
  source: AssistantAgentSkipSource;
}

/**
 * The skip-permissions value in effect for the agent running the assistant
 * (#14141): the agent's own setting when it has one, else the global. With no
 * agent chosen there is nothing to follow but the global, which keeps the
 * pre-#14141 behaviour. The global reaches only agents whose assistant wiring
 * declares `supports.permissionBypass`, which is narrower than the terminal
 * launch's reach (#16414), so this doesn't defer to `resolveEffectiveBypass`.
 */
export function resolveAssistantAgentSkip(
  agentId: string | null | undefined,
  agentSettings: Pick<AgentSettings, "agents" | "globalSkipPermissions"> | null | undefined
): AssistantAgentSkip {
  const global = agentSettings?.globalSkipPermissions === true;
  if (!agentId) return { skips: global, source: "global" };
  const mode = resolveDangerousMode(agentSettings?.agents?.[agentId] ?? {});
  if (mode !== "inherit") return { skips: mode === "on", source: "agent" };
  if (!isAgentBypassSupported(agentId)) return { skips: false, source: "unsupported" };
  return { skips: global, source: "global" };
}

/**
 * Whether the assistant's Daintree confirmations are skipped (#12874, #12989).
 * `never-ask` skips whatever the agent's skip setting says, `always-ask` never
 * skips, and `inherit` follows the assistant agent's effective skip setting
 * (see {@link resolveAssistantAgentSkip}). An absent or unrecognised preference
 * reads as the default, `inherit`.
 */
export function assistantSkipsDaintreeConfirmations(
  preference: HelpAssistantDaintreeConfirmations | undefined,
  agentSkipsPermissions: boolean | undefined
): boolean {
  if (preference === "never-ask") return true;
  if (preference === "always-ask") return false;
  return agentSkipsPermissions === true;
}
