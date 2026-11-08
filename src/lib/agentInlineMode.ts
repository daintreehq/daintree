import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

export interface AgentInlineSupport {
  /** The agent has a main-screen mode Daintree launches it in. */
  supported: boolean;
  /** What to type inside the CLI to get back to it, when the agent has one. */
  command?: string;
}

/**
 * Read from what the registry declares, never from the user's alt-screen
 * settings or what a launch resolved to: the pane notice reports a screen it
 * observed, and says nothing about why the agent is on it.
 */
export function getAgentInlineSupport(agentId: string): AgentInlineSupport {
  const capabilities = getEffectiveAgentConfig(agentId)?.capabilities;
  const command = capabilities?.inlineModeCommand;
  const supported = Boolean(
    capabilities?.inlineModeFlag || capabilities?.inlineModeEnv || command !== undefined
  );
  return command === undefined ? { supported } : { supported, command };
}
