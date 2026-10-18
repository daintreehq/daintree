import type { ActionRegistry } from "../actionTypes";
import {
  HostCallArgsSchema,
  HostCallResultSchema,
  HostListArgsSchema,
  HostListResultSchema,
} from "@shared/types/hostControl";

function mainProcessOnly(id: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `${id} must be invoked through the MCP main-process path, not renderer dispatch.`
    );
  };
}

/**
 * A Shell's assistants' reach into its hosts (#13493), registered here for
 * manifest metadata only — schema, description, tier and audit. Execution
 * lives in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts): any assistant running in
 * one of this machine's own views may call them (#13468), and they reach
 * hosts over the link from main. Delegating to a host's assistant is agent
 * messaging run through `host.call` (#13496).
 * `run()` throws if the renderer ever invokes it directly.
 */
export function registerHostControlActions(actions: ActionRegistry): void {
  actions.set("host.list", () => ({
    id: "host.list",
    title: "List hosts",
    description:
      "List the hosts this machine's assistant may reach, as observed: connection, last load sample, agent counts, and each connected host's projects, which a call there names. Null means not measured.",
    category: "help",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "assistant", "control", "load"],
    palette: { mode: "hidden" },
    argsSchema: HostListArgsSchema,
    resultSchema: HostListResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.list"),
  }));

  actions.set("host.call", () => ({
    id: "host.call",
    title: "Run a tool on a host",
    description:
      "Run one of a host's own Daintree tools in one of its projects and get its result, such as starting the host's assistant or sending it a prompt. Changes are refused while another machine drives that project. ambiguous: resend under its callId, which never runs twice.",
    category: "help",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "call", "tool", "relay", "control"],
    palette: { mode: "hidden" },
    argsSchema: HostCallArgsSchema,
    resultSchema: HostCallResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      // A resend under its callId is; a new call runs again.
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.call"),
  }));
}
