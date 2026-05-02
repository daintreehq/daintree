import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ActionDispatchResult,
  ActionManifestEntry,
  ActionId,
  ActionKind,
  ActionDanger,
} from "../../../shared/types/actions.js";

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-home-${Math.random().toString(36).slice(2)}`
);

const electronMocks = vi.hoisted(() => {
  class IpcMainMock {
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    handle = vi.fn();
    removeHandler = vi.fn();

    on(event: string, listener: (...args: unknown[]) => void): this {
      const eventListeners = this.listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      this.listeners.set(event, eventListeners);
      return this;
    }

    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const eventListeners = this.listeners.get(event);
      if (!eventListeners) {
        return false;
      }

      for (const listener of eventListeners) {
        listener(...args);
      }
      return eventListeners.size > 0;
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }
  }

  const ipcMain = new IpcMainMock();

  return {
    ipcMain,
  };
});

const storeState = vi.hoisted(() => ({
  mcpServer: {
    enabled: true,
    port: 0,
    apiKey: "",
    fullToolSurface: false,
    auditEnabled: true,
    auditMaxRecords: 500,
    auditLog: [] as Array<Record<string, unknown>>,
  },
}));

const storeMocks = vi.hoisted(() => ({
  get: vi.fn((key: string) => {
    if (key !== "mcpServer") {
      throw new Error(`Unexpected store key: ${key}`);
    }
    return storeState.mcpServer;
  }),
  set: vi.fn((key: string, value: typeof storeState.mcpServer) => {
    if (key !== "mcpServer") {
      throw new Error(`Unexpected store key: ${key}`);
    }
    storeState.mcpServer = value;
  }),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = {
    ...actual,
    homedir: () => testHomeDir,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock("electron", () => ({
  ipcMain: electronMocks.ipcMain,
  BrowserWindow: class BrowserWindow {},
}));

vi.mock("../../store.js", () => ({
  store: {
    get: storeMocks.get,
    set: storeMocks.set,
  },
}));

import { McpServerService } from "../McpServerService.js";

type DispatchRequest = {
  requestId: string;
  actionId: string;
  args?: unknown;
  confirmed?: boolean;
};

type TextToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function createManifestEntry(entry: {
  id: string;
  title: string;
  description: string;
  name?: string;
  category?: string;
  kind?: ActionKind;
  danger?: ActionDanger;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  enabled?: boolean;
  disabledReason?: string;
  requiresArgs?: boolean;
}): ActionManifestEntry {
  return {
    id: entry.id as ActionId,
    name: entry.name ?? entry.id,
    title: entry.title,
    description: entry.description,
    category: entry.category ?? "test",
    kind: entry.kind ?? "command",
    danger: entry.danger ?? "safe",
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    enabled: entry.enabled ?? true,
    disabledReason: entry.disabledReason,
    requiresArgs: entry.requiresArgs ?? false,
  };
}

let nextWebContentsId = 100;

function createMockWindow(options?: {
  getManifest?: () => ActionManifestEntry[];
  dispatchAction?: (payload: DispatchRequest) => ActionDispatchResult;
  senderIdOverride?: number;
  hostShellWebContentsId?: number;
}) {
  const getManifest = options?.getManifest ?? (() => []);
  const dispatchAction =
    options?.dispatchAction ??
    (() => ({
      ok: true,
      result: "ok",
    }));

  const projectViewWcId = nextWebContentsId++;
  const hostShellWcId = options?.hostShellWebContentsId ?? nextWebContentsId++;
  const senderId = options?.senderIdOverride ?? projectViewWcId;
  const destroyedListeners = new Set<() => void>();

  const webContents: {
    id: number;
    isDestroyed: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    triggerDestroyed: () => void;
  } = {
    id: projectViewWcId,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(
      (channel: string, payload: { requestId: string; actionId?: string; args?: unknown }) => {
        if (channel === "mcp:get-manifest-request") {
          queueMicrotask(() => {
            electronMocks.ipcMain.emit(
              "mcp:get-manifest-response",
              { sender: { id: senderId } },
              {
                requestId: payload.requestId,
                manifest: getManifest(),
              }
            );
          });
          return;
        }

        if (channel === "mcp:dispatch-action-request") {
          queueMicrotask(() => {
            electronMocks.ipcMain.emit(
              "mcp:dispatch-action-response",
              { sender: { id: senderId } },
              {
                requestId: payload.requestId,
                result: dispatchAction(payload as DispatchRequest),
              }
            );
          });
        }
      }
    ),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") {
        destroyedListeners.add(listener);
      }
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === "destroyed") {
        destroyedListeners.delete(listener);
      }
    }),
    triggerDestroyed: () => {
      const listeners = Array.from(destroyedListeners);
      destroyedListeners.clear();
      for (const listener of listeners) listener();
    },
  };

  const hostShellWebContents = {
    id: hostShellWcId,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
  };

  const browserWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: hostShellWebContents,
  };

  const projectViewManager = {
    getActiveView: vi.fn((): { webContents: typeof webContents } | null => ({ webContents })),
  };

  const windowContext = {
    windowId: 1,
    webContentsId: hostShellWcId,
    browserWindow,
    projectPath: null,
    abortController: new AbortController(),
    services: { projectViewManager },
    cleanup: [],
  };

  const registry = {
    all: () => [windowContext],
    getPrimary: () => windowContext,
    getByWindowId: () => windowContext,
    getByWebContentsId: () => windowContext,
    size: 1,
  };

  return {
    window: registry as never,
    webContents,
    hostShellWebContents,
    projectViewManager,
  };
}

async function connectClient(
  port: number,
  headers?: Record<string, string>
): Promise<{ client: Client; transport: SSEClientTransport }> {
  const apiKey = storeState.mcpServer.apiKey;
  const mergedHeaders: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(headers ?? {}),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
    eventSourceInit: hasHeaders ? ({ headers: mergedHeaders } as never) : undefined,
    requestInit: hasHeaders ? { headers: mergedHeaders } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

async function connectHttpClient(
  port: number,
  headers?: Record<string, string>
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const apiKey = storeState.mcpServer.apiKey;
  const mergedHeaders: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(headers ?? {}),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;
  const client = new Client({ name: "mcp-test-http-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: hasHeaders ? { headers: mergedHeaders } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

async function requestMcp(
  port: number,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<{ status: number; body: string }> {
  const method = options.method ?? "POST";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );

    req.on("error", reject);
    if (options.body !== undefined) {
      req.end(options.body);
    } else {
      req.end();
    }
  });
}

async function requestSse(
  port: number,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/sse",
        method: "GET",
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

function getTextResult(result: unknown): TextToolResult {
  return result as TextToolResult;
}

describe("McpServerService", () => {
  let service: McpServerService;
  const transports: SSEClientTransport[] = [];
  const httpTransports: StreamableHTTPClientTransport[] = [];
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    storeState.mcpServer = {
      enabled: true,
      port: 0,
      apiKey: "",
      fullToolSurface: false,
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: [],
    };
    storeMocks.get.mockClear();
    storeMocks.set.mockClear();
    electronMocks.ipcMain.removeAllListeners();
    electronMocks.ipcMain.handle.mockClear();
    electronMocks.ipcMain.removeHandler.mockClear();
    transports.length = 0;
    httpTransports.length = 0;
    await fs.rm(path.join(testHomeDir, ".daintree"), { recursive: true, force: true });
    await fs.mkdir(testHomeDir, { recursive: true });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
  });

  afterEach(async () => {
    for (const transport of transports) {
      await transport.close().catch(() => {});
    }
    for (const transport of httpTransports) {
      await transport.close().catch(() => {});
    }
    if (service.isRunning) {
      await service.stop();
    }
    consoleLogSpy.mockRestore();
  });

  afterAll(async () => {
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  it("lists tools and advertises explicit confirmation metadata for destructive actions", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
        createManifestEntry({
          id: "worktree.delete" as ActionId,
          title: "Delete Worktree",
          description: "Delete a worktree",
          danger: "confirm",
          inputSchema: {
            type: "object",
            properties: {
              worktreeId: { type: "string" },
            },
            required: ["worktreeId"],
          },
          requiresArgs: true,
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const safeTool = result.tools.find((tool) => tool.name === "actions.list");
    const dangerousTool = result.tools.find((tool) => tool.name === "worktree.delete");

    expect(safeTool).toBeDefined();
    expect(dangerousTool).toBeDefined();
    expect(dangerousTool?.description).toContain("Requires explicit confirmation");
    expect(dangerousTool?.inputSchema.properties?._meta).toEqual({
      type: "object",
      description: "Reserved Daintree MCP metadata.",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true to execute this destructive action.",
        },
      },
      additionalProperties: false,
    });

    // Annotations — query tool
    expect(safeTool?.annotations).toEqual({
      title: "List Actions",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    // Annotations — destructive tool
    expect(dangerousTool?.annotations).toEqual({
      title: "Delete Worktree",
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  it("sets openWorldHint true for network-bound categories and false for local ones", async () => {
    storeState.mcpServer.fullToolSurface = true;
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "github.listPullRequests" as ActionId,
          title: "List PRs",
          description: "List pull requests",
          category: "github",
          kind: "query",
        }),
        createManifestEntry({
          id: "system.checkCommand" as ActionId,
          title: "Check Command",
          description: "Check if a command exists",
          category: "system",
          kind: "query",
        }),
        createManifestEntry({
          id: "worktree.create" as ActionId,
          title: "Create Worktree",
          description: "Create a new worktree",
          category: "worktree",
          kind: "command",
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const ghTool = result.tools.find((t) => t.name === "github.listPullRequests");
    const systemTool = result.tools.find((t) => t.name === "system.checkCommand");
    const wtTool = result.tools.find((t) => t.name === "worktree.create");

    expect(ghTool?.annotations?.openWorldHint).toBe(true);
    expect(systemTool?.annotations?.openWorldHint).toBe(true);
    expect(wtTool?.annotations?.openWorldHint).toBe(false);
  });

  it("requires explicit MCP confirmation before dispatching destructive actions", async () => {
    const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
      if (!payload.confirmed) {
        return {
          ok: false,
          error: {
            code: "CONFIRMATION_REQUIRED",
            message: "Explicit confirmation is required",
          },
        };
      }

      return {
        ok: true,
        result: {
          deleted: true,
          args: payload.args,
        },
      };
    });

    const { window, webContents } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "worktree.delete" as ActionId,
          title: "Delete Worktree",
          description: "Delete a worktree",
          danger: "confirm",
          inputSchema: {
            type: "object",
            properties: {
              worktreeId: { type: "string" },
            },
            required: ["worktreeId"],
          },
          requiresArgs: true,
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const unconfirmed = getTextResult(
      await client.callTool({
        name: "worktree.delete",
        arguments: { worktreeId: "wt-123" },
      })
    );
    const confirmed = getTextResult(
      await client.callTool({
        name: "worktree.delete",
        arguments: {
          worktreeId: "wt-123",
          _meta: { confirmed: true },
        },
      })
    );

    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.content[0]).toMatchObject({
      type: "text",
    });
    expect(unconfirmed.content[0].text).toContain("CONFIRMATION_REQUIRED");

    expect(confirmed.isError).not.toBe(true);
    expect(confirmed.content[0].text).toContain('"deleted": true');

    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actionId: "worktree.delete",
        args: { worktreeId: "wt-123" },
        confirmed: false,
      })
    );
    expect(dispatchMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        actionId: "worktree.delete",
        args: { worktreeId: "wt-123" },
        confirmed: true,
      })
    );
    expect(webContents.send).toHaveBeenCalledTimes(2);
  });

  it("refreshes the discovery file when authentication changes while running", async () => {
    const { window } = createMockWindow();
    const discoveryFile = path.join(testHomeDir, ".daintree", "mcp.json");

    await service.start(window);

    const initial = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<
        string,
        { type?: string; url?: string; headers?: { Authorization: string } }
      >;
    };
    const initialKey = storeState.mcpServer.apiKey;
    expect(initialKey).toMatch(/^daintree_[a-f0-9]+$/);
    expect(initial.mcpServers.daintree.type).toBe("http");
    expect(initial.mcpServers.daintree.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(initial.mcpServers.daintree.headers).toEqual({
      Authorization: `Bearer ${initialKey}`,
    });

    const rotatedKey = await service.generateApiKey();
    expect(rotatedKey).not.toBe(initialKey);
    const rotated = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(rotated.mcpServers.daintree.headers).toEqual({
      Authorization: `Bearer ${rotatedKey}`,
    });

    await service.setApiKey("");
    const cleared = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(cleared.mcpServers.daintree.headers).toBeUndefined();
  });

  it("auto-generates a bearer token on first start and persists it across restarts", async () => {
    const { window } = createMockWindow();

    expect(storeState.mcpServer.apiKey).toBe("");

    await service.start(window);
    const generatedKey = storeState.mcpServer.apiKey;
    expect(generatedKey).toMatch(/^daintree_[a-f0-9]+$/);

    await service.stop();

    await service.start(window);
    expect(storeState.mcpServer.apiKey).toBe(generatedKey);
  });

  it("rejects requests with a non-loopback Origin header", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const evil = await requestSse(service.currentPort!, {
      Authorization: `Bearer ${storeState.mcpServer.apiKey}`,
      Origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    expect(evil.body).toBe("Forbidden");
  });

  it("accepts absent and loopback Origin headers on the SSE GET", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const auth = `Bearer ${storeState.mcpServer.apiKey}`;

    // Helper that aborts the SSE GET as soon as the response status is known.
    const peekStatus = async (extraHeaders: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/sse",
            method: "GET",
            headers: { Authorization: auth, ...extraHeaders },
          },
          (res) => {
            const status = res.statusCode ?? 0;
            req.destroy();
            resolve(status);
          }
        );
        req.on("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "ECONNRESET") return;
          reject(err);
        });
        req.end();
      });

    expect(await peekStatus({})).toBe(200);
    expect(await peekStatus({ Origin: `http://127.0.0.1:${port}` })).toBe(200);
    expect(await peekStatus({ Origin: `http://localhost:${port}` })).toBe(200);
  });

  it("uses constant-time comparison that does not short-circuit on length mismatch", async () => {
    storeState.mcpServer.apiKey = "secret";
    const { window } = createMockWindow();
    await service.start(window);

    const wrongShort = await requestSse(service.currentPort!, {
      Authorization: "Bearer x",
    });
    const wrongLong = await requestSse(service.currentPort!, {
      Authorization: `Bearer ${"x".repeat(1024)}`,
    });
    const correct = await requestSse(service.currentPort!, {
      Authorization: "Bearer wrong-but-same-length-ish",
    });

    expect(wrongShort.status).toBe(401);
    expect(wrongLong.status).toBe(401);
    expect(correct.status).toBe(401);
  });

  it("sets POSIX 0700/0600 mode on the discovery directory and file", async () => {
    if (process.platform === "win32") return;

    const { window } = createMockWindow();
    const discoveryDir = path.join(testHomeDir, ".daintree");
    const discoveryFile = path.join(discoveryDir, "mcp.json");

    await service.start(window);

    const dirStat = await fs.stat(discoveryDir);
    const fileStat = await fs.stat(discoveryFile);
    expect(dirStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("preserves 0600 mode on partial discovery file removal", async () => {
    if (process.platform === "win32") return;

    const { window } = createMockWindow();
    const discoveryDir = path.join(testHomeDir, ".daintree");
    const discoveryFile = path.join(discoveryDir, "mcp.json");

    // Pre-populate with another MCP entry that should survive removal.
    await fs.mkdir(discoveryDir, { recursive: true });
    await fs.writeFile(
      discoveryFile,
      JSON.stringify(
        {
          mcpServers: {
            other: { type: "sse", url: "http://other.local/sse" },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    await service.start(window);
    await service.stop();

    const fileStat = await fs.stat(discoveryFile);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const remaining = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(remaining.mcpServers.other).toBeDefined();
    expect(remaining.mcpServers.daintree).toBeUndefined();
  });

  it("invalidates the old bearer immediately after rotation", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const oldKey = storeState.mcpServer.apiKey;
    const newKey = await service.generateApiKey();
    expect(newKey).not.toBe(oldKey);

    const oldRequest = await requestSse(service.currentPort!, {
      Authorization: `Bearer ${oldKey}`,
    });
    expect(oldRequest.status).toBe(401);

    // New key works (peek + abort).
    const port = service.currentPort!;
    const newStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/sse",
          method: "GET",
          headers: { Authorization: `Bearer ${newKey}` },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          req.destroy();
          resolve(status);
        }
      );
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNRESET") return;
        reject(err);
      });
      req.end();
    });
    expect(newStatus).toBe(200);
  });

  it("rejects POST /messages with a non-loopback Origin header", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const auth = `Bearer ${storeState.mcpServer.apiKey}`;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/messages?sessionId=anything",
          method: "POST",
          headers: {
            Authorization: auth,
            Origin: "https://evil.example",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("closes idle SSE sessions after the application-level timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { window } = createMockWindow();
      await service.start(window);

      const sessions = (
        service as unknown as {
          sessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      ).sessions;

      const transport = {
        sessionId: "test-session",
        close: vi.fn(async () => {}),
      };
      const createIdleTimer = (
        service as unknown as {
          createIdleTimer: (sessionId: string) => ReturnType<typeof setTimeout>;
        }
      ).createIdleTimer.bind(service);

      const idleTimer = createIdleTimer("test-session");
      sessions.set("test-session", { transport, idleTimer } as never);

      expect(sessions.has("test-session")).toBe(true);

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);

      expect(sessions.has("test-session")).toBe(false);
      expect(transport.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the idle timer on incoming POST traffic", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { window } = createMockWindow();
      await service.start(window);

      const sessions = (
        service as unknown as {
          sessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      ).sessions;

      const transport = {
        sessionId: "active-session",
        close: vi.fn(async () => {}),
      };
      const createIdleTimer = (
        service as unknown as {
          createIdleTimer: (sessionId: string) => ReturnType<typeof setTimeout>;
        }
      ).createIdleTimer.bind(service);
      const resetIdleTimer = (
        service as unknown as { resetIdleTimer: (sessionId: string) => void }
      ).resetIdleTimer.bind(service);

      sessions.set("active-session", {
        transport,
        idleTimer: createIdleTimer("active-session"),
      } as never);

      // Just before timeout: keep alive via a POST.
      vi.advanceTimersByTime(29 * 60 * 1000);
      resetIdleTimer("active-session");

      // After original timeout would have fired — session should still exist.
      vi.advanceTimersByTime(2 * 60 * 1000);
      expect(sessions.has("active-session")).toBe(true);
      expect(transport.close).not.toHaveBeenCalled();

      // Now let the new timer expire.
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(sessions.has("active-session")).toBe(false);
      expect(transport.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unauthorized requests and invalid host headers", async () => {
    storeState.mcpServer.apiKey = "secret";
    const { window } = createMockWindow();

    await service.start(window);

    const unauthorized = await requestSse(service.currentPort!);
    const forbidden = await requestSse(service.currentPort!, {
      Authorization: "Bearer secret",
      Host: "evil.example",
    });

    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toBe("Unauthorized");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toBe("Forbidden");
  });

  it("fails fast when the renderer bridge is unavailable", async () => {
    const { window, webContents } = createMockWindow();

    await service.start(window);
    webContents.isDestroyed.mockReturnValue(true);

    const requestManifest = (service as never as { requestManifest: () => Promise<unknown> })
      .requestManifest;
    const dispatchAction = (
      service as never as {
        dispatchAction: (actionId: string, args: unknown, confirmed?: boolean) => Promise<unknown>;
      }
    ).dispatchAction;

    await expect(requestManifest.call(service)).rejects.toThrow("MCP renderer bridge unavailable");
    await expect(dispatchAction.call(service, "actions.list", {}, false)).rejects.toThrow(
      "MCP renderer bridge unavailable"
    );
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("hides non-allowlisted tools by default (curated MCP surface)", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
        createManifestEntry({
          id: "panel.gridLayout.setStrategy" as ActionId,
          title: "Set grid layout",
          description: "UI plumbing — should not appear in curated surface",
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const ids = result.tools.map((tool) => tool.name);

    expect(ids).toContain("actions.list");
    expect(ids).not.toContain("panel.gridLayout.setStrategy");
  });

  it("exposes the full non-restricted surface when fullToolSurface is enabled", async () => {
    storeState.mcpServer.fullToolSurface = true;
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
        createManifestEntry({
          id: "panel.gridLayout.setStrategy" as ActionId,
          title: "Set grid layout",
          description: "Power-user UI plumbing",
        }),
        createManifestEntry({
          id: "internal.dangerous" as ActionId,
          title: "Restricted",
          description: "Should never be advertised",
          danger: "restricted",
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const ids = result.tools.map((tool) => tool.name);

    expect(ids).toContain("actions.list");
    expect(ids).toContain("panel.gridLayout.setStrategy");
    expect(ids).not.toContain("internal.dangerous");
  });

  it("treats non-true fullToolSurface values as curated (fail-closed)", async () => {
    (storeState.mcpServer as { fullToolSurface: unknown }).fullToolSurface = "false";
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
        createManifestEntry({
          id: "panel.gridLayout.setStrategy" as ActionId,
          title: "Set grid layout",
          description: "UI plumbing",
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const ids = (await client.listTools()).tools.map((tool) => tool.name);
    expect(ids).toContain("actions.list");
    expect(ids).not.toContain("panel.gridLayout.setStrategy");
  });

  it("dispatches non-allowlisted actions even in curated mode", async () => {
    const dispatchMock = vi.fn(
      (payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: { dispatched: payload.actionId },
      })
    );

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const ids = (await client.listTools()).tools.map((tool) => tool.name);
    expect(ids).not.toContain("panel.gridLayout.setStrategy");

    const result = getTextResult(
      await client.callTool({
        name: "panel.gridLayout.setStrategy",
        arguments: { strategy: "automatic" },
      })
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('"dispatched": "panel.gridLayout.setStrategy"');
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "panel.gridLayout.setStrategy" })
    );
  });

  describe("audit log", () => {
    type AuditRecord = {
      id: string;
      timestamp: number;
      toolId: string;
      sessionId: string;
      tier: string;
      argsSummary: string;
      result: "success" | "error" | "confirmation-pending";
      errorCode?: string;
      durationMs: number;
    };

    function getAuditRecords(svc: McpServerService): AuditRecord[] {
      return (svc as unknown as { getAuditRecords: () => AuditRecord[] }).getAuditRecords();
    }

    it("records a successful dispatch with redacted args and a non-empty session id", async () => {
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({
          ok: true,
          result: { ok: true },
        })
      );
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const longArg = "x".repeat(120);
      await client.callTool({
        name: "actions.list",
        arguments: { query: longArg, limit: 10, force: false },
      });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      const [record] = records;
      expect(record.toolId).toBe("actions.list");
      expect(record.result).toBe("success");
      expect(record.tier).toBe("unknown");
      expect(record.sessionId.length).toBeGreaterThan(0);
      expect(record.argsSummary).toContain("<string: 120 chars>");
      expect(record.argsSummary).toContain('"limit":10');
      expect(record.argsSummary).toContain('"force":false');
      expect(record.argsSummary).not.toContain("xxxxxxxxxx");
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.errorCode).toBeUndefined();
    });

    it("records error and confirmation-pending dispatches separately", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "worktree.delete" && !payload.confirmed) {
          return {
            ok: false,
            error: { code: "CONFIRMATION_REQUIRED", message: "Need confirm" },
          };
        }
        return {
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "exploded" },
        };
      });
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.delete" as ActionId,
            title: "Delete Worktree",
            description: "Delete a worktree",
            danger: "confirm",
          }),
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "worktree.delete", arguments: { worktreeId: "wt" } });
      await client.callTool({ name: "actions.list", arguments: {} });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(2);
      const byTool = Object.fromEntries(records.map((r) => [r.toolId, r]));
      expect(byTool["worktree.delete"].result).toBe("confirmation-pending");
      expect(byTool["worktree.delete"].errorCode).toBe("CONFIRMATION_REQUIRED");
      expect(byTool["actions.list"].result).toBe("error");
      expect(byTool["actions.list"].errorCode).toBe("EXECUTION_ERROR");
    });

    it("records dispatch throws even when no result envelope is returned", async () => {
      const { window, webContents } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      // After start, simulate the renderer bridge dropping mid-call so dispatch
      // throws synchronously inside the handler.
      webContents.isDestroyed.mockReturnValue(true);

      const result = (await client.callTool({
        name: "actions.list",
        arguments: {},
      })) as TextToolResult;
      expect(result.isError).toBe(true);

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].toolId).toBe("actions.list");
      expect(records[0].result).toBe("error");
      expect(records[0].errorCode).toBe("DISPATCH_THREW");
    });

    it("trims the ring buffer to the configured cap on append", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });

      storeState.mcpServer.auditMaxRecords = 50; // clamped floor
      await service.start(window);
      (
        service as unknown as {
          setAuditMaxRecords: (n: number) => unknown;
        }
      ).setAuditMaxRecords(50);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      for (let i = 0; i < 55; i++) {
        await client.callTool({ name: "actions.list", arguments: { i } });
      }

      const records = getAuditRecords(service);
      expect(records).toHaveLength(50);
      // newest first → first record should reference highest i (54)
      expect(records[0].argsSummary).toContain('"i":54');
    });

    it("clearAuditLog empties the buffer and persists immediately", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);
      await client.callTool({ name: "actions.list", arguments: {} });

      expect(getAuditRecords(service)).toHaveLength(1);

      storeMocks.set.mockClear();
      (service as unknown as { clearAuditLog: () => void }).clearAuditLog();

      expect(getAuditRecords(service)).toHaveLength(0);
      // clearAuditLog must persist synchronously, not wait for the debounce.
      expect(storeMocks.set).toHaveBeenCalled();
      const lastCall = storeMocks.set.mock.calls[storeMocks.set.mock.calls.length - 1];
      expect(lastCall[0]).toBe("mcpServer");
      expect((lastCall[1] as { auditLog: unknown[] }).auditLog).toEqual([]);
    });

    it("does not record dispatches when capture is disabled", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });
      storeState.mcpServer.auditEnabled = false;
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "actions.list", arguments: {} });

      expect(getAuditRecords(service)).toHaveLength(0);
    });

    it("hydrates the buffer from persisted audit records on start", async () => {
      const seeded: AuditRecord[] = [
        {
          id: "seed-1",
          timestamp: 1,
          toolId: "actions.list",
          sessionId: "old",
          tier: "unknown",
          argsSummary: "{}",
          result: "success",
          durationMs: 5,
        },
      ];
      storeState.mcpServer.auditLog = seeded;

      const { window } = createMockWindow();
      await service.start(window);

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("seed-1");
    });

    it("treats a missing auditEnabled key (legacy persisted config) as enabled", async () => {
      // Simulate a user whose config.json predates this feature: auditEnabled
      // and auditMaxRecords are absent. A naive `!auditEnabled` guard would
      // silently drop every record while the UI shows "Capture on".
      delete (storeState.mcpServer as Partial<typeof storeState.mcpServer>).auditEnabled;
      delete (storeState.mcpServer as Partial<typeof storeState.mcpServer>).auditMaxRecords;

      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "actions.list", arguments: {} });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].toolId).toBe("actions.list");

      const config = (
        service as unknown as { getAuditConfig: () => { enabled: boolean; maxRecords: number } }
      ).getAuditConfig();
      expect(config.enabled).toBe(true);
      expect(config.maxRecords).toBe(500);
    });

    it("debounced flush persists without an explicit clear or stop", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
        advanceTimeDelta: 50,
      });
      try {
        await client.callTool({ name: "actions.list", arguments: { x: 1 } });
        storeMocks.set.mockClear();

        // Before the debounce window expires, no flush.
        vi.advanceTimersByTime(1000);
        expect(storeMocks.set).not.toHaveBeenCalled();

        // After the 2s window the debounced flush fires once.
        vi.advanceTimersByTime(1500);
        const calls = storeMocks.set.mock.calls.filter((call) => call[0] === "mcpServer");
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const last = calls[calls.length - 1];
        expect(
          (last[1] as unknown as { auditLog: Array<{ toolId: string }> }).auditLog
        ).toHaveLength(1);
        expect(
          (last[1] as unknown as { auditLog: Array<{ toolId: string }> }).auditLog[0].toolId
        ).toBe("actions.list");
      } finally {
        vi.useRealTimers();
      }
    });

    it("clearAuditLog cancels any pending debounce flush", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
        advanceTimeDelta: 50,
      });
      try {
        await client.callTool({ name: "actions.list", arguments: {} });
        // Pending debounce timer is now set with the record in the buffer.
        (service as unknown as { clearAuditLog: () => void }).clearAuditLog();
        storeMocks.set.mockClear();

        // Advance well past the original debounce window. The cancelled
        // timer must not fire and re-persist the cleared record.
        vi.advanceTimersByTime(5000);
        expect(storeMocks.set).not.toHaveBeenCalled();
        expect(getAuditRecords(service)).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves audit log when other config writes happen", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
          }),
        ],
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "actions.list", arguments: {} });
      expect(getAuditRecords(service)).toHaveLength(1);

      // Mutate auth — historically this clobbered auditLog because the config
      // setter wrote back the spread of getConfig() without the in-memory log.
      await service.setApiKey("daintree_abcd");

      expect(storeState.mcpServer.auditLog).toHaveLength(1);
      expect(getAuditRecords(service)).toHaveLength(1);
    });
  });

  it("returns safe text output for circular tool results", async () => {
    const circularResult: Record<string, unknown> = { ok: true };
    circularResult.self = circularResult;

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
        }),
      ],
      dispatchAction: () => ({
        ok: true,
        result: circularResult,
      }),
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = getTextResult(
      await client.callTool({
        name: "actions.list",
        arguments: {},
      })
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('"self": "[Circular]"');
  });

  it("routes IPC bounce to the active project view, not the host shell", async () => {
    const { window, webContents, hostShellWebContents } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
      ],
    });

    await service.start(window);
    const requestManifest = (
      service as never as { requestManifest: () => Promise<ActionManifestEntry[]> }
    ).requestManifest.bind(service);

    await requestManifest();

    expect(webContents.send).toHaveBeenCalledWith(
      "mcp:get-manifest-request",
      expect.objectContaining({ requestId: expect.any(String) })
    );
    expect(hostShellWebContents.send).not.toHaveBeenCalled();
  });

  it("rejects IPC responses from a sender that did not originate the request", async () => {
    const { window, webContents } = createMockWindow({
      senderIdOverride: 99999, // simulate a response coming from the wrong webContents
    });

    await service.start(window);
    const requestManifest = (
      service as never as { requestManifest: () => Promise<ActionManifestEntry[]> }
    ).requestManifest.bind(service);

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      const promise = requestManifest();
      // Attach the rejection assertion synchronously so the eventual reject
      // is not flagged as an unhandled rejection when the timer fires below.
      const assertion = expect(promise).rejects.toThrow("Manifest request timed out");
      // Flush the queueMicrotask in send() so the wrong-sender response lands.
      await Promise.resolve();
      // Advance past the 5s manifest timeout.
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      expect(webContents.send).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("unexpected sender 99999")
      );
    } finally {
      vi.useRealTimers();
      consoleWarnSpy.mockRestore();
    }
  });

  it("fails closed when no project view is active", async () => {
    const { window, webContents, projectViewManager } = createMockWindow();
    projectViewManager.getActiveView.mockReturnValue(null);

    await service.start(window);
    const requestManifest = (
      service as never as { requestManifest: () => Promise<unknown> }
    ).requestManifest.bind(service);
    const dispatchAction = (
      service as never as {
        dispatchAction: (actionId: string, args: unknown, confirmed?: boolean) => Promise<unknown>;
      }
    ).dispatchAction.bind(service);

    await expect(requestManifest()).rejects.toThrow("MCP renderer bridge unavailable");
    await expect(dispatchAction("actions.list", {}, false)).rejects.toThrow(
      "MCP renderer bridge unavailable"
    );
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("rejects pending requests when the target webContents is destroyed mid-flight", async () => {
    const { window, webContents } = createMockWindow({
      // Manifest mock won't fire — we simulate a destroy before the response arrives.
      getManifest: () => {
        throw new Error("should not be called");
      },
    });
    // Override send to a no-op so the destroyed event has time to land.
    webContents.send.mockImplementation(() => {});

    await service.start(window);
    const requestManifest = (
      service as never as { requestManifest: () => Promise<unknown> }
    ).requestManifest.bind(service);

    const promise = requestManifest();

    // Trigger the once("destroyed") listener that the service registered.
    webContents.triggerDestroyed();

    await expect(promise).rejects.toThrow("MCP renderer bridge destroyed");
  });

  it("serves the Streamable HTTP transport at /mcp and lists tools", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectHttpClient(service.currentPort!);
    httpTransports.push(transport);

    const result = await client.listTools();
    const ids = result.tools.map((tool) => tool.name);
    expect(ids).toContain("actions.list");

    const httpSessions = (service as unknown as { httpSessions: Map<string, unknown> })
      .httpSessions;
    expect(httpSessions.size).toBe(1);
  });

  it("reuses the same Streamable HTTP session for follow-up tool calls", async () => {
    const dispatchMock = vi.fn(
      (payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: { dispatched: payload.actionId },
      })
    );

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const { client, transport } = await connectHttpClient(service.currentPort!);
    httpTransports.push(transport);

    await client.callTool({ name: "actions.list", arguments: {} });

    const httpSessions = (service as unknown as { httpSessions: Map<string, unknown> })
      .httpSessions;
    const sessionIdsAfterFirst = Array.from(httpSessions.keys());
    expect(sessionIdsAfterFirst).toHaveLength(1);

    await client.callTool({ name: "actions.list", arguments: {} });

    const sessionIdsAfterSecond = Array.from(httpSessions.keys());
    expect(sessionIdsAfterSecond).toEqual(sessionIdsAfterFirst);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
  });

  it("returns 404 on /mcp requests with an unknown mcp-session-id header", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const result = await requestMcp(port, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${storeState.mcpServer.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": "definitely-not-a-real-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(result.status).toBe(404);
    const parsed = JSON.parse(result.body) as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.error.code).toBe(-32001);
    expect(parsed.error.message).toBe("Session not found");
    expect(parsed.id).toBeNull();
  });

  it("returns 405 with an Allow header for unsupported methods on /mcp", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const result = await new Promise<{ status: number; allow: string | undefined }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/mcp",
            method: "PUT",
            headers: { Authorization: `Bearer ${storeState.mcpServer.apiKey}` },
          },
          (res) => {
            const allow = res.headers["allow"];
            resolve({
              status: res.statusCode ?? 0,
              allow: Array.isArray(allow) ? allow[0] : allow,
            });
            res.resume();
          }
        );
        req.on("error", reject);
        req.end();
      }
    );

    expect(result.status).toBe(405);
    expect(result.allow).toBe("GET, POST, DELETE");
  });

  it("rejects /mcp requests that fail auth, host, or origin checks", async () => {
    storeState.mcpServer.apiKey = "secret";
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;

    const unauthorized = await requestMcp(port, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const wrongOrigin = await requestMcp(port, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(wrongOrigin.status).toBe(403);

    const wrongHost = await requestMcp(port, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret",
        Host: "evil.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(wrongHost.status).toBe(403);
  });

  it("closes idle Streamable HTTP sessions after the application-level timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { window } = createMockWindow();
      await service.start(window);

      const httpSessions = (
        service as unknown as {
          httpSessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      ).httpSessions;

      const transport = {
        sessionId: "http-test-session",
        close: vi.fn(async () => {}),
      };
      const createHttpIdleTimer = (
        service as unknown as {
          createHttpIdleTimer: (sessionId: string) => ReturnType<typeof setTimeout>;
        }
      ).createHttpIdleTimer.bind(service);

      const idleTimer = createHttpIdleTimer("http-test-session");
      httpSessions.set("http-test-session", {
        transport,
        idleTimer,
      } as never);

      expect(httpSessions.has("http-test-session")).toBe(true);

      vi.advanceTimersByTime(30 * 60 * 1000 + 1);

      expect(httpSessions.has("http-test-session")).toBe(false);
      expect(transport.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the SSE transport functional after Streamable HTTP is in use", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "Read the action registry",
          kind: "query",
        }),
      ],
    });

    await service.start(window);

    const { client: httpClient, transport: httpTransport } = await connectHttpClient(
      service.currentPort!
    );
    httpTransports.push(httpTransport);
    const httpResult = await httpClient.listTools();
    expect(httpResult.tools.map((t) => t.name)).toContain("actions.list");

    const { client: sseClient, transport: sseTransport } = await connectClient(
      service.currentPort!
    );
    transports.push(sseTransport);
    const sseResult = await sseClient.listTools();
    expect(sseResult.tools.map((t) => t.name)).toContain("actions.list");
  });

  it("emits the Streamable HTTP config snippet with type 'http' and /mcp", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const snippet = JSON.parse(service.getConfigSnippet()) as {
      mcpServers: Record<
        string,
        { type: string; url: string; headers?: { Authorization: string } }
      >;
    };

    expect(snippet.mcpServers.daintree.type).toBe("http");
    expect(snippet.mcpServers.daintree.url).toBe(`http://127.0.0.1:${service.currentPort}/mcp`);
    expect(snippet.mcpServers.daintree.headers).toEqual({
      Authorization: `Bearer ${storeState.mcpServer.apiKey}`,
    });
  });
});
