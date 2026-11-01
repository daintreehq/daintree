import type http from "node:http";
import {
  createDecisionsMcpHandler,
  type DecisionsBridge,
  type PaneAuthenticator,
} from "@daintreehq/decisions-client";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { ListenerRoute } from "../mcp-server/listenerHold.js";
import { createPaneAccess, type PaneAccessSources } from "./paneAccess.js";
import { QuestionBridge } from "./questionBridge.js";
import type { QuestionSource } from "./relayConnection.js";

export const DECISIONS_MCP_PATH = "/mcp/decisions";

/** The slice of a listener hold the route keeps (`McpServerService.holdListener`). */
export interface DecisionsListenerHold {
  release(): Promise<void>;
}

export type DecisionsHoldListener = (
  id: string,
  route: ListenerRoute
) => Promise<DecisionsListenerHold>;

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ error: "not_found" }));
}

/**
 * `/mcp/decisions` on the loopback listener, while questions can be asked
 * (#16011). It holds the listener whether or not the MCP server is on, and
 * serves the library's handler there. The listener's duplicate-header, Host
 * and Origin checks run first; the handler then checks the Host again,
 * refuses any Origin at all, and authenticates every request by its pane
 * bearer. It keeps no session, so a revoked bearer is refused on its next
 * request. One handler serves the route's whole life, so a pane's rate limit
 * carries across relay attempts and listener moves.
 */
export class DecisionsMcpRoute {
  private readonly handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  private port: number | null = null;
  private closed = false;
  private opening: Promise<DecisionsListenerHold | null> | null = null;

  constructor(
    bridge: DecisionsBridge,
    authenticator: PaneAuthenticator,
    private readonly holdListener: DecisionsHoldListener
  ) {
    this.handler = createDecisionsMcpHandler(bridge, authenticator, {
      path: DECISIONS_MCP_PATH,
      allowedHosts: () =>
        this.port === null ? [] : [`127.0.0.1:${this.port}`, `localhost:${this.port}`],
    });
  }

  /** Takes the listener hold. Rejects if the hold can't be had; a close meanwhile releases it. */
  open(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.opening ??= this.holdListener("decisions", {
      path: DECISIONS_MCP_PATH,
      handle: (req, res, _url, port) => {
        if (this.closed) {
          notFound(res);
          return Promise.resolve();
        }
        this.port = port;
        return this.handler(req, res);
      },
    }).then(async (hold) => {
      if (!this.closed) return hold;
      await hold.release();
      return null;
    });
    return this.opening.then(() => {});
  }

  /** Refuses every request from now on, then lets the listener hold go. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    const hold = await this.opening?.catch(() => null);
    await hold?.release();
  }
}

export interface DecisionsMcpRouteSources extends PaneAccessSources {
  holdListener: DecisionsHoldListener;
}

/** What a lifetime closes when questions can no longer be asked. */
export interface DecisionsQuestions {
  close(): Promise<void>;
}

/** Serves agents' questions over `source` on `/mcp/decisions` until closed. */
export function openDecisionsMcpRoute(
  source: QuestionSource,
  sources: DecisionsMcpRouteSources
): DecisionsQuestions {
  const access = createPaneAccess(sources);
  const bridge = new QuestionBridge({ source, isCurrent: access.isCurrent });
  const route = new DecisionsMcpRoute(bridge, access.authenticator, sources.holdListener);
  route.open().catch((error: unknown) => {
    console.warn(
      `[Decisions] /mcp/decisions couldn't hold the MCP listener: ${formatErrorMessage(error, "unknown error")}`
    );
  });
  return route;
}
