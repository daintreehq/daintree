import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import {
  TerminalNotifyWhenIdleArgsSchema,
  TerminalNotifyWhenIdleResultSchema,
} from "@shared/types/terminalNotify";

function mainProcessOnly(id: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `${id} must be invoked through the MCP main-process path, not renderer dispatch.`
    );
  };
}

/**
 * Terminal notices, registered here for manifest metadata only — schema,
 * description, tier and audit. Execution lives in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts): which pane to type into is
 * known only from the caller's MCP credential, which the renderer never sees,
 * and a notice outlives the call that armed it. `run()` throws if the renderer
 * ever invokes it directly.
 */
export function registerTerminalNotifyActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("terminal.notifyWhenIdle", () => ({
    id: "terminal.notifyWhenIdle",
    title: "Notify when terminal is idle",
    description:
      "Be told when a working agent terminal stops, instead of polling. Returns at once; when it next stops working, Daintree types what it saw, your note and its last screen lines into your prompt. End your turn after calling. A terminal not working comes back unarmed. When sending a prompt, set notify on the send instead.",
    category: "terminal",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["notify", "wake", "idle", "done", "orchestrate"],
    palette: { mode: "hidden" },
    argsSchema: TerminalNotifyWhenIdleArgsSchema,
    resultSchema: TerminalNotifyWhenIdleResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: false,
    },
    run: mainProcessOnly("terminal.notifyWhenIdle"),
  }));
}
