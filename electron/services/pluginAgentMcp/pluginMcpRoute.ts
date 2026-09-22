import type http from "node:http";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PluginMcpCaller } from "../../../shared/types/plugin.js";
import { extractBearerToken } from "../mcp-server/tierAuth.js";
import { parseWorkspaceSelector } from "../mcp-server/workspaceSelector.js";
import {
  MCP_HANDSHAKE_REJECTED_CODE,
  MCP_SSE_IDLE_TIMEOUT_MS,
  MCP_WORKSPACE_ID_HEADER,
  MCP_WORKSPACE_ID_QUERY_PARAM,
} from "../mcp-server/shared.js";
import { agentMcpEndpointRegistry, type AgentMcpEndpointRegistry } from "./endpointRegistry.js";
import {
  pluginMcpGrantRegistry,
  type PluginMcpGrant,
  type PluginMcpGrantRegistry,
} from "./grantRegistry.js";
import { isAgentMcpEndpointEnabled } from "./projectEnablement.js";
import { createPluginSessionServer } from "./pluginSessionServer.js";
import { PLUGIN_MCP_ROUTE_PREFIX, type PluginMcpRouteHandler } from "./types.js";

/**
 * Open sessions one credential may hold. An agent needs one; a few more covers
 * reconnects that race the old session's teardown. Beyond that a leaked or
 * misbehaving credential would just be allocating servers until the idle
 * reaper caught up.
 */
export const MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL = 8;

export interface PluginMcpRouteDeps {
  /** Whether the plugin instance is loaded right now (`PluginService.hasPlugin`). */
  isPluginLoaded: (pluginInstanceId: string) => boolean | Promise<boolean>;
  /** Idempotent lazy activation (`PluginService.activatePlugin`). */
  activatePlugin: (pluginInstanceId: string) => Promise<void>;
  isEndpointEnabled?: (projectId: string, pluginInstanceId: string, endpointId: string) => boolean;
  grantRegistry?: PluginMcpGrantRegistry;
  endpointRegistry?: AgentMcpEndpointRegistry;
  idleTimeoutMs?: number;
  callTimeoutMs?: number;
  maxResultBytes?: number;
}

interface PluginMcpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  credentialId: string;
  pluginInstanceId: string;
  endpointId: string;
  idleTimer: ReturnType<typeof setTimeout>;
  /** Aborted on teardown; every in-flight call of the session listens to it. */
  lifetime: AbortController;
  /** Follow-up responses handed to the SDK and not yet finished. */
  openResponses: Set<http.ServerResponse>;
}

/**
 * Invert {@link pluginMcpRoutePath}: exactly two non-empty segments after the
 * prefix, each decoded once. Anything else — a trailing slash, an extra
 * segment, malformed escapes — names no endpoint.
 */
export function parsePluginMcpRoute(
  pathname: string
): { pluginInstanceId: string; endpointId: string } | null {
  if (!pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX)) return null;
  const segments = pathname.slice(PLUGIN_MCP_ROUTE_PREFIX.length).split("/");
  if (segments.length !== 2 || segments[0] === "" || segments[1] === "") return null;
  try {
    const pluginInstanceId = decodeURIComponent(segments[0]);
    const endpointId = decodeURIComponent(segments[1]);
    if (pluginInstanceId === "" || endpointId === "") return null;
    return { pluginInstanceId, endpointId };
  } catch {
    return null;
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeText(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "text/plain", ...headers });
  res.end(body);
}

function writeSessionNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    })
  );
}

function writeWorkspaceRejected(res: http.ServerResponse, code: string, message: string): void {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: MCP_HANDSHAKE_REJECTED_CODE, message, data: { code } },
      id: null,
    })
  );
}

/**
 * The plugin-only MCP surface: `/mcp/plugin/<pluginInstanceId>/<endpointId>`.
 *
 * Authenticates plugin grants and nothing else. Orchestration bearers (api key,
 * pane, help) are simply not grants here and get a 401, and nothing on this
 * path ever reaches orchestration routing. Every HTTP leg is re-authenticated
 * rather than trusting the session id, because a session id is a routing
 * handle, not proof of who is calling: a session answers only to the credential
 * that created it, and to the route it was created on.
 */
export class PluginMcpRoute implements PluginMcpRouteHandler {
  private readonly sessions = new Map<string, PluginMcpSession>();
  private readonly sessionsByCredential = new Map<string, Set<string>>();
  private readonly isPluginLoaded: PluginMcpRouteDeps["isPluginLoaded"];
  private readonly activatePlugin: PluginMcpRouteDeps["activatePlugin"];
  private readonly isEndpointEnabled: NonNullable<PluginMcpRouteDeps["isEndpointEnabled"]>;
  private readonly grants: PluginMcpGrantRegistry;
  private readonly endpoints: AgentMcpEndpointRegistry;
  private readonly idleTimeoutMs: number;
  private readonly callTimeoutMs: number | undefined;
  private readonly maxResultBytes: number | undefined;
  private readonly offRevoked: () => void;
  /**
   * Bumped by {@link closeAllSessions}, so a handshake still in flight when the
   * listener stops cannot file a session after the sweep that should have
   * closed it.
   */
  private epoch = 0;

  constructor(deps: PluginMcpRouteDeps) {
    this.isPluginLoaded = deps.isPluginLoaded;
    this.activatePlugin = deps.activatePlugin;
    this.isEndpointEnabled = deps.isEndpointEnabled ?? isAgentMcpEndpointEnabled;
    this.grants = deps.grantRegistry ?? pluginMcpGrantRegistry;
    this.endpoints = deps.endpointRegistry ?? agentMcpEndpointRegistry;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? MCP_SSE_IDLE_TIMEOUT_MS;
    this.callTimeoutMs = deps.callTimeoutMs;
    this.maxResultBytes = deps.maxResultBytes;
    // Grants are deleted before this fires, so any request racing the close
    // already fails authentication; this only has to reap what is open.
    this.offRevoked = this.grants.onRevoked((revoked) => {
      for (const grant of revoked) this.closeCredentialSessions(grant.credentialId);
    });
  }

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    port: number
  ): Promise<void> {
    try {
      await this.route(req, res, url, port);
    } catch (err) {
      console.error("[PluginAgentMcp] plugin MCP request failed:", err);
      if (!res.headersSent) writeText(res, 500, "Internal server error");
      else if (!res.writableEnded) res.end();
    }
  }

  closeAllSessions(): void {
    this.epoch += 1;
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
  }

  /** Stop listening for revocations and close everything. For tests and shutdown. */
  dispose(): void {
    this.offRevoked();
    this.closeAllSessions();
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  private async route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    port: number
  ): Promise<void> {
    // Captured before the first await, so a request that resumes after the
    // listener stopped can tell the sweep already ran.
    const epoch = this.epoch;
    const grant = this.authenticate(req);
    if (!grant) {
      writeText(res, 401, "Unauthorized", {
        "WWW-Authenticate": 'Bearer realm="Daintree plugin MCP"',
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      writeText(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
      return;
    }

    // A grant names exactly one endpoint of one plugin instance; the path must
    // agree, so a credential can never be pointed at a sibling endpoint.
    const target = parsePluginMcpRoute(url.pathname);
    if (
      target === null ||
      target.pluginInstanceId !== grant.pluginInstanceId ||
      target.endpointId !== grant.endpointId
    ) {
      writeText(res, 403, "Forbidden");
      return;
    }

    let loaded = false;
    try {
      loaded = await this.isPluginLoaded(grant.pluginInstanceId);
    } catch (err) {
      console.error("[PluginAgentMcp] plugin load check failed:", err);
    }
    // Re-read after the await: a revocation that landed meanwhile has already
    // closed this credential's sessions and must not be undone by this request.
    if (!this.grants.isLive(grant.credentialId)) {
      writeText(res, 401, "Unauthorized", {
        "WWW-Authenticate": 'Bearer realm="Daintree plugin MCP"',
      });
      return;
    }
    if (
      !loaded ||
      !this.isEndpointEnabled(grant.projectId, grant.pluginInstanceId, grant.endpointId)
    ) {
      writeText(res, 403, "Forbidden");
      return;
    }

    // The grant already fixes the project. A selector is optional, but one that
    // names anything else is a client that believes it is scoped elsewhere.
    const selector = parseWorkspaceSelector(
      req.headers[MCP_WORKSPACE_ID_HEADER],
      url.searchParams.getAll(MCP_WORKSPACE_ID_QUERY_PARAM)
    );
    if (selector.kind === "reject") {
      writeWorkspaceRejected(res, selector.rejection.code, selector.rejection.message);
      return;
    }
    if (selector.kind === "selector" && selector.workspaceId !== grant.projectId) {
      writeWorkspaceRejected(
        res,
        "WORKSPACE_SELECTOR_MISMATCH",
        "This plugin endpoint credential is bound to a different workspace than the one requested."
      );
      return;
    }

    const sessionId = headerString(req.headers["mcp-session-id"]);
    if (sessionId !== undefined && sessionId !== "") {
      const session = this.sessions.get(sessionId);
      // Unknown, owned by another credential, or created on another route all
      // answer identically, so a guessed or stolen id reveals nothing.
      if (
        !session ||
        session.credentialId !== grant.credentialId ||
        session.pluginInstanceId !== grant.pluginInstanceId ||
        session.endpointId !== grant.endpointId
      ) {
        writeSessionNotFound(res);
        return;
      }
      this.resetIdleTimer(sessionId, session);
      // The SDK reads the body before it opens this request's stream, and its
      // `close()` only ends the streams that exist. A session torn down during
      // that read would leave this response open with nothing left to answer
      // it — and the SDK waiting on it — so teardown ends every response the
      // session was handed.
      session.openResponses.add(res);
      res.once("close", () => session.openResponses.delete(res));
      await session.transport.handleRequest(req, res);
      if (session.lifetime.signal.aborted && !res.writableEnded) res.end();
      return;
    }

    if (this.epoch !== epoch) {
      writeText(res, 503, "Service unavailable");
      return;
    }
    if (
      (this.sessionsByCredential.get(grant.credentialId)?.size ?? 0) >=
      MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL
    ) {
      writeText(res, 429, "Too many sessions for this credential");
      return;
    }
    await this.handleNewSession(req, res, grant, port, epoch);
  }

  private authenticate(req: http.IncomingMessage): PluginMcpGrant | null {
    const token = extractBearerToken(req.headers.authorization ?? "");
    if (token === null) return null;
    return this.grants.authenticate(token);
  }

  private async handleNewSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    grant: PluginMcpGrant,
    port: number,
    epoch: number
  ): Promise<void> {
    const caller: PluginMcpCaller = Object.freeze({
      credentialId: grant.credentialId,
      projectId: grant.projectId,
      terminalId: grant.terminalId,
      ...(grant.launchAgentIdHint !== undefined
        ? { launchAgentIdHint: grant.launchAgentIdHint }
        : {}),
    });
    const lifetime = new AbortController();
    const server = createPluginSessionServer({
      pluginInstanceId: grant.pluginInstanceId,
      endpointId: grant.endpointId,
      caller,
      sessionSignal: lifetime.signal,
      activatePlugin: this.activatePlugin,
      endpointRegistry: this.endpoints,
      ...(this.callTimeoutMs !== undefined ? { callTimeoutMs: this.callTimeoutMs } : {}),
      ...(this.maxResultBytes !== undefined ? { maxResultBytes: this.maxResultBytes } : {}),
    });

    const newSessionId = randomUUID();
    // enableDnsRebindingProtection / allowedHosts / allowedOrigins are
    // deprecated in SDK ^1.27.1; the listener's manual gate is authoritative.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      onsessioninitialized: (initializedSessionId) => {
        if (lifetime.signal.aborted) return;
        const idleTimer = this.createIdleTimer(initializedSessionId);
        this.sessions.set(initializedSessionId, {
          transport,
          server,
          credentialId: grant.credentialId,
          pluginInstanceId: grant.pluginInstanceId,
          endpointId: grant.endpointId,
          idleTimer,
          lifetime,
          openResponses: new Set(),
        });
        let ids = this.sessionsByCredential.get(grant.credentialId);
        if (!ids) {
          ids = new Set();
          this.sessionsByCredential.set(grant.credentialId, ids);
        }
        ids.add(initializedSessionId);
      },
    });

    // Set before `connect`, which chains the SDK's own close handling after it.
    transport.onclose = () => {
      this.forgetSession(transport.sessionId ?? newSessionId);
      lifetime.abort();
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[PluginAgentMcp] plugin MCP handshake failed:", err);
      this.forgetSession(transport.sessionId ?? newSessionId);
      lifetime.abort();
      await server.close().catch(() => {});
      if (!res.headersSent) writeText(res, 500, "Internal server error");
      return;
    }

    if (!this.sessions.has(newSessionId)) {
      // The SDK answers a malformed pre-initialize request — wrong `Accept`,
      // an unparseable body, a method other than `initialize` — with a 4xx
      // rather than throwing, so no session was ever filed. Release the server
      // and transport that were built for it.
      lifetime.abort();
      await server.close().catch(() => {});
      return;
    }

    // Revoked, or the listener stopped, while the handshake was in flight: the
    // sweep ran before this session existed, so close it now.
    if (!this.grants.isLive(grant.credentialId) || this.epoch !== epoch) {
      this.closeSession(newSessionId);
    }
  }

  private createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.closeSession(sessionId), this.idleTimeoutMs);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(sessionId: string, session: PluginMcpSession): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }

  private closeCredentialSessions(credentialId: string): void {
    const ids = this.sessionsByCredential.get(credentialId);
    if (!ids) return;
    for (const sessionId of [...ids]) this.closeSession(sessionId);
  }

  /** Abort the session's in-flight calls, drop it from every index, then close the transport. */
  private closeSession(sessionId: string): void {
    const session = this.forgetSession(sessionId);
    if (!session) return;
    session.lifetime.abort();
    session.server.close().catch((err: unknown) => {
      console.error("[PluginAgentMcp] closing plugin MCP session failed:", err);
    });
    for (const res of session.openResponses) {
      if (res.writableEnded) continue;
      if (!res.headersSent) writeSessionNotFound(res);
      else res.end();
    }
    session.openResponses.clear();
  }

  /** Idempotent: every teardown path funnels through here, in whatever order they fire. */
  private forgetSession(sessionId: string): PluginMcpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    clearTimeout(session.idleTimer);
    this.sessions.delete(sessionId);
    const ids = this.sessionsByCredential.get(session.credentialId);
    if (ids) {
      ids.delete(sessionId);
      if (ids.size === 0) this.sessionsByCredential.delete(session.credentialId);
    }
    return session;
  }
}

export function createPluginMcpRoute(deps: PluginMcpRouteDeps): PluginMcpRoute {
  return new PluginMcpRoute(deps);
}
