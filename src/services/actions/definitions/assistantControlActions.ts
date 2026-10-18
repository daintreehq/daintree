import type { ActionRegistry } from "../actionTypes";
import {
  AgentReadQuotaArgsSchema,
  AgentReadQuotaResultSchema,
  AssistantListArgsSchema,
  AssistantListResultSchema,
  AssistantStartArgsSchema,
  AssistantStartResultSchema,
} from "@shared/types/assistantControl";

function mainProcessOnly(id: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `${id} must be invoked through the MCP main-process path, not renderer dispatch.`
    );
  };
}

/**
 * One assistant finding and starting another (#13496), and this machine's
 * quota, registered here for manifest metadata only — schema, description,
 * tier and audit. Execution lives in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts), for an assistant caller
 * alone: this machine's own, or another machine's through its Shell's
 * `host.call`. Never a worker pane, a plugin or an api-key client.
 * `run()` throws if the renderer ever invokes it directly.
 */
export function registerAssistantControlActions(actions: ActionRegistry): void {
  actions.set("assistant.list", () => ({
    id: "assistant.list",
    title: "List assistants",
    description:
      "List the other Daintree Assistants running in this project, and its vacant slots. Address one by its terminalId with the agent messaging tools; a send passes its generation.",
    category: "help",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["assistant", "delegate", "lane", "host"],
    palette: { mode: "hidden" },
    argsSchema: AssistantListArgsSchema,
    resultSchema: AssistantListResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: mainProcessOnly("assistant.list"),
  }));

  actions.set("assistant.start", () => ({
    id: "assistant.start",
    title: "Open another assistant",
    description:
      "Open another Daintree Assistant in this project with no window, in a vacant slot, and return it as the assistant listing does. Not ready still means it runs; don't open another.",
    category: "help",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["assistant", "delegate", "host"],
    palette: { mode: "hidden" },
    argsSchema: AssistantStartArgsSchema,
    resultSchema: AssistantStartResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: mainProcessOnly("assistant.start"),
  }));

  actions.set("agent.readQuota", () => ({
    id: "agent.readQuota",
    title: "Read Codex quota",
    description:
      "Read this machine's Codex account quota, as Codex reports it: how much of each rate-limit window is used and when it resets.",
    category: "agent",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["codex", "quota", "usage", "limit"],
    palette: { mode: "hidden" },
    argsSchema: AgentReadQuotaArgsSchema,
    resultSchema: AgentReadQuotaResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("agent.readQuota"),
  }));
}
