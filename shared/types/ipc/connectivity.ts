/**
 * Per-service connectivity health.
 *
 * The main process probes a fixed set of remote dependencies (GitHub, agent
 * provider APIs, the local MCP server) and publishes one snapshot keyed by
 * service. The renderer consumes this map via the `useConnectivity` hook to
 * surface degraded-mode UI affordances and "reconnected" toasts.
 *
 * Probes are reachability-only for agent providers — Daintree does not own
 * the agent CLI's API keys, so any non-network HTTP response (including 4xx)
 * confirms the service is reachable. Only network-level errors flip a
 * service to `unreachable`.
 *
 * GitHub `unhealthy` (token revoked) deliberately maps to `unknown` here,
 * not `unreachable` — token validity is a distinct concern from network
 * reachability and is surfaced separately via `GitHubTokenHealthPayload`.
 */

/** Fixed set of services that are tracked. Dev-server connectivity is per-session and lives outside this snapshot. */
export type ConnectivityServiceKey =
  | "github"
  | "agent:claude"
  | "agent:gemini"
  | "agent:codex"
  | "mcp";

/** All known service keys in canonical order. */
export const CONNECTIVITY_SERVICE_KEYS: readonly ConnectivityServiceKey[] = [
  "github",
  "agent:claude",
  "agent:gemini",
  "agent:codex",
  "mcp",
] as const;

/**
 * Network reachability of a service.
 *
 * - `unknown`: no probe has completed yet, or a token-validity issue (not a network failure)
 * - `reachable`: the most recent probe succeeded or returned a non-network HTTP response
 * - `unreachable`: the most recent probe failed at the transport layer (DNS, timeout, connection refused)
 */
export type ServiceConnectivityStatus = "unknown" | "reachable" | "unreachable";

/** Push payload describing the current state of one service. */
export interface ServiceConnectivityPayload {
  /** Which service this update is for. */
  serviceKey: ConnectivityServiceKey;
  /** Current reachability status. */
  status: ServiceConnectivityStatus;
  /** Unix epoch milliseconds at which the last probe completed (0 if no probe has run). */
  checkedAt: number;
}

/** Fixed-shape map of every tracked service's current state. */
export type ServiceConnectivitySnapshot = Record<
  ConnectivityServiceKey,
  ServiceConnectivityPayload
>;
