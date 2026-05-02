import { ipcMain, safeStorage } from "electron";
import type { WindowRegistry } from "../window/WindowRegistry.js";
import http from "node:http";
import net from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry, ActionDispatchResult } from "../../shared/types/actions.js";
import { store } from "../store.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

const DISCOVERY_DIR = path.join(os.homedir(), ".daintree");
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, "mcp.json");
const MCP_SERVER_KEY = "daintree";

const DEFAULT_PORT = 45454;
const MAX_PORT_RETRIES = 10;
const MCP_SSE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const OPEN_WORLD_CATEGORIES: ReadonlySet<string> = new Set([
  "browser",
  "devServer",
  "github",
  "portal",
  "voice",
  "system",
]);

// Curated set of action IDs advertised over MCP by default. Keeps the tool
// surface small enough for `tool_choice: "auto"` reliability and bounded
// token cost while still covering the agent-facing introspection,
// query, and command actions. Power users opt into the full surface via
// `mcpServer.fullToolSurface = true`. Dispatch is not gated by this list —
// callers that already know an ID can still invoke it.
const MCP_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "actions.list",
  "actions.getContext",

  "agent.launch",
  "agent.terminal",
  "agent.focusNextWaiting",
  "agent.focusNextWorking",

  "git.getProjectPulse",
  "git.getFileDiff",
  "git.listCommits",
  "git.getStagingStatus",
  "git.stageFile",
  "git.unstageFile",
  "git.stageAll",
  "git.unstageAll",
  "git.commit",
  "git.push",
  "git.snapshotGet",
  "git.snapshotList",

  "github.checkCli",
  "github.getRepoStats",
  "github.listIssues",
  "github.listPullRequests",
  "github.openIssue",
  "github.openPR",

  "terminal.list",
  "terminal.getOutput",
  "terminal.sendCommand",
  "terminal.bulkCommand",
  "terminal.inject",
  "terminal.new",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.refresh",
  "worktree.create",
  "worktree.createWithRecipe",
  "worktree.listBranches",
  "worktree.getDefaultPath",
  "worktree.getAvailableBranch",
  "worktree.delete",
  "worktree.setActive",
  "worktree.resource.status",

  "files.search",
  "file.view",
  "file.openInEditor",

  "copyTree.isAvailable",
  "copyTree.generate",
  "copyTree.generateAndCopyFile",
  "copyTree.injectToTerminal",

  "slashCommands.list",

  "project.getAll",
  "project.getCurrent",
  "project.getSettings",
  "project.getStats",
  "project.detectRunners",

  "recipe.list",
  "recipe.run",

  "system.checkCommand",
  "system.checkDirectory",
]);

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface McpSseSession {
  transport: SSEServerTransport;
  idleTimer: ReturnType<typeof setTimeout>;
}

function safeSerializeToolResult(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString();
        }
        if (typeof currentValue === "function") {
          return `[Function: ${currentValue.name || "anonymous"}]`;
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (currentValue !== null && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }
          seen.add(currentValue);
        }
        return currentValue;
      },
      2
    );

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to string coercion.
  }

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Cached state of the decrypted bearer token.
 * - `kind: "unread"` — not yet read this session.
 * - `kind: "absent"` — no `apiKeyEncrypted` field present on the store.
 * - `kind: "ok"` — decrypted successfully; `value` holds the plaintext.
 * - `kind: "undecryptable"` — `decryptString` threw (corrupted ciphertext, OS
 *   keychain reset, bundle id change). The configured key cannot be recovered;
 *   `isAuthorized` must deny instead of opening access.
 */
type DecryptedKeyState =
  | { kind: "unread" }
  | { kind: "absent" }
  | { kind: "ok"; value: string }
  | { kind: "undecryptable" };

export class McpServerService {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private registry: WindowRegistry | null = null;
  private starting = false;
  private sessions = new Map<string, McpSseSession>();
  private pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private pendingDispatches = new Map<string, PendingRequest<ActionDispatchResult>>();
  private cleanupListeners: Array<() => void> = [];
  private statusListeners = new Set<(running: boolean) => void>();
  private decryptedKey: DecryptedKeyState = { kind: "unread" };

  get isRunning(): boolean {
    return this.httpServer !== null && this.port !== null;
  }

  /**
   * Register a subscriber that fires whenever the server transitions between
   * running and stopped. Used by `ServiceConnectivityRegistry` to surface MCP
   * reachability without polling.
   */
  onStatusChange(listener: (running: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private emitStatusChange(): void {
    const running = this.isRunning;
    for (const listener of this.statusListeners) {
      try {
        listener(running);
      } catch (err) {
        console.error("[MCP] Status change listener threw:", err);
      }
    }
  }

  get currentPort(): number | null {
    return this.port;
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  /**
   * Returns the OS-level encryption posture for the bearer token. `keychain`
   * means a real OS secret store is in use (macOS Keychain, Windows DPAPI, or a
   * Linux libsecret/KWallet daemon). `basic_text` means Linux fell back to a
   * hardcoded-password backend — encrypted at rest in name only. `unavailable`
   * means `safeStorage.isEncryptionAvailable()` returned false (extremely rare
   * post-`app.ready` on supported platforms).
   */
  getEncryptionBackend(): "keychain" | "basic_text" | "unavailable" {
    if (!safeStorage.isEncryptionAvailable()) return "unavailable";
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text") return "basic_text";
    }
    return "keychain";
  }

  /**
   * Resolve and memoize the decrypted bearer token for this session. Writes
   * (`setApiKey`/`generateApiKey`) update the cache directly. We never mutate
   * the persisted ciphertext from a read path — clearing the field on decrypt
   * failure would let `isAuthorized` interpret the next request as "no key
   * configured → open access," silently dropping authentication.
   */
  private resolveDecryptedKey(): Exclude<DecryptedKeyState, { kind: "unread" }> {
    const cached = this.decryptedKey;
    if (cached.kind !== "unread") {
      return cached;
    }
    const encrypted = this.getConfig().apiKeyEncrypted;
    let next: Exclude<DecryptedKeyState, { kind: "unread" }>;
    if (!encrypted) {
      next = { kind: "absent" };
    } else {
      try {
        next = {
          kind: "ok",
          value: safeStorage.decryptString(Buffer.from(encrypted, "base64")),
        };
      } catch (err) {
        console.warn(
          "[MCP] Failed to decrypt API key — server will deny all requests until the key is regenerated:",
          err
        );
        next = { kind: "undecryptable" };
      }
    }
    this.decryptedKey = next;
    return next;
  }

  private getApiKey(): string {
    const state = this.resolveDecryptedKey();
    return state.kind === "ok" ? state.value : "";
  }

  /**
   * Encrypt a bearer token for persistence. Returns `undefined` for an empty
   * key so callers can drop the field from the store. Throws if `safeStorage`
   * is unavailable; callers that need graceful degradation must handle the
   * throw themselves (e.g., the auto-keygen path in `start()`).
   */
  private encryptApiKey(apiKey: string): string | undefined {
    if (!apiKey) return undefined;
    return safeStorage.encryptString(apiKey).toString("base64");
  }

  async setEnabled(enabled: boolean): Promise<void> {
    store.set("mcpServer", { ...this.getConfig(), enabled });
    if (enabled && this.registry && !this.isRunning) {
      await this.start(this.registry);
    } else if (!enabled && this.isRunning) {
      await this.stop();
    }
  }

  async setPort(port: number | null): Promise<void> {
    const config = this.getConfig();
    store.set("mcpServer", { ...config, port });
    if (config.enabled && this.isRunning) {
      await this.stop();
      if (this.registry) await this.start(this.registry);
    }
  }

  async setApiKey(apiKey: string): Promise<void> {
    const config = this.getConfig();
    const { apiKeyEncrypted: _previous, apiKey: _legacy, ...rest } = config;
    const encrypted = this.encryptApiKey(apiKey);
    store.set(
      "mcpServer",
      encrypted === undefined ? rest : { ...rest, apiKeyEncrypted: encrypted }
    );
    this.decryptedKey =
      encrypted === undefined ? { kind: "absent" } : { kind: "ok", value: apiKey };
    if (this.isRunning) {
      await this.writeDiscoveryFile();
    }
  }

  async generateApiKey(): Promise<string> {
    const key = `daintree_${randomUUID().replace(/-/g, "")}`;
    await this.setApiKey(key);
    return key;
  }

  async start(registry: WindowRegistry): Promise<void> {
    this.registry = registry;

    if (this.httpServer || this.starting) {
      return;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    this.starting = true;
    try {
      if (!this.getApiKey()) {
        try {
          await this.generateApiKey();
        } catch (err) {
          // Encryption can throw when safeStorage is unavailable. Don't abort
          // startup — the encryption-backend banner already surfaces the
          // unprotected state to the user, and the server can still bind
          // (open access on loopback, like a fresh install with no key set).
          console.warn(
            "[MCP] Could not auto-generate API key — starting without authentication:",
            err
          );
        }
      }

      this.setupIpcListeners();

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
        for (const cleanup of this.cleanupListeners) {
          cleanup();
        }
        this.cleanupListeners = [];
        throw new Error(
          `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
        );
      }

      this.port = boundPort;
      this.httpServer = server;
      await this.writeDiscoveryFile();
      console.log(`[MCP] Server started on http://127.0.0.1:${this.port}/sse`);
      this.emitStatusChange();
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      clearTimeout(session.idleTimer);
      try {
        await session.transport.close();
      } catch {
        // ignore close errors during shutdown
      }
    }
    this.sessions.clear();

    for (const cleanup of this.cleanupListeners) {
      cleanup();
    }
    this.cleanupListeners = [];

    for (const [id, pending] of this.pendingManifests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP server stopped"));
      this.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP server stopped"));
      this.pendingDispatches.delete(id);
    }

    let wasRunning = false;
    if (this.httpServer) {
      wasRunning = true;
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this.port = null;
    }

    await this.removeDiscoveryFile();
    console.log("[MCP] Server stopped");
    if (wasRunning) {
      this.emitStatusChange();
    }
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
    encryptionBackend: "keychain" | "basic_text" | "unavailable";
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      port: this.port,
      configuredPort: config.port,
      apiKey: this.getApiKey(),
      encryptionBackend: this.getEncryptionBackend(),
    };
  }

  getConfigSnippet(): string {
    const apiKey = this.getApiKey();
    const url = this.port ? `http://127.0.0.1:${this.port}/sse` : "http://127.0.0.1:<port>/sse";
    const entry: Record<string, unknown> = { type: "sse", url };
    if (apiKey) {
      entry.headers = { Authorization: `Bearer ${apiKey}` };
    }
    return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
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

  private setupIpcListeners(): void {
    const manifestHandler = (
      _event: Electron.IpcMainEvent,
      payload: { requestId: string; manifest: unknown }
    ) => {
      const pending = this.pendingManifests.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingManifests.delete(payload.requestId);
        pending.resolve(
          Array.isArray(payload.manifest) ? (payload.manifest as ActionManifestEntry[]) : []
        );
      }
    };

    const dispatchHandler = (
      _event: Electron.IpcMainEvent,
      payload: { requestId: string; result: ActionDispatchResult }
    ) => {
      const pending = this.pendingDispatches.get(payload.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingDispatches.delete(payload.requestId);
        pending.resolve(payload.result);
      }
    };

    ipcMain.on("mcp:get-manifest-response", manifestHandler);
    ipcMain.on("mcp:dispatch-action-response", dispatchHandler);

    this.cleanupListeners.push(
      () => ipcMain.removeListener("mcp:get-manifest-response", manifestHandler),
      () => ipcMain.removeListener("mcp:dispatch-action-response", dispatchHandler)
    );
  }

  private requestManifest(): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getLiveWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingManifests.delete(requestId);
        reject(new Error("Manifest request timed out"));
      }, 5000);

      this.pendingManifests.set(requestId, { resolve, reject, timer });
      try {
        webContents.send("mcp:get-manifest-request", { requestId });
      } catch (err) {
        clearTimeout(timer);
        this.pendingManifests.delete(requestId);
        reject(this.normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  private dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false
  ): Promise<ActionDispatchResult> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = this.getLiveWebContents();
      } catch (err) {
        reject(this.normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pendingDispatches.delete(requestId);
        reject(new Error(`Action dispatch timed out: ${actionId}`));
      }, 30000);

      this.pendingDispatches.set(requestId, { resolve, reject, timer });

      try {
        webContents.send("mcp:dispatch-action-request", {
          requestId,
          actionId,
          args,
          confirmed,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingDispatches.delete(requestId);
        reject(this.normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
  }

  private createSessionServer(): Server {
    const server = new Server(
      { name: "Daintree", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const manifest = await this.requestManifest();
      return {
        tools: manifest
          .filter((entry) => this.shouldExposeTool(entry))
          .map((entry) => ({
            name: entry.id,
            description: this.buildToolDescription(entry),
            inputSchema: this.buildToolInputSchema(entry),
            annotations: this.buildAnnotations(entry),
          })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const actionId = request.params.name;
      const { args, confirmed } = this.parseToolArguments(request.params.arguments);

      let result: ActionDispatchResult;
      try {
        result = await this.dispatchAction(actionId, args, confirmed);
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${formatErrorMessage(err, "Action dispatch failed")}`,
            },
          ],
          isError: true,
        };
      }

      if (result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                result.result !== undefined && result.result !== null
                  ? safeSerializeToolResult(result.result)
                  : "OK",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Error [${result.error.code}]: ${result.error.message}`,
          },
        ],
        isError: true,
      };
    });

    return server;
  }

  private isValidHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? "";
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const state = this.resolveDecryptedKey();
    // No key was ever configured — the server runs with open access by design.
    if (state.kind === "absent") return true;
    // A key is on disk but couldn't be decrypted. Opening access here would
    // silently downgrade to no-auth on a transient keychain failure, so we
    // fail closed until the user regenerates the key.
    if (state.kind === "undecryptable") return false;
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${state.value}`;
    const actualHash = createHash("sha256").update(auth).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(actualHash, expectedHash);
  }

  private isValidOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private shouldExposeTool(entry: ActionManifestEntry): boolean {
    if (entry.danger === "restricted") {
      return false;
    }
    if (this.getConfig().fullToolSurface === true) {
      return true;
    }
    return MCP_TOOL_ALLOWLIST.has(entry.id);
  }

  private buildToolDescription(entry: ActionManifestEntry): string {
    let description = `[${entry.category}] ${entry.title}: ${entry.description}`;
    if (entry.danger === "confirm") {
      description += " Requires explicit confirmation via _meta.confirmed=true.";
    }
    return description;
  }

  private buildToolInputSchema(entry: ActionManifestEntry): Record<string, unknown> {
    const baseSchema =
      entry.inputSchema &&
      typeof entry.inputSchema === "object" &&
      !Array.isArray(entry.inputSchema) &&
      entry.inputSchema["type"] === "object"
        ? ({ ...entry.inputSchema } as Record<string, unknown>)
        : {
            type: "object",
            properties: {},
          };

    if (entry.danger !== "confirm") {
      return baseSchema;
    }

    const properties =
      baseSchema["properties"] &&
      typeof baseSchema["properties"] === "object" &&
      !Array.isArray(baseSchema["properties"])
        ? { ...(baseSchema["properties"] as Record<string, unknown>) }
        : {};

    properties["_meta"] = {
      type: "object",
      description: "Reserved Daintree MCP metadata.",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true to execute this destructive action.",
        },
      },
      additionalProperties: false,
    };

    return {
      ...baseSchema,
      properties,
    };
  }

  private buildAnnotations(entry: ActionManifestEntry): ToolAnnotations {
    return {
      title: entry.title,
      readOnlyHint: entry.kind === "query",
      idempotentHint: entry.kind === "query",
      destructiveHint: entry.danger === "confirm",
      openWorldHint: OPEN_WORLD_CATEGORIES.has(entry.category),
    };
  }

  private parseToolArguments(rawArgs: unknown): { args: unknown; confirmed: boolean } {
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
      return {
        args: rawArgs ?? {},
        confirmed: false,
      };
    }

    const argsRecord = rawArgs as Record<string, unknown>;
    const meta = argsRecord["_meta"];
    const metaRecord =
      meta !== null && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : null;
    const confirmed = metaRecord?.["confirmed"] === true;

    if (!("_meta" in argsRecord)) {
      return {
        args: rawArgs,
        confirmed,
      };
    }

    const { _meta: _ignored, ...actionArgs } = argsRecord;
    return {
      args: Object.keys(actionArgs).length > 0 ? actionArgs : {},
      confirmed,
    };
  }

  private getLiveWebContents(): Electron.WebContents {
    if (this.registry) {
      const primary = this.registry.getPrimary();
      if (primary && !primary.browserWindow.isDestroyed()) {
        const { webContents } = primary.browserWindow;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
      for (const ctx of this.registry.all()) {
        if (!ctx.browserWindow.isDestroyed()) {
          const { webContents } = ctx.browserWindow;
          if (webContents && !webContents.isDestroyed()) {
            return webContents;
          }
        }
      }
    }

    throw new Error("MCP renderer bridge unavailable");
  }

  private normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isValidHost(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (!this.isValidOrigin(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    if (!this.isAuthorized(req)) {
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
      const server = this.createSessionServer();
      const sessionId = transport.sessionId;

      const idleTimer = this.createIdleTimer(sessionId);
      this.sessions.set(sessionId, { transport, idleTimer });
      transport.onclose = () => {
        const session = this.sessions.get(sessionId);
        if (session) {
          clearTimeout(session.idleTimer);
          this.sessions.delete(sessionId);
        }
      };

      await server.connect(transport);
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const session = this.sessions.get(sessionId);

      if (session) {
        this.resetIdleTimer(sessionId);
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private createIdleTimer(sessionId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      this.sessions.delete(sessionId);
      session.transport.close().catch(() => {
        // ignore close errors during idle timeout cleanup
      });
    }, MCP_SSE_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.createIdleTimer(sessionId);
  }

  private async writeDiscoveryFile(): Promise<void> {
    if (!this.port) return;
    try {
      await fs.mkdir(DISCOVERY_DIR, { recursive: true });
      if (process.platform !== "win32") {
        await fs.chmod(DISCOVERY_DIR, 0o700).catch((err) => {
          console.error("[MCP] Failed to chmod discovery directory:", err);
        });
      }

      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(DISCOVERY_FILE, "utf-8");
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // file doesn't exist or isn't valid JSON — start fresh
      }

      const mcpServers = (existing["mcpServers"] as Record<string, unknown> | undefined) ?? {};
      const entry: Record<string, unknown> = {
        type: "sse",
        url: `http://127.0.0.1:${this.port}/sse`,
      };
      const apiKey = this.getApiKey();
      if (apiKey) {
        entry.headers = { Authorization: `Bearer ${apiKey}` };
      }
      mcpServers[MCP_SERVER_KEY] = entry;

      await resilientAtomicWriteFile(
        DISCOVERY_FILE,
        JSON.stringify({ ...existing, mcpServers }, null, 2) + "\n",
        "utf-8",
        { mode: 0o600 }
      );
    } catch (err) {
      console.error("[MCP] Failed to write discovery file:", err);
    }
  }

  private async removeDiscoveryFile(): Promise<void> {
    try {
      const raw = await fs.readFile(DISCOVERY_FILE, "utf-8");
      const existing = JSON.parse(raw) as Record<string, unknown>;
      const mcpServers = (existing["mcpServers"] as Record<string, unknown> | undefined) ?? {};

      delete mcpServers[MCP_SERVER_KEY];

      if (Object.keys(mcpServers).length === 0) {
        delete existing["mcpServers"];
      } else {
        existing["mcpServers"] = mcpServers;
      }

      if (Object.keys(existing).length === 0) {
        await fs.unlink(DISCOVERY_FILE);
      } else {
        await resilientAtomicWriteFile(
          DISCOVERY_FILE,
          JSON.stringify(existing, null, 2) + "\n",
          "utf-8",
          { mode: 0o600 }
        );
      }
    } catch {
      // best-effort removal — don't crash on cleanup errors
    }
  }
}

export const mcpServerService = new McpServerService();
