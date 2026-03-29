import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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

function createMockWindow(options?: {
  getManifest?: () => ActionManifestEntry[];
  dispatchAction?: (payload: DispatchRequest) => ActionDispatchResult;
}) {
  const getManifest = options?.getManifest ?? (() => []);
  const dispatchAction =
    options?.dispatchAction ??
    (() => ({
      ok: true,
      result: "ok",
    }));

  const webContents = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(
      (channel: string, payload: { requestId: string; actionId?: string; args?: unknown }) => {
        if (channel === "mcp:get-manifest-request") {
          queueMicrotask(() => {
            electronMocks.ipcMain.emit(
              "mcp:get-manifest-response",
              {},
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
              {},
              {
                requestId: payload.requestId,
                result: dispatchAction(payload as DispatchRequest),
              }
            );
          });
        }
      }
    ),
  };

  const window = {
    isDestroyed: vi.fn(() => false),
    webContents,
  };

  return {
    window: window as never,
    webContents,
  };
}

async function connectClient(
  port: number,
  headers?: Record<string, string>
): Promise<{ client: Client; transport: SSEClientTransport }> {
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`), {
    eventSourceInit: headers ? ({ headers } as never) : undefined,
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
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
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    storeState.mcpServer = {
      enabled: true,
      port: 0,
      apiKey: "",
    };
    storeMocks.get.mockClear();
    storeMocks.set.mockClear();
    electronMocks.ipcMain.removeAllListeners();
    electronMocks.ipcMain.handle.mockClear();
    electronMocks.ipcMain.removeHandler.mockClear();
    transports.length = 0;
    await fs.rm(path.join(testHomeDir, ".canopy"), { recursive: true, force: true });
    await fs.mkdir(testHomeDir, { recursive: true });
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
  });

  afterEach(async () => {
    for (const transport of transports) {
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
      description: "Reserved Canopy MCP metadata.",
      properties: {
        confirmed: {
          type: "boolean",
          description: "Must be true to execute this destructive action.",
        },
      },
      additionalProperties: false,
    });
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
    const discoveryFile = path.join(testHomeDir, ".canopy", "mcp.json");

    await service.start(window);

    const initial = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(initial.mcpServers.canopy.headers).toBeUndefined();

    const generatedKey = await service.generateApiKey();
    const generated = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(generated.mcpServers.canopy.headers).toEqual({
      Authorization: `Bearer ${generatedKey}`,
    });

    await service.setApiKey("");
    const cleared = JSON.parse(await fs.readFile(discoveryFile, "utf8")) as {
      mcpServers: Record<string, { headers?: { Authorization: string } }>;
    };
    expect(cleared.mcpServers.canopy.headers).toBeUndefined();
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
});
