import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PluginMcpCaller } from "../../../../shared/types/plugin.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { createPluginSessionServer } from "../pluginSessionServer.js";
import {
  DATABASE_ENDPOINT_ID,
  type AgentMcpRegisteredTool,
  type AgentMcpToolInvoker,
  type AgentMcpToolScope,
} from "../types.js";
import { compileAgentMcpTool } from "../validateTools.js";

const INSTANCE = "acme.ledger";
const ENDPOINT = "data";
const SERVER_NAME = "daintree-ledger";
const PLUGIN_ONLY: AgentMcpToolScope = { databases: false, pluginEndpointId: ENDPOINT };
const DATABASES_ONLY: AgentMcpToolScope = { databases: true };
const READ_WRITE: AgentMcpToolScope = { databases: true, pluginEndpointId: ENDPOINT };

const CALLER: PluginMcpCaller = Object.freeze({
  credentialId: "cred-1",
  projectId: "a".repeat(64),
  terminalId: "term-1",
  launchAgentIdHint: "claude",
});

const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});

const STRUCTURED = compileAgentMcpTool({
  name: "structured",
  description: "Returns a record.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
});

const DATABASE_SCHEMA = compileAgentMcpTool({
  name: "database_schema",
  description: "Describe the plugin's databases.",
  inputSchema: { type: "object" },
  readOnly: true,
});

const DATABASE_QUERY = compileAgentMcpTool({
  name: "database_query",
  description: "Run a read-only query.",
  inputSchema: { type: "object", properties: { sql: { type: "string" } } },
  readOnly: true,
});

interface Harness {
  client: Client;
  registry: AgentMcpEndpointRegistry;
  session: AbortController;
  activatePlugin: ReturnType<typeof vi.fn>;
  registerDatabases: (invoke?: AgentMcpToolInvoker) => void;
  close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

async function connect(
  invoke: AgentMcpToolInvoker,
  options: {
    tools?: AgentMcpRegisteredTool[];
    callTimeoutMs?: number;
    maxResultBytes?: number;
    rosterWaitMs?: number;
    register?: boolean;
    scope?: AgentMcpToolScope;
    serverName?: string;
    /** Registers the host's database roster with this invoker. */
    databaseInvoke?: AgentMcpToolInvoker;
    activation?: "fails" | "registers-nothing";
    isCallerServable?: () => boolean;
  } = {}
): Promise<Harness> {
  const registry = new AgentMcpEndpointRegistry();
  const register = (): void => {
    registry.register({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      tools: options.tools ?? [LOOKUP],
      invoke,
    });
  };
  const registerDatabases = (databaseInvoke: AgentMcpToolInvoker = vi.fn()): void => {
    registry.register({
      pluginInstanceId: INSTANCE,
      endpointId: DATABASE_ENDPOINT_ID,
      tools: [DATABASE_SCHEMA, DATABASE_QUERY],
      invoke: databaseInvoke,
    });
  };
  if (options.register !== false && options.activation === undefined) register();
  if (options.databaseInvoke) registerDatabases(options.databaseInvoke);
  const session = new AbortController();
  // Mirrors a lazy worker: the roster appears only once activation runs.
  const activatePlugin = vi.fn(async () => {
    if (options.activation === "fails") throw new Error("worker crashed");
    if (options.activation === "registers-nothing") return;
    if (options.register === false && !registry.get(INSTANCE, ENDPOINT)) register();
  });
  const server = createPluginSessionServer({
    pluginInstanceId: INSTANCE,
    scope: options.scope ?? PLUGIN_ONLY,
    serverName: options.serverName ?? SERVER_NAME,
    caller: CALLER,
    sessionSignal: session.signal,
    activatePlugin,
    endpointRegistry: registry,
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
    ...(options.rosterWaitMs !== undefined ? { rosterWaitMs: options.rosterWaitMs } : {}),
    ...(options.isCallerServable !== undefined
      ? { isCallerServable: options.isCallerServable }
      : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const harness: Harness = {
    client,
    registry,
    session,
    activatePlugin,
    registerDatabases,
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
  open.push(harness);
  return harness;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((part) => part.text).join("");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met");
}

describe("createPluginSessionServer", () => {
  it("refuses to dispatch while the session's credential is not servable", async () => {
    const invoke = vi.fn(async () => "ok");
    let servable = false;
    const { client } = await connect(invoke, { isCallerServable: () => servable });

    const refused = await client.callTool({ name: "lookup", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/reloading/);
    expect(invoke).not.toHaveBeenCalled();

    servable = true;
    const served = await client.callTool({ name: "lookup", arguments: {} });
    expect(served.isError).toBeUndefined();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("advertises tools only, with no instructions", async () => {
    const { client } = await connect(vi.fn());
    expect(Object.keys(client.getServerCapabilities() ?? {})).toEqual(["tools"]);
    expect(client.getInstructions()).toBeUndefined();
    await expect(client.listResources()).rejects.toThrow();
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it("activates the plugin before listing, then lists exactly the registered roster", async () => {
    const { client, activatePlugin } = await connect(vi.fn(), {
      register: false,
      tools: [LOOKUP, STRUCTURED],
    });
    const { tools } = await client.listTools();
    expect(activatePlugin).toHaveBeenCalledWith(INSTANCE);
    expect(tools).toEqual([
      { name: LOOKUP.name, description: LOOKUP.description, inputSchema: LOOKUP.inputSchema },
      {
        name: STRUCTURED.name,
        description: STRUCTURED.description,
        inputSchema: STRUCTURED.inputSchema,
        outputSchema: STRUCTURED.outputSchema,
      },
    ]);
  });

  it("lists nothing when the plugin registered no roster", async () => {
    const { client, activatePlugin } = await connect(vi.fn(), {
      activation: "registers-nothing",
      rosterWaitMs: 20,
    });
    expect((await client.listTools()).tools).toEqual([]);
    expect(activatePlugin).toHaveBeenCalledWith(INSTANCE);
  });

  it("rejects a tool that is not in the current roster without dispatching it", async () => {
    const invoke = vi.fn();
    const { client } = await connect(invoke);
    await expect(client.callTool({ name: "delete_everything", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("hands the plugin the session's caller and the call's arguments", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
    const { client } = await connect(invoke);
    const result = await client.callTool({ name: "lookup", arguments: { id: "r-7" } });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ ok: true });
    const [toolName, args, caller, signal] = invoke.mock.calls[0];
    expect(toolName).toBe("lookup");
    expect(args).toEqual({ id: "r-7" });
    expect(caller).toBe(CALLER);
    expect(signal.aborted).toBe(false);
  });

  it("defaults missing arguments to an empty object", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => null);
    const { client } = await connect(invoke);
    await client.callTool({ name: "lookup" });
    expect(invoke.mock.calls[0][1]).toEqual({});
  });

  describe("input schema enforcement", () => {
    const RECORD = compileAgentMcpTool({
      name: "record",
      description: "Record an entry.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 8 },
          kind: { enum: ["debit", "credit"] },
          count: { type: "integer", default: 1 },
        },
        required: ["id"],
        additionalProperties: false,
      },
    });

    it.each([
      ["a missing required property", {}, /must have required property 'id'/],
      ["a wrong type", { id: 7 }, /\/id must be string/],
      ["a value outside the enum", { id: "a", kind: "refund" }, /\/kind must be equal to one/],
      ["an over-long string", { id: "a".repeat(9) }, /\/id must NOT have more than 8/],
      ["an undeclared property", { id: "a", extra: true }, /additional properties \("extra"\)/],
      ["a numeric string for an integer", { id: "a", count: "2" }, /\/count must be integer/],
    ])(
      "refuses %s as an InvalidParams tool error without dispatching",
      async (_label, args, why) => {
        const invoke = vi.fn<AgentMcpToolInvoker>(async () => null);
        const { client } = await connect(invoke, { tools: [RECORD] });
        const result = await client.callTool({ name: "record", arguments: args });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(
          /^MCP error -32602: Input validation error: .* tool record: /
        );
        expect(textOf(result)).toMatch(why);
        expect(invoke).not.toHaveBeenCalled();
      }
    );

    it("checks missing arguments, taken as an empty object, against the schema", async () => {
      const invoke = vi.fn<AgentMcpToolInvoker>(async () => null);
      const { client } = await connect(invoke, { tools: [RECORD] });
      const result = await client.callTool({ name: "record" });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/required property 'id'/);
      expect(invoke).not.toHaveBeenCalled();
    });

    it("hands conforming arguments over as sent — nothing defaulted, coerced or stripped", async () => {
      const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
      const { client } = await connect(invoke, { tools: [RECORD] });
      const refused = await client.callTool({ name: "record", arguments: { id: 1 } });
      expect(refused.isError).toBe(true);

      // A refused call leaves the session serving the next one.
      const result = await client.callTool({ name: "record", arguments: { id: "r-1" } });
      expect(result.isError).toBeUndefined();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][1]).toEqual({ id: "r-1" });
    });
  });

  it("returns structured content only for a tool that declares an output schema", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ total: 3 }));
    const { client } = await connect(invoke, { tools: [LOOKUP, STRUCTURED] });
    await client.listTools();

    const plain = await client.callTool({ name: "lookup", arguments: {} });
    expect(plain.structuredContent).toBeUndefined();

    const structured = await client.callTool({ name: "structured", arguments: {} });
    expect(structured.structuredContent).toEqual({ total: 3 });
    expect(JSON.parse(textOf(structured))).toEqual({ total: 3 });
  });

  it("makes a non-object result of a tool with an output schema a tool error", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => [1, 2, 3]);
    const { client } = await connect(invoke, { tools: [STRUCTURED] });
    await client.listTools();
    const result = await client.callTool({ name: "structured", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });

  it("makes a result that breaks the output schema a tool error", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ total: "three" }));
    const { client } = await connect(invoke, { tools: [STRUCTURED] });
    // No listTools first: the client then has no schema of its own to check
    // the result against, so only the host's check stands between them.
    const result = await client.callTool({ name: "structured", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toBe(
      "The tool returned a result that does not match its output schema: /total must be number"
    );
  });

  it("turns a thrown error into a tool error carrying the message and no stack", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => {
      throw new Error("ledger is locked");
    });
    const { client } = await connect(invoke);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("ledger is locked");
  });

  it("clips a long thrown error message to 2,000 characters", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => {
      throw new Error("x".repeat(2_500));
    });
    const { client } = await connect(invoke);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(textOf(result)).toBe(`${"x".repeat(2_000)}…`);
  });

  it("turns a value JSON cannot serialize into a tool error", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ amount: 10n }));
    const { client } = await connect(invoke);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cannot be serialized/);
  });

  it("turns a result over the byte cap into a tool error", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => "é".repeat(60));
    const { client } = await connect(invoke, { maxResultBytes: 100 });
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    // 60 two-byte characters plus quotes: over 100 bytes though under 100 chars.
    expect(textOf(result)).toMatch(/122 bytes/);
  });

  it("aborts a call that outlives the timeout", async () => {
    let seen: AbortSignal | undefined;
    const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const { client } = await connect(invoke, { callTimeoutMs: 20 });
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/timed out after 20 ms/);
    expect(seen?.aborted).toBe(true);
  });

  it("counts a slow activation against the call timeout", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
    const registry = new AgentMcpEndpointRegistry();
    registry.register({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      tools: [LOOKUP],
      invoke,
    });
    const server = createPluginSessionServer({
      pluginInstanceId: INSTANCE,
      scope: PLUGIN_ONLY,
      serverName: SERVER_NAME,
      caller: CALLER,
      sessionSignal: new AbortController().signal,
      activatePlugin: () => new Promise(() => {}),
      endpointRegistry: registry,
      callTimeoutMs: 20,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/timed out after 20 ms/);
    expect(invoke).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("does not treat the registration activation produced as a roster change", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => ({ ok: true }));
    const { client } = await connect(invoke, { register: false });
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight calls when the session closes and discards the late result", async () => {
    const pending = deferred<unknown>();
    let seen: AbortSignal | undefined;
    const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
      seen = signal;
      return pending.promise;
    });
    const { client, session } = await connect(invoke);
    const call = client.callTool({ name: "lookup", arguments: {} });
    await waitFor(() => seen !== undefined);

    session.abort();
    expect(seen?.aborted).toBe(true);
    pending.resolve({ secret: "late" });

    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain("late");
  });

  it("aborts in-flight calls when the endpoint's roster is replaced", async () => {
    const pending = deferred<unknown>();
    let seen: AbortSignal | undefined;
    const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
      seen = signal;
      return pending.promise;
    });
    const { client, registry } = await connect(invoke);
    const call = client.callTool({ name: "lookup", arguments: {} });
    await waitFor(() => seen !== undefined);

    registry.unregisterPlugin(INSTANCE);
    expect(seen?.aborted).toBe(true);
    pending.resolve({ value: 1 });
    const result = await call;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/tools changed/);
  });

  it("ignores roster changes on other endpoints", async () => {
    const pending = deferred<unknown>();
    let seen: AbortSignal | undefined;
    const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
      seen = signal;
      return pending.promise;
    });
    const { client, registry } = await connect(invoke);
    const call = client.callTool({ name: "lookup", arguments: {} });
    await waitFor(() => seen !== undefined);

    registry.register({
      pluginInstanceId: INSTANCE,
      endpointId: "other",
      tools: [LOOKUP],
      invoke: vi.fn(),
    });
    expect(seen?.aborted).toBe(false);
    pending.resolve({ value: 1 });
    expect((await call).isError).toBeUndefined();
  });

  it("aborts the plugin's signal when the client cancels the request", async () => {
    let seen: AbortSignal | undefined;
    const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    const { client } = await connect(invoke);
    const cancel = new AbortController();
    const call = client.callTool({ name: "lookup", arguments: {} }, undefined, {
      signal: cancel.signal,
    });
    await waitFor(() => seen !== undefined);
    cancel.abort();
    await expect(call).rejects.toThrow();
    await waitFor(() => seen?.aborted === true);
  });

  it("reports the server key the agent was handed as its server name", async () => {
    const { client } = await connect(vi.fn(), { serverName: "daintree-ledger-1a2b3c4d" });
    expect(client.getServerVersion()?.name).toBe("daintree-ledger-1a2b3c4d");
  });

  describe("scope", () => {
    it("lists the database tools first, then the plugin's own, on a read-write session", async () => {
      const { client } = await connect(vi.fn(), {
        scope: READ_WRITE,
        tools: [LOOKUP, STRUCTURED],
        databaseInvoke: vi.fn(),
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "database_schema",
        "database_query",
        "lookup",
        "structured",
      ]);
      expect(tools.map((tool) => tool.annotations)).toEqual([
        { readOnlyHint: true },
        { readOnlyHint: true },
        undefined,
        undefined,
      ]);
    });

    it("never lists a plugin tool under a reserved name, and routes that name to the host", async () => {
      const shadow = compileAgentMcpTool({ ...DATABASE_QUERY, readOnly: undefined });
      const pluginInvoke = vi.fn<AgentMcpToolInvoker>(async () => "plugin");
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>(async () => "host");
      const { client } = await connect(pluginInvoke, {
        scope: READ_WRITE,
        tools: [shadow, LOOKUP],
        databaseInvoke,
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "database_schema",
        "database_query",
        "lookup",
      ]);
      const result = await client.callTool({ name: "database_query", arguments: {} });
      expect(JSON.parse(textOf(result))).toBe("host");
      expect(pluginInvoke).not.toHaveBeenCalled();
    });

    it("lists and calls a databases-only session without ever activating the plugin", async () => {
      const pluginInvoke = vi.fn<AgentMcpToolInvoker>(async () => null);
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>(async () => ({ rows: [[1]] }));
      const { client, activatePlugin } = await connect(pluginInvoke, {
        scope: DATABASES_ONLY,
        databaseInvoke,
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["database_schema", "database_query"]);

      const result = await client.callTool({
        name: "database_query",
        arguments: { sql: "SELECT 1" },
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(textOf(result))).toEqual({ rows: [[1]] });
      expect(databaseInvoke.mock.calls[0][2]).toBe(CALLER);

      // The plugin's roster is registered, but out of this session's scope.
      await expect(client.callTool({ name: "lookup", arguments: {} })).rejects.toThrow(
        /Unknown tool/
      );
      expect(pluginInvoke).not.toHaveBeenCalled();
      expect(activatePlugin).not.toHaveBeenCalled();
    });

    it("calls a database tool on a read-write session without activating the plugin", async () => {
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>(async () => ({ databases: [] }));
      const { client, activatePlugin } = await connect(vi.fn(), {
        scope: READ_WRITE,
        databaseInvoke,
      });
      const result = await client.callTool({ name: "database_schema", arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(databaseInvoke).toHaveBeenCalledTimes(1);
      expect(activatePlugin).not.toHaveBeenCalled();
    });

    it("answers a database tool as unknown on a session whose scope has no databases", async () => {
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>(async () => null);
      const { client, activatePlugin } = await connect(vi.fn(), {
        scope: PLUGIN_ONLY,
        databaseInvoke,
      });
      await expect(client.callTool({ name: "database_query", arguments: {} })).rejects.toThrow(
        /Unknown tool/
      );
      expect(databaseInvoke).not.toHaveBeenCalled();
      expect(activatePlugin).not.toHaveBeenCalled();
    });

    it("lists only the plugin's own tools on a plugin-only session", async () => {
      const { client } = await connect(vi.fn(), {
        scope: PLUGIN_ONLY,
        databaseInvoke: vi.fn(),
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["lookup"]);
    });

    it.each([
      ["fails to activate", "fails" as const],
      ["activates without a roster", "registers-nothing" as const],
    ])("still lists the database tools when the plugin %s", async (_label, activation) => {
      const { client, activatePlugin } = await connect(vi.fn(), {
        scope: READ_WRITE,
        databaseInvoke: vi.fn(),
        activation,
        rosterWaitMs: 20,
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["database_schema", "database_query"]);
      expect(activatePlugin).toHaveBeenCalledWith(INSTANCE);
    });
  });

  describe("list_changed", () => {
    async function watch(harness: Harness): Promise<{ count: () => number }> {
      let count = 0;
      harness.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        count += 1;
      });
      return { count: () => count };
    }

    const otherEndpoint = (registry: AgentMcpEndpointRegistry): void => {
      registry.register({
        pluginInstanceId: INSTANCE,
        endpointId: "other",
        tools: [LOOKUP],
        invoke: vi.fn(),
      });
    };

    it("fires when either roster of a read-write session changes", async () => {
      const harness = await connect(vi.fn(), { scope: READ_WRITE, databaseInvoke: vi.fn() });
      const seen = await watch(harness);
      harness.registerDatabases();
      await waitFor(() => seen.count() === 1);
      harness.registry.register({
        pluginInstanceId: INSTANCE,
        endpointId: ENDPOINT,
        tools: [STRUCTURED],
        invoke: vi.fn(),
      });
      await waitFor(() => seen.count() === 2);
    });

    it("does not fire for an endpoint outside the session's scope", async () => {
      const harness = await connect(vi.fn(), { scope: DATABASES_ONLY, databaseInvoke: vi.fn() });
      const seen = await watch(harness);
      // Out of scope: the plugin's own roster, another endpoint, another instance.
      harness.registry.register({
        pluginInstanceId: INSTANCE,
        endpointId: ENDPOINT,
        tools: [STRUCTURED],
        invoke: vi.fn(),
      });
      otherEndpoint(harness.registry);
      harness.registry.register({
        pluginInstanceId: "other.plugin",
        endpointId: DATABASE_ENDPOINT_ID,
        tools: [DATABASE_SCHEMA],
        invoke: vi.fn(),
      });
      // Then an in-scope change, whose notification arrives after any stray one.
      harness.registerDatabases();
      await waitFor(() => seen.count() >= 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen.count()).toBe(1);
    });

    it("does not fire for the database roster on a plugin-only session", async () => {
      const harness = await connect(vi.fn(), { scope: PLUGIN_ONLY });
      const seen = await watch(harness);
      harness.registerDatabases();
      otherEndpoint(harness.registry);
      harness.registry.register({
        pluginInstanceId: INSTANCE,
        endpointId: ENDPOINT,
        tools: [STRUCTURED],
        invoke: vi.fn(),
      });
      await waitFor(() => seen.count() >= 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(seen.count()).toBe(1);
    });
  });

  describe("roster changes during a call", () => {
    it("keeps an in-flight database call when the plugin's own roster is replaced", async () => {
      const pending = deferred<unknown>();
      let seen: AbortSignal | undefined;
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
        seen = signal;
        return pending.promise;
      });
      const { client, registry } = await connect(vi.fn(), {
        scope: READ_WRITE,
        databaseInvoke,
      });
      const call = client.callTool({ name: "database_query", arguments: {} });
      await waitFor(() => seen !== undefined);

      registry.register({
        pluginInstanceId: INSTANCE,
        endpointId: ENDPOINT,
        tools: [STRUCTURED],
        invoke: vi.fn(),
      });
      expect(seen?.aborted).toBe(false);
      pending.resolve({ rows: [] });
      const result = await call;
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(textOf(result))).toEqual({ rows: [] });
    });

    it("aborts an in-flight database call when the database roster is replaced", async () => {
      const pending = deferred<unknown>();
      let seen: AbortSignal | undefined;
      const databaseInvoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
        seen = signal;
        return pending.promise;
      });
      const harness = await connect(vi.fn(), { scope: READ_WRITE, databaseInvoke });
      const call = harness.client.callTool({ name: "database_query", arguments: {} });
      await waitFor(() => seen !== undefined);

      harness.registerDatabases();
      expect(seen?.aborted).toBe(true);
      pending.resolve({ rows: [] });
      const result = await call;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/tools changed/);
    });

    it("keeps an in-flight plugin call when the database roster is replaced", async () => {
      const pending = deferred<unknown>();
      let seen: AbortSignal | undefined;
      const invoke = vi.fn<AgentMcpToolInvoker>((_name, _args, _caller, signal) => {
        seen = signal;
        return pending.promise;
      });
      const harness = await connect(invoke, { scope: READ_WRITE, databaseInvoke: vi.fn() });
      const call = harness.client.callTool({ name: "lookup", arguments: {} });
      await waitFor(() => seen !== undefined);

      harness.registerDatabases();
      expect(seen?.aborted).toBe(false);
      pending.resolve({ value: 1 });
      expect((await call).isError).toBeUndefined();
    });
  });
});
