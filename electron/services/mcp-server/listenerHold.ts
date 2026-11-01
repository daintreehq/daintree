import type http from "node:http";
import { PLUGIN_MCP_ROUTE_PREFIX } from "../pluginAgentMcp/types.js";

/**
 * A feature's route on the loopback listener, served whether or not the MCP
 * server is on (#15999). A request reaches it only after the listener's shared
 * duplicate-header, Host and Origin checks, and it authenticates the request
 * itself: none of the control surface's credentials or sessions apply to it.
 */
export interface ListenerRoute {
  /** `/mcp/<name>`; the route serves it and every path below it. */
  path: string;
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    port: number
  ): Promise<void>;
  /** The listener closed or moved, or the hold ended: every connection it held is gone. */
  close?(): void;
}

export interface ListenerHold {
  /** The listener's port while it is open for this hold; null otherwise. */
  readonly port: number | null;
  /** Idempotent. The last hold to go, with the server off, closes the listener. */
  release(): Promise<void>;
}

const HELD_ROUTE_PATH = /^\/mcp\/[a-z0-9][a-z0-9-]*$/;
const PLUGIN_ROUTE_PATH = PLUGIN_MCP_ROUTE_PREFIX.slice(0, -1);

/** Throws for a path a hold may not take: not `/mcp/<name>`, or the plugin namespace. */
export function assertHeldRoutePath(path: string): void {
  if (!HELD_ROUTE_PATH.test(path) || path === PLUGIN_ROUTE_PATH) {
    throw new Error(`"${path}" is not a path a listener hold can serve`);
  }
}

export function heldRouteServes(path: string, pathname: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

/**
 * Whether `pathname` lies where a hold's route would be: under `/mcp/`, outside
 * the plugin namespace. With no hold serving it, nothing is there.
 */
export function inHeldRouteNamespace(pathname: string): boolean {
  return pathname.startsWith("/mcp/") && !pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX);
}

/** A route's own teardown must never stop the listener's. */
export function closeHeldRoute(route: ListenerRoute): void {
  try {
    route.close?.();
  } catch (err) {
    console.error(`[MCP] Closing the held route ${route.path} failed:`, err);
  }
}
