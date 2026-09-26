import type { ClientEndpoint } from "../../ipc/endpoint.js";

/**
 * Who MCP dispatch should reach for a project, as the drive lease sees it.
 *
 * - `vacant`: nobody drives it. A local view that shows it is still found the
 *   usual way; with none, the host may run the action itself.
 * - `unavailable`: a holder exists but cannot be reached right now — its link
 *   dropped or its view went, inside the lease's reservation — or the lease
 *   could not be read. Retriable, and never routed to anyone else meanwhile.
 * - `live`: the endpoint that drives it.
 */
export type McpDriveTarget =
  | { state: "vacant" }
  | { state: "unavailable"; reason: "reserved" | "lookup-failed" }
  | { state: "live"; endpoint: ClientEndpoint };

/**
 * The drive lease is a remote-hosts service, so core code never imports it:
 * the remote boot installs this resolver in Host mode.
 */
export type McpDriveTargetResolver = (projectId: string) => McpDriveTarget;

let resolver: McpDriveTargetResolver | null = null;

export function setMcpDriveTargetResolver(next: McpDriveTargetResolver | null): () => void {
  resolver = next;
  return () => {
    if (resolver === next) resolver = null;
  };
}

/**
 * Whether Host-mode routing is on: the drive lease decides MCP targets and the
 * host may run actions with no frontend attached. Off, MCP routes, fails and
 * describes its surface exactly as it did before Remote Hosts existed.
 */
export function isMcpHostRoutingEnabled(): boolean {
  return resolver !== null;
}

/**
 * Where MCP dispatch for `projectId` goes, or `null` when no lease is installed
 * and the caller must route the pre-lease way.
 *
 * A failed lookup is not "no lease": falling back to legacy routing then could
 * reach a renderer the lease says is not driving. A live answer whose endpoint
 * has since closed is a holder that just went, which is what the lease's
 * reservation covers.
 */
export function resolveMcpDriveTarget(projectId: string): McpDriveTarget | null {
  if (resolver === null) return null;
  let target: McpDriveTarget;
  try {
    target = resolver(projectId);
  } catch (err) {
    console.warn("[MCP] Drive lease lookup failed:", err);
    return { state: "unavailable", reason: "lookup-failed" };
  }
  if (target.state === "live" && target.endpoint.isClosed()) {
    return { state: "unavailable", reason: "reserved" };
  }
  return target;
}

/** @internal Tests only. */
export function _resetMcpDriveTargetResolverForTesting(): void {
  resolver = null;
}

/**
 * The request a Host sends a remote driving view through `endpoint.request()`
 * to run an action. The payload is the local dispatch request without its
 * `requestId` (the endpoint correlates); the answer is the local response
 * without one: `{ result, confirmationDecision?, approvalScope? }`.
 */
export const MCP_DISPATCH_ACTION_METHOD = "mcp:dispatch-action";

/** Fetch a remote driving view's action manifest; answers the manifest array. */
export const MCP_GET_MANIFEST_METHOD = "mcp:get-manifest";
