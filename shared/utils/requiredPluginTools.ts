import type {
  RequiredPluginToolStatus,
  RequiredPluginToolsState,
} from "../types/ipc/pluginAgentMcp.js";

const STATE_REASONS: Record<Exclude<RequiredPluginToolsState, "ready">, string> = {
  "unsupported-format": "this agent can't be given plugin tools",
  "disabled-access": "its agent tools are off in this project",
  "pending-load": "it's still loading",
  unavailable: "it isn't running in this project",
  "listener-failed": "Daintree's MCP server couldn't start",
  "config-failed": "the agent's tool configuration couldn't be prepared",
  revoked: "its access changed while the agent was starting",
};

/** Why one required plugin's tools couldn't be handed to the agent, as a clause. */
export function requiredPluginToolsReason(state: RequiredPluginToolsState): string | null {
  return state === "ready" ? null : STATE_REASONS[state];
}

/** One line naming each missing plugin and why, for a refused launch. */
export function describeMissingPluginTools(tools: readonly RequiredPluginToolStatus[]): string {
  const missing = tools
    .map((tool) => {
      const reason = requiredPluginToolsReason(tool.state);
      return reason === null ? null : `${tool.pluginDisplayName}: ${reason}`;
    })
    .filter((line): line is string => line !== null);
  return missing.length === 0
    ? "This agent's required plugin tools aren't ready."
    : `This agent needs plugin tools that aren't ready. ${missing.join("; ")}.`;
}
