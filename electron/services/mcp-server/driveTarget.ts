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
  /** `holderName`: the driving machine's name, for refusals that say who drives. */
  | { state: "live"; endpoint: ClientEndpoint; holderName?: string };

/**
 * A change the host is about to make to the project itself, with no view:
 * relayed from a Shell on `linkSessionId`, or this machine's own with none.
 */
export interface McpDriveChange {
  linkSessionId: string | null;
}

/**
 * The drive lease is a remote-hosts service, so core code never imports it:
 * the remote boot installs this resolver in Host mode. Asked for a `change`,
 * a vacant answer lets the host make it, which the lease hears of.
 */
export type McpDriveTargetResolver = (projectId: string, change?: McpDriveChange) => McpDriveTarget;

let resolver: McpDriveTargetResolver | null = null;
const driveTargetChangeListeners = new Set<() => void>();

export function setMcpDriveTargetResolver(next: McpDriveTargetResolver | null): () => void {
  resolver = next;
  notifyMcpDriveTargetChange();
  return () => {
    if (resolver !== next) return;
    resolver = null;
    notifyMcpDriveTargetChange();
  };
}

/**
 * Hear that some project's drive target may have moved: a takeover, a holder
 * leaving, routing turned on or off. Core cannot subscribe to the drive lease
 * itself, so the remote boot reports its changes here. Returns a disposer.
 */
export function onMcpDriveTargetChange(listener: () => void): () => void {
  driveTargetChangeListeners.add(listener);
  return () => {
    driveTargetChangeListeners.delete(listener);
  };
}

export function notifyMcpDriveTargetChange(): void {
  for (const listener of [...driveTargetChangeListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[MCP] Drive target change listener threw:", err);
    }
  }
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
export function resolveMcpDriveTarget(
  projectId: string,
  change?: McpDriveChange
): McpDriveTarget | null {
  if (resolver === null) return null;
  let target: McpDriveTarget;
  try {
    target = resolver(projectId, change);
  } catch (err) {
    console.warn("[MCP] Drive lease lookup failed:", err);
    return { state: "unavailable", reason: "lookup-failed" };
  }
  if (target.state === "live" && target.endpoint.isClosed()) {
    return { state: "unavailable", reason: "reserved" };
  }
  return target;
}

/**
 * Whether a tool only a frontend can run would reach one for `projectId` now
 * (#14122), by the same reading dispatch makes: a reachable driver, or — while
 * nobody drives it, or no lease is installed — a view on this machine that
 * shows it. A holder the lease is keeping a place for answers nothing, so it
 * is not attached. `shownLocally` is the caller's own view lookup, which keeps
 * this module free of the window registry.
 */
export function isMcpFrontendAttached(projectId: string, shownLocally: boolean): boolean {
  const target = resolveMcpDriveTarget(projectId);
  if (target === null) return shownLocally;
  switch (target.state) {
    case "live":
      return true;
    case "unavailable":
      return false;
    case "vacant":
      return shownLocally;
  }
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
