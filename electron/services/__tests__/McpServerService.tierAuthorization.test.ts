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
import {
  ACTION_TIER_ADDONS,
  SYSTEM_TIER_ADDONS,
  WORKBENCH_TIER_TOOLS as WORKBENCH_TIER_TOOLS_LIST,
} from "../../../shared/config/helpAssistantTierAllowlists.js";
import {
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  WAIT_UNTIL_IDLE_BATCH_DESCRIPTION,
  WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
} from "../../../shared/types/terminalWaitUntilIdle.js";

const waitUntilIdleManifestEntry = (): ActionManifestEntry => ({
  id: "terminal.waitUntilIdle" as ActionId,
  name: "terminal.waitUntilIdle",
  title: "Wait until terminal idle",
  description: WAIT_UNTIL_IDLE_DESCRIPTION,
  category: "terminal",
  kind: "query" as ActionKind,
  danger: "safe" as ActionDanger,
  inputSchema: WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  outputSchema: WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
  enabled: true,
  requiresArgs: true,
  mcpAnnotations: {
    readOnlyHint: true,
    idempotentHint: false,
    destructiveHint: false,
  },
});

const waitUntilIdleBatchManifestEntry = (): ActionManifestEntry => ({
  id: "terminal.waitUntilIdleBatch" as ActionId,
  name: "terminal.waitUntilIdleBatch",
  title: "Wait until terminals idle (batch)",
  description: WAIT_UNTIL_IDLE_BATCH_DESCRIPTION,
  category: "terminal",
  kind: "query" as ActionKind,
  danger: "safe" as ActionDanger,
  inputSchema: {
    type: "object",
    properties: {
      terminalIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 256 },
      mode: { type: "string", enum: ["first", "all"] },
      timeoutMs: { type: "integer", minimum: 0 },
    },
    required: ["terminalIds"],
    additionalProperties: false,
  },
  outputSchema: WAIT_UNTIL_IDLE_BATCH_OUTPUT_SCHEMA,
  enabled: true,
  requiresArgs: true,
  mcpAnnotations: {
    readOnlyHint: true,
    idempotentHint: false,
    destructiveHint: false,
  },
});

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
        "agent.getState",
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
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: { dispatched: payload.actionId },
      }));
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

      // Action-tier mutation denied at workbench
      const actionTierDenied = getTextResult(
        await client.callTool({ name: "terminal.sendCommand", arguments: { id: "t", text: "x" } })
      );
      expect(actionTierDenied.isError).toBe(true);
      expect(actionTierDenied.content[0].text).toContain("TIER_NOT_PERMITTED");
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
      expect(ids).toContain("agent.getState");
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
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: { dispatched: payload.actionId },
      }));
      const { window } = createMockWindow({
        getManifest: manifestForAllAllowlistedTools,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      // External tier inherits the legacy MCP_TOOL_ALLOWLIST — destructive
      // actions in that list (e.g. worktree.delete, git.commit) and broader
      // in-app mutations (terminal.sendCommand, agent.launch) remain callable
      // so existing user-facing clients keep working.
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
        id: "terminal.closeAll" as ActionId,
        title: "Close All Terminals",
        description: "Move all terminals to trash",
      }),
      createManifestEntry({
        id: "terminal.kill" as ActionId,
        title: "Kill Terminal",
        description: "Permanently remove a terminal",
      }),
      createManifestEntry({
        id: "terminal.killAll" as ActionId,
        title: "Kill All Terminals",
        description: "Permanently remove all terminals",
      }),
      createManifestEntry({
        id: "terminal.restart" as ActionId,
        title: "Restart Terminal",
        description: "Restart the terminal process",
      }),
      createManifestEntry({
        id: "terminal.arm" as ActionId,
        title: "Arm Terminal",
        description: "Add a terminal to the fleet broadcast set",
      }),
      createManifestEntry({
        id: "terminal.disarm" as ActionId,
        title: "Disarm Terminal",
        description: "Remove a terminal from the fleet broadcast set",
      }),
      createManifestEntry({
        id: "terminal.disarmAll" as ActionId,
        title: "Disarm All Terminals",
        description: "Clear the fleet broadcast set",
      }),
      createManifestEntry({
        id: "copyTree.generateAndCopyFile" as ActionId,
        title: "Generate And Copy Context",
        description: "Write generated context to the OS clipboard",
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
        id: "agent.focusNextAgent" as ActionId,
        title: "Focus Next Agent",
        description: "Cycle focus to the next agent panel",
      }),
      createManifestEntry({
        id: "agent.focusPreviousAgent" as ActionId,
        title: "Focus Previous Agent",
        description: "Cycle focus to the previous agent panel",
      }),
      createManifestEntry({
        id: "workflow.focusNextAttention" as ActionId,
        title: "Focus Next Attention",
        description: "Focus next waiting/working agent with priority",
      }),
      createManifestEntry({
        id: "app.theme.pick" as ActionId,
        title: "Pick Theme",
        description: "Open the theme picker",
      }),
      createManifestEntry({
        id: "app.theme.browser.open" as ActionId,
        title: "Open Theme Browser",
        description: "Open the theme browser panel",
      }),
      createManifestEntry({
        id: "app.theme.toggle" as ActionId,
        title: "Toggle Theme",
        description: "Toggle between light and dark themes",
      }),
      createManifestEntry({
        id: "agentSettings.get" as ActionId,
        title: "Get Agent Settings",
        description: "Read effective agent settings",
        kind: "query",
      }),
      createManifestEntry({
        id: "keybinding.getOverrides" as ActionId,
        title: "Get Keybinding Overrides",
        description: "Read user keybinding overrides",
        kind: "query",
      }),
      createManifestEntry({
        id: "system.getResourceProfileSnapshot" as ActionId,
        title: "Get Resource Profile Snapshot",
        description: "Read host resource pressure and the active resource profile",
        kind: "query",
      }),
      createManifestEntry({
        id: "cliAvailability.get" as ActionId,
        title: "Get CLI Availability",
        description: "Read cached agent CLI availability",
        kind: "query",
      }),
      createManifestEntry({
        id: "hibernation.getConfig" as ActionId,
        title: "Get Hibernation Config",
        description: "Read auto-hibernation configuration",
        kind: "query",
      }),
      createManifestEntry({
        id: "project.update" as ActionId,
        title: "Update Project",
        description: "Update project metadata",
      }),
      createManifestEntry({
        id: "project.saveSettings" as ActionId,
        title: "Save Project Settings",
        description: "Save a project's settings",
      }),
      createManifestEntry({
        id: "project.muteNotifications" as ActionId,
        title: "Mute Project Notifications",
        description: "Suppress future agent notifications for a project",
      }),
      // Additional entries needed for full ACTION_TIER_ADDONS coverage.
      createManifestEntry({
        id: "worktree.setActive" as ActionId,
        title: "Set Active Worktree",
        description: "Set the active worktree for a project",
      }),
      createManifestEntry({
        id: "worktree.refresh" as ActionId,
        title: "Refresh Worktrees",
        description: "Refresh worktree status from disk",
      }),
      createManifestEntry({
        id: "worktree.resource.provision" as ActionId,
        title: "Provision Resource",
        description: "Run resource provisioning commands for a worktree",
      }),
      createManifestEntry({
        id: "worktree.resource.pause" as ActionId,
        title: "Pause Resource",
        description: "Pause the resource associated with a worktree",
      }),
      createManifestEntry({
        id: "worktree.resource.resume" as ActionId,
        title: "Resume Resource",
        description: "Resume the resource associated with a worktree",
      }),
      createManifestEntry({
        id: "terminal.inject" as ActionId,
        title: "Inject Terminal Input",
        description: "Inject text into a terminal",
      }),
      createManifestEntry({
        id: "terminal.new" as ActionId,
        title: "New Terminal",
        description: "Create a new terminal",
      }),
      createManifestEntry({
        id: "terminal.moveToDock" as ActionId,
        title: "Move to Dock",
        description:
          "Move the target terminal from the grid to the dock. Accepts an optional terminalId; defaults to the currently focused terminal.",
      }),
      createManifestEntry({
        id: "terminal.moveToGrid" as ActionId,
        title: "Move to Grid",
        description:
          "Move the target terminal from the dock back into the grid. Accepts an optional terminalId; defaults to the currently focused terminal.",
      }),
      createManifestEntry({
        id: "terminal.toggleDock" as ActionId,
        title: "Toggle Dock",
        description:
          "Toggle the focused terminal between the dock and the grid. Pushes a layout undo snapshot so the move can be reversed.",
      }),
      createManifestEntry({
        id: "terminal.rename" as ActionId,
        title: "Rename Terminal",
        description:
          "Rename a terminal. Accepts an optional terminalId (defaults to the focused terminal) and a name; omitting the name opens the rename dialog.",
      }),
      waitUntilIdleManifestEntry(),
      waitUntilIdleBatchManifestEntry(),
      createManifestEntry({
        id: "recipe.list" as ActionId,
        title: "List Recipes",
        description: "List available recipes",
      }),
      createManifestEntry({
        id: "recipe.run" as ActionId,
        title: "Run Recipe",
        description: "Execute a recipe",
      }),
      createManifestEntry({
        id: "copyTree.injectToTerminal" as ActionId,
        title: "Inject CopyTree to Terminal",
        description: "Inject generated context into a terminal",
      }),
      createManifestEntry({
        id: "file.openInEditor" as ActionId,
        title: "Open File in Editor",
        description: "Open a file in the system editor",
      }),
      createManifestEntry({
        id: "browser.navigate" as ActionId,
        title: "Navigate Browser",
        description: "Navigate a browser panel to a URL",
      }),
      createManifestEntry({
        id: "browser.openUrl" as ActionId,
        title: "Open URL in Browser",
        description: "Open a URL in a browser panel, reusing an existing one or creating a new one",
      }),
      createManifestEntry({
        id: "browser.captureScreenshot" as ActionId,
        title: "Capture Browser Screenshot",
        description:
          "Capture a screenshot of the focused browser panel and return it as a PNG image",
      }),
      createManifestEntry({
        id: "panel.focus" as ActionId,
        title: "Focus Panel",
        description: "Focus a specific panel by id",
      }),
      createManifestEntry({
        id: "devPreview.reloadPreview" as ActionId,
        title: "Reload Dev Preview",
        description: "Reload the dev preview panel",
      }),
      createManifestEntry({
        id: "devPreview.restart" as ActionId,
        title: "Restart Dev Server",
        description: "Restart the dev server for the dev preview panel",
      }),
      createManifestEntry({
        id: "devPreview.promoteToPortal" as ActionId,
        title: "Promote Dev Preview to Portal",
        description: "Promote a dev preview panel to a portal tab",
      }),
      createManifestEntry({
        id: "portal.openUrl" as ActionId,
        title: "Open URL in Portal",
        description: "Open a URL in a new portal tab",
      }),
      createManifestEntry({
        id: "portal.newTab" as ActionId,
        title: "New Portal Tab",
        description: "Open a new portal tab",
      }),
      createManifestEntry({
        id: "portal.toggle" as ActionId,
        title: "Toggle Portal",
        description: "Show or hide the portal",
      }),
      createManifestEntry({
        id: "portal.toggleDevDashboard" as ActionId,
        title: "Toggle Dev Dashboard",
        description: "Show or hide the portal dev dashboard",
      }),
      // Additional entries needed for full SYSTEM_TIER_ADDONS coverage.
      createManifestEntry({
        id: "worktree.resource.teardown" as ActionId,
        title: "Teardown Resource",
        description: "Run resource teardown commands for a worktree",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "git.stageFile" as ActionId,
        title: "Stage File",
        description: "Stage a file for commit",
      }),
      createManifestEntry({
        id: "git.unstageFile" as ActionId,
        title: "Unstage File",
        description: "Unstage a file",
      }),
      createManifestEntry({
        id: "git.stageAll" as ActionId,
        title: "Stage All",
        description: "Stage all changed files",
      }),
      createManifestEntry({
        id: "git.unstageAll" as ActionId,
        title: "Unstage All",
        description: "Unstage all files",
      }),
      createManifestEntry({
        id: "forge.openIssue" as ActionId,
        title: "Open Issue (Forge)",
        description: "Open an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.openIssues" as ActionId,
        title: "Open Issues (Forge)",
        description: "Open the issues list via the forge provider",
      }),
      createManifestEntry({
        id: "forge.openPRs" as ActionId,
        title: "Open PRs (Forge)",
        description: "Open the pull requests list via the forge provider",
      }),
      createManifestEntry({
        id: "forge.openCommits" as ActionId,
        title: "Open Commits (Forge)",
        description: "Open the commits view via the forge provider",
      }),
      createManifestEntry({
        id: "forge.assignIssue" as ActionId,
        title: "Assign Issue (Forge)",
        description: "Assign an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.unassignIssue" as ActionId,
        title: "Unassign Issue (Forge)",
        description: "Remove an assignment from an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.createIssue" as ActionId,
        title: "Create Issue (Forge)",
        description: "Create an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.closeIssue" as ActionId,
        title: "Close Issue (Forge)",
        description: "Close an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.reopenIssue" as ActionId,
        title: "Reopen Issue (Forge)",
        description: "Reopen an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.editIssue" as ActionId,
        title: "Edit Issue (Forge)",
        description: "Edit an issue's title or body via the forge provider",
      }),
      createManifestEntry({
        id: "forge.addIssueComment" as ActionId,
        title: "Add Issue Comment (Forge)",
        description: "Add a comment to an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.addIssueLabel" as ActionId,
        title: "Add Issue Label (Forge)",
        description: "Add a label to an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.removeIssueLabel" as ActionId,
        title: "Remove Issue Label (Forge)",
        description: "Remove a label from an issue via the forge provider",
      }),
      createManifestEntry({
        id: "forge.validateToken" as ActionId,
        title: "Validate Token (Forge)",
        description: "Validate credentials via the forge provider",
      }),
      createManifestEntry({
        id: "forge.openPR" as ActionId,
        title: "Open PR",
        description: "Open a pull request via the forge provider",
      }),
      createManifestEntry({
        id: "forge.approvePR" as ActionId,
        title: "Approve PR (Forge)",
        description: "Submit an approving review via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.requestChanges" as ActionId,
        title: "Request Changes (Forge)",
        description: "Submit a request-changes review via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.dismissReview" as ActionId,
        title: "Dismiss Review (Forge)",
        description: "Dismiss a submitted review via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.requestReviewers" as ActionId,
        title: "Request Reviewers (Forge)",
        description: "Request reviewers via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.getPR" as ActionId,
        title: "Get PR",
        description: "Fetch a pull request via the forge provider",
        kind: "query",
      }),
      createManifestEntry({
        id: "forge.getCIStatus" as ActionId,
        title: "Get CI Status",
        description: "Fetch the roll-up CI status for a pull request",
        kind: "query",
      }),
      createManifestEntry({
        id: "worktree.reviewReadiness" as ActionId,
        title: "Review Readiness",
        description: "Summarize whether a worktree is ready to commit, push, and merge",
        kind: "query",
      }),
      createManifestEntry({
        id: "forge.createPR" as ActionId,
        title: "Create PR",
        description: "Open a pull request via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.closePR" as ActionId,
        title: "Close PR",
        description: "Close a pull request via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.reopenPR" as ActionId,
        title: "Reopen PR",
        description: "Reopen a pull request via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.mergePR" as ActionId,
        title: "Merge PR",
        description: "Merge a pull request via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.convertPRToDraft" as ActionId,
        title: "Convert PR to draft",
        description: "Convert a pull request to draft via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.markPRReadyForReview" as ActionId,
        title: "Mark PR ready",
        description: "Mark a pull request ready for review via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.commentOnPR" as ActionId,
        title: "Comment on PR",
        description: "Comment on a pull request via the forge provider",
        danger: "confirm",
      }),
      createManifestEntry({
        id: "forge.editPR" as ActionId,
        title: "Edit PR",
        description: "Edit a pull request via the forge provider",
        danger: "confirm",
      }),
    ];

    // Tier action/addon sets are sourced from the production allowlists so a
    // rename in shared/config/helpAssistantTierAllowlists.ts or actionIds.ts
    // produces a test failure here instead of silent drift.
    // The workbench spot-check array is deliberately minimal — the manifest
    // only contains a subset of workbench entries. Action and system addon
    // sets iterate all production entries (manifest gaps filled above).

    const WORKBENCH_SPOT_CHECKS = [
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "workflow.prepBranchForReview")!,
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "agentSettings.get")!,
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "keybinding.getOverrides")!,
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "system.getResourceProfileSnapshot")!,
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "cliAvailability.get")!,
      WORKBENCH_TIER_TOOLS_LIST.find((id) => id === "hibernation.getConfig")!,
    ] as const;

    // terminal.bulkCommand (the one-shot broadcast-send) is renderer-only — it
    // remains available via keybindings, palette, and menus, but is NOT exposed
    // through the MCP control plane on any tier. (Distinct from the arming
    // primitives terminal.arm/disarm/disarmAll, which only edit the broadcast
    // membership set and ARE exposed at the system tier.)
    const NEVER_EXPOSED_VIA_MCP = ["terminal.bulkCommand"] as const;

    // External tier (apiKey) curates MCP_TOOL_ALLOWLIST independently from the
    // help-assistant tiers. Focus and theme actions live in ACTION_TIER_ADDONS
    // for assistant-driven UI shifts but are intentionally absent from the
    // external surface — guard against accidental cross-curation.
    const NOT_IN_EXTERNAL_TIER = [
      "agent.focusNextWaiting",
      "agent.focusNextWorking",
      "agent.focusNextAgent",
      "agent.focusPreviousAgent",
      "workflow.focusNextAttention",
      "app.theme.pick",
      "app.theme.browser.open",
      "app.theme.toggle",
      "agentSettings.get",
      "keybinding.getOverrides",
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
      for (const id of WORKBENCH_SPOT_CHECKS) {
        expect(ids).toContain(id);
      }
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("git.commit");
      expect(ids).not.toContain("copyTree.isAvailable");
      for (const id of ACTION_TIER_ADDONS) {
        expect(ids).not.toContain(id);
      }
      for (const id of SYSTEM_TIER_ADDONS) {
        expect(ids).not.toContain(id);
      }
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("action tier adds full in-app orchestration, but excludes filesystem-destructive, git, and externally-visible writes", async () => {
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
      for (const id of ACTION_TIER_ADDONS) {
        expect(ids).toContain(id);
      }
      for (const id of SYSTEM_TIER_ADDONS) {
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
      for (const id of ACTION_TIER_ADDONS) {
        expect(ids).toContain(id);
      }
      for (const id of SYSTEM_TIER_ADDONS) {
        expect(ids).toContain(id);
      }
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
    });

    it("rejects callTool for actions outside the session tier with TIER_NOT_PERMITTED", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: "should-not-run",
      }));
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

    it("rejects clipboard writes, git mutations, and worktree deletes at the action tier", async () => {
      paneTokenTiers.set("token-action", "action");
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: "should-not-run",
      }));
      const { window } = createMockWindow({
        getManifest: tierManifest,
        dispatchAction: dispatchMock,
      });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-action",
      });
      transports.push(transport);

      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
        { name: "copyTree.generateAndCopyFile", arguments: {} },
        { name: "git.commit", arguments: { message: "x" } },
        { name: "git.push", arguments: {} },
        { name: "worktree.delete", arguments: {} },
      ];

      for (const call of calls) {
        const denied = (await client.callTool(call)) as TextToolResult;
        expect(denied.isError, `${call.name} should be denied at action tier`).toBe(true);
        expect(denied.content[0]?.text).toContain("TIER_NOT_PERMITTED");
      }
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("filters listTools and rejects callTool over the Streamable HTTP transport", async () => {
      paneTokenTiers.set("token-wb-http", "workbench");
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: "should-not-run",
      }));
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

    it("external tier (apiKey) excludes fleet-broadcast tools from listTools", async () => {
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      // connectClient sends the global apiKey by default → external tier.
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      for (const id of NEVER_EXPOSED_VIA_MCP) {
        expect(ids).not.toContain(id);
      }
      for (const id of NOT_IN_EXTERNAL_TIER) {
        expect(ids).not.toContain(id);
      }
    });

    // #11544 — an external agent must be able to answer "is this PR green?".
    // Both routes to that answer were previously unreachable at the external
    // tier: forge.getCIStatus did not exist, and worktree.reviewReadiness was
    // workbench-only despite already returning a CI roll-up.
    it("external tier (apiKey) reaches both CI-status routes (#11544)", async () => {
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("forge.getCIStatus");
      expect(ids).toContain("worktree.reviewReadiness");
    });

    it.each(["forge.getCIStatus", "worktree.reviewReadiness"])(
      "external tier can actually CALL %s, not merely list it (#11544)",
      async (actionId) => {
        // listTools and callTool authorize through different functions
        // (shouldExposeTool vs isTierPermitted), so advertising a tool does not
        // by itself prove an external caller can invoke it.
        const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => ({
          ok: true,
          result: { dispatched: payload.actionId },
        }));
        const { window } = createMockWindow({
          getManifest: tierManifest,
          dispatchAction: dispatchMock,
        });

        await service.start(window);
        const { client, transport } = await connectClient(service.currentPort!);
        transports.push(transport);

        const res = (await client.callTool({ name: actionId, arguments: {} })) as TextToolResult;

        expect(res.isError).toBeFalsy();
        expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ actionId }));
      }
    );

    it("workbench tier also reaches forge.getCIStatus (it is a read)", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      const { window } = createMockWindow({ getManifest: tierManifest });

      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!, {
        Authorization: "Bearer token-wb",
      });
      transports.push(transport);

      const ids = (await client.listTools()).tools.map((tool) => tool.name);
      expect(ids).toContain("forge.getCIStatus");
      // Sanity: the tier is still scoped — a write neighbour stays out.
      expect(ids).not.toContain("forge.createPR");
    });

    it("rejects callTool for fleet-broadcast tools across every tier with TIER_NOT_PERMITTED", async () => {
      paneTokenTiers.set("token-wb", "workbench");
      paneTokenTiers.set("token-action", "action");
      paneTokenTiers.set("token-sys", "system");
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: "should-not-run",
      }));
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

    it("filters listTools by the pane token's tier for pane-scoped sessions", async () => {
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
      // Outside the workbench allowlist — the pane tier is the ceiling.
      expect(ids).not.toContain("worktree.create");
      expect(ids).not.toContain("git.commit");
      expect(ids).not.toContain("panel.gridLayout.setStrategy");
    });
  });
});
