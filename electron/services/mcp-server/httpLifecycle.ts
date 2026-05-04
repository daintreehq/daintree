import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { store } from "../../store.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
import type { HelpTokenValidator } from "./shared.js";
import { isAuthorized, resolveTokenTier } from "./tierAuth.js";
import { createSessionServer, cleanupResourceSubscriptions } from "./sessionServer.js";
import type { SessionStore } from "./sessionStore.js";
import type { AuditService } from "./auditLog.js";
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
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean
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
  private registry: WindowRegistry | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private helpTokenValidator: HelpTokenValidator | null = null;
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
            this.apiKey = persisted;
          } else {
            this.apiKey = `daintree_${randomUUID().replace(/-/g, "")}`;
            this.persistConfig({ apiKey: this.apiKey });
          }
        }

        this.deps.auditService.hydrate();
        this.deps.setupIpcListeners();

        const server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            console.error("[MCP] Request handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal server error");
            }
          });
        });

        const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
        const boundPort = await this.listenWithRetry(server, configuredPort);

        if (boundPort === null) {
          for (const cleanup of this.deps.cleanupListeners) {
            cleanup();
          }
          this.deps.cleanupListeners.length = 0;
          throw new Error(
            `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
          );
        }

        this.port = boundPort;
        this.httpServer = server;
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
          await new Promise<void>((resolve) => {
            this.httpServer!.close(() => resolve());
          });
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

      const available = await this.isPortAvailable(port);
      if (!available) {
        console.log(`[MCP] Port ${port} in use, trying next…`);
        continue;
      }

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
        const addr = server.address() as AddressInfo | null;
        return addr?.port ?? null;
      } catch {
        console.log(`[MCP] Port ${port} bind failed, trying next…`);
        continue;
      }
    }
    return null;
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tester = net.createServer();
      tester.once("error", () => resolve(false));
      tester.listen(port, "127.0.0.1", () => {
        tester.close(() => resolve(true));
      });
    });
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
    if (!isAuthorized(authHeader, this.apiKey, this.helpTokenValidator)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
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
      const tier = resolveTokenTier(authHeader, this.apiKey, this.helpTokenValidator);
      this.deps.sessionStore.sessionTierMap.set(sessionId, tier);

      const deps = this.buildSessionServerDeps();
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
        cleanupResourceSubscriptions(sessionId, this.deps.sessionStore);
      };

      await server.connect(transport);
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
    const tier = resolveTokenTier(authHeader, this.apiKey, this.helpTokenValidator);
    this.deps.sessionStore.sessionTierMap.set(newSessionId, tier);

    const deps = this.buildSessionServerDeps();
    const server = createSessionServer(newSessionId, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
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
      const id = transport.sessionId;
      if (id === undefined) return;
      const session = this.deps.sessionStore.httpSessions.get(id);
      if (session) {
        clearTimeout(session.idleTimer);
        this.deps.sessionStore.httpSessions.delete(id);
      }
      this.deps.sessionStore.sessionTierMap.delete(id);
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
        cleanupResourceSubscriptions(id, this.deps.sessionStore);
      } else {
        this.deps.sessionStore.sessionTierMap.delete(newSessionId);
        cleanupResourceSubscriptions(newSessionId, this.deps.sessionStore);
      }
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  private buildSessionServerDeps(): import("./sessionServer.js").SessionServerDeps {
    return {
      sessionStore: this.deps.sessionStore,
      requestManifest: this.deps.requestManifest,
      dispatchAction: this.deps.dispatchAction,
      handleWaitUntilIdle: this.deps.handleWaitUntilIdle,
      appendAuditRecord: (input) => {
        this.deps.auditService.appendRecord({
          ...input,
          argsSummary: summarizeMcpArgs(input.args),
        });
      },
      getCachedManifest: this.deps.getCachedManifest,
      getFullToolSurface: () => this.getConfig().fullToolSurface === true,
    };
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
