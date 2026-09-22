import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => null) }));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { agentMcpEndpointRegistry } from "../../pluginAgentMcp/endpointRegistry.js";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_SCHEMA_BYTES,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  makeProjectPluginInstanceKey,
  type BuiltInPluginCapability,
  type PluginHostBinding,
  type PluginMcpCaller,
  type PluginMcpToolDefinition,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PROJECT_ID = "a".repeat(64);
const INSTANCE = makeProjectPluginInstanceKey(PROJECT_ID, "acme.ledger");
const BINDING: PluginHostBinding = {
  projectId: PROJECT_ID,
  projectRoot: path.join(path.sep, "repos", "ledger"),
};

const CALLER: PluginMcpCaller = Object.freeze({
  credentialId: "cred-1",
  projectId: PROJECT_ID,
  terminalId: "term-1",
});

function fakePlugin(endpointIds: string[] = ["data"]): LoadedPlugin {
  return {
    isBuiltin: true,
    manifest: {
      name: "acme.ledger",
      capabilities: ["mcp:expose"],
      contributes: {
        forgeProviders: [],
        fileDecorationProviders: [],
        agentMcp: endpointIds.map((id) => ({ id, name: id, mode: "tools" })),
      },
    },
  } as unknown as LoadedPlugin;
}

function makeDeps(capabilities: BuiltInPluginCapability[] = ["mcp:expose"]) {
  const plugins = new Map<string, LoadedPlugin>([[INSTANCE, fakePlugin()]]);
  const pluginEventCleanups = new Map<string, Array<() => void>>();
  const deps = {
    plugins,
    pluginEventCleanups,
    declaredCapabilities: () => new Set(capabilities),
    // Read while the host object is built, never by `host.mcp`.
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, pluginEventCleanups };
}

function tool(overrides: Partial<PluginMcpToolDefinition> = {}): PluginMcpToolDefinition {
  return {
    description: "Lists transactions.",
    inputSchema: { type: "object" },
    execute: () => ({ rows: [] }),
    ...overrides,
  };
}

function registered(endpointId = "data") {
  const registration = agentMcpEndpointRegistry.get(INSTANCE, endpointId);
  if (!registration) throw new Error("no roster registered");
  return registration;
}

beforeEach(() => agentMcpEndpointRegistry.clear());
afterEach(() => agentMcpEndpointRegistry.clear());

describe("host.mcp.registerTools", () => {
  it("registers under the plugin instance key, not the manifest id", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);

    await host.mcp.registerTools("data", { list_transactions: tool() });

    expect(agentMcpEndpointRegistry.get("acme.ledger", "data")).toBeUndefined();
    expect(registered().tools.map((t) => t.name)).toEqual(["list_transactions"]);
    expect(registered().pluginInstanceId).toBe(INSTANCE);
  });

  it("passes args, caller and signal through to execute, called on its definition", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    const execute = vi.fn(function (
      this: unknown,
      _args: Record<string, unknown>,
      _caller: PluginMcpCaller,
      _signal: AbortSignal
    ) {
      return { self: this };
    });
    const definition = tool({ execute });
    await host.mcp.registerTools("data", { list_transactions: definition });

    const signal = new AbortController().signal;
    const result = await registered().invoke("list_transactions", { limit: 3 }, CALLER, signal);

    expect(execute).toHaveBeenCalledWith({ limit: 3 }, CALLER, signal);
    expect(execute.mock.calls[0][1]).toBe(CALLER);
    expect(result).toEqual({ self: definition });
  });

  it("turns a synchronous throw into a rejection", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    await host.mcp.registerTools("data", {
      list_transactions: tool({
        execute: () => {
          throw new Error("ledger locked");
        },
      }),
    });

    await expect(
      registered().invoke("list_transactions", {}, CALLER, new AbortController().signal)
    ).rejects.toThrow("ledger locked");
  });

  it("rejects on abort even when execute ignores its signal", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    await host.mcp.registerTools("data", {
      list_transactions: tool({ execute: () => new Promise(() => {}) }),
    });

    const controller = new AbortController();
    const call = registered().invoke("list_transactions", {}, CALLER, controller.signal);
    controller.abort();

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });

  it("runs the tools it validated, not later edits to the plugin's roster object", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    const roster: Record<string, PluginMcpToolDefinition> = {
      list_transactions: tool({ execute: () => "original" }),
    };
    await host.mcp.registerTools("data", roster);

    roster.list_transactions.execute = () => "swapped";
    roster.injected = tool({ execute: () => "never advertised" });

    const signal = new AbortController().signal;
    await expect(registered().invoke("list_transactions", {}, CALLER, signal)).resolves.toBe(
      "original"
    );
    await expect(registered().invoke("injected", {}, CALLER, signal)).rejects.toThrow(
      /has no tool "injected"/
    );
  });

  it("refuses to run a tool once its plugin instance is gone", async () => {
    const { deps, plugins } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    await host.mcp.registerTools("data", { list_transactions: tool() });
    const registration = registered();

    plugins.delete(INSTANCE);

    await expect(
      registration.invoke("list_transactions", {}, CALLER, new AbortController().signal)
    ).rejects.toThrow(/not loaded/);
  });

  it("replaces a roster, leaving the replaced disposer inert", async () => {
    const { deps, pluginEventCleanups } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    const disposeFirst = await host.mcp.registerTools("data", { first: tool() });
    const disposeSecond = await host.mcp.registerTools("data", { second: tool() });

    // The replaced roster is released at replacement, not held until unload.
    expect(pluginEventCleanups.get(INSTANCE)).toHaveLength(1);

    disposeFirst();
    expect(registered().tools.map((t) => t.name)).toEqual(["second"]);

    disposeSecond();
    expect(agentMcpEndpointRegistry.get(INSTANCE, "data")).toBeUndefined();
    expect(pluginEventCleanups.has(INSTANCE)).toBe(false);
  });

  it("drops its roster through the unload cascade's tracked disposers", async () => {
    const { deps, pluginEventCleanups } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    await host.mcp.registerTools("data", { list_transactions: tool() });

    for (const dispose of [...(pluginEventCleanups.get(INSTANCE) ?? [])]) dispose();

    expect(agentMcpEndpointRegistry.get(INSTANCE, "data")).toBeUndefined();
  });

  it("keeps the current roster when a replacement is rejected", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, INSTANCE, BINDING);
    await host.mcp.registerTools("data", { list_transactions: tool() });

    expect(() => host.mcp.registerTools("data", { "Bad-Name": tool() })).toThrow();

    expect(registered().tools.map((t) => t.name)).toEqual(["list_transactions"]);
  });

  describe("rejects the whole roster", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: AGENT_MCP_MAX_TOOLS_PER_ENDPOINT + 1 }, (_, i) => [`tool_${i}`, tool()])
    );
    const cases: Array<[string, string, Record<string, PluginMcpToolDefinition>, RegExp]> = [
      [
        "for an undeclared endpoint",
        "reports",
        { list: tool() },
        /not declared in contributes\.agentMcp/,
      ],
      ["over the tool budget", "data", tooMany, /at most/],
      ["for a bad tool name", "data", { ListTransactions: tool() }, /must match/],
      [
        "for an oversized description",
        "data",
        { list: tool({ description: "x".repeat(AGENT_MCP_MAX_DESCRIPTION_BYTES + 1) }) },
        /description is \d+ bytes/,
      ],
      [
        "for an oversized schema",
        "data",
        {
          list: tool({
            inputSchema: { type: "object", description: "x".repeat(AGENT_MCP_MAX_SCHEMA_BYTES) },
          }),
        },
        /inputSchema is \d+ bytes/,
      ],
      [
        "for a non-object schema",
        "data",
        { list: tool({ outputSchema: { type: "array" } as never }) },
        /outputSchema must be a plain object with type "object"/,
      ],
    ];

    it.each(cases)("%s", (_label, endpointId, tools, message) => {
      const { deps } = makeDeps();
      const { host } = createHost(deps, INSTANCE, BINDING);

      expect(() => host.mcp.registerTools(endpointId, tools)).toThrow(message);
      expect(agentMcpEndpointRegistry.get(INSTANCE, endpointId)).toBeUndefined();
    });

    it("without the mcp:expose capability", () => {
      const { deps } = makeDeps([]);
      const { host } = createHost(deps, INSTANCE, BINDING);

      expect(() => host.mcp.registerTools("data", { list: tool() })).toThrow(
        /^PERMISSION_REQUIRED: .*"mcp:expose"/
      );
      expect(agentMcpEndpointRegistry.get(INSTANCE, "data")).toBeUndefined();
    });

    it("after activation has closed", () => {
      const { deps } = makeDeps();
      const { host, revoke } = createHost(deps, INSTANCE, BINDING);
      revoke();

      expect(() => host.mcp.registerTools("data", { list: tool() })).toThrow(/host revoked/);
      expect(agentMcpEndpointRegistry.get(INSTANCE, "data")).toBeUndefined();
    });
  });
});
