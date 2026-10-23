import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  makeProjectPluginInstanceKey,
  type McpServerContribution,
  type PluginAgentMcpServerSource,
  type PluginMcpCaller,
} from "../../../../shared/types/plugin.js";
import { PluginMcpSupervisor } from "../../PluginMcpSupervisor.js";
import { ContributedServerEndpoints } from "../contributedServerEndpoint.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import { createPluginSessionServer } from "../pluginSessionServer.js";
import type {
  AgentMcpServerSourceLookup,
  AgentMcpToolGroupRef,
  AgentMcpToolScope,
} from "../types.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "syntheticMcpServer.mjs"
);
const ENDPOINT = "catalog";
const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const INSTANCE_A = makeProjectPluginInstanceKey(PROJECT_A, "acme.catalog");
const INSTANCE_B = makeProjectPluginInstanceKey(PROJECT_B, "acme.catalog");

const SOURCE: PluginAgentMcpServerSource = {
  mcpServer: "synthetic",
  tools: [
    { name: "echo", serverTool: "echo-text" },
    { name: "who", serverTool: "whoami" },
    { name: "failing", serverTool: "fail" },
    { name: "picture", serverTool: "image" },
    { name: "huge", serverTool: "big" },
    { name: "wait", serverTool: "slow" },
    { name: "die", serverTool: "crash" },
    { name: "pinger", serverTool: "ask-ping" },
    { name: "changer", serverTool: "change-tools" },
  ],
};

function server(overrides: Partial<McpServerContribution> = {}): McpServerContribution {
  return {
    id: "synthetic",
    name: "Synthetic server",
    command: process.execPath,
    args: [FIXTURE],
    env: { FIXTURE_LABEL: "${settings:label}" },
    ...overrides,
  };
}

interface Instance {
  source: PluginAgentMcpServerSource;
  contribution: McpServerContribution;
  groups?: AgentMcpToolGroupRef[];
  label: string;
}

const supervisors: PluginMcpSupervisor[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  for (const supervisor of supervisors.splice(0)) await supervisor.shutdownAll().catch(() => {});
});

function setup(instances: Record<string, Instance>) {
  const supervisor = new PluginMcpSupervisor({ killTree: () => {} });
  supervisors.push(supervisor);
  const registry = new AgentMcpEndpointRegistry();
  const resolveSettings = vi.fn(async (instanceId: string, settingId: string) =>
    settingId === "label" ? (instances[instanceId]?.label ?? "") : ""
  );
  const findSource = (instanceId: string): AgentMcpServerSourceLookup | undefined => {
    const instance = instances[instanceId];
    if (!instance) return undefined;
    return {
      endpointId: ENDPOINT,
      groups: instance.groups ?? [],
      source: instance.source,
      contribution: instance.contribution,
      pluginDir: path.dirname(FIXTURE),
      declaredQueryNames: [],
    };
  };
  const endpoints = new ContributedServerEndpoints({
    findSource,
    resolveSettings,
    supervisor,
    registry,
    retryBaseMs: 0,
  });
  closers.push(async () => endpoints.dispose());
  return { supervisor, registry, endpoints, resolveSettings };
}

async function connect(
  env: ReturnType<typeof setup>,
  instanceId: string,
  projectId: string,
  options: { scope?: AgentMcpToolScope; callTimeoutMs?: number } = {}
) {
  const caller: PluginMcpCaller = {
    credentialId: `cred-${instanceId}`,
    projectId,
    terminalId: "term-1",
    launchAgentIdHint: "claude",
  };
  const session = new AbortController();
  const sessionServer = createPluginSessionServer({
    pluginInstanceId: instanceId,
    scope: options.scope ?? { databases: false, pluginEndpointId: ENDPOINT },
    serverName: "daintree-catalog",
    caller,
    sessionSignal: session.signal,
    // As McpServerService wires it: activation, then the bridged endpoint,
    // whose failure leaves the endpoint without a roster.
    activatePlugin: async (id) => {
      await env.endpoints.ensure(id).catch(() => {});
    },
    endpointRegistry: env.registry,
    rosterWaitMs: 50,
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await sessionServer.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => {
    session.abort();
    await client.close().catch(() => {});
    await sessionServer.close().catch(() => {});
  });
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join("");
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const instanceA = (overrides: Partial<Instance> = {}): Instance => ({
  source: SOURCE,
  contribution: server(),
  label: "alpha",
  ...overrides,
});

describe("ContributedServerEndpoints", () => {
  it("starts nothing until an agent asks, and nothing at all for a plugin without a source", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const listen = vi.spyOn(env.supervisor, "onDidInvalidateTools");

    await env.endpoints.ensure("acme.other");
    expect(env.supervisor.list()).toEqual([]);
    expect(listen).not.toHaveBeenCalled();
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();

    const client = await connect(env, INSTANCE_A, PROJECT_A);
    expect(env.supervisor.list()).toEqual([]);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      SOURCE.tools.map((tool) => tool.name).sort()
    );
    expect(env.supervisor.list().map((info) => info.status)).toEqual(["ready"]);
  }, 20_000);

  it("serves only the allowlisted tools, under their agent names, with the server's schema and no server hints", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A);

    const { tools } = await client.listTools();
    const echo = tools.find((tool) => tool.name === "echo");
    expect(echo?.description).toBe("Echo the given text back.");
    expect(echo?.inputSchema).toMatchObject({ required: ["text"] });
    expect(echo?.annotations).toBeUndefined();
    // An empty server description falls back to naming the server tool.
    expect(tools.find((tool) => tool.name === "who")?.description).toBe(
      "whoami from Synthetic server"
    );
    expect(tools.some((tool) => tool.name === "secret" || tool.name === "echo-text")).toBe(false);

    await expect(client.callTool({ name: "secret", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
  }, 20_000);

  it("forwards text and a tool error as the server gave them, and refuses other content and oversized results", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A);

    const echoed = await client.callTool({ name: "echo", arguments: { text: "hi there" } });
    expect(echoed.isError).toBeFalsy();
    expect(textOf(echoed)).toBe("hi there");

    const failed = await client.callTool({ name: "failing", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe("it broke");

    const picture = await client.callTool({ name: "picture", arguments: {} });
    expect(picture.isError).toBe(true);
    expect(textOf(picture)).toMatch(/image content.*only text is supported/);

    const huge = await client.callTool({ name: "huge", arguments: {} });
    expect(huge.isError).toBe(true);
    expect(textOf(huge)).toMatch(/over the \d+-byte limit/);

    // Arguments are checked against the server's schema before it is called.
    const invalid = await client.callTool({ name: "echo", arguments: {} });
    expect(invalid.isError).toBe(true);
  }, 20_000);

  it("cancels a call that runs out of time on the wire and drops the late answer", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A, { callTimeoutMs: 1_500 });
    await client.listTools();

    const slow = await client.callTool({ name: "wait", arguments: {} });
    expect(slow.isError).toBe(true);
    expect(textOf(slow)).toMatch(/time/i);

    await waitFor(
      () =>
        env.supervisor
          .getStderr(INSTANCE_A, "synthetic")
          .lines.some((line) => line.startsWith("cancelled ")),
      "the server to see the cancellation"
    );
    // The server's late answer to the cancelled id resolves nothing; the next
    // call gets its own answer.
    const after = await client.callTool({ name: "echo", arguments: { text: "next" } });
    expect(textOf(after)).toBe("next");
  }, 20_000);

  it("answers the server's own ping without mistaking it for the answer to the call whose id it shares", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A);

    const result = await client.callTool({ name: "pinger", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("pong received");
  }, 20_000);

  it("drops the roster when the server crashes, tells the session, and serves a fresh server on the next demand", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });

    const before = textOf(await client.callTool({ name: "who", arguments: {} }));
    // The first registration announces itself; only a later notice is the drop.
    await waitFor(() => changed > 0, "the registration notice");
    const changedBeforeCrash = changed;
    const crashed = await client.callTool({ name: "die", arguments: {} });
    expect(crashed.isError).toBe(true);
    await waitFor(() => env.registry.get(INSTANCE_A, ENDPOINT) === undefined, "the roster drop");
    await waitFor(() => changed > changedBeforeCrash, "tools/list_changed for the drop");

    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name === "who")).toBe(true);
    const after = textOf(await client.callTool({ name: "who", arguments: {} }));
    expect(after.split(":")[0]).toBe("alpha");
    expect(after).not.toBe(before);
  }, 30_000);

  it("re-reads the roster after the server says its tools changed, still serving only the allowlist", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    const client = await connect(env, INSTANCE_A, PROJECT_A);
    const first = env.registry.get(INSTANCE_A, ENDPOINT);
    expect(first).toBeUndefined();
    await client.listTools();
    const registered = env.registry.get(INSTANCE_A, ENDPOINT);

    await client.callTool({ name: "changer", arguments: {} });
    await waitFor(() => env.registry.get(INSTANCE_A, ENDPOINT) !== registered, "the roster drop");

    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name === "extra")).toBe(false);
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeDefined();
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).not.toBe(registered);
  }, 20_000);

  it("serves each project's copy from its own server and settings, and stopping one leaves the other working", async () => {
    const env = setup({
      [INSTANCE_A]: instanceA(),
      [INSTANCE_B]: instanceA({ label: "beta" }),
    });
    const clientA = await connect(env, INSTANCE_A, PROJECT_A);
    const clientB = await connect(env, INSTANCE_B, PROJECT_B);

    const whoA = textOf(await clientA.callTool({ name: "who", arguments: {} }));
    const whoB = textOf(await clientB.callTool({ name: "who", arguments: {} }));
    expect(whoA.split(":")[0]).toBe("alpha");
    expect(whoB.split(":")[0]).toBe("beta");
    expect(whoA.split(":")[1]).not.toBe(whoB.split(":")[1]);
    expect(env.resolveSettings).toHaveBeenCalledWith(INSTANCE_A, "label");
    expect(env.resolveSettings).toHaveBeenCalledWith(INSTANCE_B, "label");

    // What an unload does: the supervisor stops A's server.
    await env.supervisor.shutdown({ pluginId: INSTANCE_A });
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
    expect(textOf(await clientB.callTool({ name: "who", arguments: {} }))).toBe(whoB);
  }, 30_000);

  it("lists and runs only the groups a grant allows", async () => {
    const groups: AgentMcpToolGroupRef[] = [
      { id: "read", access: "read" },
      { id: "write", access: "write" },
    ];
    const env = setup({
      [INSTANCE_A]: instanceA({
        groups,
        source: {
          mcpServer: "synthetic",
          tools: [
            { name: "echo", serverTool: "echo-text", group: "read" },
            { name: "failing", serverTool: "fail", group: "write" },
          ],
        },
      }),
    });
    const readOnly = await connect(env, INSTANCE_A, PROJECT_A, {
      scope: { databases: false, pluginEndpointId: ENDPOINT, pluginGroups: [groups[0]!] },
    });

    const { tools } = await readOnly.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    await expect(readOnly.callTool({ name: "failing", arguments: {} })).rejects.toThrow(
      /Unknown tool/
    );
    expect(textOf(await readOnly.callTool({ name: "echo", arguments: { text: "ok" } }))).toBe("ok");
  }, 20_000);

  it("serves nothing when the server cannot start or lacks a selected tool", async () => {
    const env = setup({
      [INSTANCE_A]: instanceA({ contribution: server({ command: "daintree-no-such-binary" }) }),
      [INSTANCE_B]: instanceA({
        source: { mcpServer: "synthetic", tools: [{ name: "gone", serverTool: "missing" }] },
      }),
    });

    await expect(env.endpoints.ensure(INSTANCE_A)).rejects.toThrow();
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
    await expect(env.endpoints.ensure(INSTANCE_B)).rejects.toThrow(/lists no tool "missing"/);
    expect(env.registry.get(INSTANCE_B, ENDPOINT)).toBeUndefined();

    const client = await connect(env, INSTANCE_A, PROJECT_A);
    expect((await client.listTools()).tools).toEqual([]);
  }, 20_000);

  it("releases its registrations and its supervisor subscription on dispose", async () => {
    const env = setup({ [INSTANCE_A]: instanceA() });
    await env.endpoints.ensure(INSTANCE_A);
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeDefined();

    env.endpoints.dispose();
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
    // A later invalidation reaches no listener.
    await env.supervisor.shutdown({ pluginId: INSTANCE_A });
    expect(env.registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
  }, 20_000);
});

describe("ContributedServerEndpoints fencing", () => {
  type Listener = Parameters<PluginMcpSupervisor["onDidInvalidateTools"]>[0];

  function fakeSupervisor(options: { description?: string } = {}) {
    const listeners = new Set<Listener>();
    let releaseStart: (() => void) | null = null;
    const gate = { held: false };
    const supervisor = {
      start: vi.fn(async () => {
        if (!gate.held) return;
        await new Promise<void>((resolve) => {
          releaseStart = resolve;
        });
      }),
      getFullSchema: vi.fn(async (_pluginId: string, _serverId: string, toolName: string) => ({
        found: true as const,
        tool: {
          name: toolName,
          description: options.description ?? "",
          inputSchema: { type: "object" },
        },
      })),
      callTool: vi.fn(async () => ({ content: [] })),
      onDidInvalidateTools: vi.fn((listener: Listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
    };
    return {
      supervisor,
      gate,
      release: () => releaseStart?.(),
      emit: (pluginId: string, serverId: string, reason: "changed" | "exited" | "stopped") => {
        for (const listener of listeners) listener(pluginId, serverId, reason);
      },
      listenerCount: () => listeners.size,
    };
  }

  function adapter(
    fake: ReturnType<typeof fakeSupervisor>,
    instance: Partial<Instance> = {},
    retryBaseMs = 0
  ) {
    const registry = new AgentMcpEndpointRegistry();
    const lookup: AgentMcpServerSourceLookup = {
      endpointId: ENDPOINT,
      groups: instance.groups ?? [],
      source: instance.source ?? {
        mcpServer: "synthetic",
        tools: [{ name: "who", serverTool: "whoami" }],
      },
      contribution: instance.contribution ?? server(),
      pluginDir: "/plugins/acme",
      declaredQueryNames: [],
    };
    const endpoints = new ContributedServerEndpoints({
      findSource: (id) => (id === INSTANCE_A ? lookup : undefined),
      resolveSettings: async () => "",
      supervisor: fake.supervisor as never,
      registry,
      retryBaseMs,
    });
    return { endpoints, registry };
  }

  it("never registers a bind that was still running when it was disposed", async () => {
    const fake = fakeSupervisor();
    fake.gate.held = true;
    const { endpoints, registry } = adapter(fake);

    const pending = endpoints.ensure(INSTANCE_A);
    await waitFor(() => fake.supervisor.start.mock.calls.length > 0, "start");
    endpoints.dispose();
    fake.release();

    await expect(pending).rejects.toThrow(/disposed/);
    expect(registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
    expect(fake.listenerCount()).toBe(0);
    await endpoints.ensure(INSTANCE_A);
    expect(fake.supervisor.start).toHaveBeenCalledTimes(1);
  });

  it("fences a bind only on its own server, not on another server of the same plugin", async () => {
    const fake = fakeSupervisor();
    fake.gate.held = true;
    const { endpoints, registry } = adapter(fake);

    const pending = endpoints.ensure(INSTANCE_A);
    await waitFor(() => fake.supervisor.start.mock.calls.length > 0, "start");
    fake.emit(INSTANCE_A, "other-server", "exited");
    fake.release();
    await pending;
    expect(registry.get(INSTANCE_A, ENDPOINT)).toBeDefined();

    fake.gate.held = true;
    fake.emit(INSTANCE_A, "synthetic", "changed");
    expect(registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
    const again = endpoints.ensure(INSTANCE_A);
    await waitFor(() => fake.supervisor.start.mock.calls.length > 1, "second start");
    fake.emit(INSTANCE_A, "synthetic", "changed");
    fake.release();
    await expect(again).rejects.toThrow(/changed while its tools were being read/);
    expect(registry.get(INSTANCE_A, ENDPOINT)).toBeUndefined();
  });

  it("waits out a backoff after a crash instead of failing, and only exits count", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const fake = fakeSupervisor();
      const { endpoints, registry } = adapter(fake, {}, 5_000);

      await endpoints.ensure(INSTANCE_A);
      // A tools change and a deliberate stop rebind at once.
      fake.emit(INSTANCE_A, "synthetic", "changed");
      await endpoints.ensure(INSTANCE_A);
      fake.emit(INSTANCE_A, "synthetic", "stopped");
      await endpoints.ensure(INSTANCE_A);
      expect(fake.supervisor.start).toHaveBeenCalledTimes(3);

      // An exit before a stable run delays the next start; the demand waits.
      fake.emit(INSTANCE_A, "synthetic", "exited");
      let settled = false;
      const pending = endpoints.ensure(INSTANCE_A).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(false);
      expect(fake.supervisor.start).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(registry.get(INSTANCE_A, ENDPOINT)).toBeDefined();
      expect(fake.supervisor.start).toHaveBeenCalledTimes(4);

      // A run that stays up past the stable window clears the history.
      await vi.advanceTimersByTimeAsync(10_000);
      fake.emit(INSTANCE_A, "synthetic", "exited");
      await endpoints.ensure(INSTANCE_A);
      expect(fake.supervisor.start).toHaveBeenCalledTimes(5);
      endpoints.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fallback description inside the byte budget", async () => {
    const fake = fakeSupervisor();
    const { endpoints, registry } = adapter(fake, {
      contribution: server({ name: "Ünïcödé server ".repeat(40) }),
    });

    await endpoints.ensure(INSTANCE_A);
    const [tool] = registry.get(INSTANCE_A, ENDPOINT)!.tools;
    expect(Buffer.byteLength(tool!.description, "utf8")).toBeLessThanOrEqual(400);
    expect(tool!.description.startsWith("whoami from Ünïcödé server")).toBe(true);
    endpoints.dispose();
  });
});
