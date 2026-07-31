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
import { setWindowRegistry } from "../../window/windowRef.js";

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
  mcpVisibility?: ActionManifestEntry["mcpVisibility"];
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
    // Eager listing is opt-in since #11540, and these suites assert what a
    // tier advertises. Default the fixtures to `core` so they keep measuring
    // the tier gate rather than silently emptying every tools/list response.
    mcpVisibility: entry.mcpVisibility ?? "core",
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

  it("starts when enabled mid-session after disabled boot skipped deferred startup", async () => {
    storeState.mcpServer = {
      ...storeState.mcpServer,
      enabled: false,
      port: 0,
    };
    const fresh = new McpServerService();
    currentService = fresh;
    const { window } = createMockWindow();
    setWindowRegistry(window);

    await fresh.setEnabled(true);

    expect(fresh.isRunning).toBe(true);
    expect(fresh.currentPort ?? 0).toBeGreaterThan(0);
    await fresh.stop();
    currentService = service;
  });

  it("lists tools without injecting _meta confirmation properties on destructive actions", async () => {
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
    expect(safeTool?.description).toBe("Read the action registry");
    // Confirmation is driven host-side by the native ConfirmDialog, not a
    // `_meta` schema property — the tool description and schema must not
    // advertise the legacy self-confirm bypass mechanism.
    expect(dangerousTool?.description).not.toContain("_meta");
    expect(dangerousTool?.description).not.toContain("Requires explicit confirmation");
    expect(safeTool?.inputSchema.additionalProperties).toBe(false);
    expect(dangerousTool?.inputSchema.additionalProperties).toBe(false);
    expect(dangerousTool?.inputSchema.properties).toEqual({
      worktreeId: { type: "string" },
    });
    expect(dangerousTool?.inputSchema.properties?._meta).toBeUndefined();

    // Annotations — query tool. readOnly/idempotent from kind: "query";
    // destructiveHint is false for queries (already declared read-only);
    // openWorldHint defaults to true per spec.
    expect(safeTool?.annotations).toEqual({
      title: "List Actions",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });

    // Annotations — destructive tool. `destructiveHint: true` is the
    // primary signal clients use to detect that a host confirmation will be
    // required on the next `tools/call` for this tool.
    expect(dangerousTool?.annotations).toEqual({
      title: "Delete Worktree",
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });

  it("applies mcpAnnotations overrides on top of kind/danger defaults", async () => {
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
          id: "git.stageFile" as ActionId,
          title: "Read Only Command",
          description: "Allowlisted command used for override coverage",
          kind: "command",
          danger: "safe",
          mcpAnnotations: { readOnlyHint: true, idempotentHint: true },
        }),
        // Query whose readOnly/idempotent hints are explicitly forced off via
        // override — guards against regressing the merge from `??` to `||`.
        createManifestEntry({
          id: "git.listCommits" as ActionId,
          title: "Query With False Overrides",
          description: "Allowlisted query whose hints are explicitly false",
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
    const readOnlyCmd = result.tools.find((t) => t.name === "git.stageFile");
    const queryFalse = result.tools.find((t) => t.name === "git.listCommits");

    // Override flips destructiveHint off; readOnlyHint/idempotentHint still
    // come from the `kind: "query"` default. openWorldHint now defaults to true.
    expect(generate?.annotations).toEqual({
      title: "Generate Context",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });

    // Override flips readOnly/idempotent on; destructiveHint derives from
    // danger: "safe" → false; openWorldHint defaults to true.
    expect(readOnlyCmd?.annotations).toEqual({
      title: "Read Only Command",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });

    // Explicit `false` overrides must win over danger-derived defaults —
    // this would silently break if `??` were ever swapped for `||`.
    // destructiveHint is false for queries (danger: "safe"); openWorldHint defaults
    // to true per spec.
    expect(queryFalse?.annotations).toEqual({
      title: "Query With False Overrides",
      readOnlyHint: false,
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("allows overriding openWorldHint via mcpAnnotations", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        // openWorldHint defaults to true; explicit false override must win.
        createManifestEntry({
          id: "worktree.delete" as ActionId,
          title: "Reset All Keybindings",
          description: "Local-only destructive action",
          category: "settings",
          kind: "command",
          danger: "confirm",
          mcpAnnotations: { openWorldHint: false },
        }),
        // No override — must default to true (spec-conservative).
        createManifestEntry({
          id: "forge.createPR" as ActionId,
          title: "Some GitHub Tool",
          description: "Tool without openWorldHint override",
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
    const localTool = result.tools.find((t) => t.name === "worktree.delete");
    const ghTool = result.tools.find((t) => t.name === "forge.createPR");

    expect(localTool?.annotations?.openWorldHint).toBe(false);
    expect(ghTool?.annotations?.openWorldHint).toBe(true);
  });

  it("defaults openWorldHint to true for all categories per spec", async () => {
    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "forge.listPRs" as ActionId,
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
          id: "worktree.createWithRecipe" as ActionId,
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
    const ghTool = result.tools.find((t) => t.name === "forge.listPRs");
    const systemTool = result.tools.find((t) => t.name === "system.checkCommand");
    const wtTool = result.tools.find((t) => t.name === "worktree.createWithRecipe");

    expect(ghTool?.annotations?.openWorldHint).toBe(true);
    expect(systemTool?.annotations?.openWorldHint).toBe(true);
    expect(wtTool?.annotations?.openWorldHint).toBe(true);
  });

  it("routes every ungated confirm call to host confirmation (renderer-modal dispatch)", async () => {
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

    const { window } = createMockWindow({
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
    // Every `danger: "confirm"` call is dispatched UNCONFIRMED to the renderer
    // bridge so the human approves it host-side — even for a client that
    // advertises `elicitation.form` and would auto-accept (#11342). The
    // capability + handler are installed precisely so `onElicit` being never
    // called is a genuine regression guard: reintroducing the vulnerable branch
    // would invoke it and flip the dispatch to confirmed:true.
    const onElicit = vi.fn(async (): Promise<ElicitResult> => ({ action: "accept", content: {} }));
    const { client, transport } = await connectClient(service.currentPort!, undefined, {
      capabilities: { elicitation: { form: {} } },
      onElicit,
    });
    transports.push(transport);

    const unconfirmed = getTextResult(
      await client.callTool({
        name: "worktree.delete",
        arguments: { worktreeId: "wt-123" },
      })
    );

    expect(onElicit).not.toHaveBeenCalled();
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.content[0]).toMatchObject({ type: "text" });
    expect(unconfirmed.content[0].text).toContain("CONFIRMATION_REQUIRED");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actionId: "worktree.delete",
        args: { worktreeId: "wt-123" },
        confirmed: false,
      })
    );
  });

  it("returns browser.captureScreenshot bytes as an MCP image content block", async () => {
    const dispatchMock = vi.fn((): ActionDispatchResult => ({
      ok: true,
      result: { pngBase64: "aGVsbG8=", width: 1024, height: 768 },
    }));

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "browser.captureScreenshot" as ActionId,
          title: "Capture Browser Screenshot",
          description:
            "Capture a screenshot of the focused browser panel and return it as a PNG image",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    // browser.captureScreenshot lives in the `action` tier — connect with a
    // token that resolves there so the tool is permitted.
    paneTokenTiers.set("token-action", "action");
    await service.start(window);
    const { client, transport } = await connectClient(service.currentPort!, {
      Authorization: "Bearer token-action",
    });
    transports.push(transport);

    const result = await client.callTool({
      name: "browser.captureScreenshot",
      arguments: {},
    });
    const content = result.content as Array<Record<string, unknown>>;

    expect(result.isError).toBeFalsy();
    // The base64 PNG is surfaced as a real image block, not text-serialized.
    expect(content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
    expect(content[1]).toMatchObject({ type: "text" });
    expect(String(content[1]!.text)).toContain("1024×768");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it("threads the external bearer's identity through to the renderer dispatch payload (#9157)", async () => {
    // Regression guard: the production `dispatchAction` wrapper in
    // McpServerService must forward the 4th `callerInfo` argument computed by
    // HttpLifecycle — dropping it silently broke the "Requested by" row while
    // every mocked unit test still passed.
    const dispatchMock = vi.fn((): ActionDispatchResult => ({
      ok: true,
      result: { listed: true },
    }));

    const { window } = createMockWindow({
      getManifest: () => [
        createManifestEntry({
          id: "actions.list" as ActionId,
          title: "List Actions",
          description: "List available actions",
          danger: "safe",
        }),
      ],
      dispatchAction: dispatchMock,
    });

    await service.start(window);
    const apiKey = service.getStatus().apiKey;
    const { client, transport } = await connectClient(service.currentPort!);
    transports.push(transport);

    await client.callTool({ name: "actions.list", arguments: {} });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const payload = (dispatchMock.mock.calls[0] as unknown as [DispatchRequest])[0];
    // External (api-key) dispatch carries display-only identity: the 4-char
    // token suffix and a non-empty user-agent. The raw key never crosses.
    expect(payload.callerInfo).toBeDefined();
    expect(payload.callerInfo?.token4LastChars).toBe(apiKey.slice(-4));
    expect(typeof payload.callerInfo?.userAgent).toBe("string");
    expect(payload.callerInfo?.userAgent.length).toBeGreaterThan(0);
  });

  it("strips legacy `_meta.confirmed=true` from arguments instead of bypassing confirmation", async () => {
    const dispatchMock = vi.fn((): ActionDispatchResult => ({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", message: "Need confirm" },
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

    // Legacy clients that still pass `_meta.confirmed=true` should NOT
    // self-confirm — host-side confirmation in the native ConfirmDialog is the
    // only way to approve a destructive action. The `_meta` key is stripped
    // from the args envelope before reaching the renderer.
    const result = getTextResult(
      await client.callTool({
        name: "worktree.delete",
        arguments: {
          worktreeId: "wt-123",
          _meta: { confirmed: true },
        },
      })
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CONFIRMATION_REQUIRED");
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        actionId: "worktree.delete",
        args: { worktreeId: "wt-123" },
        confirmed: false,
      })
    );
  });

  describe("host confirmation is authoritative — client elicitation is never authorization (#11342)", () => {
    type AuditEntry = {
      result: "success" | "error" | "confirmation-pending" | "unauthorized";
      errorCode?: string;
      confirmationDecision?: "approved" | "rejected" | "timeout";
    };

    function readAuditRecords(svc: McpServerService): AuditEntry[] {
      return (svc as unknown as { getAuditRecords: () => AuditEntry[] }).getAuditRecords();
    }

    function createDestructiveDispatchMock() {
      return vi.fn((payload: DispatchRequest): ActionDispatchResult => {
        if (!payload.confirmed) {
          return {
            ok: false,
            error: { code: "CONFIRMATION_REQUIRED", message: "Need confirm" },
          };
        }
        return {
          ok: true,
          result: { deleted: true },
        };
      });
    }

    it("dispatches only after the host renderer approves — the client's elicitation handler is never used", async () => {
      // The renderer bridge is the host-side confirmation surface: it receives
      // the UNCONFIRMED dispatch, shows the native ConfirmDialog, and on human
      // approval returns the result plus an "approved" decision. The malicious
      // client advertises `elicitation.form` and auto-accepts, but the server
      // must never consult it — approval authority lives host-side (#11342).
      const dispatchMock = vi.fn(() => ({
        result: { ok: true, result: { deleted: true } } as ActionDispatchResult,
        confirmationDecision: "approved" as const,
      }));
      const onElicit = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: {},
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
      const { client, transport } = await connectClient(service.currentPort!, undefined, {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      });
      transports.push(transport);

      const result = getTextResult(
        await client.callTool({
          name: "worktree.delete",
          arguments: { worktreeId: "wt-123" },
        })
      );

      // The self-declared elicitation capability is never exercised.
      expect(onElicit).not.toHaveBeenCalled();
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual({ deleted: true });
      // Exactly one dispatch, sent UNCONFIRMED — the renderer owns the confirm.
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          actionId: "worktree.delete",
          args: { worktreeId: "wt-123" },
          confirmed: false,
        })
      );

      const records = readAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("success");
      // The decision recorded is the host renderer's, not a client-forged one.
      expect(records[0].confirmationDecision).toBe("approved");
    });

    it("records USER_REJECTED from the host renderer without ever consulting the client", async () => {
      // Human clicked Cancel in the native dialog: the renderer bridge returns
      // USER_REJECTED with a "rejected" decision. The client's auto-accept
      // elicitation handler must never be reached (#11342).
      const dispatchMock = vi.fn(() => ({
        result: {
          ok: false,
          error: { code: "USER_REJECTED", message: "User rejected the confirmation request." },
        } as ActionDispatchResult,
        confirmationDecision: "rejected" as const,
      }));
      const onElicit = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: {},
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
      const { client, transport } = await connectClient(service.currentPort!, undefined, {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      });
      transports.push(transport);

      const result = getTextResult(
        await client.callTool({
          name: "worktree.delete",
          arguments: { worktreeId: "wt-123" },
        })
      );

      expect(onElicit).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("USER_REJECTED");
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ actionId: "worktree.delete", confirmed: false })
      );

      const records = readAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].errorCode).toBe("USER_REJECTED");
      expect(records[0].confirmationDecision).toBe("rejected");
    });

    it("records confirmation-pending when the host returns CONFIRMATION_REQUIRED — never falls back to elicitation", async () => {
      // The host confirmation surface returns CONFIRMATION_REQUIRED (the human
      // was not reached). The client advertises `elicitation.form` and
      // auto-accepts, but the server must NOT fall back to it to self-approve —
      // that fallback would be the exact self-approval vulnerability (#11342).
      // (The RendererBridgeUnavailableError no-window synthesis path itself is
      // covered end-to-end in sessionServer.test.ts.)
      const dispatchMock = createDestructiveDispatchMock();
      const onElicit = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: {},
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
      const { client, transport } = await connectClient(service.currentPort!, undefined, {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      });
      transports.push(transport);

      const result = getTextResult(
        await client.callTool({
          name: "worktree.delete",
          arguments: { worktreeId: "wt-123" },
        })
      );

      expect(onElicit).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("CONFIRMATION_REQUIRED");
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ actionId: "worktree.delete", confirmed: false })
      );

      const records = readAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("confirmation-pending");
      // No client-derived decision is ever recorded.
      expect(records[0].confirmationDecision).toBeUndefined();
    });

    it("keeps the host's approved decision in the audit even when the dispatch fails", async () => {
      // The human approved in the native dialog (renderer returns an "approved"
      // decision), but the underlying action then failed. The approval must
      // still be recorded — a later failure must not erase it from the trail.
      const dispatchMock = vi.fn(() => ({
        result: {
          ok: false,
          error: { code: "EXECUTION_ERROR", message: "action exploded" },
        } as ActionDispatchResult,
        confirmationDecision: "approved" as const,
      }));
      const onElicit = vi.fn(async (): Promise<ElicitResult> => ({
        action: "accept",
        content: {},
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
      const { client, transport } = await connectClient(service.currentPort!, undefined, {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      });
      transports.push(transport);

      const result = getTextResult(
        await client.callTool({
          name: "worktree.delete",
          arguments: { worktreeId: "wt-1" },
        })
      );

      expect(onElicit).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("EXECUTION_ERROR");
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      // The dispatch reached the renderer UNCONFIRMED — approval came from the
      // host envelope, never a client-forged confirmed:true (#11342).
      expect(dispatchMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ actionId: "worktree.delete", confirmed: false })
      );

      const records = readAuditRecords(service);
      expect(records).toHaveLength(1);
      expect(records[0].result).toBe("error");
      expect(records[0].errorCode).toBe("EXECUTION_ERROR");
      expect(records[0].confirmationDecision).toBe("approved");
    });

    it("never sends an elicitation request for non-destructive tools", async () => {
      const dispatchMock = vi.fn((): ActionDispatchResult => ({
        ok: true,
        result: ["a", "b"],
      }));
      const onElicit = vi.fn();
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
      const { client, transport } = await connectClient(service.currentPort!, undefined, {
        capabilities: { elicitation: { form: {} } },
        onElicit,
      });
      transports.push(transport);

      const result = getTextResult(await client.callTool({ name: "actions.list", arguments: {} }));

      expect(onElicit).not.toHaveBeenCalled();
      expect(result.isError).not.toBe(true);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });
  });
});
