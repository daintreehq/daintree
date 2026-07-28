/**
 * Lifecycle state for a single plugin-contributed MCP server tracked by
 * `PluginMcpSupervisor`. Distinct from the in-process MCP server's
 * {@link McpRuntimeState} (`disabled|starting|ready|failed`) — this supervises
 * outbound stdio subprocesses launched from plugin manifests, not the inbound
 * server that exposes Daintree actions to assistants.
 *
 * - `spawning`: subprocess started; `initialize` request sent or in flight.
 *   `tools/call` against a spawning server fails fast with `NOT_READY`.
 * - `ready`: handshake complete (server responded to `initialize`, client sent
 *   `notifications/initialized`). `tools/call` is accepted.
 * - `crashed`: subprocess exited unexpectedly before `shutdown()` was called,
 *   or the handshake failed. `lastError` carries the diagnostic.
 * - `stopped`: `shutdown()` was called and the subprocess exited cleanly.
 */
export type PluginMcpServerStatus = "spawning" | "ready" | "crashed" | "stopped";

/**
 * Compact, JSON-safe snapshot of one supervised MCP server. Returned by the
 * `plugin-mcp:list` IPC and used by Settings → MCP. Carries no live handles or
 * subprocess references — those stay inside the supervisor.
 */
export interface PluginMcpServerInfo {
  pluginId: string;
  serverId: string;
  name: string;
  status: PluginMcpServerStatus;
  /** OS pid of the direct child subprocess. Absent when not currently running. */
  pid: number | null;
  /** Most recent error message, if any. Cleared on a successful (re)start. */
  lastError: string | null;
  /** Number of stderr lines currently buffered for this server. */
  stderrLineCount: number;
}

/**
 * Result of a `plugin-mcp:get-stderr` IPC. Bounded by the supervisor's
 * per-server ring cap so a misbehaving server can't pin unbounded memory.
 */
export interface PluginMcpStderrResult {
  pluginId: string;
  serverId: string;
  lines: string[];
  /** Total lines emitted by the server since spawn; may exceed `lines.length`. */
  totalLines: number;
}

/**
 * Identifier passed to per-server IPC calls (`get-stderr`, `restart`). The
 * pair uniquely identifies one supervised subprocess.
 */
export interface PluginMcpServerKey {
  pluginId: string;
  serverId: string;
}

/**
 * Identifier passed to `plugin-mcp:get-full-schema` — the server pair plus the
 * tool name whose full input schema the agent has selected (tier 2).
 */
export interface PluginMcpToolKey extends PluginMcpServerKey {
  toolName: string;
}

/**
 * Tier-1 tool summary injected into agent context at session start (#9235):
 * just the name and a short, truncated description — never the input schema.
 * The full schema is fetched lazily via `plugin-mcp:get-full-schema` only when
 * the agent's own discovery query matches a tool.
 */
export interface PluginMcpToolSummary {
  name: string;
  /** Truncated to {@link PLUGIN_MCP_TOOL_DESCRIPTION_CAP} chars; absent if the server gave none. */
  description?: string;
}

/**
 * Tier-2 full tool definition — the cached `tools/list` entry including the
 * JSON input schema and annotations. Returned by `plugin-mcp:get-full-schema`.
 * `inputSchema` is typed `unknown` because no shared JSON-schema type exists
 * and the supervisor never inspects its shape (consistent with how
 * `PluginMcpConsentService` types it for TOFU fingerprinting).
 */
export interface PluginMcpFullTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

/**
 * Result of `plugin-mcp:list-tools`. Carries the tier-1 summaries plus the cap
 * that was applied — `truncated` is true when the global per-session cap
 * ({@link PluginMcpServerKey}-spanning) clipped this server's list.
 */
export interface PluginMcpListToolsResult {
  pluginId: string;
  serverId: string;
  tools: PluginMcpToolSummary[];
  /** True when the global per-session cap clipped the returned list. */
  truncated: boolean;
  /** The cap applied (advanced setting `pluginMcpConfig.maxToolsPerSession`). */
  maxToolsPerSession: number;
}

/**
 * Result of `plugin-mcp:get-full-schema`. A discriminated union so callers can
 * handle the not-found case (e.g. a stale tool name after a crash refetch)
 * without a thrown error — mirrors `getStderr` returning an empty result for
 * an unknown server rather than throwing.
 */
export type PluginMcpGetFullSchemaResult =
  { found: true; tool: PluginMcpFullTool } | { found: false };

/**
 * Input to `plugin-mcp:call-tool`. Identifies one supervised server plus the
 * tool the assistant selected and the arguments the model produced. `args` is
 * the raw argument object; it is hashed for the audit row and redacted for the
 * consent preview in main — it is never persisted or echoed back to the
 * renderer.
 */
export interface PluginMcpCallToolInput {
  pluginId: string;
  serverId: string;
  toolName: string;
  args?: Record<string, unknown>;
}

/**
 * Result of `plugin-mcp:call-tool`. A discriminated union so the renderer
 * (assistant) distinguishes a delivered MCP result from a consent/cap denial
 * or a dispatch error without inspecting thrown-error shapes.
 *
 * - `success` — consent approved and the supervised server returned. `result`
 *   is the raw MCP `CallToolResult`; the renderer formats it for the model.
 * - `denied` — refused before dispatch (consent rejected/timed-out, capability
 *   cap exceeded, or rate limited). `retryAfterMs` is set only when the denial
 *   is a transient rate-limit throttle.
 * - `error` — consent approved but the dispatched call failed (server not
 *   ready, timeout, subprocess write failure). `message` is diagnostic.
 */
export type PluginMcpCallToolResult =
  | { kind: "success"; result: unknown }
  | { kind: "denied"; errorCode: string; retryAfterMs?: number }
  | { kind: "error"; errorCode: string; message: string };

/**
 * Input to `plugin-mcp:resolve-consent` — the renderer's reply to a
 * `plugin-mcp:consent-request` push, correlated by `requestId`.
 */
export interface PluginMcpResolveConsentInput {
  requestId: string;
  decision: import("../pluginMcpConsent.js").PluginMcpConsentDecision;
}

/**
 * Advanced plugin-MCP tuning surfaced via `plugin-mcp:get-config` /
 * `plugin-mcp:set-config` (#9235). Persisted in the `pluginMcpConfig` store
 * slice. Kept a distinct object (rather than loose IPC args) so future tuning
 * knobs can be added without widening the channel signature.
 */
export interface PluginMcpConfig {
  /** Hard cap on tools surfaced across ALL servers per session. */
  maxToolsPerSession: number;
}

/** Per-server ring cap — capped lines retained for the `Settings → MCP` log view. */
export const PLUGIN_MCP_STDERR_RING_LINES = 500;

/** Clamp bounds for the user-configurable tool cap. */
export const PLUGIN_MCP_MIN_MAX_TOOLS_PER_SESSION = 1;
export const PLUGIN_MCP_MAX_MAX_TOOLS_PER_SESSION = 10_000;

/**
 * Tier-1 description cap (#9235). Descriptions longer than this are sliced and
 * suffixed with an ellipsis before injection so a verbose third-party server
 * can't blow the agent's context budget at session start.
 */
export const PLUGIN_MCP_TOOL_DESCRIPTION_CAP = 200;

/**
 * Default hard cap on the number of tools surfaced across ALL supervised
 * servers within a session (#9235). Surfaced as the advanced setting
 * `pluginMcpConfig.maxToolsPerSession`; this constant is the fallback when the
 * setting is absent or invalid.
 */
export const PLUGIN_MCP_DEFAULT_MAX_TOOLS_PER_SESSION = 200;
