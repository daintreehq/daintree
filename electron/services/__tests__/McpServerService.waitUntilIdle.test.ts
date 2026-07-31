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
  WAIT_UNTIL_IDLE_DESCRIPTION,
  WAIT_UNTIL_IDLE_INPUT_SCHEMA,
  WAIT_UNTIL_IDLE_OUTPUT_SCHEMA,
} from "../../../shared/types/terminalWaitUntilIdle.js";

const stateChangedListenerCount = (events: unknown): number =>
  (
    events as {
      bus: import("node:events").EventEmitter;
    }
  ).bus.listenerCount("agent:state-changed");

const waitForStateChangedListener = async (events: unknown, baseline: number): Promise<void> => {
  await expect.poll(() => stateChangedListenerCount(events)).toBeGreaterThan(baseline);
};

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
      state: "idle" | "working" | "waiting" | "completed" | "exited" = "idle",
      waitingReason?: "prompt" | "question"
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
        ...(state === "waiting" && waitingReason ? { waitingReason } : {}),
      });
    };

    it("listTools advertises the native tool with the documented schema for the action tier", async () => {
      paneTokenTiers.set("token-wait-action", "action");
      const { window } = createMockWindow({
        getManifest: () => [waitUntilIdleManifestEntry()],
      });
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
      const { window } = createMockWindow({
        getManifest: () => [waitUntilIdleManifestEntry()],
      });
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

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      }) as Promise<TextToolResult>;

      await waitForStateChangedListener(events, listenerBaseline);

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
      // waitingReason is only present when idleReason === "waiting_for_user".
      expect(payload.waitingReason).toBeUndefined();
    });

    it("surfaces waitingReason='question' on a working→waiting transition", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      }) as Promise<TextToolResult & { structuredContent?: Record<string, unknown> }>;

      await waitForStateChangedListener(events, listenerBaseline);

      const transitionTs = Date.now();
      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state: "waiting",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        waitingReason: "question",
        timestamp: transitionTs,
      });

      const result = await callPromise;
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId,
        agentId,
        busyState: "idle",
        idleReason: "waiting_for_user",
        waitingReason: "question",
        previousBusyState: "working",
        lastTransitionAt: transitionTs,
        timedOut: false,
      });
      expect(result.structuredContent).toMatchObject({
        idleReason: "waiting_for_user",
        waitingReason: "question",
      });
    });

    it("surfaces waitingReason='prompt' on a working→waiting transition", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      }) as Promise<TextToolResult>;

      await waitForStateChangedListener(events, listenerBaseline);

      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state: "waiting",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        waitingReason: "prompt",
        timestamp: Date.now(),
      });

      const result = await callPromise;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.idleReason).toBe("waiting_for_user");
      expect(payload.waitingReason).toBe("prompt");
    });

    it("omits waitingReason on working→waiting transitions without a classified reason", async () => {
      const { events } = await import("../events.js");
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      }) as Promise<TextToolResult & { structuredContent?: Record<string, unknown> }>;

      await waitForStateChangedListener(events, listenerBaseline);

      events.emit("agent:state-changed", {
        agentId,
        terminalId,
        state: "waiting",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        timestamp: Date.now(),
      });

      const result = await callPromise;
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.idleReason).toBe("waiting_for_user");
      expect(payload.waitingReason).toBeUndefined();
      expect(result.structuredContent?.waitingReason).toBeUndefined();
    });

    it("returns the stored waitingReason for a terminal already in waiting state", async () => {
      const { terminalId, agentId } = nextIds();
      // Seed the terminal directly into "waiting" with a classified reason.
      // The already-idle path must read waitingReason from the store, since no
      // new agent:state-changed event fires for the snapshot case.
      await seedTerminalAgent(terminalId, agentId, "waiting", "question");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      })) as TextToolResult;

      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload).toMatchObject({
        terminalId,
        agentId,
        busyState: "idle",
        idleReason: "waiting_for_user",
        waitingReason: "question",
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

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 200 },
      }) as Promise<TextToolResult>;

      await waitForStateChangedListener(events, listenerBaseline);

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

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 150 },
      }) as Promise<TextToolResult>;

      await waitForStateChangedListener(events, listenerBaseline);

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

      const listenerBaseline = stateChangedListenerCount(events);
      const callPromise = client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId: terminalA, timeoutMs: 120 },
      }) as Promise<TextToolResult>;

      await waitForStateChangedListener(events, listenerBaseline);

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

    it("emits exactly one audit record per call via the shared finally path", async () => {
      // Regression guard for the post-#7529 refactor: the wait-until-idle
      // branch short-circuits before dispatchAction but must still feed the
      // single shared audit `finally` block — never duplicate the record.
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "idle");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const baselineMatching = service
        .getAuditRecords()
        .filter((r) => r.toolId === "terminal.waitUntilIdle").length;
      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId },
      })) as TextToolResult;
      expect(result.isError).toBeFalsy();

      const matching = service
        .getAuditRecords()
        .filter((r) => r.toolId === "terminal.waitUntilIdle");
      expect(matching.length - baselineMatching).toBe(1);
      const record = matching.at(-1)!;
      expect(record.result).toBe("success");
      expect(record.toolId).toBe("terminal.waitUntilIdle");
      expect(record.tier).toBe("external");
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
      expect(record.errorCode).toBeUndefined();
    });

    it("releases its event listener after a timeout exit", async () => {
      const { events } = await import("../events.js");
      const innerBus = (events as unknown as { bus: import("node:events").EventEmitter }).bus;
      const { terminalId, agentId } = nextIds();
      await seedTerminalAgent(terminalId, agentId, "working");

      const { window } = createMockWindow({ getManifest: () => [] });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const baseline = innerBus.listenerCount("agent:state-changed");

      const result = (await client.callTool({
        name: "terminal.waitUntilIdle",
        arguments: { terminalId, timeoutMs: 50 },
      })) as TextToolResult;
      expect(result.isError).toBeFalsy();
      const payload = JSON.parse(result.content[0]!.text);
      expect(payload.timedOut).toBe(true);

      // The timeout exit path runs through the same `finally` cleanup as the
      // resolved path — the listener must be removed even when the wait
      // expires without a state transition.
      expect(innerBus.listenerCount("agent:state-changed")).toBe(baseline);
    });
  });
});
