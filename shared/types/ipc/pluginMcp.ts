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

/** Per-server ring cap — capped lines retained for the `Settings → MCP` log view. */
export const PLUGIN_MCP_STDERR_RING_LINES = 500;
