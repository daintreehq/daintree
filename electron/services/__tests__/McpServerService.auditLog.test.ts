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
import { ACTIONS_LIST_TOOL } from "../mcp-server/shared.js";

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

let currentService: McpServerService | null = null;

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

    it("pruneAuditByRetention delegates to both audit and turn-outcome services (#10776)", () => {
      const auditSpy = vi.spyOn(service._auditService, "pruneByAge");
      const turnSpy = vi.spyOn(service._turnOutcomeService, "pruneByAge");

      service.pruneAuditByRetention(30);

      expect(auditSpy).toHaveBeenCalledWith(30);
      expect(turnSpy).toHaveBeenCalledWith(30);
    });

    it("pruneAuditByRetention forwards the Off value (0) to both rings (#10776)", () => {
      const auditSpy = vi.spyOn(service._auditService, "pruneByAge");
      const turnSpy = vi.spyOn(service._turnOutcomeService, "pruneByAge");

      service.pruneAuditByRetention(0);

      expect(auditSpy).toHaveBeenCalledWith(0);
      expect(turnSpy).toHaveBeenCalledWith(0);
    });

    it("records a successful dispatch with redacted args and a non-empty session id", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: { ok: true },
      }));
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
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: false,
        error: { code: "USER_REJECTED", message: "User rejected the confirmation request." },
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
      expect(records[0].result).toBe("error");
      expect(records[0].errorCode).toBe("USER_REJECTED");
      expect(records[0].confirmationDecision).toBe("rejected");
    });

    it("records confirmationDecision='timeout' when dispatch returns CONFIRMATION_TIMEOUT", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: false,
        error: {
          code: "CONFIRMATION_TIMEOUT",
          message: "Confirmation request timed out before the user responded.",
        },
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

      auditLogsStoreMocks.set.mockClear();
      (service as unknown as { clearAuditLog: () => void }).clearAuditLog();

      expect(getAuditRecords(service)).toHaveLength(0);
      // clearAuditLog must persist synchronously, not wait for the debounce.
      expect(auditLogsStoreMocks.set).toHaveBeenCalledWith("mcpAuditLog", []);
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
      auditLogsState.mcpAuditLog = seeded;

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
        auditLogsStoreMocks.set.mockClear();

        // Before the debounce window expires, no flush.
        vi.advanceTimersByTime(1000);
        expect(auditLogsStoreMocks.set).not.toHaveBeenCalled();

        // After the 2s window the debounced flush fires once.
        vi.advanceTimersByTime(1500);
        const calls = auditLogsStoreMocks.set.mock.calls.filter(
          (call) => call[0] === "mcpAuditLog"
        );
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const last = calls[calls.length - 1];
        expect(last[1] as Array<{ toolId: string }>).toHaveLength(1);
        expect((last[1] as Array<{ toolId: string }>)[0].toolId).toBe("actions.list");
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
        await client.callTool({ name: ACTIONS_LIST_TOOL, arguments: {} });
        // Pending debounce timer is now set with the record in the buffer.
        (service as unknown as { clearAuditLog: () => void }).clearAuditLog();
        auditLogsStoreMocks.set.mockClear();

        // Advance well past the original debounce window. The cancelled
        // timer must not fire and re-persist the cleared record.
        vi.advanceTimersByTime(5000);
        expect(auditLogsStoreMocks.set).not.toHaveBeenCalled();
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
      // The ring now lives in the dedicated audit-logs store, so config
      // writes are structurally unable to touch it.
      service.setAuditMaxRecords(750);

      expect(auditLogsState.mcpAuditLog).toHaveLength(1);
      expect(getAuditRecords(service)).toHaveLength(1);
    });
  });
});
