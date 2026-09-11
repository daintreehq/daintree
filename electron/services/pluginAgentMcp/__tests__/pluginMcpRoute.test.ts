import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import type { PluginMcpCaller } from "../../../../shared/types/plugin.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { pluginMcpGrantRegistry } from "../grantRegistry.js";
import { setAgentMcpEndpointEnabled } from "../projectEnablement.js";
import { PluginMcpRoute, parsePluginMcpRoute, type PluginMcpRouteDeps } from "../pluginMcpRoute.js";
import {
  PLUGIN_MCP_ROUTE_PREFIX,
  pluginMcpRoutePath,
  type AgentMcpToolDescriptor,
  type AgentMcpToolInvoker,
} from "../types.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE = "acme.ledger";
const OTHER_INSTANCE = "acme.crm";
const ENDPOINT = "data";

const LOOKUP: AgentMcpToolDescriptor = {
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};
const SUMMARY: AgentMcpToolDescriptor = {
  name: "summary",
  description: "Summarise the ledger.",
  inputSchema: { type: "object" },
};

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "1.0.0" },
  },
};

interface Listener {
  port: number;
  close: () => Promise<void>;
}

let listener: Listener;
let route: PluginMcpRoute;
let endpoints: AgentMcpEndpointRegistry;
let loaded: Set<string>;
let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
const clients: Client[] = [];

async function startListener(handler: PluginMcpRoute): Promise<Listener> {
  let port = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX)) {
      void handler.handle(req, res, url, port);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function makeRoute(overrides: Partial<PluginMcpRouteDeps> = {}): PluginMcpRoute {
  return new PluginMcpRoute({
    isPluginLoaded: (id) => loaded.has(id),
    activatePlugin: async () => {},
    endpointRegistry: endpoints,
    ...overrides,
  });
}

function issue(
  overrides: Partial<{
    pluginInstanceId: string;
    endpointId: string;
    projectId: string;
    terminalId: string;
  }> = {}
) {
  return pluginMcpGrantRegistry.issue({
    pluginInstanceId: INSTANCE,
    endpointId: ENDPOINT,
    projectId: PROJECT_A,
    terminalId: "term-1",
    launchAgentIdHint: "claude",
    ...overrides,
  });
}

function routeUrl(instance = INSTANCE, endpoint = ENDPOINT): string {
  return `http://127.0.0.1:${listener.port}${pluginMcpRoutePath(instance, endpoint)}`;
}

async function connect(
  token: string,
  options: { url?: string; headers?: Record<string, string> } = {}
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url ?? routeUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...options.headers } },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

async function rawRequest(
  options: {
    token?: string;
    url?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  const method = options.method ?? "POST";
  const response = await fetch(options.url ?? routeUrl(), {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(options.body ?? INIT_BODY) } : {}),
  });
  return response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}

beforeEach(async () => {
  storeMock.data.clear();
  pluginMcpGrantRegistry.revokeAll();
  endpoints = new AgentMcpEndpointRegistry();
  loaded = new Set([INSTANCE, OTHER_INSTANCE]);
  invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
  endpoints.register({
    pluginInstanceId: INSTANCE,
    endpointId: ENDPOINT,
    tools: [LOOKUP, SUMMARY],
    invoke,
  });
  setAgentMcpEndpointEnabled(PROJECT_A, INSTANCE, ENDPOINT, true);
  route = makeRoute();
  listener = await startListener(route);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  route.dispose();
  await listener.close();
});

describe("parsePluginMcpRoute", () => {
  it("inverts pluginMcpRoutePath, including ids that need escaping", () => {
    const instance = "project__" + PROJECT_A + "__acme/ledger%v2";
    const endpoint = "data set";
    expect(parsePluginMcpRoute(pluginMcpRoutePath(instance, endpoint))).toEqual({
      pluginInstanceId: instance,
      endpointId: endpoint,
    });
  });

  it("names no endpoint for a wrong segment count, empty segments or malformed escapes", () => {
    for (const path of [
      "/mcp/plugin/acme.ledger",
      "/mcp/plugin/acme.ledger/",
      "/mcp/plugin/acme.ledger/data/",
      "/mcp/plugin/acme.ledger/data/extra",
      "/mcp/plugin//data",
      "/mcp/plugin/acme.ledger/%E0%A4%A",
    ]) {
      expect(parsePluginMcpRoute(path)).toBeNull();
    }
  });
});

describe("PluginMcpRoute", () => {
  it("serves a tools-only session listing exactly the registered roster", async () => {
    const { token } = issue();
    const { client } = await connect(token);

    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
    expect(client.getInstructions()).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["lookup", "summary"]);
    expect(tools[0].description).toBe(LOOKUP.description);
  });

  it("dispatches a listed tool with a frozen caller built from the grant", async () => {
    const { grant, token } = issue();
    const { client } = await connect(token);
    const result = await client.callTool({ name: "lookup", arguments: { id: "r-1" } });
    expect(result.isError).toBeUndefined();

    const caller = invoke.mock.calls[0][2];
    const expected: PluginMcpCaller = {
      credentialId: grant.credentialId,
      projectId: PROJECT_A,
      terminalId: "term-1",
      launchAgentIdHint: "claude",
    };
    expect(caller).toEqual(expected);
    expect(Object.isFrozen(caller)).toBe(true);
    expect(JSON.stringify(caller)).not.toContain(token);
  });

  it("answers a missing or orchestration bearer with a 401 challenge", async () => {
    for (const token of [undefined, "daintree-api-key-value", "pane-token-abc"]) {
      const response = await rawRequest(token === undefined ? {} : { token });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="Daintree plugin MCP"');
    }
    expect(route.sessionCount).toBe(0);
  });

  it("rejects a credential presented on another plugin's route", async () => {
    const { token } = issue();
    const response = await rawRequest({ token, url: routeUrl(OTHER_INSTANCE, ENDPOINT) });
    expect(response.status).toBe(403);
    expect(route.sessionCount).toBe(0);
  });

  it("rejects a credential presented on another endpoint of its own plugin", async () => {
    setAgentMcpEndpointEnabled(PROJECT_A, INSTANCE, "notes", true);
    const { token } = issue();
    const response = await rawRequest({ token, url: routeUrl(INSTANCE, "notes") });
    expect(response.status).toBe(403);
  });

  it("rejects a grant whose project has not enabled the endpoint", async () => {
    const { token } = issue({ projectId: PROJECT_B });
    const response = await rawRequest({ token });
    expect(response.status).toBe(403);
    expect(route.sessionCount).toBe(0);
  });

  it("re-checks enablement on every request", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    // The file is user-editable; a record removed behind the setter's back
    // must still stop the next request even though no revocation fired.
    storeMock.data.set("projectAgentMcpEnablement", {});
    await expect(client.listTools()).rejects.toMatchObject({ code: 403 });
  });

  it("closes the session when the endpoint is disabled for the project", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    expect(route.sessionCount).toBe(1);

    setAgentMcpEndpointEnabled(PROJECT_A, INSTANCE, ENDPOINT, false);
    expect(route.sessionCount).toBe(0);
    await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
  });

  it("rejects a request when the plugin instance is not loaded", async () => {
    loaded.delete(INSTANCE);
    const { token } = issue();
    const response = await rawRequest({ token });
    expect(response.status).toBe(403);
  });

  it("answers a session id held by another credential exactly like an unknown one", async () => {
    const { token: tokenA } = issue({ terminalId: "term-a" });
    const { token: tokenB } = issue({ terminalId: "term-b" });
    const { transport } = await connect(tokenA);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();

    const listBody = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const stolen = await rawRequest({
      token: tokenB,
      body: listBody,
      headers: { "mcp-session-id": sessionId! },
    });
    const unknown = await rawRequest({
      token: tokenB,
      body: listBody,
      headers: { "mcp-session-id": "00000000-0000-4000-8000-000000000000" },
    });
    expect(stolen.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await stolen.text()).toBe(await unknown.text());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a workspace selector naming another project", async () => {
    const { token } = issue();
    const forged = await rawRequest({ token, headers: { "Daintree-Workspace-Id": PROJECT_B } });
    expect(forged.status).toBe(400);
    const forgedQuery = await rawRequest({
      token,
      url: `${routeUrl()}?workspaceId=${PROJECT_B}`,
    });
    expect(forgedQuery.status).toBe(400);
    expect(route.sessionCount).toBe(0);
  });

  it("accepts a workspace selector matching the grant's project on every leg", async () => {
    const { token } = issue();
    const { client } = await connect(token, { headers: { "Daintree-Workspace-Id": PROJECT_A } });
    expect((await client.listTools()).tools).toHaveLength(2);
  });

  it("rejects a forged workspace selector on an established session", async () => {
    const { token } = issue();
    const { transport } = await connect(token);
    const response = await rawRequest({
      token,
      body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      headers: { "mcp-session-id": transport.sessionId!, "Daintree-Workspace-Id": PROJECT_B },
    });
    expect(response.status).toBe(400);
  });

  it("rejects a direct call to an unlisted tool without dispatching it", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    await expect(client.callTool({ name: "actions_list", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses methods other than GET, POST and DELETE", async () => {
    const { token } = issue();
    const response = await rawRequest({ token, method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("aborts an in-flight call on revocation and never delivers its late result", async () => {
    const pending = deferred<unknown>();
    let seen: AbortSignal | undefined;
    invoke.mockImplementation((_name, _args, _caller, signal) => {
      seen = signal;
      return pending.promise;
    });
    const { token } = issue();
    const { client } = await connect(token);
    // Settled into a value up front: the rejection lands while the test is
    // still asserting, and must not surface as unhandled in between.
    const outcome = client
      .callTool({ name: "lookup", arguments: {} }, undefined, { timeout: 1_000 })
      .then(
        () => "resolved",
        () => "rejected"
      );
    await waitFor(() => seen !== undefined);

    pluginMcpGrantRegistry.revokeTerminal("term-1");
    expect(seen?.aborted).toBe(true);
    expect(route.sessionCount).toBe(0);
    pending.resolve({ secret: "late" });

    expect(await outcome).toBe("rejected");
  });

  it("aborts a call that outlives the call timeout", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ callTimeoutMs: 25 });
    listener = await startListener(route);

    let seen: AbortSignal | undefined;
    invoke.mockImplementation((_name, _args, _caller, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const { token } = issue();
    const { client } = await connect(token);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it("turns a result over the byte cap into a tool error", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ maxResultBytes: 64 });
    listener = await startListener(route);

    invoke.mockImplementation(async () => ({ rows: "x".repeat(200) }));
    const { token } = issue();
    const { client } = await connect(token);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain("x".repeat(200));
  });

  it("does not file a session for a request the SDK never initialized", async () => {
    const { token } = issue();
    const response = await rawRequest({
      token,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });
    expect(response.status).toBe(400);
    expect(route.sessionCount).toBe(0);
  });

  it("does not file a session for GET or DELETE without a session id", async () => {
    const { token } = issue();
    for (const method of ["GET", "DELETE"]) {
      const response = await rawRequest({ token, method });
      expect(response.status).toBe(400);
      await response.body?.cancel();
    }
    expect(route.sessionCount).toBe(0);
  });

  it("files no session for a handshake that resumes after the listener stopped", async () => {
    route.dispose();
    await listener.close();
    const loadCheck = deferred<boolean>();
    let asked = false;
    route = makeRoute({
      isPluginLoaded: () => {
        asked = true;
        return loadCheck.promise;
      },
    });
    listener = await startListener(route);

    const { token } = issue();
    const pending = rawRequest({ token });
    await waitFor(() => asked);
    route.closeAllSessions();
    loadCheck.resolve(true);

    const response = await pending;
    expect(response.status).toBe(503);
    expect(route.sessionCount).toBe(0);
  });

  it("closes a session on DELETE and forgets it", async () => {
    const { token } = issue();
    const { transport } = await connect(token);
    expect(route.sessionCount).toBe(1);
    await transport.terminateSession();
    await waitFor(() => route.sessionCount === 0);
  });

  it("reaps an idle session", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ idleTimeoutMs: 250 });
    listener = await startListener(route);

    const { token } = issue();
    await connect(token);
    expect(route.sessionCount).toBe(1);
    await waitFor(() => route.sessionCount === 0);
  });

  it("closes every session and aborts in-flight calls on closeAllSessions", async () => {
    let seen: AbortSignal | undefined;
    invoke.mockImplementation((_name, _args, _caller, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const { token } = issue();
    const { client } = await connect(token);
    // Settled into a value up front: the rejection lands while the test is
    // still asserting, and must not surface as unhandled in between.
    const outcome = client
      .callTool({ name: "lookup", arguments: {} }, undefined, { timeout: 1_000 })
      .then(
        () => "resolved",
        () => "rejected"
      );
    await waitFor(() => seen !== undefined);

    route.closeAllSessions();
    expect(seen?.aborted).toBe(true);
    expect(route.sessionCount).toBe(0);
    expect(await outcome).toBe("rejected");
  });
});
