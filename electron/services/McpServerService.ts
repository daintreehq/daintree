import { ipcMain, BrowserWindow } from "electron";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ActionManifestEntry, ActionDispatchResult } from "../../shared/types/actions.js";
import { store } from "../store.js";
import { resilientAtomicWriteFile } from "../utils/fs.js";

const DISCOVERY_DIR = path.join(os.homedir(), ".canopy");
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, "mcp.json");
const MCP_SERVER_KEY = "canopy";
const DEFAULT_PORT = 45454;
const MAX_PORT_RETRIES = 10;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

export class McpServerService {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private mainWindow: BrowserWindow | null = null;
  private sessions = new Map<string, SSEServerTransport>();
  private pendingManifests = new Map<string, PendingRequest<ActionManifestEntry[]>>();
  private pendingDispatches = new Map<string, PendingRequest<ActionDispatchResult>>();
  private cleanupListeners: Array<() => void> = [];

  get isRunning(): boolean {
    return this.httpServer !== null && this.port !== null;
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

  async setEnabled(enabled: boolean): Promise<void> {
    store.set("mcpServer", { ...this.getConfig(), enabled });
    if (enabled && this.mainWindow && !this.isRunning) {
      await this.start(this.mainWindow);
    } else if (!enabled && this.isRunning) {
      await this.stop();
    }
  }

  async setPort(port: number | null): Promise<void> {
    const config = this.getConfig();
    store.set("mcpServer", { ...config, port });
    if (config.enabled && this.isRunning) {
      await this.stop();
      if (this.mainWindow) await this.start(this.mainWindow);
    }
  }

  async setApiKey(apiKey: string): Promise<void> {
    store.set("mcpServer", { ...this.getConfig(), apiKey });
    if (this.isRunning) {
      await this.writeDiscoveryFile();
    }
  }

  async generateApiKey(): Promise<string> {
    const key = `canopy_${randomUUID().replace(/-/g, "")}`;
    store.set("mcpServer", { ...this.getConfig(), apiKey: key });
    if (this.isRunning) {
      await this.writeDiscoveryFile();
    }
    return key;
  }

  async start(window: BrowserWindow): Promise<void> {
    this.mainWindow = window;

    if (this.httpServer) {
      return;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
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
  }

  async stop(): Promise<void> {
    for (const transport of this.sessions.values()) {
      try {
        await transport.close();
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

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this.port = null;
    }

    await this.removeDiscoveryFile();
    console.log("[MCP] Server stopped");
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
      apiKey: config.apiKey,
    };
  }

  getConfigSnippet(): string {
    const config = this.getConfig();
    const url = this.port ? `http://127.0.0.1:${this.port}/sse` : "http://127.0.0.1:<port>/sse";
    const entry: Record<string, unknown> = { type: "sse", url };
    if (config.apiKey) {
      entry.headers = { Authorization: `Bearer ${config.apiKey}` };
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
      { name: "Canopy", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const manifest = await this.requestManifest();
      return {
        tools: manifest
          .filter((entry) => entry.danger !== "restricted")
          .map((entry) => ({
            name: entry.id,
            description: this.buildToolDescription(entry),
            inputSchema: this.buildToolInputSchema(entry),
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
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
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
    return (
      host === `127.0.0.1:${this.port}` ||
      host === `localhost:${this.port}` ||
      host === "127.0.0.1" ||
      host === "localhost"
    );
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const apiKey = this.getConfig().apiKey;
    if (!apiKey) return true;
    const auth = req.headers.authorization ?? "";
    return auth === `Bearer ${apiKey}`;
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
      description: "Reserved Canopy MCP metadata.",
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
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      throw new Error("MCP renderer bridge unavailable");
    }

    const { webContents } = this.mainWindow;
    if (!webContents || webContents.isDestroyed()) {
      throw new Error("MCP renderer bridge unavailable");
    }

    return webContents;
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

    if (!this.isAuthorized(req)) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      const server = this.createSessionServer();
      const sessionId = transport.sessionId;

      this.sessions.set(sessionId, transport);
      transport.onclose = () => {
        this.sessions.delete(sessionId);
      };

      await server.connect(transport);
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId") ?? "";
      const transport = this.sessions.get(sessionId);

      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private async writeDiscoveryFile(): Promise<void> {
    if (!this.port) return;
    try {
      await fs.mkdir(DISCOVERY_DIR, { recursive: true });

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
      const apiKey = this.getConfig().apiKey;
      if (apiKey) {
        entry.headers = { Authorization: `Bearer ${apiKey}` };
      }
      mcpServers[MCP_SERVER_KEY] = entry;

      await resilientAtomicWriteFile(
        DISCOVERY_FILE,
        JSON.stringify({ ...existing, mcpServers }, null, 2) + "\n",
        "utf-8"
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
          "utf-8"
        );
      }
    } catch {
      // best-effort removal — don't crash on cleanup errors
    }
  }
}

export const mcpServerService = new McpServerService();
