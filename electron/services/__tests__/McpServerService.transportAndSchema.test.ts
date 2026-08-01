import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  type ElicitResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ActionDispatchResult,
  ActionManifestEntry,
  ActionId,
  ActionKind,
  ActionDanger,
} from "../../../shared/types/actions.js";
import { CHANNELS } from "../../ipc/channels.js";

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
  // Lookup table that backs the mocked `webContents.fromId(id)` — populated by
  // `createMockWindow` so per-session pinned dispatch (#7002) can resolve a
  // specific WebContents at MCP tool-call time, the same way Electron does.
  const webContentsById = new Map<number, unknown>();

  return {
    ipcMain,
    webContentsById,
  };
});

const storeState = vi.hoisted(() => ({
  mcpServer: {
    enabled: true,
    port: 0,
    apiKey: "",
    auditEnabled: true,
    auditMaxRecords: 500,
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

const auditLogsState = vi.hoisted(() => ({
  mcpAuditLog: [] as Array<Record<string, unknown>>,
  mcpTurnOutcomeLog: [] as Array<Record<string, unknown>>,
}));

const auditLogsStoreMocks = vi.hoisted(() => ({
  get: vi.fn((key: string) => {
    if (key !== "mcpAuditLog" && key !== "mcpTurnOutcomeLog") {
      throw new Error(`Unexpected audit-logs store key: ${key}`);
    }
    return auditLogsState[key as keyof typeof auditLogsState];
  }),
  set: vi.fn((key: string, value: Array<Record<string, unknown>>) => {
    if (key !== "mcpAuditLog" && key !== "mcpTurnOutcomeLog") {
      throw new Error(`Unexpected audit-logs store key: ${key}`);
    }
    auditLogsState[key as keyof typeof auditLogsState] = value;
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
  webContents: {
    fromId: (id: number) => electronMocks.webContentsById.get(id),
  },
  BrowserWindow: class BrowserWindow {},
  app: { getVersion: () => "0.0.0-test" },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: storeMocks.get,
    set: storeMocks.set,
  },
  auditLogsStore: {
    get: auditLogsStoreMocks.get,
    set: auditLogsStoreMocks.set,
  },
}));

vi.mock("../persistence/auditRingStore.js", () => ({
  auditRingStore: {
    readAll: (ring: string) => {
      if (ring !== "mcpAuditLog" && ring !== "mcpTurnOutcomeLog") {
        throw new Error(`Unexpected audit ring: ${ring}`);
      }
      return auditLogsState[ring as keyof typeof auditLogsState];
    },
    writeAll: (ring: string, records: Array<Record<string, unknown>>) => {
      if (ring !== "mcpAuditLog" && ring !== "mcpTurnOutcomeLog") {
        throw new Error(`Unexpected audit ring: ${ring}`);
      }
      auditLogsStoreMocks.set(ring, records);
    },
  },
}));

const paneTokenTiers = vi.hoisted(() => new Map<string, "workbench" | "action" | "system">());

vi.mock("../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    isValidPaneToken: (token: string) => paneTokenTiers.has(token),
    getTierForToken: (token: string) => paneTokenTiers.get(token),
  },
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => Number.MAX_SAFE_INTEGER),
    onWake: vi.fn(() => () => {}),
  })),
}));

import { McpServerService } from "../McpServerService.js";

type DispatchRequest = {
  requestId: string;
  actionId: string;
  args?: unknown;
  confirmed?: boolean;
  callerInfo?: { token4LastChars: string; userAgent: string };
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
        if (channel === CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST) {
          queueMicrotask(() => {
            electronMocks.ipcMain.emit(
              CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE,
              { sender: { id: senderId } },
              {
                requestId: payload.requestId,
                manifest: getManifest(),
              }
            );
          });
          return;
        }

        if (channel === CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST) {
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
              CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE,
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

    getWorkspaceRefForWebContents: vi.fn(() => null),
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
    focusOrder: () => [windowContext],
    getPrimary: () => windowContext,
    getByWindowId: () => windowContext,
    getByWebContentsId: () => windowContext,
    size: 1,
  };

  // Register the project-view WebContents in the shared lookup so per-session
  // pinned dispatch (#7002) can resolve it via `webContents.fromId()`.
  electronMocks.webContentsById.set(projectViewWcId, webContents);

  return {
    window: registry as never,
    webContents,
    hostShellWebContents,
    projectViewManager,
    windowContext,
  };
}

function getServiceApiKey(): string {
  const key = currentService?.getStatus().apiKey ?? "";
  return key;
}

async function connectClient(
  port: number,
  headers?: Record<string, string>,
  options?: {
    capabilities?: ClientCapabilities;
    onElicit?: (request: { params: { message: string } }) => Promise<ElicitResult> | ElicitResult;
  }
): Promise<{ client: Client; transport: SSEClientTransport }> {
  const apiKey = getServiceApiKey();
  const mergedHeaders: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(headers ?? {}),
  };
  const hasHeaders = Object.keys(mergedHeaders).length > 0;
  const client = new Client(
    { name: "mcp-test-client", version: "1.0.0" },
    options?.capabilities ? { capabilities: options.capabilities } : undefined
  );
  if (options?.onElicit) {
    const handler = options.onElicit;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      return handler(request as { params: { message: string } });
    });
  }
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
      auditEnabled: true,
      auditMaxRecords: 500,
    };
    auditLogsState.mcpAuditLog = [];
    auditLogsState.mcpTurnOutcomeLog = [];
    storeMocks.get.mockClear();
    storeMocks.set.mockClear();
    auditLogsStoreMocks.get.mockClear();
    auditLogsStoreMocks.set.mockClear();
    paneTokenTiers.clear();
    electronMocks.ipcMain.removeAllListeners();
    electronMocks.webContentsById.clear();
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

  it("returns safe text output for circular tool results", async () => {
    const circularResult: Record<string, unknown> = { ok: true };
    circularResult.self = circularResult;

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "terminal.list" as ActionId,
          title: "List Terminals",
          description: "Read the terminal list",
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
        name: "terminal.list",
        arguments: {},
      })
    );

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, self: "[Circular]" });
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
      CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST,
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

    const httpSessions = (service as unknown as { _httpSessions: Map<string, unknown> })
      ._httpSessions;
    expect(httpSessions.size).toBe(1);
  });

  it("reuses the same Streamable HTTP session for follow-up tool calls", async () => {
    const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => ({
      ok: true,
      result: { dispatched: payload.actionId },
    }));

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

    const httpSessions = (service as unknown as { _httpSessions: Map<string, unknown> })
      ._httpSessions;
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
          _httpSessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      )._httpSessions;

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
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "terminal.getStatus" as ActionId,
            title: "Get Log Entries",
            description: "Returns log entries",
            kind: "query",
            outputSchema: objectSchema,
          }),
          createManifestEntry({
            id: "worktree.createWithRecipe" as ActionId,
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
      const objectTool = result.tools.find((t) => t.name === "terminal.getStatus");
      const primitiveTool = result.tools.find((t) => t.name === "worktree.createWithRecipe");
      const noSchemaTool = result.tools.find((t) => t.name === "actions.list");

      expect(objectTool).toBeDefined();
      expect(primitiveTool).toBeDefined();
      expect(noSchemaTool).toBeDefined();
      expect(objectTool?.outputSchema).toEqual(objectSchema);
      expect(primitiveTool?.outputSchema).toBeUndefined();
      expect(noSchemaTool?.outputSchema).toBeUndefined();
    });

    it("emits structuredContent on callTool when the action has an object outputSchema and an object result", async () => {
      const objectResult = { count: 7, label: "ok" };
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "terminal.getStatus" as ActionId,
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
        name: "terminal.getStatus",
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
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "worktree.createWithRecipe" as ActionId,
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
        name: "worktree.createWithRecipe",
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
            id: "terminal.list" as ActionId,
            title: "List Terminals",
            description: "Read the terminal list",
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
        name: "terminal.list",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toBeUndefined();
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ foo: "bar" });
    });

    it("warms the manifest cache and emits structuredContent on a cold callTool (no prior listTools)", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "terminal.list" as ActionId,
            title: "List Terminals",
            description: "Read the terminal list",
            kind: "query",
            outputSchema: objectSchema,
          }),
        ],
        dispatchAction: () => ({ ok: true, result: { count: 1, label: "cold" } }),
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      // The destructive-action gate requires the manifest, so the call
      // handler now lazy-fetches it on first use. As a side effect, the
      // structured output schema is also resolved without requiring the
      // client to call `tools/list` beforehand.
      const result = (await client.callTool({
        name: "terminal.list",
        arguments: {},
      })) as {
        content: Array<{ type: string; text: string }>;
        structuredContent?: Record<string, unknown>;
      };

      expect(result.structuredContent).toEqual({ count: 1, label: "cold" });
      expect(JSON.parse(result.content[0]!.text)).toEqual({ count: 1, label: "cold" });
    });

    it("does not emit structuredContent on failed tool calls", async () => {
      const { window } = createMockWindow({
        getManifest: () => [
          createManifestEntry({
            id: "terminal.getStatus" as ActionId,
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
        name: "terminal.getStatus",
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
});
