import type { ClientEndpoint } from "../../ipc/endpoint.js";

/**
 * Names the endpoint that drives a project, or `null` when nobody does. The
 * drive lease is a remote-hosts service, so core code never imports it: the
 * remote boot installs this resolver, and without one MCP routing keeps its
 * focus- and workspace-based resolution.
 */
export type McpDriveTargetResolver = (projectId: string) => ClientEndpoint | null;

let resolver: McpDriveTargetResolver | null = null;

export function setMcpDriveTargetResolver(next: McpDriveTargetResolver | null): () => void {
  resolver = next;
  return () => {
    if (resolver === next) resolver = null;
  };
}

/**
 * The live endpoint driving `projectId`, `null` when the lease says nobody is,
 * or `undefined` when no lease is installed and the caller must decide the
 * pre-lease way.
 *
 * A closed endpoint is nobody: a lease can outlive its holder by the moment it
 * takes the host to notice the disconnect, and dispatching into a closed
 * endpoint would only fail later with a less honest error.
 */
export function resolveMcpDriveTarget(projectId: string): ClientEndpoint | null | undefined {
  if (resolver === null) return undefined;
  let endpoint: ClientEndpoint | null;
  try {
    endpoint = resolver(projectId);
  } catch (err) {
    console.warn("[MCP] Drive lease lookup failed; routing as if no lease were installed:", err);
    return undefined;
  }
  if (endpoint === null || endpoint.isClosed()) return null;
  return endpoint;
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
