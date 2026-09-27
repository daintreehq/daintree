import type http from "node:http";
import type { PluginMcpCaller, PluginMcpJsonSchema } from "../../../shared/types/plugin.js";
import type { AgentMcpSchemaCheck } from "./schemaValidation.js";

/** Path prefix of the plugin-only MCP surface on the host's loopback listener. */
export const PLUGIN_MCP_ROUTE_PREFIX = "/mcp/plugin/";

/**
 * The roster the host serves for every plugin that declares databases. `@` is
 * outside the manifest's id grammar, so no plugin-declared `agentMcp` endpoint
 * can take this id.
 */
export const DATABASE_ENDPOINT_ID = "@databases";

/**
 * The host's database tools share a plugin's MCP server with the plugin's own,
 * so no plugin roster may use these names.
 */
export const RESERVED_AGENT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "database_schema",
  "database_query",
]);

/** The agent-facing URL path for one plugin instance's MCP server. */
export function pluginMcpRoutePath(pluginInstanceId: string): string {
  return `${PLUGIN_MCP_ROUTE_PREFIX}${encodeURIComponent(pluginInstanceId)}`;
}

/**
 * Which of a plugin's rosters one grant reaches: the host's read-only database
 * tools, the plugin's own `agentMcp` endpoint, or both. Fixed when the grant is
 * minted; a later change in access can take it away but never widen it.
 */
export interface AgentMcpToolScope {
  readonly databases: boolean;
  readonly pluginEndpointId?: string;
}

/** The part of a registered tool an agent is shown. The implementation stays behind {@link AgentMcpToolInvoker}. */
export interface AgentMcpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: PluginMcpJsonSchema;
  readonly outputSchema?: PluginMcpJsonSchema;
  /**
   * Host-owned tools only: advertised as `readOnlyHint`, which lets a client
   * such as Codex run the call without an approval prompt. Never taken from a
   * plugin's own roster, where it would be the plugin vouching for itself.
   */
  readonly readOnly?: true;
}

/**
 * A tool as dispatch holds it: the descriptor plus its schemas compiled at
 * registration, so a call is checked without compiling anything and a tool
 * cannot be registered without the checks its schemas promise.
 */
export type AgentMcpRegisteredTool = AgentMcpToolDescriptor & {
  readonly checkInput: AgentMcpSchemaCheck;
} & (
    | { readonly outputSchema?: undefined; readonly checkOutput?: undefined }
    | { readonly outputSchema: PluginMcpJsonSchema; readonly checkOutput: AgentMcpSchemaCheck }
  );

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
  readonly tools: readonly AgentMcpRegisteredTool[];
  readonly invoke: AgentMcpToolInvoker;
}

/**
 * A loaded plugin instance that could serve agent tools to one project: its
 * declared databases, its own `agentMcp` endpoint, or both. Declared is not
 * allowed — see `projectEnablement.ts`.
 */
export interface DeclaredAgentMcpPlugin {
  /** What access and grants are keyed by. */
  readonly pluginInstanceId: string;
  /** Bare manifest id, for display, naming and diagnostics. */
  readonly pluginManifestId: string;
  readonly pluginDisplayName: string;
  readonly origin: "global" | "project";
  readonly mcpName?: string;
  readonly hasDatabases: boolean;
  readonly pluginEndpoint?: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
  };
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
