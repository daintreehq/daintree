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
          id: "forge.listIssues" as ActionId,
          title: "List Issues",
          description: "List forge issues",
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
      const dispatchMock = vi.fn((_payload: DispatchRequest): ActionDispatchResult => ({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: "no view" },
      }));
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

    it("readResource for project issues dispatches forge.listIssues", async () => {
      const dispatchMock = vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (payload.actionId === "forge.listIssues") {
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
        expect.objectContaining({ actionId: "forge.listIssues" })
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
        timestamp: 1_700_000_000_000,
      });

      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({ uri: "daintree://agent/agent-xyz/state" });
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(content.mimeType).toBe("application/json");
      // A working agent has no exit metadata; lastTransitionAt tracks the last
      // state change.
      expect(JSON.parse(content.text)).toEqual({
        agentId: "agent-xyz",
        state: "working",
        lastTransitionAt: 1_700_000_000_000,
      });

      const missing = await client.readResource({ uri: "daintree://agent/agent-missing/state" });
      const missingContent = missing.contents[0] as {
        uri: string;
        mimeType: string;
        text: string;
      };
      expect(JSON.parse(missingContent.text)).toEqual({ agentId: "agent-missing", state: null });
    });

    it("readResource for an agent in waiting state surfaces waitingReason", async () => {
      const { events } = await import("../events.js");
      const { getAgentAvailabilityStore } = await import("../AgentAvailabilityStore.js");
      getAgentAvailabilityStore();
      events.emit("agent:state-changed", {
        agentId: "agent-waiting",
        state: "waiting",
        previousState: "working",
        trigger: "output",
        confidence: 1,
        waitingReason: "question",
        timestamp: 1_700_000_000_000,
      });

      const { window } = createMockWindow({ getManifest: manifestForResources });
      await service.start(window);
      const { client, transport } = await connectClient(service.currentPort!);
      transports.push(transport);

      const result = await client.readResource({ uri: "daintree://agent/agent-waiting/state" });
      const content = result.contents[0] as { uri: string; mimeType: string; text: string };
      expect(JSON.parse(content.text)).toEqual({
        agentId: "agent-waiting",
        state: "waiting",
        waitingReason: "question",
        lastTransitionAt: 1_700_000_000_000,
      });
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
      const dispatchMock = vi.fn((_payload: DispatchRequest): ActionDispatchResult => ({
        ok: true,
        result: [],
      }));
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
        service as unknown as { _resourceSubscriptions: Map<string, Map<string, () => void>> }
      )._resourceSubscriptions;
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
        service as unknown as { _resourceSubscriptions: Map<string, Map<string, () => void>> }
      )._resourceSubscriptions;
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
});
