import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

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
import { setProjectAgentMcpAccess } from "../projectEnablement.js";
import {
  MAX_PARKED_PLUGIN_MCP_REQUESTS_PER_CREDENTIAL,
  MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL,
  PluginMcpRoute,
  parsePluginMcpRoute,
  type PluginMcpRouteDeps,
} from "../pluginMcpRoute.js";
import {
  DATABASE_ENDPOINT_ID,
  PLUGIN_MCP_ROUTE_PREFIX,
  pluginMcpRoutePath,
  type AgentMcpToolInvoker,
  type AgentMcpToolScope,
} from "../types.js";
import { compileAgentMcpTool } from "../validateTools.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE = "acme.ledger";
const OTHER_INSTANCE = "acme.crm";
const ENDPOINT = "data";
const SERVER_NAME = "daintree-ledger";
const PLUGIN_ONLY: AgentMcpToolScope = { databases: false, pluginEndpointId: ENDPOINT };

const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});
const SUMMARY = compileAgentMcpTool({
  name: "summary",
  description: "Summarise the ledger.",
  inputSchema: { type: "object" },
});
const DATABASE_QUERY = compileAgentMcpTool({
  name: "database_query",
  description: "Run a read-only query.",
  inputSchema: { type: "object" },
  readOnly: true,
});

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
  /** Requests whose route handler has not settled yet. */
  inFlight: () => number;
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
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX)) {
      inFlight += 1;
      void handler.handle(req, res, url, port).finally(() => {
        inFlight -= 1;
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    inFlight: () => inFlight,
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
    scope: AgentMcpToolScope;
    serverName: string;
    projectId: string;
    terminalId: string;
  }> = {}
) {
  return pluginMcpGrantRegistry.issue({
    pluginInstanceId: INSTANCE,
    scope: PLUGIN_ONLY,
    serverName: SERVER_NAME,
    projectId: PROJECT_A,
    terminalId: "term-1",
    launchAgentIdHint: "claude",
    ...overrides,
  });
}

function routeUrl(instance = INSTANCE): string {
  return `http://127.0.0.1:${listener.port}${pluginMcpRoutePath(instance)}`;
}

async function connect(
  token: string,
  options: { url?: string; headers?: Record<string, string>; fetch?: typeof fetch } = {}
): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(options.url ?? routeUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...options.headers } },
    ...(options.fetch ? { fetch: options.fetch } : {}),
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

interface HeldRequest {
  /** The response status, or the error that ended the connection first. */
  outcome: Promise<number | Error>;
  finish: () => void;
  abort: () => void;
}

/**
 * An `initialize` POST sent all but its last byte, so the SDK sits in its body
 * read with the handshake admitted but not yet initialised.
 */
function holdInitialize(token: string): HeldRequest {
  const body = JSON.stringify(INIT_BODY);
  const request = http.request(routeUrl(), {
    method: "POST",
    agent: false,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  const outcome = new Promise<number | Error>((resolve) => {
    request.on("error", resolve);
    request.on("response", (response) => {
      response.on("error", () => {});
      response.resume();
      resolve(response.statusCode ?? 0);
    });
  });
  request.write(body.slice(0, -1));
  return {
    outcome,
    finish: () => request.end(body.slice(-1)),
    abort: () => request.destroy(),
  };
}

/** Every slot of the credential is free: exactly the cap is admitted, then 429. */
async function expectFullCapacity(token: string): Promise<void> {
  for (let i = 0; i < MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL; i++) {
    const response = await rawRequest({ token });
    expect(response.status).toBe(200);
    await response.body?.cancel();
  }
  expect((await rawRequest({ token })).status).toBe(429);
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
  setProjectAgentMcpAccess(PROJECT_A, INSTANCE, "read-write");
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
    const instance = "project__" + PROJECT_A + "__acme/ledger%v2 x";
    expect(pluginMcpRoutePath(instance)).not.toContain("/acme/");
    expect(parsePluginMcpRoute(pluginMcpRoutePath(instance))).toEqual({
      pluginInstanceId: instance,
    });
    expect(parsePluginMcpRoute("/mcp/plugin/acme.ledger")).toEqual({
      pluginInstanceId: "acme.ledger",
    });
  });

  it("names no plugin for a wrong segment count, empty segments or malformed escapes", () => {
    for (const path of [
      "/mcp/plugin/",
      "/mcp/plugin/acme.ledger/",
      "/mcp/plugin/acme.ledger/data",
      "/mcp/plugin/acme.ledger/%40databases",
      "/mcp/plugin/acme.ledger/data/",
      "/mcp/plugin//data",
      "/mcp/plugin/%E0%A4%A",
      "/mcp/plugins/acme.ledger",
      "/mcp/acme.ledger",
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

  it("serves the grant's rosters on one server named after the grant's server key", async () => {
    const databaseInvoke = vi.fn<AgentMcpToolInvoker>(async () => ({ rows: [] }));
    endpoints.register({
      pluginInstanceId: INSTANCE,
      endpointId: DATABASE_ENDPOINT_ID,
      tools: [DATABASE_QUERY],
      invoke: databaseInvoke,
    });
    const activatePlugin = vi.fn(async () => {});
    route.dispose();
    await listener.close();
    route = makeRoute({ activatePlugin });
    listener = await startListener(route);

    const { token } = issue({
      scope: { databases: true, pluginEndpointId: ENDPOINT },
      serverName: "daintree-ledger-1a2b3c4d",
    });
    const { client } = await connect(token);
    expect(client.getServerVersion()?.name).toBe("daintree-ledger-1a2b3c4d");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["database_query", "lookup", "summary"]);

    const { token: readOnly } = issue({ scope: { databases: true }, terminalId: "term-2" });
    const { client: narrow } = await connect(readOnly);
    activatePlugin.mockClear();
    expect((await narrow.listTools()).tools.map((tool) => tool.name)).toEqual(["database_query"]);
    const result = await narrow.callTool({ name: "database_query", arguments: {} });
    expect(result.isError).toBeUndefined();
    await expect(narrow.callTool({ name: "lookup", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    expect(activatePlugin).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
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

  it("answers arguments that break the input schema with a tool error, over HTTP too", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    const refused = await client.callTool({ name: "lookup", arguments: { id: 7 } });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("-32602");
    expect(JSON.stringify(refused.content)).toContain("/id must be string");
    expect(invoke).not.toHaveBeenCalled();

    const accepted = await client.callTool({ name: "lookup", arguments: { id: "r-1" } });
    expect(accepted.isError).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
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
    const response = await rawRequest({ token, url: routeUrl(OTHER_INSTANCE) });
    expect(response.status).toBe(403);
    expect(route.sessionCount).toBe(0);
  });

  it("rejects a credential presented on a pre-merge per-endpoint path of its own plugin", async () => {
    const { token } = issue();
    for (const suffix of [`/${ENDPOINT}`, `/${encodeURIComponent(DATABASE_ENDPOINT_ID)}`, "/"]) {
      const response = await rawRequest({ token, url: `${routeUrl()}${suffix}` });
      expect(response.status).toBe(403);
    }
    expect(route.sessionCount).toBe(0);
  });

  it("rejects a grant whose project has not given the plugin access", async () => {
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
    storeMock.data.set("projectAgentMcpAccess", {});
    await expect(client.listTools()).rejects.toMatchObject({ code: 403 });
  });

  it("closes the session when the plugin is switched off for the project", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    expect(route.sessionCount).toBe(1);

    setProjectAgentMcpAccess(PROJECT_A, INSTANCE, "off");
    expect(route.sessionCount).toBe(0);
    await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
  });

  it("closes only the sessions whose scope a lowered access no longer covers", async () => {
    const { token: readWrite } = issue({
      scope: { databases: true, pluginEndpointId: ENDPOINT },
      terminalId: "term-rw",
    });
    const { token: readOnly } = issue({ scope: { databases: true }, terminalId: "term-ro" });
    const { client: wide } = await connect(readWrite);
    const { client: narrow } = await connect(readOnly);
    expect(route.sessionCount).toBe(2);

    setProjectAgentMcpAccess(PROJECT_A, INSTANCE, "read-only");
    expect(route.sessionCount).toBe(1);
    await expect(wide.listTools()).rejects.toMatchObject({ code: 401 });
    await expect(narrow.listTools()).resolves.toBeDefined();
  });

  it("rejects a grant whose scope reaches past the project's current access", async () => {
    storeMock.data.set("projectAgentMcpAccess", {
      [PROJECT_A]: { [INSTANCE]: { decidedAt: 1, access: "read-only" } },
    });
    const { token } = issue({ scope: { databases: true, pluginEndpointId: ENDPOINT } });
    expect((await rawRequest({ token })).status).toBe(403);
    const { token: narrow } = issue({ scope: { databases: true }, terminalId: "term-2" });
    const allowed = await rawRequest({ token: narrow });
    expect(allowed.status).toBe(200);
    await allowed.body?.cancel();
  });

  it("asks the isGrantAllowed dependency with the presented grant on every request", async () => {
    route.dispose();
    await listener.close();
    let allowed = true;
    const isGrantAllowed = vi.fn(() => allowed);
    route = makeRoute({ isGrantAllowed });
    listener = await startListener(route);

    // No project answer at all: only the dependency decides.
    storeMock.data.clear();
    const { grant, token } = issue();
    const { client } = await connect(token);
    expect(isGrantAllowed).toHaveBeenCalledWith(grant);
    await client.listTools();
    allowed = false;
    await expect(client.listTools()).rejects.toMatchObject({ code: 403 });
  });

  it("parks a held credential's requests through a matching reload, on the same session", async () => {
    const { token } = issue();
    const { client } = await connect(token);
    expect(route.sessionCount).toBe(1);

    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    loaded.delete(INSTANCE);
    endpoints.unregisterPlugin(INSTANCE);
    const base = listener.inFlight();
    let listed: string[] | undefined;
    const listing = client.listTools().then(({ tools }) => {
      listed = tools.map((tool) => tool.name);
    });
    await waitFor(() => listener.inFlight() > base);
    expect(listed).toBeUndefined();
    expect(route.sessionCount).toBe(1);

    loaded.add(INSTANCE);
    endpoints.register({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      tools: [LOOKUP],
      invoke,
    });
    pluginMcpGrantRegistry.releasePlugin(INSTANCE, "surface-1");
    await listing;
    expect(listed).toEqual(["lookup"]);
    expect(route.sessionCount).toBe(1);
  });

  it("tells a kept credential's sessions to list again once the reload settles", async () => {
    const { token } = issue();
    // The client opens the standalone GET stream notifications travel on only
    // after `initialized` is accepted, without awaiting it, and the server drops
    // a notification sent before that stream is attached. The server registers
    // the stream before it answers the GET, so an OK response means it is there.
    const standaloneStream = deferred<void>();
    const { client } = await connect(token, {
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === "GET" && response.ok) standaloneStream.resolve();
        return response;
      },
    });
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });
    await standaloneStream.promise;

    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    pluginMcpGrantRegistry.releasePlugin(INSTANCE, "surface-1");

    await waitFor(() => notified > 0);
    expect(route.sessionCount).toBe(1);
  });

  it("wakes a parked request to a 401 when the reload changes the declared surface", async () => {
    const { token } = issue();
    await connect(token);

    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    const base = listener.inFlight();
    const parked = rawRequest({ token });
    await waitFor(() => listener.inFlight() > base);
    pluginMcpGrantRegistry.releasePlugin(INSTANCE, "surface-2");

    expect((await parked).status).toBe(401);
    expect(route.sessionCount).toBe(0);
  });

  it("wakes a parked request to a 401 when its terminal exits mid-reload", async () => {
    const { token } = issue();
    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    const base = listener.inFlight();
    const parked = rawRequest({ token });
    await waitFor(() => listener.inFlight() > base);

    pluginMcpGrantRegistry.revokeTerminal("term-1");
    pluginMcpGrantRegistry.releasePlugin(INSTANCE, "surface-1");

    expect((await parked).status).toBe(401);
    expect(route.sessionCount).toBe(0);
  });

  it("wakes parked requests when the listener stops, without filing a session", async () => {
    const { token } = issue();
    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    const base = listener.inFlight();
    const parked = rawRequest({ token });
    await waitFor(() => listener.inFlight() > base);

    route.closeAllSessions();

    expect((await parked).status).toBe(503);
    expect(route.sessionCount).toBe(0);
    pluginMcpGrantRegistry.revokeAll();
  });

  it("parks only a bounded number of one credential's requests", async () => {
    const { token } = issue();
    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    const base = listener.inFlight();
    const parked = Array.from({ length: MAX_PARKED_PLUGIN_MCP_REQUESTS_PER_CREDENTIAL }, () =>
      rawRequest({ token })
    );
    await waitFor(
      () => listener.inFlight() >= base + MAX_PARKED_PLUGIN_MCP_REQUESTS_PER_CREDENTIAL
    );

    const overflow = await rawRequest({ token });
    expect(overflow.status).toBe(503);

    pluginMcpGrantRegistry.releasePlugin(INSTANCE, "surface-2");
    for (const response of await Promise.all(parked)) expect(response.status).toBe(401);
  });

  it("answers a retryable 503 when the reload outlasts the wait", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ reloadWaitMs: 20 });
    listener = await startListener(route);
    const { token } = issue();

    pluginMcpGrantRegistry.holdPlugin(INSTANCE, "surface-1");
    const response = await rawRequest({ token });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(
      pluginMcpGrantRegistry.isLive(pluginMcpGrantRegistry.authenticate(token)!.credentialId)
    ).toBe(true);
    pluginMcpGrantRegistry.revokeAll();
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

  it("caps the sessions one credential may hold open", async () => {
    const { token } = issue();
    for (let i = 0; i < MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL; i++) {
      const response = await rawRequest({ token });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }

    const refused = await rawRequest({ token });
    expect(refused.status).toBe(429);
    expect(route.sessionCount).toBe(MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL);

    // Another credential is unaffected.
    const other = await rawRequest({ token: issue({ terminalId: "term-2" }).token });
    expect(other.status).toBe(200);
    await other.body?.cancel();
  });

  it("counts handshakes admitted concurrently against the cap", async () => {
    route.dispose();
    await listener.close();
    const loadCheck = deferred<boolean>();
    route = makeRoute({ isPluginLoaded: () => loadCheck.promise });
    listener = await startListener(route);

    const { token } = issue();
    const attempts = MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL + 4;
    // Settled into a value up front, so a failure before the barrier cannot
    // leave these rejecting unhandled.
    const pending = Array.from({ length: attempts }, () =>
      rawRequest({ token }).then(
        async (response) => {
          await response.body?.cancel();
          return response.status;
        },
        (err: unknown) => err
      )
    );
    await waitFor(() => listener.inFlight() === attempts);
    // Every request reaches the cap check in the same turn, before any
    // session has initialised.
    loadCheck.resolve(true);

    const statuses = await Promise.all(pending);
    expect(statuses.filter((status) => status === 200)).toHaveLength(
      MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL
    );
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    expect(route.sessionCount).toBe(MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL);
  });

  it("counts handshakes whose body is still arriving against the cap", async () => {
    const { token } = issue();
    const held = Array.from({ length: MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL }, () =>
      holdInitialize(token)
    );
    // The load check resolves synchronously, so a settled poll means each
    // handler has gone past admission into the SDK's body read.
    await waitFor(() => listener.inFlight() === MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL);
    expect(route.sessionCount).toBe(0);

    const refused = await rawRequest({ token });
    expect(refused.status).toBe(429);

    // One initialised plus seven still arriving is still the whole cap.
    held[0].finish();
    expect(await held[0].outcome).toBe(200);
    expect(route.sessionCount).toBe(1);
    expect((await rawRequest({ token })).status).toBe(429);

    for (const request of held.slice(1)) request.finish();
    expect(await Promise.all(held.map((request) => request.outcome))).toEqual(
      Array(MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL).fill(200)
    );
    expect(route.sessionCount).toBe(MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL);
  });

  it("drops a handshake that outlives the deadline and gives its slot back", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ handshakeTimeoutMs: 100 });
    listener = await startListener(route);

    const { token } = issue();
    const held = Array.from({ length: MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL }, () =>
      holdInitialize(token)
    );
    for (const outcome of await Promise.all(held.map((request) => request.outcome))) {
      expect(outcome).toBeInstanceOf(Error);
    }
    await waitFor(() => listener.inFlight() === 0);
    expect(route.sessionCount).toBe(0);
    await expectFullCapacity(token);
  });

  it("drops pending handshakes on revocation and when the listener stops", async () => {
    route.dispose();
    await listener.close();
    // Past the test timeout, so only the sweeps themselves can end these.
    route = makeRoute({ handshakeTimeoutMs: 60_000 });
    listener = await startListener(route);

    const { token } = issue();
    const { token: revokedToken } = issue({ terminalId: "term-2" });
    const revoked = holdInitialize(revokedToken);
    const unaffected = holdInitialize(token);
    const stopped = holdInitialize(token);
    await waitFor(() => listener.inFlight() === 3);

    pluginMcpGrantRegistry.revokeTerminal("term-2");
    expect(await revoked.outcome).toBeInstanceOf(Error);
    unaffected.finish();
    expect(await unaffected.outcome).toBe(200);

    route.closeAllSessions();
    expect(await stopped.outcome).toBeInstanceOf(Error);

    await waitFor(() => listener.inFlight() === 0);
    expect(route.sessionCount).toBe(0);
    await expectFullCapacity(token);
  });

  it("gives the slot back when a handshake fails or its client walks away", async () => {
    const { token } = issue();
    for (let i = 0; i < MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL; i++) {
      const rejected = await rawRequest({
        token,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(rejected.status).toBe(400);
    }

    const abandoned = Array.from({ length: MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL }, () =>
      holdInitialize(token)
    );
    await waitFor(() => listener.inFlight() === MAX_PLUGIN_MCP_SESSIONS_PER_CREDENTIAL);
    for (const request of abandoned) request.abort();
    await Promise.all(abandoned.map((request) => request.outcome));
    await waitFor(() => listener.inFlight() === 0);

    expect(route.sessionCount).toBe(0);
    await expectFullCapacity(token);
  });

  it("drops a pipelined handshake whose response is queued behind another", async () => {
    route.dispose();
    await listener.close();
    route = makeRoute({ handshakeTimeoutMs: 100 });
    listener = await startListener(route);

    const { token } = issue();
    const opened = await rawRequest({ token });
    const sessionId = opened.headers.get("mcp-session-id");
    await opened.body?.cancel();
    expect(sessionId).toBeTruthy();

    const socket = net.connect(listener.port, "127.0.0.1");
    socket.on("error", () => {});
    // Read what arrives: a paused socket never reports the server's close.
    socket.resume();
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const path = pluginMcpRoutePath(INSTANCE);
    const common = `Host: 127.0.0.1:${listener.port}\r\nAuthorization: Bearer ${token}\r\n`;
    const body = JSON.stringify(INIT_BODY);
    // The standalone SSE stream holds the connection's response slot, so the
    // handshake behind it has a response with no socket of its own yet.
    socket.write(
      `GET ${path} HTTP/1.1\r\n${common}Accept: text/event-stream\r\n` +
        `mcp-session-id: ${sessionId}\r\n\r\n` +
        `POST ${path} HTTP/1.1\r\n${common}Content-Type: application/json\r\n` +
        `Accept: application/json, text/event-stream\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, -1)}`
    );

    await closed;
    await waitFor(() => listener.inFlight() === 0);
    expect(route.sessionCount).toBe(1);
  });

  it("waits for a roster that registers after activation instead of listing nothing", async () => {
    endpoints.unregisterPlugin(INSTANCE);
    const { token } = issue();
    const { client } = await connect(token);

    const listing = client.listTools();
    setTimeout(() => {
      endpoints.register({
        pluginInstanceId: INSTANCE,
        endpointId: ENDPOINT,
        tools: [LOOKUP],
        invoke,
      });
    }, 20);

    const { tools } = await listing;
    expect(tools.map((tool) => tool.name)).toEqual(["lookup"]);
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
