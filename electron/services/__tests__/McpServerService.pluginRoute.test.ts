import fs from "node:fs/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The plugin route and the orchestration gate share one listener. Each is
// tested alone elsewhere; this suite proves the credentials do not cross.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-plugin-route-${Math.random().toString(36).slice(2)}`
);

const storeState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const mocked = { ...actual, homedir: () => testHomeDir };
  return { ...mocked, default: mocked };
});

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  webContents: { fromId: vi.fn(() => undefined), getAllWebContents: vi.fn(() => []) },
  BrowserWindow: class BrowserWindow {},
  app: { getVersion: () => "0.0.0-test", getPath: () => testHomeDir },
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) => storeState.values.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      storeState.values.set(key, value);
    }),
  },
  auditLogsStore: { get: vi.fn(() => []), set: vi.fn() },
}));

vi.mock("../persistence/auditRingStore.js", () => ({
  auditRingStore: { readAll: () => [], writeAll: vi.fn() },
}));

const paneTokenTiers = vi.hoisted(() => new Map<string, "workbench" | "action" | "system">());

vi.mock("../McpPaneConfigService.js", () => ({
  mcpPaneConfigService: {
    isValidPaneToken: (token: string) => paneTokenTiers.has(token),
    getTierForToken: (token: string) => paneTokenTiers.get(token),
    getWebContentsIdForToken: () => null,
    getActionContextForToken: () => null,
  },
}));

vi.mock("../SystemSleepService.js", () => ({
  getSystemSleepService: vi.fn(() => ({
    getAwakeTimeSince: vi.fn(() => 0),
    onWake: vi.fn(() => () => {}),
  })),
}));

const pluginHost = vi.hoisted(() => ({
  loaded: new Set<string>(),
  activatePlugin: vi.fn(async (_id: string) => {}),
}));

vi.mock("../PluginService.js", () => ({
  pluginService: {
    hasPlugin: (id: string) => pluginHost.loaded.has(id),
    activatePlugin: (id: string) => pluginHost.activatePlugin(id),
  },
}));

import { McpServerService } from "../McpServerService.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { pluginMcpGrantRegistry } from "../pluginAgentMcp/grantRegistry.js";
import { setAgentMcpEndpointEnabled } from "../pluginAgentMcp/projectEnablement.js";
import { pluginMcpRoutePath, type AgentMcpToolInvoker } from "../pluginAgentMcp/types.js";

const API_KEY = "orchestration-api-key";
const PANE_TOKEN = "pane-token-workbench";
const PROJECT = "c".repeat(64);
const INSTANCE = "acme.ledger";
const ENDPOINT = "data";

const emptyRegistry = {
  all: () => [],
  focusOrder: () => [],
  getPrimary: () => null,
  getByWindowId: () => null,
  getByWebContentsId: () => null,
  size: 0,
};

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
});

function post(port: number, path: string, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: INIT_BODY,
  });
}

describe("McpServerService plugin route", () => {
  let service: McpServerService;
  let unregister: (() => void) | null = null;
  let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
  const clients: Client[] = [];

  beforeEach(async () => {
    storeState.values.clear();
    storeState.values.set("mcpServer", {
      enabled: true,
      port: 0,
      apiKey: API_KEY,
      auditEnabled: false,
      auditMaxRecords: 500,
    });
    paneTokenTiers.clear();
    paneTokenTiers.set(PANE_TOKEN, "workbench");
    pluginHost.loaded = new Set([INSTANCE]);
    pluginHost.activatePlugin.mockClear();
    pluginMcpGrantRegistry.revokeAll();
    invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
    unregister = agentMcpEndpointRegistry.register({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      tools: [
        { name: "lookup", description: "Look a record up.", inputSchema: { type: "object" } },
      ],
      invoke,
    });
    setAgentMcpEndpointEnabled(PROJECT, INSTANCE, ENDPOINT, true);
    await fs.mkdir(testHomeDir, { recursive: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    service = new McpServerService();
    await service.start(emptyRegistry as never);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    if (service.isRunning) await service.stop();
    unregister?.();
    pluginMcpGrantRegistry.revokeAll();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fs.rm(testHomeDir, { recursive: true, force: true });
  });

  function issue() {
    return pluginMcpGrantRegistry.issue({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      projectId: PROJECT,
      terminalId: "term-1",
    });
  }

  async function connectPlugin(token: string): Promise<Client> {
    const port = service.currentPort!;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}${pluginMcpRoutePath(INSTANCE, ENDPOINT)}`),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
    );
    const client = new Client({ name: "plugin-test", version: "1.0.0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it("serves a plugin grant on its route, activating the plugin lazily", async () => {
    const { token } = issue();
    const client = await connectPlugin(token);
    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["lookup"]);
    expect(pluginHost.activatePlugin).toHaveBeenCalledWith(INSTANCE);
  });

  it("refuses a plugin grant on the orchestration endpoints", async () => {
    const { token } = issue();
    const port = service.currentPort!;
    const onMcp = await post(port, "/mcp", token);
    expect(onMcp.status).toBe(401);
    expect(onMcp.headers.get("www-authenticate")).toBe('Bearer realm="Daintree MCP"');
    const onSse = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(onSse.status).toBe(401);
  });

  it("refuses orchestration bearers on the plugin route", async () => {
    const port = service.currentPort!;
    const path = pluginMcpRoutePath(INSTANCE, ENDPOINT);
    for (const token of [API_KEY, PANE_TOKEN]) {
      // Each is accepted by the orchestration gate — the contrast is the point.
      const orchestration = await post(port, "/mcp", token);
      expect(orchestration.status).toBe(200);
      await orchestration.body?.cancel();

      const plugin = await post(port, path, token);
      expect(plugin.status).toBe(401);
      expect(plugin.headers.get("www-authenticate")).toBe('Bearer realm="Daintree plugin MCP"');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a plugin route request when the plugin instance is not loaded", async () => {
    pluginHost.loaded.clear();
    const { token } = issue();
    const response = await post(
      service.currentPort!,
      pluginMcpRoutePath(INSTANCE, ENDPOINT),
      token
    );
    expect(response.status).toBe(403);
  });

  it("aborts in-flight plugin calls when the server stops", async () => {
    let seen: AbortSignal | undefined;
    invoke.mockImplementation((_name, _args, _caller, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const { token } = issue();
    const client = await connectPlugin(token);
    // Settled into a value up front: the rejection lands while the test is
    // still asserting, and must not surface as unhandled in between.
    const outcome = client
      .callTool({ name: "lookup", arguments: {} }, undefined, { timeout: 1_000 })
      .then(
        () => "resolved",
        () => "rejected"
      );
    for (let i = 0; i < 200 && seen === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(seen).toBeDefined();

    await service.stop();
    expect(seen?.aborted).toBe(true);
    expect(await outcome).toBe("rejected");
  });
});
