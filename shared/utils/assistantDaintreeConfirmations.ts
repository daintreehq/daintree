import type { HelpAssistantDaintreeConfirmations } from "../types/ipc/api.js";
import {
  ASSISTANT_HOST_SETTINGS_CONFIRMATION,
  sanitizeDelegatedConfirmations,
} from "../config/assistantConfirmationDelegation.js";
import {
  isAgentBypassSupported,
  resolveDangerousMode,
  type AgentSettings,
} from "../types/agentSettings.js";

export function isHelpAssistantDaintreeConfirmations(
  value: unknown
): value is HelpAssistantDaintreeConfirmations {
  return (
    value === "inherit" || value === "always-ask" || value === "never-ask" || value === "ask-except"
  );
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
 * Whether every one of the assistant's Daintree confirmations is skipped
 * (#12874, #12989). `never-ask` skips whatever the agent's skip setting says,
 * `always-ask` and `ask-except` (#16752) don't, and `inherit` follows the
 * assistant agent's effective skip setting (see
 * {@link resolveAssistantAgentSkip}). An absent or unrecognised preference
 * reads as the default, `inherit`.
 */
export function assistantSkipsDaintreeConfirmations(
  preference: HelpAssistantDaintreeConfirmations | undefined,
  agentSkipsPermissions: boolean | undefined
): boolean {
  if (preference === "never-ask") return true;
  if (preference === "always-ask" || preference === "ask-except") return false;
  return agentSkipsPermissions === true;
}

/**
 * The assistant's Daintree confirmations, read once: whether everything is
 * skipped, and which called ids are handed over one by one (#16752). The ids
 * count only under `ask-except`, and only those still delegable.
 */
export interface AssistantConfirmationPolicy {
  readonly skipsAll: boolean;
  readonly delegated: ReadonlySet<string>;
}

const NOTHING_DELEGATED: ReadonlySet<string> = new Set();

/** No preference read, or none that skips: every confirm-gated call asks. */
export const ASKS_FOR_EVERYTHING: AssistantConfirmationPolicy = {
  skipsAll: false,
  delegated: NOTHING_DELEGATED,
};

export function resolveAssistantConfirmationPolicy(
  preference: HelpAssistantDaintreeConfirmations | undefined,
  except: unknown,
  agentSkipsPermissions: boolean | undefined
): AssistantConfirmationPolicy {
  return {
    skipsAll: assistantSkipsDaintreeConfirmations(preference, agentSkipsPermissions),
    delegated:
      preference === "ask-except"
        ? new Set(sanitizeDelegatedConfirmations(except))
        : NOTHING_DELEGATED,
  };
}

/**
 * Whether the assistant's call to `calledActionId` runs without asking. A
 * `host.settings` change never asked before it could be delegated, so the
 * blanket skip doesn't reach it: only its own tick does.
 */
export function assistantPolicySkips(
  policy: AssistantConfirmationPolicy,
  calledActionId: string
): boolean {
  if (policy.delegated.has(calledActionId)) return true;
  return policy.skipsAll && calledActionId !== ASSISTANT_HOST_SETTINGS_CONFIRMATION;
}
