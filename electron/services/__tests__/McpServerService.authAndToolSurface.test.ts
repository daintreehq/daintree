import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerProjectView, unregisterProjectView } from "../../window/webContentsRegistry.js";
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
  _meta?: Record<string, unknown>;
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
  /** Workspace this window's view belongs to, for the #11536 result stamp. */
  workspaceRef?: { kind: "project" | "scratch"; workspaceId: string; workspacePath: string };
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
    getWorkspaceRefForWebContents: vi.fn((id: number) =>
      options?.workspaceRef && id === projectViewWcId ? options.workspaceRef : null
    ),
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

let currentService: McpServerService | null = null;

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
          _sessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      )._sessions;

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
          _sessions: Map<string, { transport: { close: () => Promise<void> } }>;
        }
      )._sessions;

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

  it("pins each help-session bearer to its own renderer WebContents — tool calls never cross windows (#7002)", async () => {
    // Two windows, each with a distinct project-view WebContents. Two
    // help-session bearers — one minted from each. Without per-session
    // pinning, both sessions would dispatch into whatever the shared
    // `getActiveProjectWebContents()` returns first; with the fix, each
    // session routes to the WebContents that minted it.
    const pinnedRefA = {
      kind: "project" as const,
      workspaceId: "proj-a",
      workspacePath: "/repos/a",
    };
    const pinnedRefB = {
      kind: "project" as const,
      workspaceId: "proj-b",
      workspacePath: "/repos/b",
    };
    const winA = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "terminal.list",
          title: "List Terminals",
          description: "Read the terminal list",
          kind: "query",
        }),
      ],
      dispatchAction: () => ({ ok: true, result: "from-window-A" }),
      workspaceRef: pinnedRefA,
    });
    const winB = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "terminal.list",
          title: "List Terminals",
          description: "Read the terminal list",
          kind: "query",
        }),
      ],
      dispatchAction: () => ({ ok: true, result: "from-window-B" }),
      workspaceRef: pinnedRefB,
    });

    // Indexed by id rather than always answering window A, so each pinned
    // session's stamp is resolved through its OWN window's manager.
    const pinnedContextByWcId = new Map([
      [winA.webContents.id, winA.windowContext],
      [winB.webContents.id, winB.windowContext],
    ]);
    const combinedRegistry = {
      all: () => [winA.windowContext, winB.windowContext],
      focusOrder: () => [winA.windowContext, winB.windowContext],
      getPrimary: () => winA.windowContext,
      getByWindowId: () => winA.windowContext,
      getByWebContentsId: (id: number) => pinnedContextByWcId.get(id),
      size: 2,
    } as never;

    await service.start(combinedRegistry);

    const tokenToWcId = new Map<string, number>([
      ["help-A", winA.webContents.id],
      ["help-B", winB.webContents.id],
    ]);
    service.setHelpTokenValidator((token) => (tokenToWcId.has(token) ? "action" : false));
    service.setHelpSessionWebContentsResolver((token) => tokenToWcId.get(token) ?? null);

    const a = await connectClient(service.currentPort!, { Authorization: "Bearer help-A" });
    transports.push(a.transport);
    const b = await connectClient(service.currentPort!, { Authorization: "Bearer help-B" });
    transports.push(b.transport);

    const resA = getTextResult(await a.client.callTool({ name: "terminal.list", arguments: {} }));
    const resB = getTextResult(await b.client.callTool({ name: "terminal.list", arguments: {} }));

    expect(resA.content[0].text).toBe('"from-window-A"');
    expect(resB.content[0].text).toBe('"from-window-B"');

    // Each pinned result reports its own window's workspace (#11536) — the
    // stamp is resolved from the responding sender, so it is right on the
    // pinned path too, not just the focus-following external one.
    expect(resA._meta?.["org.daintree/resolved-workspace"]).toEqual(pinnedRefA);
    expect(resB._meta?.["org.daintree/resolved-workspace"]).toEqual(pinnedRefB);

    // Both windows' WebContents.send must have been invoked — and only for
    // the dispatch belonging to that window. (Each window also receives one
    // `CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST` per session — that is fine because pinned
    // sessions explicitly bypass the shared manifest cache.)
    const sendsToA = winA.webContents.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST
    );
    const sendsToB = winB.webContents.send.mock.calls.filter(
      ([channel]) => channel === CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST
    );
    expect(sendsToA).toHaveLength(1);
    expect(sendsToB).toHaveLength(1);
  });

  it("routes an unpinned external session by focus order and reports the workspace it landed on (#11536)", async () => {
    // Registration order is [A, B]; focus order is the opposite. Before the
    // fix the bridge walked `all()` (Map insertion order) and every external
    // call landed on A — whichever window happened to register first —
    // regardless of what the user was actually looking at.
    // A non-introspection carrier: tier filtering rewrites `actions.list`
    // results (#11525), which would replace the routing payload this test reads.
    // The routing behaviour is tool-agnostic, and `terminal.list` is reachable
    // at the external tier on the curated allowlist alone.
    const manifest = () => [
      createManifestEntry({
        id: "terminal.list",
        title: "List Terminals",
        description: "Read the terminal list",
        kind: "query",
      }),
    ];
    const refA = { kind: "project" as const, workspaceId: "proj-a", workspacePath: "/repos/a" };
    const refB = { kind: "project" as const, workspaceId: "proj-b", workspacePath: "/repos/b" };
    const winA = createMockWindow({
      getManifest: manifest,
      dispatchAction: () => ({ ok: true, result: "from-window-A" }),
      workspaceRef: refA,
    });
    const winB = createMockWindow({
      getManifest: manifest,
      dispatchAction: () => ({ ok: true, result: "from-window-B" }),
      workspaceRef: refB,
    });

    const focus = { current: [winB.windowContext, winA.windowContext] };
    const contextByWcId = new Map([
      [winA.webContents.id, winA.windowContext],
      [winB.webContents.id, winB.windowContext],
    ]);
    const combinedRegistry = {
      all: () => [winA.windowContext, winB.windowContext],
      focusOrder: () => focus.current,
      getPrimary: () => winA.windowContext,
      getByWindowId: () => winA.windowContext,
      getByWebContentsId: (id: number) => contextByWcId.get(id),
      size: 2,
    } as never;

    await service.start(combinedRegistry);

    // No help token — an api-key bearer, i.e. the unpinned external path.
    const external = await connectClient(service.currentPort!);
    transports.push(external.transport);

    const first = await external.client.callTool({ name: "terminal.list", arguments: {} });
    expect(getTextResult(first).content[0].text).toBe('"from-window-B"');
    // Read by literal key, as a real external client would: this string is the
    // wire contract, so renaming it must fail here even if the constant moves.
    expect(first._meta?.["org.daintree/resolved-workspace"]).toEqual(refB);

    // The user switches windows mid-session. The session stays unpinned by
    // design (#7003), so the next call follows focus — and says so.
    focus.current = [winA.windowContext, winB.windowContext];

    const second = await external.client.callTool({ name: "terminal.list", arguments: {} });
    expect(getTextResult(second).content[0].text).toBe('"from-window-A"');
    expect(second._meta?.["org.daintree/resolved-workspace"]).toEqual(refA);
  });

  it("fails closed when the pinned WebContents has been destroyed (#7002 — never silently re-routes)", async () => {
    const winA = createMockWindow({
      dispatchAction: () => ({ ok: true, result: "from-A" }),
    });
    const winB = createMockWindow({
      dispatchAction: () => ({ ok: true, result: "from-B" }),
    });

    const combinedRegistry = {
      all: () => [winA.windowContext, winB.windowContext],
      focusOrder: () => [winA.windowContext, winB.windowContext],
      getPrimary: () => winA.windowContext,
      getByWindowId: () => winA.windowContext,
      getByWebContentsId: () => winA.windowContext,
      size: 2,
    } as never;

    await service.start(combinedRegistry);

    service.setHelpTokenValidator((token) => (token === "help-A" ? "action" : false));
    service.setHelpSessionWebContentsResolver((token) =>
      token === "help-A" ? winA.webContents.id : null
    );

    const a = await connectClient(service.currentPort!, { Authorization: "Bearer help-A" });
    transports.push(a.transport);

    // Window A's view goes away — pinned session must NOT silently fall
    // through to window B (the bug behind #7002).
    electronMocks.webContentsById.delete(winA.webContents.id);

    const result = getTextResult(await a.client.callTool({ name: "actions.list", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no longer available/);
    expect(winB.webContents.send).not.toHaveBeenCalledWith(
      CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST,
      expect.anything()
    );
  });

  it("routes a pinned session's confirm-danger tool through the pinned renderer's host confirmation — never client elicitation (#7002, #11342)", async () => {
    // Pinned sessions deliberately skip `cachedManifest`; `lookupManifestEntry`
    // resolves the entry from `requestManifest()` directly (#7002). The confirm
    // is then performed HOST-side by the pinned renderer's native ConfirmDialog,
    // reached via the UNCONFIRMED dispatch — the client's self-declared
    // `elicitation.form` capability is never treated as authorization (#11342).
    // The pinned renderer here plays the approving human: it returns the result
    // plus an "approved" decision for the unconfirmed dispatch.
    const dispatchMock = vi.fn(() => ({
      result: { ok: true, result: { deleted: true } } as ActionDispatchResult,
      confirmationDecision: "approved" as const,
    }));
    const onElicit = vi.fn(async (): Promise<ElicitResult> => ({ action: "accept", content: {} }));

    const winA = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "worktree.delete" as ActionId,
          title: "Delete Worktree",
          description: "Delete a worktree",
          danger: "confirm",
          // A resolvable outputSchema makes structuredContent a
          // manifest-dependent observable: it is emitted only when the pinned
          // manifest ENTRY resolved (`buildStructuredContent(entry, …)`). This
          // re-arms the original #7002 guard — if `lookupManifestEntry` regressed
          // to re-reading the deliberately-empty shared cache, the entry would be
          // undefined and structuredContent would silently drop.
          outputSchema: { type: "object", properties: { deleted: { type: "boolean" } } },
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(winA.window);
    service.setHelpTokenValidator((token) => (token === "help-A" ? "system" : false));
    service.setHelpSessionWebContentsResolver((token) =>
      token === "help-A" ? winA.webContents.id : null
    );

    const { client, transport } = await connectClient(
      service.currentPort!,
      { Authorization: "Bearer help-A" },
      {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      }
    );
    transports.push(transport);

    const result = (await client.callTool({
      name: "worktree.delete",
      arguments: { worktreeId: "wt-123" },
    })) as TextToolResult & { structuredContent?: Record<string, unknown> };

    // The client's elicitation handler is never consulted; the confirm is
    // resolved by the pinned renderer, which received an UNCONFIRMED dispatch.
    expect(onElicit).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "worktree.delete", confirmed: false })
    );
    // Proves the pinned manifest entry resolved (#7002) — not just that the
    // dispatch was unconfirmed (#11342).
    expect(result.structuredContent).toEqual({ deleted: true });
  });

  it("external (api-key) sessions keep most-recently-focused-view fallback even when help routing is wired (#7002)", async () => {
    storeState.mcpServer.apiKey = "external-secret";
    const winA = createMockWindow({
      dispatchAction: () => ({ ok: true, result: "from-A" }),
    });
    const winB = createMockWindow({
      dispatchAction: () => ({ ok: true, result: "from-B" }),
    });

    const combinedRegistry = {
      all: () => [winA.windowContext, winB.windowContext],
      focusOrder: () => [winA.windowContext, winB.windowContext],
      getPrimary: () => winA.windowContext,
      getByWindowId: () => winA.windowContext,
      getByWebContentsId: () => winA.windowContext,
      size: 2,
    } as never;

    await service.start(combinedRegistry);

    // Help routing is configured but the external bearer doesn't match it.
    service.setHelpTokenValidator((token) => (token === "help-A" ? "action" : false));
    service.setHelpSessionWebContentsResolver((token) =>
      token === "help-A" ? winA.webContents.id : null
    );

    const ext = await connectClient(service.currentPort!, {
      Authorization: "Bearer external-secret",
    });
    transports.push(ext.transport);

    const result = getTextResult(
      await ext.client.callTool({ name: "terminal.list", arguments: {} })
    );

    // Falls through to getActiveProjectWebContents which returns winA (first
    // in registry). The point of the assertion is that the external session
    // is NOT failing closed and IS using the fallback path, regardless of
    // which window happens to be first.
    expect(result.content[0].text).toBe('"from-A"');
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

  // The curated allowlist is the only external surface — nothing widens it
  // (#10701, #11537). Non-allowlisted and restricted entries both stay off.
  it("hides non-allowlisted and restricted tools (curated MCP surface)", async () => {
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
        // Allowlisted, so only the restricted filter can withhold it — using a
        // non-allowlisted id here would pass even with that filter deleted.
        createManifestEntry({
          id: "actions.search" as ActionId,
          title: "Search Actions",
          description: "Restricted despite being allowlisted",
          kind: "query",
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
    expect(ids).not.toContain("panel.gridLayout.setStrategy");
    expect(ids).not.toContain("actions.search");
  });

  it("denies dispatch of non-allowlisted tools for the external tier (#10701)", async () => {
    const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => ({
      ok: true,
      result: { dispatched: payload.actionId },
    }));
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "panel.gridLayout.setStrategy" as ActionId,
          title: "Set grid layout",
          description: "Sensitive UI plumbing — not in the curated allowlist",
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

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
    expect(result.content[0].text).toContain("panel.gridLayout.setStrategy");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  // A store written before #11537 (or hand-edited since) can still carry
  // `mcpServer.fullToolSurface: true` until migration 026 runs. It must be inert
  // — this is the regression guard for reintroducing the #10701 config-gated
  // bypass, which no other test would catch now that the flag is gone.
  it("ignores a stale persisted fullToolSurface key (#11537)", async () => {
    (storeState.mcpServer as Record<string, unknown>)["fullToolSurface"] = true;
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
        // Real, currently-shipping danger:"safe" action with a genuine side
        // effect that the curated allowlist deliberately excludes — one of the
        // 335 the old flag leaked.
        createManifestEntry({
          id: "system.openExternal" as ActionId,
          title: "Open External URL",
          description: "Launches a URL in the OS browser",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    const ids = (await client.listTools()).tools.map((tool) => tool.name);
    expect(ids).toContain("actions.list");
    expect(ids).not.toContain("system.openExternal");

    const result = getTextResult(
      await client.callTool({ name: "system.openExternal", arguments: { url: "https://x.test" } })
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("denies non-allowlisted actions for the external tier (dispatch never reached)", async () => {
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
  describe("workspace-bound external sessions (#11789)", () => {
    const REF_A = { kind: "project" as const, workspaceId: "proj-a", workspacePath: "/repos/a" };
    const REF_B = { kind: "project" as const, workspaceId: "proj-b", workspacePath: "/repos/b" };
    const registeredViews: number[] = [];

    afterEach(() => {
      for (const wcId of registeredViews) unregisterProjectView(wcId);
      registeredViews.length = 0;
    });

    function boundManifest() {
      return [
        createManifestEntry({
          id: "terminal.list",
          title: "List Terminals",
          description: "Read the terminal list",
          kind: "query",
        }),
        createManifestEntry({
          id: "recipe.run",
          title: "Run Recipe",
          description: "Run a saved recipe",
          kind: "command",
          danger: "confirm",
        }),
      ];
    }

    /** A window whose project view is discoverable through the shared registry. */
    function boundWindow(
      ref: { kind: "project"; workspaceId: string; workspacePath: string },
      result: string
    ) {
      const win = createMockWindow({
        getManifest: boundManifest,
        dispatchAction: () => ({ ok: true, result }),
        workspaceRef: ref,
      });
      registerProjectView(ref.workspaceId, win.webContents as never);
      registeredViews.push(win.webContents.id);
      return win;
    }

    function twoWindowRegistry(
      winA: ReturnType<typeof boundWindow>,
      winB: ReturnType<typeof boundWindow>
    ) {
      const focus = { current: [winB.windowContext, winA.windowContext] };
      const contextByWcId = new Map([
        [winA.webContents.id, winA.windowContext],
        [winB.webContents.id, winB.windowContext],
      ]);
      const registry = {
        all: () => [winA.windowContext, winB.windowContext],
        focusOrder: () => focus.current,
        getPrimary: () => winA.windowContext,
        getByWindowId: () => winA.windowContext,
        getByWebContentsId: (id: number) => contextByWcId.get(id),
        size: 2,
      } as never;
      return { registry, focus };
    }

    async function connectBound(port: number, workspaceId?: string) {
      const apiKey = getServiceApiKey();
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: {
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...(workspaceId ? { "Daintree-Workspace-Id": workspaceId } : {}),
          },
        },
      });
      const client = new Client({ name: "bound-test-client", version: "1.0.0" });
      await client.connect(transport);
      httpTransports.push(transport);
      return client;
    }

    it("keeps two bound sessions isolated while calls interleave and focus moves", async () => {
      // The decisive test from the report: focus is the thing that used to
      // retarget these sessions, so it is moved between every pair of calls.
      const winA = boundWindow(REF_A, "from-window-A");
      const winB = boundWindow(REF_B, "from-window-B");
      const { registry, focus } = twoWindowRegistry(winA, winB);
      await service.start(registry);

      const clientA = await connectBound(service.currentPort!, REF_A.workspaceId);
      const clientB = await connectBound(service.currentPort!, REF_B.workspaceId);

      const call = (client: Client) => client.callTool({ name: "terminal.list", arguments: {} });

      focus.current = [winB.windowContext, winA.windowContext];
      expect(getTextResult(await call(clientA)).content[0].text).toBe('"from-window-A"');
      expect(getTextResult(await call(clientB)).content[0].text).toBe('"from-window-B"');

      focus.current = [winA.windowContext, winB.windowContext];
      expect(getTextResult(await call(clientB)).content[0].text).toBe('"from-window-B"');
      expect(getTextResult(await call(clientA)).content[0].text).toBe('"from-window-A"');
    });

    it("stamps each result with the workspace it was bound to", async () => {
      const winA = boundWindow(REF_A, "from-window-A");
      const winB = boundWindow(REF_B, "from-window-B");
      const { registry, focus } = twoWindowRegistry(winA, winB);
      await service.start(registry);

      const clientA = await connectBound(service.currentPort!, REF_A.workspaceId);
      focus.current = [winB.windowContext, winA.windowContext];

      const result = await clientA.callTool({ name: "terminal.list", arguments: {} });

      expect(result._meta?.["org.daintree/resolved-workspace"]).toEqual(REF_A);
    });

    it("advertises the resolved binding in the initialize result", async () => {
      const winA = boundWindow(REF_A, "from-window-A");
      await service.start(winA.window);

      const client = await connectBound(service.currentPort!, REF_A.workspaceId);

      expect(
        client.getServerCapabilities()?.experimental?.["org.daintree/workspace-binding"]
      ).toEqual(REF_A);
    });

    it("withholds the confirm-gated tool from a bound session but keeps it for an unbound one", async () => {
      const winA = boundWindow(REF_A, "from-window-A");
      await service.start(winA.window);

      const bound = await connectBound(service.currentPort!, REF_A.workspaceId);
      const unbound = await connectBound(service.currentPort!);

      const boundNames = (await bound.listTools()).tools.map((t) => t.name);
      const unboundNames = (await unbound.listTools()).tools.map((t) => t.name);

      expect(boundNames).toContain("terminal.list");
      expect(boundNames).not.toContain("recipe.run");
      // Binding is opt-in, so an unbound session's surface is unchanged.
      expect(unboundNames).toContain("recipe.run");
    });

    it("refuses a handshake naming a workspace with no live view, creating no session", async () => {
      const winA = boundWindow(REF_A, "from-window-A");
      await service.start(winA.window);

      await expect(connectBound(service.currentPort!, "proj-nonexistent")).rejects.toThrow();
      // The failed handshake must not leave a client behind in the inventory.
      expect(service.listActiveClients()).toHaveLength(0);
    });

    it("still lists a bound session among the external clients", async () => {
      // A background-bound agent is the one the user most needs to be able to
      // find and disconnect, since they cannot see it working.
      const winA = boundWindow(REF_A, "from-window-A");
      await service.start(winA.window);

      await connectBound(service.currentPort!, REF_A.workspaceId);

      await vi.waitFor(() => {
        expect(service.listActiveClients()).toHaveLength(1);
      });
    });

    it("leaves an unbound external session following focus, exactly as documented", async () => {
      // The behaviour the pre-binding contract promises, re-asserted through
      // the new code path so binding can't have quietly changed it.
      const winA = boundWindow(REF_A, "from-window-A");
      const winB = boundWindow(REF_B, "from-window-B");
      const { registry, focus } = twoWindowRegistry(winA, winB);
      await service.start(registry);

      const client = await connectBound(service.currentPort!);

      focus.current = [winB.windowContext, winA.windowContext];
      expect(
        getTextResult(await client.callTool({ name: "terminal.list", arguments: {} })).content[0]
          .text
      ).toBe('"from-window-B"');

      focus.current = [winA.windowContext, winB.windowContext];
      expect(
        getTextResult(await client.callTool({ name: "terminal.list", arguments: {} })).content[0]
          .text
      ).toBe('"from-window-A"');
    });
  });
});
