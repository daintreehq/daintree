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
import { isPluginMcpGrantAllowed } from "./projectEnablement.js";
import { createPluginSessionServer } from "./pluginSessionServer.js";
import { PLUGIN_MCP_ROUTE_PREFIX, type PluginMcpRouteHandler } from "./types.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:PluginAgentMcp");

/**
 * Open sessions one credential may hold. An agent needs one; a few more covers
 * reconnects that race the old session's teardown. Beyond that a leaked or
 * misbehaving credential would just be allocating servers until the idle
 * reaper caught up.
 */
export const MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL = 8;

/**
 * How long an admitted `initialize` may hold its slot before the SDK files it.
 * The only slow step in that window is receiving the request body, which a
 * local client sends at once; plugin activation and roster discovery come after.
 */
const PLUGIN_MCP_HANDSHAKE_TIMEOUT_MS = 10_000;
/**
 * How long a request on a credential held by a plugin reload waits for the
 * reload to be judged. A rebuild normally settles well inside this; past it the
 * request is answered 503 and the client retries.
 */
const PLUGIN_MCP_RELOAD_WAIT_MS = 15_000;
/** Requests one credential may have parked on a reload at once; the rest get 503 now. */
export const MAX_PARKED_PLUGIN_MCP_REQUESTS_PER_CREDENTIAL = 8;
/**
 * A rejection is logged once per kind and credential in this window: a client
 * retrying a dead credential would otherwise write a line per attempt.
 */
export const PLUGIN_MCP_REJECTION_LOG_INTERVAL_MS = 60_000;
export const MAX_TRACKED_PLUGIN_MCP_REJECTIONS = 512;

/**
 * Why a request was refused, as logged. Categories and public identifiers
 * only: never the bearer, its digest, or the Authorization header.
 */
type PluginMcpRejection =
  | "missing-bearer"
  | "unknown-bearer"
  | "revoked"
  | "method-not-allowed"
  | "route-mismatch"
  | "plugin-not-loaded"
  | "access-not-allowed"
  | "reload-pending"
  | "workspace-rejected"
  | "session-not-found"
  | "session-cap"
  | "listener-stopped";

export interface PluginMcpRouteDeps {
  /** Whether the plugin instance is loaded right now (`PluginService.hasPlugin`). */
  isPluginLoaded: (pluginInstanceId: string) => boolean | Promise<boolean>;
  /** Idempotent lazy activation (`PluginService.activatePlugin`). */
  activatePlugin: (pluginInstanceId: string) => Promise<void>;
  /** Whether the project's current access still covers what the grant reaches. */
  isGrantAllowed?: (grant: PluginMcpGrant) => boolean;
  grantRegistry?: PluginMcpGrantRegistry;
  endpointRegistry?: AgentMcpEndpointRegistry;
  idleTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  reloadWaitMs?: number;
  callTimeoutMs?: number;
  maxResultBytes?: number;
}

interface PluginMcpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  credentialId: string;
  pluginInstanceId: string;
  idleTimer: ReturnType<typeof setTimeout>;
  /** Aborted on teardown; every in-flight call of the session listens to it. */
  lifetime: AbortController;
  /** Follow-up responses handed to the SDK and not yet finished. */
  openResponses: Set<http.ServerResponse>;
}

interface PendingHandshake {
  deadline: ReturnType<typeof setTimeout>;
  /** Ends the handshake's connection; the SDK has no way to cancel one mid-read. */
  abandon: () => void;
}

/**
 * Invert {@link pluginMcpRoutePath}: exactly one non-empty segment after the
 * prefix, decoded once. Anything else — a trailing slash, an extra segment,
 * malformed escapes — names no plugin.
 */
export function parsePluginMcpRoute(pathname: string): { pluginInstanceId: string } | null {
  if (!pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX)) return null;
  const segments = pathname.slice(PLUGIN_MCP_ROUTE_PREFIX.length).split("/");
  if (segments.length !== 1 || segments[0] === "") return null;
  try {
    const pluginInstanceId = decodeURIComponent(segments[0]);
    return pluginInstanceId === "" ? null : { pluginInstanceId };
  } catch {
    return null;
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function writeUnauthorized(res: http.ServerResponse, body = "Unauthorized"): void {
  writeText(res, 401, body, { "WWW-Authenticate": 'Bearer realm="Daintree plugin MCP"' });
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
 * The plugin-only MCP surface: `/mcp/plugin/<pluginInstanceId>`, one server per plugin.
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
  /** Admitted handshakes not yet filed as sessions, by credential then reserved session id. */
  private readonly pendingByCredential = new Map<string, Map<string, PendingHandshake>>();
  private readonly isPluginLoaded: PluginMcpRouteDeps["isPluginLoaded"];
  private readonly activatePlugin: PluginMcpRouteDeps["activatePlugin"];
  private readonly isGrantAllowed: NonNullable<PluginMcpRouteDeps["isGrantAllowed"]>;
  private readonly grants: PluginMcpGrantRegistry;
  private readonly endpoints: AgentMcpEndpointRegistry;
  private readonly idleTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly reloadWaitMs: number;
  /** Requests parked on a reload, by credential, each with its way out. */
  private readonly parked = new Map<string, Set<AbortController>>();
  private readonly callTimeoutMs: number | undefined;
  private readonly maxResultBytes: number | undefined;
  private readonly offRevoked: () => void;
  private readonly offKept: () => void;
  /** When each rejection kind was last logged, by kind and credential. */
  private readonly rejectionsLoggedAt = new Map<string, number>();
  /**
   * Bumped by {@link closeAllSessions}, so a handshake still in flight when the
   * listener stops cannot file a session after the sweep that should have
   * closed it.
   */
  private epoch = 0;

  constructor(deps: PluginMcpRouteDeps) {
    this.isPluginLoaded = deps.isPluginLoaded;
    this.activatePlugin = deps.activatePlugin;
    this.isGrantAllowed = deps.isGrantAllowed ?? isPluginMcpGrantAllowed;
    this.grants = deps.grantRegistry ?? pluginMcpGrantRegistry;
    this.endpoints = deps.endpointRegistry ?? agentMcpEndpointRegistry;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? MCP_SSE_IDLE_TIMEOUT_MS;
    this.handshakeTimeoutMs = deps.handshakeTimeoutMs ?? PLUGIN_MCP_HANDSHAKE_TIMEOUT_MS;
    this.reloadWaitMs = deps.reloadWaitMs ?? PLUGIN_MCP_RELOAD_WAIT_MS;
    this.callTimeoutMs = deps.callTimeoutMs;
    this.maxResultBytes = deps.maxResultBytes;
    // Grants are deleted before this fires, so any request racing the close
    // already fails authentication; this only has to reap what is open.
    this.offRevoked = this.grants.onRevoked((revoked) => {
      for (const grant of revoked) this.closeCredentialSessions(grant.credentialId);
    });
    // The reload's roster changes may have reached a client while its
    // credential was held, or not at all (a lazy plugin registers nothing until
    // asked). Once the credential is kept, tell its sessions to list again.
    this.offKept = this.grants.onKept((kept) => {
      for (const grant of kept) {
        for (const sessionId of this.sessionsByCredential.get(grant.credentialId) ?? []) {
          this.sessions
            .get(sessionId)
            ?.server.sendToolListChanged()
            .catch(() => {});
        }
      }
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
    // Parked requests wake to the epoch bump and the re-checks after it.
    for (const waits of this.parked.values()) {
      for (const wait of waits) wait.abort();
    }
    for (const credentialId of [...this.pendingByCredential.keys()]) {
      this.abandonHandshakes(credentialId);
    }
    for (const sessionId of [...this.sessions.keys()]) this.closeSession(sessionId);
  }

  /** Stop listening for revocations and close everything. For tests and shutdown. */
  dispose(): void {
    this.offRevoked();
    this.offKept();
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
    const token = extractBearerToken(req.headers.authorization ?? "");
    const grant = token === null ? null : this.grants.authenticate(token);
    if (!grant) {
      this.rejectUnauthenticated(res, token, url);
      return;
    }

    if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
      this.logRejection(405, "method-not-allowed", grant.credentialId, {
        credentialId: grant.credentialId,
        method: req.method ?? null,
      });
      writeText(res, 405, "Method not allowed", { Allow: "GET, POST, DELETE" });
      return;
    }

    // A grant names exactly one plugin instance; the path must agree, so a
    // credential can never be pointed at another plugin.
    const target = parsePluginMcpRoute(url.pathname);
    if (target === null || target.pluginInstanceId !== grant.pluginInstanceId) {
      this.logRejection(403, "route-mismatch", grant.credentialId, {
        credentialId: grant.credentialId,
        pluginInstanceId: grant.pluginInstanceId,
        requestedPluginInstanceId: target?.pluginInstanceId ?? null,
      });
      writeText(res, 403, "Forbidden");
      return;
    }

    // Mid-reload: the plugin is between generations and the credential is
    // waiting to be judged against the new one. Park the request rather than
    // fail it — a client refetching its tool list on the reload's
    // list_changed then gets the new roster, not an error. The re-reads below
    // catch a credential the reload revoked.
    if (this.grants.isHeld(grant.credentialId)) {
      await this.park(grant.credentialId, res);
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
      this.rejectUnauthenticated(res, token, url);
      return;
    }
    // Still (or newly) held: neither generation may serve this credential until
    // the new one has been judged. Transient, so its sessions stay open.
    if (this.grants.isHeld(grant.credentialId)) {
      this.logRejection(503, "reload-pending", grant.credentialId, {
        credentialId: grant.credentialId,
        pluginInstanceId: grant.pluginInstanceId,
      });
      writeText(res, 503, "Plugin is reloading", { "Retry-After": "1" });
      return;
    }
    if (!loaded || !this.isGrantAllowed(grant)) {
      this.logRejection(
        403,
        loaded ? "access-not-allowed" : "plugin-not-loaded",
        grant.credentialId,
        {
          credentialId: grant.credentialId,
          pluginInstanceId: grant.pluginInstanceId,
          projectId: grant.projectId,
        }
      );
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
      this.logRejection(400, "workspace-rejected", grant.credentialId, {
        credentialId: grant.credentialId,
        code: selector.rejection.code,
      });
      writeWorkspaceRejected(res, selector.rejection.code, selector.rejection.message);
      return;
    }
    if (selector.kind === "selector" && selector.workspaceId !== grant.projectId) {
      this.logRejection(400, "workspace-rejected", grant.credentialId, {
        credentialId: grant.credentialId,
        code: "WORKSPACE_SELECTOR_MISMATCH",
      });
      writeWorkspaceRejected(
        res,
        "WORKSPACE_SELECTOR_MISMATCH",
        "This plugin MCP credential is bound to a different workspace than the one requested."
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
        session.pluginInstanceId !== grant.pluginInstanceId
      ) {
        this.logRejection(404, "session-not-found", grant.credentialId, {
          credentialId: grant.credentialId,
          pluginInstanceId: grant.pluginInstanceId,
        });
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
      this.logRejection(503, "listener-stopped", grant.credentialId, {
        credentialId: grant.credentialId,
      });
      writeText(res, 503, "Service unavailable");
      return;
    }
    if (
      (this.sessionsByCredential.get(grant.credentialId)?.size ?? 0) +
        (this.pendingByCredential.get(grant.credentialId)?.size ?? 0) >=
      MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL
    ) {
      this.logRejection(429, "session-cap", grant.credentialId, {
        credentialId: grant.credentialId,
        pluginInstanceId: grant.pluginInstanceId,
      });
      writeText(res, 429, "Too many sessions for this credential");
      return;
    }
    // Reserved in the same turn as the cap check: a session is only filed once
    // the SDK has read its body and initialised it, and every handshake
    // admitted in the meantime has to count this one.
    const newSessionId = randomUUID();
    this.reserveHandshake(grant.credentialId, newSessionId, () => {
      // The request drops its connection even when a pipelined response is
      // still queued behind another and has no socket for `res` to destroy.
      req.destroy();
      res.destroy();
    });
    try {
      await this.handleNewSession(req, res, grant, port, epoch, newSessionId);
    } finally {
      this.releaseHandshake(grant.credentialId, newSessionId);
    }
  }

  /**
   * Wait out a reload holding this credential, bounded in time and in how many
   * of its requests may wait at once, and given up when the client goes away or
   * the listener stops. The caller re-checks everything afterwards.
   */
  private async park(credentialId: string, res: http.ServerResponse): Promise<void> {
    let waits = this.parked.get(credentialId);
    if (!waits) {
      waits = new Set();
      this.parked.set(credentialId, waits);
    }
    if (waits.size >= MAX_PARKED_PLUGIN_MCP_REQUESTS_PER_CREDENTIAL) return;
    const wait = new AbortController();
    const onClose = (): void => wait.abort();
    res.once("close", onClose);
    waits.add(wait);
    try {
      await this.grants.whenNotHeld(credentialId, this.reloadWaitMs, wait.signal);
    } finally {
      res.off("close", onClose);
      waits.delete(wait);
      if (waits.size === 0 && this.parked.get(credentialId) === waits) {
        this.parked.delete(credentialId);
      }
    }
  }

  /**
   * A 401, told apart in the log: no bearer, one never issued (or revoked too
   * long ago to remember), or one that was revoked and why. The revoked case
   * also says so in the body, so an agent CLI that surfaces it can tell its
   * user to relaunch rather than leave them guessing.
   */
  private rejectUnauthenticated(res: http.ServerResponse, token: string | null, url: URL): void {
    const requestedPluginInstanceId = parsePluginMcpRoute(url.pathname)?.pluginInstanceId ?? null;
    if (token === null) {
      this.logRejection(401, "missing-bearer", null, { requestedPluginInstanceId });
      writeUnauthorized(res);
      return;
    }
    const revoked = this.grants.describeRevoked(token);
    if (revoked === null) {
      this.logRejection(401, "unknown-bearer", null, { requestedPluginInstanceId });
      writeUnauthorized(res);
      return;
    }
    this.logRejection(401, "revoked", revoked.credentialId, {
      credentialId: revoked.credentialId,
      pluginInstanceId: revoked.pluginInstanceId,
      terminalId: revoked.terminalId,
      reason: revoked.reason,
      revokedAgoMs: Date.now() - revoked.revokedAt,
    });
    writeUnauthorized(
      res,
      `Unauthorized: this credential was revoked (${revoked.reason}). Relaunch the agent to get a new one.`
    );
  }

  private logRejection(
    status: number,
    rejection: PluginMcpRejection,
    credentialId: string | null,
    context: Record<string, unknown>
  ): void {
    const key = `${rejection}:${credentialId ?? ""}`;
    const now = Date.now();
    const last = this.rejectionsLoggedAt.get(key);
    if (last !== undefined && now - last < PLUGIN_MCP_REJECTION_LOG_INTERVAL_MS) return;
    if (last === undefined && this.rejectionsLoggedAt.size >= MAX_TRACKED_PLUGIN_MCP_REJECTIONS) {
      for (const [tracked, at] of this.rejectionsLoggedAt) {
        if (now - at >= PLUGIN_MCP_REJECTION_LOG_INTERVAL_MS)
          this.rejectionsLoggedAt.delete(tracked);
      }
      // Still full of live suppressions: dropping this line keeps the log
      // bounded, where clearing would let a cycle of keys log every request.
      if (this.rejectionsLoggedAt.size >= MAX_TRACKED_PLUGIN_MCP_REJECTIONS) return;
    }
    this.rejectionsLoggedAt.set(key, now);
    logger.warn(`Rejected plugin MCP request: ${status} ${rejection}`, context);
  }

  private async handleNewSession(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    grant: PluginMcpGrant,
    port: number,
    epoch: number,
    newSessionId: string
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
      scope: grant.scope,
      serverName: grant.serverName,
      caller,
      sessionSignal: lifetime.signal,
      isCallerServable: () =>
        this.grants.isLive(grant.credentialId) && !this.grants.isHeld(grant.credentialId),
      activatePlugin: this.activatePlugin,
      endpointRegistry: this.endpoints,
      ...(this.callTimeoutMs !== undefined ? { callTimeoutMs: this.callTimeoutMs } : {}),
      ...(this.maxResultBytes !== undefined ? { maxResultBytes: this.maxResultBytes } : {}),
    });

    // enableDnsRebindingProtection / allowedHosts / allowedOrigins are
    // deprecated in SDK ^1.27.1; the listener's manual gate is authoritative.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      onsessioninitialized: (initializedSessionId) => {
        if (lifetime.signal.aborted) return;
        // The reservation becomes the session in one step, so the cap never
        // counts it twice or not at all. One already abandoned stays that way.
        if (!this.releaseHandshake(grant.credentialId, initializedSessionId)) return;
        const idleTimer = this.createIdleTimer(initializedSessionId);
        this.sessions.set(initializedSessionId, {
          transport,
          server,
          credentialId: grant.credentialId,
          pluginInstanceId: grant.pluginInstanceId,
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

  private reserveHandshake(credentialId: string, sessionId: string, abandon: () => void): void {
    const deadline = setTimeout(
      () => this.releaseHandshake(credentialId, sessionId)?.abandon(),
      this.handshakeTimeoutMs
    );
    deadline.unref?.();
    let handshakes = this.pendingByCredential.get(credentialId);
    if (!handshakes) {
      handshakes = new Map();
      this.pendingByCredential.set(credentialId, handshakes);
    }
    handshakes.set(sessionId, { deadline, abandon });
  }

  /** Idempotent: promotion, the deadline, sweeps and the handshake's own exit all release here. */
  private releaseHandshake(credentialId: string, sessionId: string): PendingHandshake | undefined {
    const handshakes = this.pendingByCredential.get(credentialId);
    const handshake = handshakes?.get(sessionId);
    if (!handshakes || !handshake) return undefined;
    clearTimeout(handshake.deadline);
    handshakes.delete(sessionId);
    if (handshakes.size === 0) this.pendingByCredential.delete(credentialId);
    return handshake;
  }

  /**
   * Drop the connection of every handshake the credential still has pending.
   * Its body read then fails and the handshake unwinds through its own
   * failure paths, instead of holding the listener's drain or its slot open.
   */
  private abandonHandshakes(credentialId: string): void {
    const handshakes = this.pendingByCredential.get(credentialId);
    if (!handshakes) return;
    for (const sessionId of [...handshakes.keys()]) {
      this.releaseHandshake(credentialId, sessionId)?.abandon();
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
    this.abandonHandshakes(credentialId);
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
