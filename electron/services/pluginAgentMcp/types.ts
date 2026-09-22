import type http from "node:http";
import type { PluginMcpCaller, PluginMcpJsonSchema } from "../../../shared/types/plugin.js";

/** Path prefix of the plugin-only MCP surface on the host's loopback listener. */
export const PLUGIN_MCP_ROUTE_PREFIX = "/mcp/plugin/";

/** The agent-facing URL path for one endpoint of one plugin instance. */
export function pluginMcpRoutePath(pluginInstanceId: string, endpointId: string): string {
  return `${PLUGIN_MCP_ROUTE_PREFIX}${encodeURIComponent(pluginInstanceId)}/${encodeURIComponent(endpointId)}`;
}

/** The part of a registered tool an agent is shown. The implementation stays behind {@link AgentMcpToolInvoker}. */
export interface AgentMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: PluginMcpJsonSchema;
  readonly outputSchema?: PluginMcpJsonSchema;
}

/**
 * Runs one tool of a registered endpoint. For a worker plugin this crosses the
 * worker message port; for a builtin it is the plugin's own closure. Rejects
 * when the signal aborts.
 */
export type AgentMcpToolInvoker = (
  toolName: string,
  args: Record<string, unknown>,
  caller: PluginMcpCaller,
  signal: AbortSignal
) => Promise<unknown>;

export interface AgentMcpEndpointRegistration {
  /** Plugin instance key — the manifest id for installed plugins, `project__{projectId}__{id}` for project plugins. */
  readonly pluginInstanceId: string;
  readonly endpointId: string;
  readonly tools: readonly AgentMcpToolDescriptor[];
  readonly invoke: AgentMcpToolInvoker;
}

/**
 * An `agentMcp` endpoint a loaded plugin instance declares and may serve to one
 * project. Declared is not enabled — see `projectEnablement.ts`.
 */
export interface DeclaredAgentMcpEndpoint {
  /** What per-project enablement and grants are keyed by. */
  readonly pluginInstanceId: string;
  /** Bare manifest id, for display and diagnostics. */
  readonly pluginManifestId: string;
  readonly pluginDisplayName: string;
  readonly endpointId: string;
  readonly name: string;
  readonly description?: string;
}

/**
 * The plugin-only MCP route mounted on the host's HTTP listener. The listener
 * runs its duplicate-header, Host and Origin checks, then hands over every
 * request under {@link PLUGIN_MCP_ROUTE_PREFIX} before orchestration auth runs —
 * plugin credentials are never valid on `/mcp` or `/sse`, and orchestration
 * credentials are never valid here.
 */
export interface PluginMcpRouteHandler {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    port: number
  ): Promise<void>;
  /** Close every plugin session. Called when the listener stops or dies. */
  closeAllSessions(): void;
}
