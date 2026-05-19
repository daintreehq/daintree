import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { webContents as webContentsModule } from "electron";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
import { scrubSecrets } from "../../utils/secretScrubber.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import type {
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionActionContextResolver,
  McpTier,
} from "./shared.js";
import type {
  McpIssueGrantResult,
  McpRevokeSessionGrantsResult,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  extractBearerToken,
  isAuthorized,
  precomputeApiKeyBearerHash,
  resolveTokenTier,
} from "./tierAuth.js";
import { createSessionServer, cleanupResourceSubscriptions } from "./sessionServer.js";
import type { SessionStore } from "./sessionStore.js";
import type { AuditService } from "./auditLog.js";
import type { TurnOutcomeService } from "./turnOutcomeLog.js";
import {
  DEFAULT_PORT,
  MAX_PORT_RETRIES,
  MAX_RESTART_ATTEMPTS,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  RESTART_JITTER_MS,
  RESTART_STABLE_RESET_MS,
  MCP_SERVER_KEY,
} from "./shared.js";

export interface HttpLifecycleDeps {
  sessionStore: SessionStore;
  auditService: AuditService;
  turnOutcomeService: TurnOutcomeService;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  // Pinned variants used for help-session bearers — route to the renderer
  // WebContents that minted the bearer at provision time (#7002). Optional
  // for backward-compat with test fixtures that don't wire help routing.
  requestManifestForWebContents?: (
    id: number
  ) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchActionForWebContents?: (
    id: number,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    contextOverride?: import("../../../shared/types/actions.js").ActionContext
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  handleWaitUntilIdle: (
    rawArgs: unknown,
    signal: AbortSignal
  ) => Promise<import("./shared.js").WaitUntilIdleResult>;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  clearCachedManifest: () => void;
  cleanupListeners: Array<() => void>;
  pendingManifests: Map<
    string,
    import("./shared.js").PendingRequest<
      import("../../../shared/types/actions.js").ActionManifestEntry[]
    >
  >;
  pendingDispatches: Map<
    string,
    import("./shared.js").PendingRequest<import("./shared.js").DispatchEnvelope>
  >;
  setupIpcListeners: () => void;
  emitStatusChange: () => void;
  emitRuntimeStateChange: () => void;
  setConfig: (patch: Record<string, unknown>) => void;
}

export class HttpLifecycle {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private apiKeyBearerHash: Buffer | null = null;
  private registry: WindowRegistry | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private helpTokenValidator: HelpTokenValidator | null = null;
  private helpSessionWebContentsResolver: HelpSessionWebContentsResolver | null = null;
  private helpSessionActionContextResolver: HelpSessionActionContextResolver | null = null;
  private lastError: string | null = null;
  private intentionalStop = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HttpLifecycleDeps) {}

  get isRunning(): boolean {
    return this.httpServer !== null && this.httpServer.listening && this.port !== null;
  }

  get currentPort(): number | null {
    return this.port;
  }

  get currentApiKey(): string | null {
    return this.apiKey;
  }

  setApiKey(key: string | null): void {
    this.apiKey = key;
    this.apiKeyBearerHash = precomputeApiKeyBearerHash(key);
  }

  get lastErrorState(): string | null {
    return this.lastError;
  }

  setLastError(err: string | null): void {
    this.lastError = err;
  }

  get isIntentionalStop(): boolean {
    return this.intentionalStop;
  }

  get httpServerInstance(): http.Server | null {
    return this.httpServer;
  }

  setPort(port: number | null): void {
    this.port = port;
  }

  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.helpTokenValidator = validator;
  }

  setHelpSessionWebContentsResolver(resolver: HelpSessionWebContentsResolver | null): void {
    this.helpSessionWebContentsResolver = resolver;
  }

  setHelpSessionActionContextResolver(resolver: HelpSessionActionContextResolver | null): void {
    this.helpSessionActionContextResolver = resolver;
  }

  /**
   * Parses a Bearer header and asks the help-session resolver for the
   * pinned WebContents id. Returns null for non-help bearers (api-key /
   * pane tokens) so external sessions keep the existing focused-window
   * fallback in `buildSessionServerDeps`.
   */
  private resolvePinnedWebContentsId(authHeader: string): number | null {
    if (!this.helpSessionWebContentsResolver) return null;
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.helpSessionWebContentsResolver(token);
  }

  /**
   * Parses a Bearer header and asks the help-session resolver for the
   * `ActionContext` snapshot bound to it at provision time (#8317). Returns
   * null for non-help bearers so external/api-key sessions keep their live
   * focused-window context in `buildSessionServerDeps`.
   */
  private resolveActionContext(
    authHeader: string
  ): import("../../../shared/types/actions.js").ActionContext | null {
    if (!this.helpSessionActionContextResolver) return null;
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.helpSessionActionContextResolver(token);
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  private persistConfig(patch: Record<string, unknown>): void {
    this.deps.setConfig(patch);
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async start(registry: WindowRegistry): Promise<void> {
    this.registry = registry;

    if (this.stopPromise) {
      await this.stopPromise;
    }

    if (this.isRunning) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    const hadPriorFailure = this.lastError !== null;
    this.lastError = null;
    if (hadPriorFailure) this.deps.emitRuntimeStateChange();

    this.startPromise = (async () => {
      try {
        if (!this.apiKey) {
          const persisted = this.getConfig().apiKey;
          if (persisted && persisted.length > 0) {
            this.setApiKey(persisted);
          } else {
            this.setApiKey(`daintree_${randomUUID().replace(/-/g, "")}`);
            this.persistConfig({ apiKey: this.apiKey });
          }
        }

        this.deps.auditService.hydrate();

        const server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            console.error("[MCP] Request handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal server error");
            }
          });
        });

        server.keepAliveTimeout = 30_000;
        server.headersTimeout = 60_000;

        const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
        const boundPort = await this.listenWithRetry(server, configuredPort);

        if (boundPort === null) {
          throw new Error(
            `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
          );
        }

        this.port = boundPort;
        this.httpServer = server;
        this.deps.setupIpcListeners();
        this.attachServerSupervision(server);
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.restartAttempts = 0;
        }, RESTART_STABLE_RESET_MS);
        this.stableTimer.unref?.();
        console.log(
          `[MCP] Server started on http://127.0.0.1:${this.port}/mcp (Streamable HTTP) and /sse (legacy SSE)`
        );
        this.deps.emitStatusChange();
      } catch (err) {
        this.lastError = formatErrorMessage(err, "MCP server failed to start");
        this.deps.emitRuntimeStateChange();
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  private attachServerSupervision(server: http.Server): void {
    server.on("error", (err) => {
      console.error("[MCP] HTTP server error after bind:", err);
    });
    server.on("close", () => {
      if (server !== this.httpServer || this.intentionalStop) return;
      console.warn("[MCP] HTTP server closed unexpectedly — scheduling restart");
      this.handleUnexpectedClose();
    });
  }

  private handleUnexpectedClose(): void {
    this.deps.auditService.flushNow();
    this.deps.turnOutcomeService.flushNow();

    // Drain sessions
    this.deps.sessionStore.drain();

    for (const cleanup of this.deps.cleanupListeners) {
      try {
        cleanup();
      } catch {
        // best-effort
      }
    }
    this.deps.cleanupListeners.length = 0;

    for (const [id, pending] of this.deps.pendingManifests) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server closed unexpectedly"));
      this.deps.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.deps.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server closed unexpectedly"));
      this.deps.pendingDispatches.delete(id);
    }
    this.deps.clearCachedManifest();

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    this.httpServer = null;
    this.port = null;
    this.lastError = null;
    this.deps.emitStatusChange();

    if (!this.isEnabled() || !this.registry) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.lastError = `MCP server restart limit reached after ${MAX_RESTART_ATTEMPTS} attempts`;
      this.deps.emitRuntimeStateChange();
      return;
    }
    this.restartAttempts++;
    const baseDelay = RESTART_BASE_DELAY_MS * Math.pow(2, this.restartAttempts - 1);
    const jitter = Math.random() * RESTART_JITTER_MS;
    const delay = Math.min(baseDelay + jitter, RESTART_MAX_DELAY_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isEnabled() || !this.registry) return;
      void this.start(this.registry).catch((err) => {
        console.error("[MCP] Auto-restart attempt failed:", err);
        if (!this.isRunning && this.isEnabled() && this.registry) {
          this.scheduleRestart();
        }
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.restartAttempts = 0;
    this.intentionalStop = true;

    this.stopPromise = (async () => {
      try {
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // start failed; no server to close
          }
        }

        this.deps.auditService.flushNow();
        this.deps.turnOutcomeService.flushNow();
        this.deps.sessionStore.drain();

        for (const cleanup of this.deps.cleanupListeners) {
          try {
            cleanup();
          } catch {
            // best-effort
          }
        }
        this.deps.cleanupListeners.length = 0;

        for (const [id, pending] of this.deps.pendingManifests) {
          clearTimeout(pending.timer);
          pending.destroyedCleanup?.();
          pending.reject(new Error("MCP server stopped"));
          this.deps.pendingManifests.delete(id);
        }
        for (const [id, pending] of this.deps.pendingDispatches) {
          clearTimeout(pending.timer);
          pending.destroyedCleanup?.();
          pending.reject(new Error("MCP server stopped"));
          this.deps.pendingDispatches.delete(id);
        }
        this.deps.clearCachedManifest();

        let wasRunning = false;
        if (this.httpServer) {
          wasRunning = this.httpServer.listening;
          this.httpServer.closeAllConnections();
          await Promise.race([
            new Promise<void>((resolve) => {
              this.httpServer!.close(() => resolve());
            }),
            new Promise<void>((resolve) => {
              setTimeout(() => {
                console.warn("[MCP] server.close() timed out after 10s — force-clearing");
                resolve();
              }, 10_000).unref?.();
            }),
          ]);
          this.httpServer = null;
          this.port = null;
        }

        this.lastError = null;

        console.log("[MCP] Server stopped");
        if (wasRunning) {
          this.deps.emitStatusChange();
        } else {
          this.deps.emitRuntimeStateChange();
        }
      } finally {
        this.intentionalStop = false;
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  private async listenWithRetry(server: http.Server, startPort: number): Promise<number | null> {
    for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
      const port = startPort + attempt;
      if (port > 65535) break;

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener("error", onError);
            reject(err);
          };
          server.on("error", onError);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
        return (server.address() as AddressInfo)?.port ?? null;
      } catch {
        console.log(`[MCP] Port ${port} bind failed, trying next…`);
        continue;
      }
    }
    return null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (!(host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${this.port}` &&
      origin !== `http://localhost:${this.port}`
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    if (!isAuthorized(authHeader, this.apiKeyBearerHash, this.helpTokenValidator)) {
      this.deps.auditService.recordAuth401();
      res.writeHead(401, {
        "Content-Type": "text/plain",
        "WWW-Authenticate": 'Bearer realm="Daintree MCP"',
      });
      res.end("Unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });
      const sessionId = transport.sessionId;
      const tier = resolveTokenTier(authHeader, this.apiKeyBearerHash, this.helpTokenValidator);
      this.deps.sessionStore.sessionTierMap.set(sessionId, tier);

      const pinnedWebContentsId = this.resolvePinnedWebContentsId(authHeader);
      if (pinnedWebContentsId !== null) {
        this.deps.sessionStore.sessionWebContentsMap.set(sessionId, pinnedWebContentsId);
      }

      const boundActionContext = this.resolveActionContext(authHeader);
      if (boundActionContext !== null) {
        this.deps.sessionStore.sessionContextMap.set(sessionId, boundActionContext);
      }

      const deps = this.buildSessionServerDeps(sessionId);
      const server = createSessionServer(sessionId, deps);

      const idleTimer = this.deps.sessionStore.createIdleTimer(sessionId);
      this.deps.sessionStore.sessions.set(sessionId, { transport, idleTimer });
      transport.onclose = () => {
        const session = this.deps.sessionStore.sessions.get(sessionId);
        if (session) {
          clearTimeout(session.idleTimer);
          this.deps.sessionStore.sessions.delete(sessionId);
        }
        this.deps.sessionStore.sessionTierMap.delete(sessionId);
        // Revoke before deleting the WebContents pin so the lifecycle
        // emitter can still find the pinned renderer for the
        // `grant.revoked` push. The audit record carries the
        // `session-ended` reason. Without this, grants accumulate
        // forever in the cache across a long-running session lifecycle.
        this.deps.sessionStore.grantCache.revokeSession(sessionId, "session-ended");
        this.deps.sessionStore.sessionWebContentsMap.delete(sessionId);
        this.deps.sessionStore.sessionContextMap.delete(sessionId);
        this.deps.sessionStore.clearDedupState(sessionId);
        cleanupResourceSubscriptions(sessionId, this.deps.sessionStore);
      };

      try {
        await server.connect(transport);
      } catch (err) {
        clearTimeout(idleTimer);
        this.deps.sessionStore.sessions.delete(sessionId);
        this.deps.sessionStore.sessionTierMap.delete(sessionId);
        // Same pin-before-clear ordering — the connect failure path
        // mirrors normal close cleanup.
        this.deps.sessionStore.grantCache.revokeSession(sessionId, "session-ended");
        this.deps.sessionStore.sessionWebContentsMap.delete(sessionId);
        this.deps.sessionStore.sessionContextMap.delete(sessionId);
        this.deps.sessionStore.clearDedupState(sessionId);
        transport.onclose = undefined;
        await transport.close().catch(() => {});
        throw err;
      }
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sid = url.searchParams.get("sessionId") ?? "";
      const session = this.deps.sessionStore.sessions.get(sid);

      if (session) {
        this.deps.sessionStore.resetIdleTimer(sid);
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else if (url.pathname === "/mcp") {
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        res.writeHead(405, {
          Allow: "GET, POST, DELETE",
          "Content-Type": "text/plain",
        });
        res.end("Method not allowed");
        return;
      }
      await this.handleStreamableHttpRequest(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private async handleStreamableHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const headerValue = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (sessionId !== undefined && sessionId !== "") {
      const session = this.deps.sessionStore.httpSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }
      this.deps.sessionStore.resetHttpIdleTimer(sessionId);
      await session.transport.handleRequest(req, res);
      return;
    }

    const newSessionId = randomUUID();
    const authHeader = req.headers.authorization ?? "";
    const tier = resolveTokenTier(authHeader, this.apiKeyBearerHash, this.helpTokenValidator);
    this.deps.sessionStore.sessionTierMap.set(newSessionId, tier);

    const pinnedWebContentsId = this.resolvePinnedWebContentsId(authHeader);
    if (pinnedWebContentsId !== null) {
      this.deps.sessionStore.sessionWebContentsMap.set(newSessionId, pinnedWebContentsId);
    }

    const boundActionContext = this.resolveActionContext(authHeader);
    if (boundActionContext !== null) {
      this.deps.sessionStore.sessionContextMap.set(newSessionId, boundActionContext);
    }

    const deps = this.buildSessionServerDeps(newSessionId);
    const server = createSessionServer(newSessionId, deps);
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
    // enableDnsRebindingProtection / allowedHosts / allowedOrigins are
    // deprecated in SDK ^1.27.1; the manual gate in handleRequest is authoritative.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (initializedSessionId) => {
        const idleTimer = this.deps.sessionStore.createHttpIdleTimer(initializedSessionId);
        this.deps.sessionStore.httpSessions.set(initializedSessionId, {
          transport,
          server,
          idleTimer,
        });
      },
    });

    transport.onclose = () => {
      // Fall back to `newSessionId` when the transport closes before
      // `onsessioninitialized` fires — otherwise the entries inserted under
      // `newSessionId` (tier + pin) leak. Mirrors the catch-block path.
      const id = transport.sessionId ?? newSessionId;
      const session = this.deps.sessionStore.httpSessions.get(id);
      if (session) {
        clearTimeout(session.idleTimer);
        this.deps.sessionStore.httpSessions.delete(id);
      }
      this.deps.sessionStore.sessionTierMap.delete(id);
      // Pin-before-revoke ordering identical to the SSE path above —
      // see `transport.onclose` in the GET /sse branch.
      this.deps.sessionStore.grantCache.revokeSession(id, "session-ended");
      this.deps.sessionStore.sessionWebContentsMap.delete(id);
      this.deps.sessionStore.sessionContextMap.delete(id);
      this.deps.sessionStore.clearDedupState(id);
      cleanupResourceSubscriptions(id, this.deps.sessionStore);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP] Streamable HTTP request failed:", err);
      const id = transport.sessionId;
      if (id !== undefined) {
        const session = this.deps.sessionStore.httpSessions.get(id);
        if (session) {
          clearTimeout(session.idleTimer);
          this.deps.sessionStore.httpSessions.delete(id);
        }
        this.deps.sessionStore.sessionTierMap.delete(id);
        this.deps.sessionStore.grantCache.revokeSession(id, "session-ended");
        this.deps.sessionStore.sessionWebContentsMap.delete(id);
        this.deps.sessionStore.sessionContextMap.delete(id);
        this.deps.sessionStore.clearDedupState(id);
        cleanupResourceSubscriptions(id, this.deps.sessionStore);
      } else {
        this.deps.sessionStore.sessionTierMap.delete(newSessionId);
        this.deps.sessionStore.grantCache.revokeSession(newSessionId, "session-ended");
        this.deps.sessionStore.sessionWebContentsMap.delete(newSessionId);
        this.deps.sessionStore.sessionContextMap.delete(newSessionId);
        this.deps.sessionStore.clearDedupState(newSessionId);
        cleanupResourceSubscriptions(newSessionId, this.deps.sessionStore);
      }
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  /**
   * Builds per-session dispatch deps. When the session was pinned to a
   * renderer WebContents at handshake (help-session bearers, #7002), routes
   * through the pinned `*ForWebContents` helpers and forces a cache-free
   * manifest lookup so window A's manifest can never be served to window B.
   * Sessions without a pin (api-key / pane tokens) keep the existing shared
   * dispatch + cached-manifest path.
   */
  private buildSessionServerDeps(
    sessionId: string
  ): import("./sessionServer.js").SessionServerDeps {
    const pinnedDispatch = this.deps.dispatchActionForWebContents;
    const pinnedManifest = this.deps.requestManifestForWebContents;

    const requestManifest: import("./sessionServer.js").SessionServerDeps["requestManifest"] =
      () => {
        const id = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
        if (id !== undefined && pinnedManifest) {
          return pinnedManifest(id);
        }
        return this.deps.requestManifest();
      };

    const dispatchAction: import("./sessionServer.js").SessionServerDeps["dispatchAction"] = (
      actionId,
      args,
      confirmed
    ) => {
      const id = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
      if (id !== undefined && pinnedDispatch) {
        // Replay the provision-time context snapshot so the assistant's
        // tool call targets the worktree/terminal the user had focused
        // when they launched it — not wherever focus drifted to during
        // the model's turn (#8317). Absent for context-less sessions, in
        // which case pinned dispatch falls back to live renderer context.
        const boundContext = this.deps.sessionStore.sessionContextMap.get(sessionId);
        return pinnedDispatch(id, actionId, args, confirmed, boundContext);
      }
      return this.deps.dispatchAction(actionId, args, confirmed);
    };

    const getCachedManifest: import("./sessionServer.js").SessionServerDeps["getCachedManifest"] =
      () => {
        // Pinned sessions never read the shared manifest cache — see
        // `requestManifestForWebContents` doc in rendererBridge.ts.
        if (this.deps.sessionStore.sessionWebContentsMap.has(sessionId)) {
          return null;
        }
        return this.deps.getCachedManifest();
      };

    const notifyTierMismatch: import("./sessionServer.js").SessionServerDeps["notifyTierMismatch"] =
      (payload) => {
        // Help-session bearers only — external/api-key sessions have no
        // associated UI to surface a banner. Targeted at the pinned WebContents
        // so the assistant panel that triggered the call gets the event,
        // even if a different project view is currently focused.
        const id = this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        try {
          wc.send(CHANNELS.MCP_TIER_NOT_PERMITTED, {
            sessionId: payload.sessionId,
            toolId: payload.toolId,
            tier: payload.tier,
            targetTier: payload.targetTier,
          });
        } catch (err) {
          console.error("[MCP] tier-not-permitted send failed:", err);
        }
      };

    return {
      sessionStore: this.deps.sessionStore,
      requestManifest,
      dispatchAction,
      handleWaitUntilIdle: this.deps.handleWaitUntilIdle,
      appendAuditRecord: (input) => {
        // Scrub structural secrets BEFORE the truncation step inside
        // `summarizeMcpArgs` — running the scrubber after truncation would
        // miss bearer tokens whose body got cut below the scrubber's
        // 8-char minimum match length.
        const turnId = this.deps.turnOutcomeService.getCurrentTurnIdForSession(sessionId);
        this.deps.auditService.appendRecord({
          ...input,
          argsSummary: summarizeMcpArgs(input.args, (s) => scrubSecrets(sanitizePath(s))),
          ...(turnId !== null ? { turnId } : {}),
        });
      },
      getCachedManifest,
      getFullToolSurface: () => this.getConfig().fullToolSurface === true,
      notifyTierMismatch,
    };
  }

  /**
   * Promote a help-session's tier in-memory (Approve once). Refuses downgrades
   * — a malicious renderer cannot drop its own privileges. When `callerWcId`
   * is supplied, also requires the caller to be the WebContents the session
   * was pinned to at handshake (cross-window forgery defence). Returns the
   * new tier or throws if the session is unknown / the request is invalid.
   */
  setSessionTier(
    sessionId: string,
    tier: McpTier,
    callerWcId?: number
  ): { sessionId: string; tier: McpTier } {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (tier !== "workbench" && tier !== "action" && tier !== "system") {
      throw new Error("Invalid tier");
    }
    const current = this.deps.sessionStore.sessionTierMap.get(sessionId);
    if (current === undefined) {
      throw new Error("Unknown session");
    }
    // Reject elevations for sessions whose transport already closed (idle
    // timeout, server shutdown). The tier-map entry can outlive the transport
    // briefly during cleanup; mutating a dead entry would silently fail when
    // the next call lands.
    if (
      !this.deps.sessionStore.sessions.has(sessionId) &&
      !this.deps.sessionStore.httpSessions.has(sessionId)
    ) {
      throw new Error("Session is no longer active");
    }
    // Only help-session bearers should be elevated through this surface —
    // an unpinned session is api-key/external and has no UI invariant to
    // satisfy.
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId === undefined) {
      throw new Error("Session is not eligible for renderer tier elevation");
    }
    if (callerWcId !== undefined && callerWcId !== pinnedWcId) {
      // Cross-WebContents forgery: another renderer is trying to elevate a
      // session that wasn't minted by it. Reject loudly.
      throw new Error("Caller is not the pinned renderer for this session");
    }
    const order: McpTier[] = ["workbench", "action", "system", "external"];
    const currentRank = order.indexOf(current);
    const newRank = order.indexOf(tier);
    if (newRank < currentRank) {
      // Refuse downgrades — keep current tier.
      return { sessionId, tier: current };
    }
    this.deps.sessionStore.sessionTierMap.set(sessionId, tier);
    return { sessionId, tier };
  }

  /**
   * Mint a time-bounded per-`(sessionId, toolId)` grant — the "Approve
   * once" pathway that replaces sticky session-tier elevation for single
   * tool calls (#8442). Validates the same caller-pin invariant as
   * {@link setSessionTier}: only the renderer that minted the session
   * can issue grants on its behalf.
   */
  issueGrant(sessionId: string, toolId: string, callerWcId?: number): McpIssueGrantResult {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (!toolId || typeof toolId !== "string") {
      throw new Error("Invalid toolId");
    }
    if (
      !this.deps.sessionStore.sessions.has(sessionId) &&
      !this.deps.sessionStore.httpSessions.has(sessionId)
    ) {
      throw new Error("Session is no longer active");
    }
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId === undefined) {
      throw new Error("Session is not eligible for renderer tier elevation");
    }
    if (callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this session");
    }
    const entry = this.deps.sessionStore.grantCache.issueGrant(sessionId, toolId);
    return {
      sessionId,
      toolId,
      ttlMs: entry.ttlMs,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Drop every grant currently held by the session. Caller-pin checked
   * identically to {@link issueGrant}. Returns the count of revoked
   * grants for the renderer's confirmation copy.
   */
  revokeSessionGrants(sessionId: string, callerWcId?: number): McpRevokeSessionGrantsResult {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    // Caller-pin is enforced when the session is still alive; if the
    // session has already drained (idle reaper / explicit close) the
    // pin map is empty and the revoke becomes an idempotent no-op so
    // the renderer's cleanup pass after a banner dismissal succeeds
    // even though there's nothing left to drop.
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId !== undefined && callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this session");
    }
    const revokedCount = this.deps.sessionStore.grantCache.revokeSession(sessionId, "user");
    return { sessionId, revokedCount };
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      port: this.port,
      configuredPort: config.port,
      apiKey: this.apiKey ?? "",
    };
  }

  getConfigSnippet(): string {
    const url = this.port ? `http://127.0.0.1:${this.port}/mcp` : "http://127.0.0.1:<port>/mcp";
    const entry: Record<string, unknown> = { type: "http", url };
    if (this.apiKey) {
      entry.headers = { Authorization: `Bearer ${this.apiKey}` };
    }
    return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
  }
}
