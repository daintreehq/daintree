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

const paneTokenTiers = vi.hoisted(() => new Map<string, "workbench" | "action" | "system">());

vi.mock("../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    isValidPaneToken: (token: string) => paneTokenTiers.has(token),
    getTierForToken: (token: string) => paneTokenTiers.get(token),
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
  mcpAnnotations?: ActionManifestEntry["mcpAnnotations"];
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
    ...(entry.mcpAnnotations ? { mcpAnnotations: entry.mcpAnnotations } : {}),
  };
}

let nextWebContentsId = 100;

function createMockWindow(options?: {
  getManifest?: () => ActionManifestEntry[];
  dispatchAction?: (payload: DispatchRequest) =>
    | ActionDispatchResult
    | {
        result: ActionDispatchResult;
        confirmationDecision?: "approved" | "rejected" | "timeout";
      };
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
            const dispatched = dispatchAction(payload as DispatchRequest);
            const isEnvelope =
              typeof dispatched === "object" && dispatched !== null && !("ok" in dispatched);
            const envelope = isEnvelope
              ? (dispatched as {
                  result: ActionDispatchResult;
                  confirmationDecision?: "approved" | "rejected" | "timeout";
                })
              : { result: dispatched as ActionDispatchResult };
            electronMocks.ipcMain.emit(
              "mcp:dispatch-action-response",
              { sender: { id: senderId } },
              {
                requestId: payload.requestId,
                result: envelope.result,
                confirmationDecision: envelope.confirmationDecision,
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

function getServiceApiKey(): string {
  const key = currentService?.getStatus().apiKey ?? "";
  return key;
}

async function connectClient(
  port: number,
  headers?: Record<string, string>
): Promise<{ client: Client; transport: SSEClientTransport }> {
  const apiKey = getServiceApiKey();
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
  const apiKey = getServiceApiKey();
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

let currentService: McpServerService | null = null;

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

/**
 * Variant of `requestSse` that resolves with just the status code and aborts
 * the request, used to inspect successful SSE responses (which never `end`
 * because the stream stays open). Lets auth-positive cases assert without
 * timing out.
 */
async function requestSseStatus(
  port: number,
  headers: Record<string, string> = {}
): Promise<number> {
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
        const status = res.statusCode ?? 0;
        res.destroy();
        req.destroy();
        resolve(status);
      }
    );

    req.on("error", (err: NodeJS.ErrnoException) => {
      // res.destroy() can surface as ECONNRESET on the request socket — ignore
      // since we have already resolved with the status code.
      if (err.code === "ECONNRESET") return;
      reject(err);
    });
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
    paneTokenTiers.clear();
    electronMocks.ipcMain.removeAllListeners();
    electronMocks.ipcMain.handle.mockClear();
    electronMocks.ipcMain.removeHandler.mockClear();
    transports.length = 0;
    httpTransports.length = 0;
    await fs.rm(path.join(testHomeDir, ".daintree"), { recursive: true, force: true });
    await fs.mkdir(testHomeDir, { recursive: true });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
    currentService = service;
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
    currentService = null;
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
    expect(safeTool?.inputSchema.additionalProperties).toBe(false);
    expect(dangerousTool?.inputSchema.additionalProperties).toBe(false);
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

  it("applies mcpAnnotations overrides on top of kind/danger defaults", async () => {
    storeState.mcpServer.fullToolSurface = true;
    const { window } = createMockWindow({
      getManifest: () => [
        // Query that requires UX confirmation but is not destructive.
        createManifestEntry({
          id: "copyTree.generate" as ActionId,
          title: "Generate Context",
          description: "Generate worktree context",
          kind: "query",
          danger: "confirm",
          mcpAnnotations: { destructiveHint: false },
        }),
        // Command that is semantically a read-only lookup; both readOnly and
        // idempotent hints are forced on via override.
        createManifestEntry({
          id: "test.readOnlyCommand" as ActionId,
          title: "Read Only Command",
          description: "Synthetic read-only command for override coverage",
          kind: "command",
          danger: "safe",
          mcpAnnotations: { readOnlyHint: true, idempotentHint: true },
        }),
        // Query whose readOnly/idempotent hints are explicitly forced off via
        // override — guards against regressing the merge from `??` to `||`.
        createManifestEntry({
          id: "test.queryOverriddenFalse" as ActionId,
          title: "Query With False Overrides",
          description: "Synthetic query whose hints are explicitly false",
          kind: "query",
          danger: "safe",
          mcpAnnotations: { readOnlyHint: false, idempotentHint: false },
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const generate = result.tools.find((t) => t.name === "copyTree.generate");
    const readOnlyCmd = result.tools.find((t) => t.name === "test.readOnlyCommand");
    const queryFalse = result.tools.find((t) => t.name === "test.queryOverriddenFalse");

    // Override flips destructiveHint off; readOnlyHint/idempotentHint still
    // come from the `kind: "query"` default.
    expect(generate?.annotations).toEqual({
      title: "Generate Context",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    // Override flips readOnly/idempotent on; destructiveHint still comes from
    // the `danger: "safe"` default.
    expect(readOnlyCmd?.annotations).toEqual({
      title: "Read Only Command",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });

    // Explicit `false` overrides must win over the `kind: "query"` default —
    // this would silently break if `??` were ever swapped for `||`.
    expect(queryFalse?.annotations).toEqual({
      title: "Query With False Overrides",
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  it("ignores attempts to override openWorldHint via mcpAnnotations", async () => {
    storeState.mcpServer.fullToolSurface = true;
    const { window } = createMockWindow({
      getManifest: () => [
        // openWorldHint is category-derived; mcpAnnotations exposes only the
        // three hint fields, so this entry's `category: "github"` must yield
        // `openWorldHint: true` regardless of any per-action override.
        createManifestEntry({
          id: "github.someTool" as ActionId,
          title: "Some GitHub Tool",
          description: "Tool in an open-world category",
          category: "github",
          kind: "command",
          danger: "safe",
          mcpAnnotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: true,
          },
        }),
      ],
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const result = await client.listTools();
    const tool = result.tools.find((t) => t.name === "github.someTool");

    expect(tool?.annotations?.openWorldHint).toBe(true);
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

  it("persists the rotated api key to electron-store", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const initialKey = service.getStatus().apiKey;
    expect(initialKey).toMatch(/^daintree_[a-f0-9]+$/);
    expect(storeState.mcpServer.apiKey).toBe(initialKey);

    const rotatedKey = await service.rotateApiKey();
    expect(rotatedKey).not.toBe(initialKey);
    expect(service.getStatus().apiKey).toBe(rotatedKey);
    expect(storeState.mcpServer.apiKey).toBe(rotatedKey);
  });

  it("persists the freshly generated api key to electron-store on first start", async () => {
    const { window } = createMockWindow();
    expect(storeState.mcpServer.apiKey).toBe("");

    await service.start(window);
    const generatedKey = service.getStatus().apiKey;
    expect(generatedKey).toMatch(/^daintree_[a-f0-9]+$/);
    expect(storeState.mcpServer.apiKey).toBe(generatedKey);
  });

  it("auto-generates a bearer token on first start and keeps it across stop/start", async () => {
    const { window } = createMockWindow();

    expect(service.getStatus().apiKey).toBe("");

    await service.start(window);
    const generatedKey = service.getStatus().apiKey;
    expect(generatedKey).toMatch(/^daintree_[a-f0-9]+$/);

    await service.stop();

    await service.start(window);
    expect(service.getStatus().apiKey).toBe(generatedKey);
  });

  it("recovers the api key from electron-store when a fresh service instance starts", async () => {
    const seededKey = "daintree_seeded12345";
    storeState.mcpServer.apiKey = seededKey;

    const fresh = new McpServerService();
    currentService = fresh;
    const { window } = createMockWindow();
    await fresh.start(window);

    expect(fresh.getStatus().apiKey).toBe(seededKey);
    await fresh.stop();
  });

  it("rejects requests with a non-loopback Origin header", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const evil = await requestSse(service.currentPort!, {
      Authorization: `Bearer ${service.getStatus().apiKey}`,
      Origin: "https://evil.example",
    });
    expect(evil.status).toBe(403);
    expect(evil.body).toBe("Forbidden");
  });

  it("accepts absent and loopback Origin headers on the SSE GET", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const auth = `Bearer ${service.getStatus().apiKey}`;

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

  it("invalidates the old bearer immediately after rotation", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const oldKey = service.getStatus().apiKey;
    const newKey = await service.rotateApiKey();
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

  it("rolls back to the old key when rotation's store persist fails", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const oldKey = service.getStatus().apiKey;
    expect(oldKey).toMatch(/^daintree_[a-f0-9]+$/);

    // Force the next mcpServer store write to throw so we exercise
    // rotateApiKey's rollback path. Rotation must not leak the half-applied
    // new key — getStatus and the live HTTP server must still answer with
    // the old bearer.
    storeMocks.set.mockImplementationOnce((key: string) => {
      if (key === "mcpServer") throw new Error("store write failed");
    });

    await expect(service.rotateApiKey()).rejects.toThrow("store write failed");

    expect(service.getStatus().apiKey).toBe(oldKey);
    const port = service.currentPort!;
    const oldStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/sse",
          method: "GET",
          headers: { Authorization: `Bearer ${oldKey}` },
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
    expect(oldStatus).toBe(200);
  });

  it("collapses concurrent rotateApiKey calls into a single in-flight rotation", async () => {
    const { window } = createMockWindow();
    await service.start(window);
    const oldKey = service.getStatus().apiKey;

    const [a, b] = await Promise.all([service.rotateApiKey(), service.rotateApiKey()]);

    // Both callers see the same new key, neither receives a stale value.
    expect(a).toBe(b);
    expect(a).not.toBe(oldKey);
    expect(service.getStatus().apiKey).toBe(a);
    expect(storeState.mcpServer.apiKey).toBe(a);
  });

  it("rejects POST /messages with a non-loopback Origin header", async () => {
    const { window } = createMockWindow();
    await service.start(window);

    const port = service.currentPort!;
    const auth = `Bearer ${service.getStatus().apiKey}`;

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

  it("authorizes requests carrying a valid help-session bearer token alongside the external key", async () => {
    storeState.mcpServer.apiKey = "external-secret";
    const { window } = createMockWindow();
    await service.start(window);

    service.setHelpTokenValidator((token) => (token === "help-token" ? "action" : false));

    const externalStatus = await requestSseStatus(service.currentPort!, {
      Authorization: "Bearer external-secret",
    });
    expect(externalStatus).not.toBe(401);

    const helpStatus = await requestSseStatus(service.currentPort!, {
      Authorization: "Bearer help-token",
    });
    expect(helpStatus).not.toBe(401);

    const denied = await requestSse(service.currentPort!, {
      Authorization: "Bearer wrong-token",
    });
    expect(denied.status).toBe(401);
  });

  it("rejects help-session tokens once the validator says they are revoked", async () => {
    storeState.mcpServer.apiKey = "external-secret";
    const { window } = createMockWindow();
    await service.start(window);

    let isLive = true;
    service.setHelpTokenValidator((token) =>
      token === "rotating-token" && isLive ? "action" : false
    );

    const before = await requestSseStatus(service.currentPort!, {
      Authorization: "Bearer rotating-token",
    });
    expect(before).not.toBe(401);

    isLive = false;

    const after = await requestSse(service.currentPort!, {
      Authorization: "Bearer rotating-token",
    });
    expect(after.status).toBe(401);
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

  it("dispatches fullToolSurface external tools that are outside the curated allowlist", async () => {
    storeState.mcpServer.fullToolSurface = true;
    const dispatchMock = vi.fn(
      (payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: { dispatched: payload.actionId },
      })
    );
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "panel.gridLayout.setStrategy" as ActionId,
          title: "Set grid layout",
          description: "Power-user UI plumbing",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

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

  it("denies non-allowlisted actions for the external tier (dispatch never reached)", async () => {
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

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
    expect(result.content[0].text).toContain("panel.gridLayout.setStrategy");
    expect(result.content[0].text).toContain("external");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  describe("tier authorization", () => {
    type AuditRecord = {
      id: string;
      timestamp: number;
      toolId: string;
      sessionId: string;
      tier: string;
      argsSummary: string;
      result: "success" | "error" | "confirmation-pending" | "unauthorized";
      errorCode?: string;
      durationMs: number;
      confirmationDecision?: "approved" | "rejected" | "timeout";
    };

    function getAuditRecords(svc: McpServerService): AuditRecord[] {
      return (svc as unknown as { getAuditRecords: () => AuditRecord[] }).getAuditRecords();
    }

    async function connectWorkbench(
      port: number
    ): Promise<{ client: Client; transport: SSEClientTransport; token: string }> {
      const token = `pane-token-${Math.random().toString(36).slice(2)}`;
      paneTokenTiers.set(token, "workbench");
      const client = new Client({ name: "mcp-pane-client", version: "1.0.0" });
      const headers = { Authorization: `Bearer ${token}` };
      const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
        eventSourceInit: { headers } as never,
        requestInit: { headers },
      });
      await client.connect(transport);
      return { client, transport, token };
    }

    function manifestForAllAllowlistedTools(): ActionManifestEntry[] {
      const ids = [
        "actions.list",
        "worktree.list",
        "worktree.createWithRecipe",
        "worktree.delete",
        "terminal.list",
        "terminal.inject",
        "terminal.sendCommand",
        "recipe.run",
        "git.commit",
      ];
      return ids.map((id) =>
        createManifestEntry({
          id: id as ActionId,
          title: id,
          description: id,
        })
      );
    }

    it("workbench tier: allows queries, denies mutations, and never reaches dispatch on denial", async () => {
      const dispatchMock = vi.fn(
        (payload: DispatchRequest): ActionDispatchResult => ({
          ok: true,
          result: { dispatched: payload.actionId },
        })
      );
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectWorkbench(service.currentPort!);
      transports.push(transport);

      // Query allowed
      const allowed = getTextResult(await client.callTool({ name: "actions.list", arguments: {} }));
      expect(allowed.isError).not.toBe(true);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "actions.list" })
      );
      dispatchMock.mockClear();

      // Mutation denied — workbench cannot create worktrees
      const denied = getTextResult(
        await client.callTool({
          name: "worktree.createWithRecipe",
          arguments: { branchName: "x" },
        })
      );
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain("TIER_NOT_PERMITTED");
      expect(denied.content[0].text).toContain("workbench");
      expect(dispatchMock).not.toHaveBeenCalled();

      // Destructive denied
      const destructiveDenied = getTextResult(
        await client.callTool({ name: "terminal.sendCommand", arguments: { id: "t", text: "x" } })
      );
      expect(destructiveDenied.isError).toBe(true);
      expect(destructiveDenied.content[0].text).toContain("TIER_NOT_PERMITTED");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("workbench tier: listTools advertises only the workbench surface", async () => {
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
      });

      await service.start(window);
      const { client, transport } = await connectWorkbench(service.currentPort!);
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((t) => t.name);
      expect(ids).toContain("actions.list");
      expect(ids).toContain("worktree.list");
      expect(ids).toContain("terminal.list");
      // Mutations and destructive operations are absent.
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("worktree.createWithRecipe");
      expect(ids).not.toContain("worktree.delete");
      expect(ids).not.toContain("terminal.inject");
      expect(ids).not.toContain("terminal.sendCommand");
      expect(ids).not.toContain("recipe.run");
      expect(ids).not.toContain("git.commit");
    });

    it("external tier: backward compatibility for the apiKey-authenticated server", async () => {
      const dispatchMock = vi.fn(
        (payload: DispatchRequest): ActionDispatchResult => ({
          ok: true,
          result: { dispatched: payload.actionId },
        })
      );
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      // External tier inherits the legacy MCP_TOOL_ALLOWLIST — destructive
      // actions in that list (e.g. terminal.sendCommand, worktree.delete)
      // remain callable so existing user-facing clients keep working.
      const ids = (await client.listTools()).tools.map((t) => t.name);
      expect(ids).toContain("worktree.createWithRecipe");
      expect(ids).not.toContain("worktree.create");

      const result = getTextResult(
        await client.callTool({
          name: "terminal.sendCommand",
          arguments: { id: "t", text: "ls" },
        })
      );
      expect(result.isError).not.toBe(true);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "terminal.sendCommand" })
      );
    });

    it("audit records carry the resolved tier and unauthorized denials are classified", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({ ok: true, result: { ok: true } }));
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectWorkbench(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "actions.list", arguments: {} });
      await client.callTool({ name: "worktree.delete", arguments: { id: "wt" } });

      const records = getAuditRecords(service);
      // newest first: worktree.delete (denied), then actions.list (allowed)
      expect(records).toHaveLength(2);
      const denied = records.find((r) => r.toolId === "worktree.delete");
      const allowed = records.find((r) => r.toolId === "actions.list");
      expect(denied?.tier).toBe("workbench");
      expect(denied?.result).toBe("unauthorized");
      expect(denied?.errorCode).toBe("TIER_NOT_PERMITTED");
      expect(allowed?.tier).toBe("workbench");
      expect(allowed?.result).toBe("success");
    });

    it("fullToolSurface widens external tier only — workbench remains tightly scoped", async () => {
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
            description: "UI plumbing",
          }),
        ],
      });

      await service.start(window);
      const { client, transport } = await connectWorkbench(service.currentPort!);
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((t) => t.name);
      expect(ids).toContain("actions.list");
      // panel.gridLayout.setStrategy is NOT in the workbench allowlist —
      // fullToolSurface must not widen anything for non-external tiers.
      expect(ids).not.toContain("panel.gridLayout.setStrategy");
    });

    it("Streamable HTTP transport stamps the resolved tier on the session", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({ ok: true, result: { ok: true } }));
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectHttpClient(service.currentPort!);
      httpTransports.push(transport);

      await client.callTool({ name: "actions.list", arguments: {} });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      // connectHttpClient sends the global apiKey header → external tier.
      expect(records[0].tier).toBe("external");
      expect(records[0].result).toBe("success");
    });

    it("Streamable HTTP transport with a pane token stamps workbench tier and gates dispatch", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({ ok: true, result: { ok: true } }));
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);

      const token = `pane-token-${Math.random().toString(36).slice(2)}`;
      paneTokenTiers.set(token, "workbench");
      const client = new Client({ name: "mcp-pane-http-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${service.currentPort}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
      );
      await client.connect(transport);
      httpTransports.push(transport);

      // Query allowed
      const allowed = getTextResult(await client.callTool({ name: "actions.list", arguments: {} }));
      expect(allowed.isError).not.toBe(true);

      // Destructive denied at dispatch time
      const denied = getTextResult(
        await client.callTool({ name: "worktree.delete", arguments: { id: "x" } })
      );
      expect(denied.isError).toBe(true);
      expect(denied.content[0].text).toContain("TIER_NOT_PERMITTED");
      expect(denied.content[0].text).toContain("workbench");

      const records = getAuditRecords(service);
      const denyRecord = records.find((r) => r.toolId === "worktree.delete");
      const allowRecord = records.find((r) => r.toolId === "actions.list");
      expect(denyRecord?.tier).toBe("workbench");
      expect(denyRecord?.result).toBe("unauthorized");
      expect(allowRecord?.tier).toBe("workbench");
    });
  });

  describe("per-pane MCP tier", () => {
    const tierManifest = () => [
      createManifestEntry({
        id: "actions.list" as ActionId,
        title: "List Actions",
        description: "Read the action registry",
        kind: "query",
      }),
      createManifestEntry({
        id: "worktree.list" as ActionId,
        title: "List Worktrees",
        description: "Read worktree state",
        kind: "query",
      }),
      createManifestEntry({
        id: "worktree.create" as ActionId,
        title: "Create Worktree",
        description: "Create a new worktree",
      }),
      createManifestEntry({
        id: "worktree.createWithRecipe" as ActionId,
        title: "Create Worktree with Recipe",
        description: "Create worktree, optionally check out a PR, optionally run a recipe",
      }),
      // System-only tools — irreversible or externally-visible mutations.
      createManifestEntry({
        id: "git.commit" as ActionId,
        title: "Commit",
        description: "Create a git commit",
      }),
      createManifestEntry({
        id: "git.push" as ActionId,
        title: "Push",
        description: "Push commits to a remote",
      }),
      createManifestEntry({
        id: "worktree.delete" as ActionId,
        title: "Delete Worktree",
        description: "Permanently remove a worktree",
      }),
      createManifestEntry({
        id: "terminal.sendCommand" as ActionId,
        title: "Send Terminal Command",
        description: "Run an arbitrary command in a terminal",
      }),
      createManifestEntry({
        id: "terminal.close" as ActionId,
        title: "Close Terminal",
        description: "Move a terminal to trash",
      }),
      createManifestEntry({
        id: "terminal.kill" as ActionId,
        title: "Kill Terminal",
        description: "Permanently remove a terminal",
      }),
      createManifestEntry({
        id: "agent.terminal" as ActionId,
        title: "Agent Terminal",
        description: "Drive a running agent",
      }),
      createManifestEntry({
        id: "agent.launch" as ActionId,
        title: "Launch Agent",
        description: "Spawn a registered agent CLI",
      }),
      createManifestEntry({
        id: "workflow.startWorkOnIssue" as ActionId,
        title: "Start Work on Issue",
        description: "Macro: fetch issue, create worktree, launch agent, inject context",
      }),
      createManifestEntry({
        id: "workflow.prepBranchForReview" as ActionId,
        title: "Prep Branch for Review",
        description: "Macro: inspect staging status and detected runners",
        kind: "query",
      }),
      // Renderer-only primitives included in the manifest so the
      // NEVER_EXPOSED_VIA_MCP absence loops below catch regressions: a
      // re-add to any tier's allowlist would surface here as a listTools
      // hit. Without these manifest entries the absence checks are vacuous.
      createManifestEntry({
        id: "terminal.bulkCommand" as ActionId,
        title: "Broadcast to Terminals",
        description: "Send a command to multiple terminals at once",
      }),
      createManifestEntry({
        id: "agent.focusNextWaiting" as ActionId,
        title: "Focus Next Waiting Agent",
        description: "Focus the next agent awaiting input",
      }),
      createManifestEntry({
        id: "agent.focusNextWorking" as ActionId,
        title: "Focus Next Working Agent",
        description: "Focus the next active agent",
      }),
      createManifestEntry({
        id: "workflow.focusNextAttention" as ActionId,
        title: "Focus Next Attention",
        description: "Focus next waiting/working agent with priority",
      }),
    ];

    // Spawning terminals/agents, driving them via sent commands, and trashing
    // terminals are intentionally action-tier — see ACTION_TIER_ADDONS in
    // McpServerService. System tier is reserved for destructive or
    // externally-visible ops, including permanent terminal kills.
    const ACTION_TIER_TOOLS = [
      "terminal.sendCommand",
      "terminal.close",
      "agent.terminal",
      "agent.launch",
      "workflow.startWorkOnIssue",
    ] as const;

    const WORKBENCH_TIER_TOOLS = ["workflow.prepBranchForReview"] as const;

    const SYSTEM_ONLY_TOOLS = [
      "git.commit",
      "git.push",
      "worktree.delete",
      "terminal.kill",
    ] as const;

    // Fleet-broadcast and focus-shift primitives are renderer-only — they
    // remain available via keybindings, palette, and menus, but are NOT
    // exposed through the MCP control plane on any tier.
    const NEVER_EXPOSED_VIA_MCP = [
      "terminal.bulkCommand",
      "agent.focusNextWaiting",
      "agent.focusNextWorking",
      "workflow.focusNextAttention",
    ] as const;

    it("workbench tier exposes only read-only introspection tools", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wb",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("actions.list");
      expect(ids).toContain("worktree.list");
      for (const id of WORKBENCH_TIER_TOOLS) {
        expect(ids).toContain(id);
      }
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("git.commit");
      expect(ids).not.toContain("workflow.startWorkOnIssue");
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("action tier adds non-destructive mutations and terminal/agent spawning, but excludes irreversible ones", async () => {
      paneTokenTiers.set("token-action", "action");
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-action",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("worktree.list");
      expect(ids).not.toContain("worktree.create");
      expect(ids).toContain("worktree.createWithRecipe");
      for (const id of ACTION_TIER_TOOLS) {
        expect(ids).toContain(id);
      }
      for (const id of SYSTEM_ONLY_TOOLS) {
        expect(ids).not.toContain(id);
      }
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("system tier exposes the full curated allowlist including irreversible mutations", async () => {
      paneTokenTiers.set("token-sys", "system");
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-sys",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("worktree.list");
      expect(ids).not.toContain("worktree.create");
      expect(ids).toContain("worktree.createWithRecipe");
      for (const id of ACTION_TIER_TOOLS) {
        expect(ids).toContain(id);
      }
      for (const id of SYSTEM_ONLY_TOOLS) {
        expect(ids).toContain(id);
      }
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("rejects callTool for actions outside the session tier with TIER_NOT_PERMITTED", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({ ok: true, result: "should-not-run" })
      );
      const { window } = createMockWindow({
        getManifest: tierManifest,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wb",
      });
      transports.push(transport);

      const denied = (await client.callTool({
        name: "git.commit",
        arguments: { message: "x" },
      })) as TextToolResult;
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain("TIER_NOT_PERMITTED");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("filters listTools and rejects callTool over the Streamable HTTP transport", async () => {
      paneTokenTiers.set("token-wb-http", "workbench");
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({ ok: true, result: "should-not-run" })
      );
      const { window } = createMockWindow({
        getManifest: tierManifest,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectHttpClient(service.currentPort!, {
        Authorization: "Bearer token-wb-http",
      });
      httpTransports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("worktree.list");
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("git.commit");

      const denied = (await client.callTool({
        name: "worktree.create",
        arguments: {},
      })) as TextToolResult;
      expect(denied.isError).toBe(true);
      expect(denied.content[0]?.text).toContain("TIER_NOT_PERMITTED");
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("external tier (apiKey) excludes fleet-broadcast and focus-shift tools from listTools", async () => {
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      // connectClient sends the global apiKey by default → external tier.
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("rejects callTool for fleet-broadcast and focus-shift tools across every tier with TIER_NOT_PERMITTED", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      paneTokenTiers.set("token-action", "action");
      paneTokenTiers.set("token-sys", "system");
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({ ok: true, result: "should-not-run" })
      );
      const { window } = createMockWindow({
        getManifest: tierManifest,
        dispatchAction: dispatchMock,
      });

      await service.start(window);

      const tierTokens: Array<[string, string]> = [
        ["workbench", "token-wb"],
        ["action", "token-action"],
        ["system", "token-sys"],
        ["external", ""],
      ];

      for (const [tier, token] of tierTokens) {
        const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
        const { client, transport } = await connectClient(service.currentPort!, headers);
        transports.push(transport);

        for (const id of NEVER_EXPOSED_VIA_MCP) {
          const denied = (await client.callTool({
            name: id,
            arguments: {},
          })) as TextToolResult;
          expect(denied.isError, `${tier} should deny ${id}`).toBe(true);
          expect(denied.content[0]?.text).toContain("TIER_NOT_PERMITTED");
        }
      }

      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("tier filtering takes precedence over fullToolSurface for pane-scoped sessions", async () => {
      storeState.mcpServer.fullToolSurface = true;
      paneTokenTiers.set("token-wb", "workbench");
      const { window } = createMockWindow({
        getManifest: () => [
          ...tierManifest(),
          createManifestEntry({
            id: "panel.gridLayout.setStrategy" as ActionId,
            title: "Set grid layout",
            description: "Power-user UI plumbing",
          }),
        ],
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wb",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("worktree.list");
      // workbench excludes these even with fullToolSurface enabled.
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("git.commit");
      expect(ids).not.toContain("panel.gridLayout.setStrategy");
    });
  });

  describe("audit log", () => {
    type AuditRecord = {
      id: string;
      timestamp: number;
      toolId: string;
      sessionId: string;
      tier: string;
      argsSummary: string;
      result: "success" | "error" | "confirmation-pending" | "unauthorized";
      errorCode?: string;
      durationMs: number;
      confirmationDecision?: "approved" | "rejected" | "timeout";
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
      // connectClient passes the global apiKey by default, mapping to external tier.
      expect(record.tier).toBe("external");
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

    it("records confirmationDecision='approved' when the renderer signals an approved modal", async () => {
      const dispatchMock = vi.fn(() => ({
        result: { ok: true, result: { ok: true } } satisfies ActionDispatchResult,
        confirmationDecision: "approved" as const,
      }));
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.delete" as ActionId,
            title: "Delete Worktree",
            description: "Delete a worktree",
            danger: "confirm",
          }),
        ],
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("success");
      expect(records[0].confirmationDecision).toBe("approved");
      expect(records[0].errorCode).toBeUndefined();
    });

    it("records confirmationDecision='rejected' when dispatch returns USER_REJECTED", async () => {
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({
          ok: false,
          error: { code: "USER_REJECTED", message: "User rejected the confirmation request." },
        })
      );
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.delete" as ActionId,
            title: "Delete Worktree",
            description: "Delete a worktree",
            danger: "confirm",
          }),
        ],
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("error");
      expect(records[0].errorCode).toBe("USER_REJECTED");
      expect(records[0].confirmationDecision).toBe("rejected");
    });

    it("records confirmationDecision='timeout' when dispatch returns CONFIRMATION_TIMEOUT", async () => {
      const dispatchMock = vi.fn(
        (): ActionDispatchResult => ({
          ok: false,
          error: {
            code: "CONFIRMATION_TIMEOUT",
            message: "Confirmation request timed out before the user responded.",
          },
        })
      );
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.delete" as ActionId,
            title: "Delete Worktree",
            description: "Delete a worktree",
            danger: "confirm",
          }),
        ],
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.callTool({ name: "worktree.delete", arguments: { worktreeId: "wt-1" } });

      const records = getAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("error");
      expect(records[0].errorCode).toBe("CONFIRMATION_TIMEOUT");
      expect(records[0].confirmationDecision).toBe("timeout");
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

      // Mutate config — historically this clobbered auditLog because the
      // setter wrote back the spread of getConfig() without the in-memory log.
      service.setAuditMaxRecords(750);

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
        Authorization: `Bearer ${service.getStatus().apiKey}`,
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
            headers: { Authorization: `Bearer ${service.getStatus().apiKey}` },
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
      Authorization: `Bearer ${service.getStatus().apiKey}`,
    });
  });

  describe("outputSchema and structuredContent", () => {
    const objectSchema = {
      type: "object",
      properties: {
        count: { type: "number" },
        label: { type: "string" },
      },
      required: ["count", "label"],
    };

    const primitiveSchema = {
      type: "string",
    };

    it("advertises outputSchema in listTools for actions with an object resultSchema", async () => {
      storeState.mcpServer.fullToolSurface = true;
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "log.getEntries" as ActionId,
            title: "Get Log Entries",
            description: "Returns log entries",
            kind: "query",
            outputSchema: objectSchema,
          }),
          createManifestEntry({
            id: "worktree.create" as ActionId,
            title: "Create Worktree",
            description: "Create a worktree",
            kind: "command",
            outputSchema: primitiveSchema,
          }),
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
            kind: "query",
          }),
        ],
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.listTools();
      const objectTool = result.tools.find((t) => t.name === "log.getEntries");
      const primitiveTool = result.tools.find((t) => t.name === "worktree.create");
      const noSchemaTool = result.tools.find((t) => t.name === "actions.list");

      expect(objectTool).toBeDefined();
      expect(primitiveTool).toBeDefined();
      expect(noSchemaTool).toBeDefined();
      expect(objectTool?.outputSchema).toEqual(objectSchema);
      expect(primitiveTool?.outputSchema).toBeUndefined();
      expect(noSchemaTool?.outputSchema).toBeUndefined();
    });

    it("emits structuredContent on callTool when the action has an object outputSchema and an object result", async () => {
      storeState.mcpServer.fullToolSurface = true;
      const objectResult = { count: 7, label: "ok" };
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "log.getEntries" as ActionId,
            title: "Get Log Entries",
            description: "Returns log entries",
            kind: "query",
            outputSchema: objectSchema,
          }),
        ],
        dispatchAction: () => ({ ok: true, result: objectResult }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.listTools();
      const result = (await client.callTool({
        name: "log.getEntries",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toEqual(objectResult);
      expect(result.content[0]?.type).toBe("text");
      expect(JSON.parse(result.content[0]!.text)).toEqual(objectResult);
    });

    it("omits structuredContent when the action has a primitive resultSchema", async () => {
      storeState.mcpServer.fullToolSurface = true;
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.create" as ActionId,
            title: "Create Worktree",
            description: "Create a worktree",
            kind: "command",
            outputSchema: primitiveSchema,
          }),
        ],
        dispatchAction: () => ({ ok: true, result: "wt-123" }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.listTools();
      const result = (await client.callTool({
        name: "worktree.create",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).toContain("wt-123");
    });

    it("omits structuredContent when the action has no resultSchema", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
            kind: "query",
          }),
        ],
        dispatchAction: () => ({ ok: true, result: { foo: "bar" } }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.listTools();
      const result = (await client.callTool({
        name: "actions.list",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).toContain('"foo": "bar"');
    });

    it("does not emit structuredContent when callTool runs without a prior listTools (cache cold)", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "actions.list" as ActionId,
            title: "List Actions",
            description: "Read the action registry",
            kind: "query",
            outputSchema: objectSchema,
          }),
        ],
        dispatchAction: () => ({ ok: true, result: { count: 1, label: "cold" } }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = (await client.callTool({
        name: "actions.list",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).toContain('"label": "cold"');
    });

    it("does not emit structuredContent on failed tool calls", async () => {
      storeState.mcpServer.fullToolSurface = true;
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "log.getEntries" as ActionId,
            title: "Get Log Entries",
            description: "Returns log entries",
            kind: "query",
            outputSchema: objectSchema,
          }),
        ],
        dispatchAction: () => ({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "boom" },
        }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.listTools();
      const result = (await client.callTool({
        name: "log.getEntries",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0]?.text).toContain("boom");
    });
  });

  describe("prompts", () => {
    it("advertises the prompts capability and lists the starter prompts with argument metadata", async () => {
      const { window } = createMockWindow();
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      expect(client.getServerCapabilities()?.prompts).toBeDefined();

      const result = await client.listPrompts();
      const startIssue = result.prompts.find((p) => p.name === "start_issue");
      const triage = result.prompts.find((p) => p.name === "triage_failed_agent");

      expect(startIssue).toBeDefined();
      expect(startIssue?.description).toContain("issue");
      expect(startIssue?.arguments).toEqual([
        expect.objectContaining({ name: "issue_number", required: true }),
      ]);

      expect(triage).toBeDefined();
      expect(triage?.arguments).toEqual([
        expect.objectContaining({ name: "terminal_id", required: false }),
      ]);
    });

    it("renders start_issue with the issue number and live worktree context", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return {
              ok: true,
              result: {
                id: "wt-1",
                path: "/Users/test/proj/feature-foo",
                branch: "feature/foo",
                isMain: false,
                issueNumber: 42,
              },
            };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "start_issue",
        arguments: { issue_number: "6610" },
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      const content = result.messages[0].content;
      expect(content.type).toBe("text");
      const text = (content as { type: "text"; text: string }).text;
      expect(text).toContain("6610");
      expect(text).toContain("/Users/test/proj/feature-foo");
      expect(text).toContain("feature/foo");
    });

    it("renders triage_failed_agent without arguments and falls back to placeholder copy", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return {
              ok: true,
              result: {
                id: "wt-1",
                path: "/wt",
                branch: "develop",
                isMain: true,
              },
            };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({ name: "triage_failed_agent" });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      expect(text).toContain("/wt");
      expect(text).toContain("terminal.list");
    });

    it("renders triage_failed_agent with terminal output when terminal_id is supplied", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return {
              ok: true,
              result: { id: "wt-1", path: "/wt", branch: "feat/x", isMain: false },
            };
          }
          if (payload.actionId === "terminal.getOutput") {
            return {
              ok: true,
              result: {
                terminalId: "term-7",
                content: "ERROR: agent crashed\nstack trace line 1",
                lineCount: 2,
                truncated: false,
              },
            };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "triage_failed_agent",
        arguments: { terminal_id: "term-7" },
      });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      expect(text).toContain("term-7");
      expect(text).toContain("ERROR: agent crashed");
      expect(text).toContain("stack trace line 1");
    });

    it("throws InvalidParams for an unknown prompt name", async () => {
      const { window } = createMockWindow();
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(client.getPrompt({ name: "no_such_prompt" })).rejects.toMatchObject({
        code: -32602,
      });
    });

    it("throws InvalidParams when a required argument is missing", async () => {
      const { window } = createMockWindow();
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(client.getPrompt({ name: "start_issue", arguments: {} })).rejects.toMatchObject({
        code: -32602,
      });
    });

    it("falls back to placeholder text when the renderer dispatch fails", async () => {
      const { window } = createMockWindow({
        dispatchAction: () => ({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "renderer is gone" },
        }),
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "start_issue",
        arguments: { issue_number: "1" },
      });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      expect(text).toContain("(no active worktree detected)");
      expect(text).toContain("(unknown branch)");
      expect(text).toContain("#1");
    });

    it("uses a fence marker that does not collide with backtick runs in terminal output", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return { ok: true, result: { id: "wt", path: "/wt", branch: "b", isMain: false } };
          }
          if (payload.actionId === "terminal.getOutput") {
            return {
              ok: true,
              result: {
                terminalId: "t",
                content: "before\n```\nadversarial markdown\n```\nafter",
                lineCount: 5,
                truncated: false,
              },
            };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "triage_failed_agent",
        arguments: { terminal_id: "t" },
      });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      // Outer fence must be 4 backticks so the embedded ``` runs can't
      // terminate it early. The exact-match toContain proves the wrapping
      // marker is wider than any backtick run inside the content.
      expect(text).toContain("````\nbefore\n```\nadversarial markdown\n```\nafter\n````");
    });

    it("distinguishes a fetched-but-empty terminal from a fetch failure", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return { ok: true, result: { id: "wt", path: "/wt", branch: "b", isMain: false } };
          }
          if (payload.actionId === "terminal.getOutput") {
            return {
              ok: true,
              result: { terminalId: "t-empty", content: "", lineCount: 0, truncated: false },
            };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "triage_failed_agent",
        arguments: { terminal_id: "t-empty" },
      });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      expect(text).toContain("fetched but is empty");
      expect(text).not.toContain("could not be fetched");
    });

    it("preserves worktree context when only terminal.getOutput fails", async () => {
      const { window } = createMockWindow({
        dispatchAction: (payload) => {
          if (payload.actionId === "worktree.getCurrent") {
            return {
              ok: true,
              result: { id: "wt", path: "/proj/wt-x", branch: "feat/x", isMain: false },
            };
          }
          if (payload.actionId === "terminal.getOutput") {
            return { ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } };
          }
          return { ok: true, result: null };
        },
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.getPrompt({
        name: "triage_failed_agent",
        arguments: { terminal_id: "t" },
      });
      const text = (result.messages[0].content as { type: "text"; text: string }).text;

      expect(text).toContain("/proj/wt-x");
      expect(text).toContain("feat/x");
      expect(text).toContain("could not be fetched");
    });

    it("rejects non-string argument values via the SDK schema validator", async () => {
      const { window } = createMockWindow();
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      // The SDK's GetPromptRequestSchema enforces Record<string, string> on
      // arguments. Numeric values are rejected (the SDK surfaces this as a
      // request-level error) before our handler runs — the surface signal
      // for client authors that the MCP spec requires string-valued prompt
      // arguments.
      await expect(
        client.getPrompt({
          name: "start_issue",
          arguments: { issue_number: 6610 as unknown as string },
        })
      ).rejects.toThrow();
    });
  });

  describe("resources", () => {
    function manifestForResources(): ActionManifestEntry[] {
      return [
        createManifestEntry({
          id: "github.listIssues" as ActionId,
          title: "List Issues",
          description: "List GitHub issues",
          kind: "query",
        }),
        createManifestEntry({
          id: "git.getProjectPulse" as ActionId,
          title: "Project pulse",
          description: "Worktree pulse",
          kind: "query",
        }),
        createManifestEntry({
          id: "terminal.getOutput" as ActionId,
          title: "Terminal output",
          description: "Read terminal output",
          kind: "query",
        }),
        createManifestEntry({
          id: "terminal.list" as ActionId,
          title: "List terminals",
          description: "List terminals",
          kind: "query",
        }),
        createManifestEntry({
          id: "worktree.list" as ActionId,
          title: "List worktrees",
          description: "List worktrees",
          kind: "query",
        }),
      ];
    }

    it("advertises the resources capability with subscribe enabled", async () => {
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const caps = client.getServerCapabilities();
      expect(caps?.resources).toBeDefined();
      expect(caps?.resources?.subscribe).toBe(true);
    });

    it("listResources includes the static issues URI plus enumerated worktrees and terminals", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "worktree.list") {
          return {
            ok: true,
            result: [
              { id: "wt-1", branch: "feature/foo" },
              { id: "wt-2", branch: "develop" },
            ],
          };
        }
        if (payload.actionId === "terminal.list") {
          return {
            ok: true,
            result: [
              { id: "term-1", title: "agent: claude", agentId: "agent-claude-1" },
              { id: "term-2", title: "shell", agentId: null },
            ],
          };
        }
        return { ok: true, result: null };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain("daintree://project/current/issues");
      expect(uris).toContain("daintree://worktree/wt-1/pulse");
      expect(uris).toContain("daintree://worktree/wt-2/pulse");
      expect(uris).toContain("daintree://terminal/term-1/scrollback");
      expect(uris).toContain("daintree://terminal/term-2/scrollback");
      // Agent URI uses the launch agentId, not the panel id, and excludes
      // terminals without an agent (plain shells).
      expect(uris).toContain("daintree://agent/agent-claude-1/state");
      expect(uris).not.toContain("daintree://agent/term-1/state");
      expect(uris).not.toContain("daintree://agent/term-2/state");
    });

    it("listResources still returns the static issues URI when enumeration fails", async () => {
      const dispatchMock = vi.fn(
        (_payload: DispatchRequest): ActionDispatchResult => ({
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "no view" },
        })
      );
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toEqual(["daintree://project/current/issues"]);
    });

    it("listResourceTemplates returns the four template patterns", async () => {
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.listResourceTemplates();
      const patterns = result.resourceTemplates.map((t) => t.uriTemplate);
      expect(patterns).toContain("daintree://worktree/{id}/pulse");
      expect(patterns).toContain("daintree://terminal/{id}/scrollback");
      expect(patterns).toContain("daintree://agent/{id}/state");
    });

    it("readResource for project issues dispatches github.listIssues", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "github.listIssues") {
          return { ok: true, result: [{ number: 1, title: "Hello" }] };
        }
        return { ok: true, result: [] };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({ uri: "daintree://project/current/issues" });
      expect(result.contents).toHaveLength(1);
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.uri).toBe("daintree://project/current/issues");
      expect(content.mimeType).toBe("application/json");
      expect(JSON.parse(content.text)).toEqual([{ number: 1, title: "Hello" }]);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "github.listIssues" })
      );
    });

    it("readResource for worktree pulse passes the worktreeId", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "git.getProjectPulse") {
          return { ok: true, result: { worktreeId: payload.args, summary: "clean" } };
        }
        return { ok: true, result: [] };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.readResource({ uri: "daintree://worktree/wt-42/pulse" });
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "git.getProjectPulse",
          args: { worktreeId: "wt-42", rangeDays: 60 },
        })
      );
    });

    it("readResource for terminal scrollback returns text/plain output", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "terminal.getOutput") {
          return { ok: true, result: "line one\nline two\n" };
        }
        return { ok: true, result: [] };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({
        uri: "daintree://terminal/t-1/scrollback",
      });
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.mimeType).toBe("text/plain");
      expect(content.text).toBe("line one\nline two\n");
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "terminal.getOutput",
          args: { terminalId: "t-1", maxLines: 200, stripAnsi: true },
        })
      );
    });

    it("readResource for agent state reads the AgentAvailabilityStore directly", async () => {
      const { events } = await import("../events.js");
      const { getAgentAvailabilityStore } = await import("../AgentAvailabilityStore.js");
      // Force singleton construction so its event listeners are wired before we emit.
      getAgentAvailabilityStore();
      events.emit("agent:state-changed", {
        agentId: "agent-xyz",
        state: "working",
        previousState: "idle",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({ uri: "daintree://agent/agent-xyz/state" });
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.mimeType).toBe("application/json");
      expect(JSON.parse(content.text)).toEqual({ agentId: "agent-xyz", state: "working" });

      const missing = await client.readResource({ uri: "daintree://agent/agent-missing/state" });
      const missingContent = missing.contents[0] as {
        uri: string;
        mimeType: string;
        text: string;
      };
      expect(JSON.parse(missingContent.text)).toEqual({ agentId: "agent-missing", state: null });
    });

    it("readResource on an unknown URI rejects as InvalidRequest", async () => {
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(client.readResource({ uri: "daintree://something/else" })).rejects.toThrow(
        /Unknown resource URI/
      );
    });

    it("readResource on a malformed percent-encoded URI rejects cleanly", async () => {
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(
        client.readResource({ uri: "daintree://terminal/%E0%A4%A/scrollback" })
      ).rejects.toThrow(/Unknown resource URI/);
    });

    it("listResources returns terminals when worktree.list fails partially", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "worktree.list") {
          return { ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } };
        }
        if (payload.actionId === "terminal.list") {
          return {
            ok: true,
            result: [{ id: "term-A", title: "agent", agentId: "agent-A" }],
          };
        }
        return { ok: true, result: null };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain("daintree://project/current/issues");
      expect(uris).toContain("daintree://terminal/term-A/scrollback");
      expect(uris).toContain("daintree://agent/agent-A/state");
      expect(uris.some((u) => u.startsWith("daintree://worktree/"))).toBe(false);
    });

    it("truncates oversized scrollback payloads with a marker", async () => {
      const huge = "x".repeat(60 * 1024);
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "terminal.getOutput") return { ok: true, result: huge };
        return { ok: true, result: [] };
      });
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({ uri: "daintree://terminal/t-1/scrollback" });
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.text.endsWith("\n\n[truncated]")).toBe(true);
      expect(content.text.length).toBeLessThan(huge.length);
    });

    it("workbench tier sees resources and is permitted to read them", async () => {
      const dispatchMock = vi.fn(
        (_payload: DispatchRequest): ActionDispatchResult => ({ ok: true, result: [] })
      );
      const { window } = createMockWindow({
        getManifest: manifestForResources,
        dispatchAction: dispatchMock,
      });
      await service.start(window);

      const token = `pane-token-${Math.random().toString(36).slice(2)}`;
      paneTokenTiers.set(token, "workbench");
      const client = new Client({ name: "mcp-pane-client", version: "1.0.0" });
      const headers = { Authorization: `Bearer ${token}` };
      const transport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${service.currentPort}/sse`),
        {
          eventSourceInit: { headers } as never,
          requestInit: { headers },
        }
      );
      await client.connect(transport);
      transports.push(transport);

      const list = await client.listResources();
      const uris = list.resources.map((r) => r.uri);
      expect(uris).toContain("daintree://project/current/issues");
    });

    it("subscribes to agent state and notifies on agent:state-changed", async () => {
      const { events } = await import("../events.js");
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const updated: string[] = [];
      const { ResourceUpdatedNotificationSchema } =
        await import("@modelcontextprotocol/sdk/types.js");
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        updated.push(notification.params.uri);
      });

      await client.subscribeResource({ uri: "daintree://agent/agent-7/state" });

      events.emit("agent:state-changed", {
        agentId: "agent-7",
        state: "working",
        previousState: "idle",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });
      events.emit("agent:state-changed", {
        agentId: "different-agent",
        state: "working",
        previousState: "idle",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(updated).toEqual(["daintree://agent/agent-7/state"]);
    });

    it("unsubscribe stops further notifications and clears the per-session entry", async () => {
      const { events } = await import("../events.js");
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const updated: string[] = [];
      const { ResourceUpdatedNotificationSchema } =
        await import("@modelcontextprotocol/sdk/types.js");
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        updated.push(notification.params.uri);
      });

      await client.subscribeResource({ uri: "daintree://agent/agent-9/state" });
      events.emit("agent:state-changed", {
        agentId: "agent-9",
        state: "working",
        previousState: "idle",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(updated.length).toBe(1);

      await client.unsubscribeResource({ uri: "daintree://agent/agent-9/state" });
      events.emit("agent:state-changed", {
        agentId: "agent-9",
        state: "idle",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(updated.length).toBe(1);

      const subs = (
        service as unknown as { resourceSubscriptions: Map<string, Map<string, () => void>> }
      ).resourceSubscriptions;
      const allEmpty = Array.from(subs.values()).every((b) => b.size === 0);
      expect(allEmpty).toBe(true);
    });

    it("rejects subscribe for resources that do not support it", async () => {
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(
        client.subscribeResource({ uri: "daintree://terminal/t-1/scrollback" })
      ).rejects.toThrow(/Subscriptions are not supported/);
    });

    it("transport close clears all resource subscriptions for the session", async () => {
      const { events } = await import("../events.js");
      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await client.subscribeResource({ uri: "daintree://agent/agent-x/state" });
      const subs = (
        service as unknown as { resourceSubscriptions: Map<string, Map<string, () => void>> }
      ).resourceSubscriptions;
      expect(Array.from(subs.values()).some((b) => b.size > 0)).toBe(true);

      await transport.close();
      // give the close handler a tick
      await new Promise((r) => setTimeout(r, 30));

      const stillHas = Array.from(subs.values()).some((b) => b.size > 0);
      expect(stillHas).toBe(false);

      // Confirm the listener was removed by emitting an event and ensuring no errors:
      expect(() =>
        events.emit("agent:state-changed", {
          agentId: "agent-x",
          state: "idle",
          previousState: "working",
          trigger: "output",
          confidence: 1,
          timestamp: Date.now(),
        })
      ).not.toThrow();
    });
  });

  describe("terminal.waitUntilIdle native tool", () => {
    let uniqueCounter = 0;
    const nextIds = () => {
      uniqueCounter += 1;
      return {
        terminalId: `wait-term-${uniqueCounter}-${Math.random().toString(36).slice(2, 6)}`,
        agentId: `wait-agent-${uniqueCounter}-${Math.random().toString(36).slice(2, 6)}`,
      };
    };

    const seedTerminalAgent = async (
      terminalId: string,
      agentId: string,
      state: "idle" | "working" | "waiting" | "completed" | "exited" = "idle"
    ) => {
      const { events } = await import("../events.js");
      const { getAgentAvailabilityStore } = await import("../AgentAvailabilityStore.js");
      // Force singleton wiring before any emit.
      getAgentAvailabilityStore();
      events.emit("agent:spawned", {
        agentId,
        terminalId,
        timestamp: Date.now(),
      });
      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state,
        previousState: state === "working" ? "idle" : "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });
    };

    it("listTools advertises the native tool with the documented schema for the action tier", async () => {
      paneTokenTiers.set("token-wait-action", "action");
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wait-action",
      });
      transports.push(transport);

      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "terminal.waitUntilIdle");
      expect(tool).toBeDefined();
      expect(tool?.inputSchema.required).toEqual(["terminalId"]);
      expect(tool?.inputSchema.additionalProperties).toBe(false);
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.annotations?.destructiveHint).toBe(false);
    });

    it("listTools hides the native tool from the workbench tier", async () => {
      paneTokenTiers.set("token-wait-wb", "workbench");
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wait-wb",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((t) => t.name);
      expect(ids).not.toContain("terminal.waitUntilIdle");
    });

    it("returns immediately for a terminal that is already idle", async () => {
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "idle");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const startedAt = Date.now();
      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      })) as TextToolResult & { structuredContent?: Record<string, unknown> };
      const elapsed = Date.now() - startedAt;

      expect(result.isError).toBeFalsy();
      expect(elapsed).toBeLessThan(1000);
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId,
        agentId,
        busyState: "idle",
        idleReason: "idle",
        timedOut: false,
      });
      expect(result.structuredContent).toMatchObject({
        terminalId,
        busyState: "idle",
        timedOut: false,
      });
    });

    it("returns immediately as idle for a terminal with no spawned agent", async () => {
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId: "plain-shell-term" },
      })) as TextToolResult;

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId: "plain-shell-term",
        busyState: "idle",
        idleReason: "unknown",
        timedOut: false,
      });
      expect(payload.agentId).toBeUndefined();
    });

    it("blocks on a working terminal and resolves when state transitions to idle", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      }) as Promise<TextToolResult>;

      // Give the call time to register its listener.
      await new Promise((r) => setTimeout(r, 30));

      const transitionTs = Date.now();
      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state: "completed",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: transitionTs,
      });

      const result = await callPromise;
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId,
        agentId,
        busyState: "idle",
        idleReason: "completed",
        previousBusyState: "working",
        lastTransitionAt: transitionTs,
        timedOut: false,
      });
    });

    it("ignores agent:state-changed events that stay in working state", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 200 },
      }) as Promise<TextToolResult>;

      await new Promise((r) => setTimeout(r, 30));

      // working → working is a no-op for the tool — the listener must not resolve.
      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state: "working",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      const result = await callPromise;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.timedOut).toBe(true);
      expect(payload.busyState).toBe("working");
    });

    it("returns timedOut:true when the timeout elapses without a transition", async () => {
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 80 },
      })) as TextToolResult;

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId,
        agentId,
        busyState: "working",
        timedOut: true,
      });
      expect(payload.previousBusyState).toBe("working");
    });

    it("filters state-change events by the resolved agentId", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      const otherAgent = `other-${Math.random().toString(36).slice(2)}`;
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 150 },
      }) as Promise<TextToolResult>;

      await new Promise((r) => setTimeout(r, 30));

      // Unrelated agent transitions must not satisfy the wait.
      events.emit("agent:state-changed", {
        agentId: otherAgent,
        state: "idle",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      const result = await callPromise;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.timedOut).toBe(true);
      expect(payload.agentId).toBe(agentId);
    });

    it("does not resolve when another terminal sharing the same agent type transitions", async () => {
      const { events } = await import("../events.js");
      // Two Claude terminals — same `agentId` ("claude"), different terminalIds.
      // A transition for terminal B must NOT satisfy a wait on terminal A.
      const sharedAgentId = "claude";
      const terminalA = `share-A-${Math.random().toString(36).slice(2)}`;
      const terminalB = `share-B-${Math.random().toString(36).slice(2)}`;
      await seedTerminalAgent(terminalA, sharedAgentId, "working");
      // Note: emitting agent:spawned for terminalB overwrites the
      // agentToTerminal mapping for sharedAgentId; this is a known
      // AgentAvailabilityStore limitation and not something this tool can fix.
      events.emit("agent:spawned", {
        agentId: sharedAgentId,
        terminalId: terminalB,
        timestamp: Date.now(),
      });

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId: terminalA, timeoutMs: 120 },
      }) as Promise<TextToolResult>;

      await new Promise((r) => setTimeout(r, 30));

      // Terminal B finishes — must NOT resolve the wait on terminal A.
      events.emit("agent:state-changed", {
        agentId: sharedAgentId,
        terminalId: terminalB,
        state: "completed",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      const result = await callPromise;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.timedOut).toBe(true);
      expect(payload.terminalId).toBe(terminalA);
    });

    it("rejects calls with a missing or empty terminalId", async () => {
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(
        client.callTool({
          name: "terminal.waitUntilIdle",
          arguments: { terminalId: "" },
        })
      ).rejects.toThrow(/non-empty/);
    });

    it("rejects calls with an invalid timeoutMs", async () => {
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      await expect(
        client.callTool({
          name: "terminal.waitUntilIdle",
          arguments: { terminalId: "any", timeoutMs: -1 },
        })
      ).rejects.toThrow(/non-negative integer/);
    });

    it("rejects callTool from a workbench-tier session before invoking the handler", async () => {
      paneTokenTiers.set("token-wait-deny", "workbench");
      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wait-deny",
      });
      transports.push(transport);

      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId: "anything" },
      })) as TextToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("TIER_NOT_PERMITTED");
    });

    it("releases its event listener after resolving so repeated calls do not leak", async () => {
      const { events } = await import("../events.js");
      const innerBus = (events as unknown as { bus: import("node:events").EventEmitter }).bus;
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "idle");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const baseline = innerBus.listenerCount("agent:state-changed");

      for (let i = 0; i < 3; i += 1) {
        const result = (await client.callTool({
          name: "terminal.waitUntilIdle",
          arguments: { terminalId },
        })) as TextToolResult;
        expect(result.isError).toBeFalsy();
      }

      // Listener count should not grow per call — the handler must remove its
      // subscription on every exit path.
      expect(innerBus.listenerCount("agent:state-changed")).toBe(baseline);
    });
  });
});
