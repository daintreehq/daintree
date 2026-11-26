import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GLOBAL_PLUGIN_TOOLS_LIST,
  isGlobalPluginToolOperation,
} from "../../../shared/config/globalAssistant.js";
import type { RelayMcpSession, RelayMcpSessionSpec } from "./mcpRelayExecutor.js";

/** What answers the global Assistant's two plugin tool operations (#18254). */
export interface LocalPluginTools {
  list(
    helpSessionId: string,
    projectId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult>;
  call(
    helpSessionId: string,
    projectId: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<CallToolResult>;
}

/**
 * This machine's global Assistant's relay session into one of its projects,
 * answering `plugin.tools` and `plugin.callTool` itself (#18254) and passing
 * every other tool to the session. Only a session the in-process relay opened
 * for the global Assistant is decorated: neither name is a Daintree tool, so
 * any other session, and any host's, answers them as unknown.
 *
 * Inside the session, a call has already been through the relay's ledger, so
 * a resend under its callId never runs the plugin's tool twice.
 */
export function withLocalPluginTools(
  session: RelayMcpSession,
  spec: RelayMcpSessionSpec,
  pluginTools: () => Promise<LocalPluginTools>
): RelayMcpSession {
  if (spec.local !== true || spec.global !== true) return session;
  return {
    isOpen: () => session.isOpen(),
    close: () => session.close(),
    callTool: async (tool, args, options) => {
      if (!isGlobalPluginToolOperation(tool)) return session.callTool(tool, args, options);
      const deadline = AbortSignal.timeout(Math.max(0, options.timeoutMs));
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      // The work hears the same signal, and settles soon after it fires with
      // what the tool session saw, a write's "may still have applied" included.
      const tools = await pluginTools();
      const result =
        tool === GLOBAL_PLUGIN_TOOLS_LIST
          ? await tools.list(spec.helpSessionId, spec.projectId, args, signal)
          : await tools.call(spec.helpSessionId, spec.projectId, args, signal);
      // Cancelled while it ran: the relay reads a throw as "the tool heard the
      // cancel", as it does when an MCP session's wait ends on one.
      if (options.signal?.aborted) throw new Error("The call was cancelled.");
      return result;
    },
  };
}
