import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PluginMcpCaller } from "../../../../shared/types/plugin.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { createPluginSessionServer } from "../pluginSessionServer.js";
import type { AgentMcpToolDescriptor, AgentMcpToolInvoker } from "../types.js";

const INSTANCE = "acme.ledger";
const ENDPOINT = "data";

const CALLER: PluginMcpCaller = Object.freeze({
  credentialId: "cred-1",
  projectId: "a".repeat(64),
  terminalId: "term-1",
  launchAgentIdHint: "claude",
});

const LOOKUP: AgentMcpToolDescriptor = {
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
};

const STRUCTURED: AgentMcpToolDescriptor = {
  name: "structured",
  description: "Returns a record.",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { total: { type: "number" } } },
};

interface Harness {
  client: Client;
  registry: AgentMcpEndpointRegistry;
  session: AbortController;
  activatePlugin: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
});

async function connect(
  invoke: AgentMcpToolInvoker,
  options: {
    tools?: AgentMcpToolDescriptor[];
    callTimeoutMs?: number;
    maxResultBytes?: number;
    register?: boolean;
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
  if (options.register !== false) register();
  const session = new AbortController();
  // Mirrors a lazy worker: the roster appears only once activation runs.
  const activatePlugin = vi.fn(async () => {
    if (options.register === false && !registry.get(INSTANCE, ENDPOINT)) register();
  });
  const server = createPluginSessionServer({
    pluginInstanceId: INSTANCE,
    endpointId: ENDPOINT,
    caller: CALLER,
    sessionSignal: session.signal,
    activatePlugin,
    endpointRegistry: registry,
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    ...(options.maxResultBytes !== undefined ? { maxResultBytes: options.maxResultBytes } : {}),
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
    const registry = new AgentMcpEndpointRegistry();
    const server = createPluginSessionServer({
      pluginInstanceId: INSTANCE,
      endpointId: ENDPOINT,
      caller: CALLER,
      sessionSignal: new AbortController().signal,
      activatePlugin: async () => {},
      endpointRegistry: registry,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toEqual([]);
    await client.close();
    await server.close();
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

  it("turns a thrown error into a tool error carrying the message and no stack", async () => {
    const invoke = vi.fn<AgentMcpToolInvoker>(async () => {
      throw new Error("ledger is locked");
    });
    const { client } = await connect(invoke);
    const result = await client.callTool({ name: "lookup", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("ledger is locked");
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
      endpointId: ENDPOINT,
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
});
