/**
 * Per-service connectivity health.
 *
 * The main process aggregates the state of dependencies it already talks to
 * on its own account — the GitHub forge provider's token health and the local
 * MCP server subprocess — and publishes one snapshot keyed by service. The
 * renderer consumes this map via the `useConnectivity` hook to surface
 * degraded-mode UI affordances and "reconnected" toasts.
 *
 * Every entry is derived from work the app is already doing; nothing here
 * issues speculative traffic to observe a service. Agent provider APIs are
 * deliberately absent: Daintree neither holds the agent CLI's credentials nor
 * routes its requests, so an agent CLI reports its own upstream failures in
 * the terminal, on the path that actually failed.
 *
 * GitHub `unhealthy` (token revoked) deliberately maps to `unknown` here,
 * not `unreachable` — token validity is a distinct concern from network
 * reachability and is surfaced separately via `GitHubTokenHealthPayload`.
 */

/** Fixed set of services that are tracked. Dev-server connectivity is per-session and lives outside this snapshot. */
export type ConnectivityServiceKey = "github" | "mcp";

/** All known service keys in canonical order. */
export const CONNECTIVITY_SERVICE_KEYS: readonly ConnectivityServiceKey[] = [
  "github",
  "mcp",
] as const;

/**
 * Reachability of a service.
 *
 * - `unknown`: no state has been observed yet, or a token-validity issue (not a reachability failure)
 * - `reachable`: the most recent observation found the service healthy/running
 * - `unreachable`: the most recent observation found the service down
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
