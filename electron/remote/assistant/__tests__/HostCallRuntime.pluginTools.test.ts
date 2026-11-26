import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { LoadedPluginInfo, PluginManifest } from "../../../../shared/types/plugin.js";
import { listDeclaredAgentMcpPlugins } from "../../../services/pluginAgentMcp/declaredEndpoints.js";
import { AgentMcpEndpointRegistry } from "../../../services/pluginAgentMcp/endpointRegistry.js";
import { GlobalAssistantPluginTools } from "../../../services/pluginAgentMcp/globalAssistantTools.js";
import { pluginMcpGrantRegistry } from "../../../services/pluginAgentMcp/grantRegistry.js";
import { resolveLaunchPluginsReport } from "../../../services/pluginAgentMcp/launchPlugins.js";
import { _resetProjectMcpDefaultsForTests } from "../../../services/pluginAgentMcp/projectDefaults.js";
import {
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../../../services/pluginAgentMcp/projectEnablement.js";
import type { AgentMcpToolInvoker } from "../../../services/pluginAgentMcp/types.js";
import { compileAgentMcpTool } from "../../../services/pluginAgentMcp/validateTools.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { createLocalMcpRelay, type LocalMcpRelay } from "../localMcpRelay.js";
import { withLocalPluginTools } from "../localPluginTools.js";
import type { RelayMcpSession, RelayMcpSessionSpec } from "../mcpRelayExecutor.js";

const PROJECT = "c".repeat(64);
const OWN_PROJECT = "d".repeat(64);
const LEDGER = "acme.ledger";
const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});

const GLOBAL: OpenRun = {
  projectId: GLOBAL_ASSISTANT_ID,
  slot: 0,
  sessionId: "g",
  terminalId: "t-g",
  launchGeneration: 1,
};

const STUDIO: ObservedHost = {
  hostId: "studio",
  name: "studio-01",
  connection: {
    status: "connected",
    rttMs: 12,
    handshake: {
      version: "1.0.0",
      commit: "abc1234",
      protocolVersion: 12,
      platform: "linux",
      arch: "x64",
    },
  },
  lastSeenAt: 900,
  summary: null,
};

const LIST = { hostId: "local", projectId: PROJECT, tool: "plugin.tools", args: {} };
const CALL = {
  hostId: "local",
  projectId: PROJECT,
  tool: "plugin.callTool",
  args: { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
};

const ledger = {
  manifest: {
    name: LEDGER,
    version: "1.0.0",
    displayName: "Ledger",
    capabilities: ["mcp:expose"],
    contributes: { agentMcp: [{ id: "data", name: "Ledger", mode: "tools" }], databases: [] },
  } as unknown as PluginManifest,
  instanceId: LEDGER,
  origin: "global",
  projectId: null,
  disabled: false,
} as unknown as LoadedPluginInfo;

describe("HostCallRuntime reaching a local project's plugin agent tools (#18254)", () => {
  let runs: Map<string, OpenRun>;
  let relayCall: ReturnType<typeof vi.fn>;
  let innerCalls: Array<{ helpSessionId: string; tool: string }>;
  let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
  let endpoints: AgentMcpEndpointRegistry;
  let tools: GlobalAssistantPluginTools;
  let local: LocalMcpRelay;
  let runtime: HostCallRuntime;
  let ids: number;

  beforeEach(() => {
    storeMock.data.clear();
    storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
    storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
      storeMock.data.set(key, value);
    });
    pluginMcpGrantRegistry.revokeAll();
    _resetProjectMcpDefaultsForTests();
    setProjectAgentMcpAccess(PROJECT, LEDGER, "read-write");
    setProjectAssistantAgentMcpAccess(PROJECT, LEDGER, "read-write");

    runs = new Map([
      ["g", GLOBAL],
      ["standby", { ...GLOBAL, slot: 1, sessionId: "standby", standby: true }],
      // A project's own Assistant, relaying into another project here.
      ["a", { ...GLOBAL, projectId: OWN_PROJECT, sessionId: "a", terminalId: "t-a" }],
    ]);
    relayCall = vi.fn();
    innerCalls = [];
    ids = 0;
    endpoints = new AgentMcpEndpointRegistry();
    invoke = vi.fn<AgentMcpToolInvoker>(async (_name, args) => ({ found: args.id }));
    endpoints.register({ pluginInstanceId: LEDGER, endpointId: "data", tools: [LOOKUP], invoke });
    const pluginService = {
      waitForCatalog: async () => {},
      waitForProjectPlugins: async () => true,
      listPlugins: () => [ledger],
      hasPlugin: (id: string) => id === LEDGER,
    };
    tools = new GlobalAssistantPluginTools({
      projectRoot: async (projectId) => (projectId === PROJECT ? "/nonexistent/project" : null),
      resolvePlugins: (projectId, root) =>
        resolveLaunchPluginsReport(
          projectId,
          root,
          "assistant",
          async () => pluginService as never
        ),
      declaredPlugin: (projectId, id) =>
        listDeclaredAgentMcpPlugins([ledger], projectId, () => true).find(
          (plugin) => plugin.pluginInstanceId === id
        ) ?? null,
      activatePlugin: async () => {},
      isSessionLive: (id) => runs.get(id)?.projectId === GLOBAL_ASSISTANT_ID,
      endpointRegistry: endpoints,
    });
    local = createLocalMcpRelay({
      machineName: () => "greg-mbp",
      hasProject: async (projectId) => projectId === PROJECT,
      openSession: async (spec: RelayMcpSessionSpec) => {
        const session: RelayMcpSession = {
          isOpen: () => true,
          callTool: async (tool): Promise<CallToolResult> => {
            innerCalls.push({ helpSessionId: spec.helpSessionId, tool });
            return { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true };
          },
          close: () => {},
        };
        return withLocalPluginTools(session, spec, async () => tools);
      },
      receiveNotices: () => {},
      receiveApproval: async () => ({ decision: "denied" }) as never,
      newId: () => `notice-${++ids}`,
    });
    runtime = new HostCallRuntime({
      getSessionLane: (id) => {
        const run = runs.get(id);
        return run ? { projectId: run.projectId, slot: run.slot } : null;
      },
      callerRun: (id) => runs.get(id) ?? null,
      client: () => ({ relayCall }) as never,
      hosts: () => [STUDIO],
      inLocalView: () => true,
      controlEnabled: (hostId) => hostId === "studio",
      local: {
        name: () => "greg-mbp",
        projects: async () => [{ id: PROJECT, name: "ledger", path: "/nonexistent/project" }],
        relayCall: (payload) => local.relayCall(payload),
        cancelCall: (helpSessionId, callId) => local.cancelCall(helpSessionId, callId),
      },
      now: () => 1000,
      newId: () => `00000000-0000-4000-8000-0000000000${String(++ids).padStart(2, "0")}`,
    });
  });

  afterEach(() => {
    runtime.dispose();
    local.dispose();
    tools.dispose();
    pluginMcpGrantRegistry.revokeAll();
  });

  it.each(["core", "full"] as const)(
    "lists and calls a plugin's tool with no Assistant or terminal in the project, at %s",
    async (tier) => {
      const listed = await runtime.call("g", LIST, { tier });
      expect(listed).toMatchObject({ ok: true, value: { outcome: "ok" } });
      if (!listed.ok) throw new Error("refused");
      expect(listed.value.result?.structured).toMatchObject({
        tools: [{ pluginInstanceId: LEDGER, name: "lookup", plugin: "Ledger" }],
        nextCursor: null,
      });

      const called = await runtime.call("g", CALL, { tier });
      if (!called.ok) throw new Error("refused");
      expect(called.value).toMatchObject({ outcome: "ok", result: { isError: false } });
      expect(called.value.result?.structured).toEqual({ found: "r-1" });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][2]).toEqual({
        credentialId: expect.any(String),
        projectId: PROJECT,
        consumer: "global-assistant",
      });
      expect(innerCalls).toEqual([]);
    }
  );

  it("runs a resend of the same call once", async () => {
    const callId = "11111111-1111-4111-8111-111111111111";
    await runtime.call("g", { ...CALL, newCallId: callId }, { tier: "core" });
    const resent = await runtime.call("g", { ...CALL, callId }, { tier: "core" });

    expect(resent).toMatchObject({ ok: true, value: { outcome: "ok", callId } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses them on another machine and from a session that isn't coordinating", async () => {
    for (const settled of [
      await runtime.call("g", { ...LIST, hostId: "studio", projectId: "host-p" }, { tier: "core" }),
      await runtime.call("g", { ...CALL, hostId: "studio", projectId: "host-p" }, { tier: "core" }),
      await runtime.call("standby", LIST, { tier: "core" }),
      await runtime.call("standby", CALL, { tier: "core" }),
    ]) {
      expect(settled).toMatchObject({ ok: true, value: { outcome: "policy_rejected" } });
    }
    expect(relayCall).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(pluginMcpGrantRegistry.listForHelpSession("standby")).toEqual([]);
  });

  it("leaves another assistant's relayed call to the project's own tools, which have none by that name", async () => {
    const settled = await runtime.call("a", CALL, { tier: "full" });

    expect(settled).toMatchObject({
      ok: true,
      value: { outcome: "ok", result: { isError: true } },
    });
    expect(innerCalls).toEqual([{ helpSessionId: "a", tool: "plugin.callTool" }]);
    expect(invoke).not.toHaveBeenCalled();
    expect(pluginMcpGrantRegistry.listForHelpSession("a")).toEqual([]);
  });

  it("refuses an ended session, and its end revokes what it held", async () => {
    await runtime.call("g", LIST, { tier: "core" });
    expect(pluginMcpGrantRegistry.listForHelpSession("g")).toHaveLength(1);

    runs.delete("g");
    local.endHelpSession("g");
    runtime.endHelpSession("g");
    tools.endSession("g");

    expect(pluginMcpGrantRegistry.listForHelpSession("g")).toEqual([]);
    const settled = await runtime.call("g", CALL, { tier: "core" });
    expect(settled).toMatchObject({ ok: false, code: "NOT_ELIGIBLE" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("decorates only a session this machine's relay opened for its global Assistant", () => {
    const session: RelayMcpSession = {
      isOpen: () => true,
      callTool: async () => ({ content: [] }),
      close: () => {},
    };
    const spec = { helpSessionId: "g", projectId: PROJECT } as RelayMcpSessionSpec;
    const pluginTools = vi.fn();

    expect(withLocalPluginTools(session, { ...spec, global: true }, pluginTools)).toBe(session);
    expect(withLocalPluginTools(session, { ...spec, local: true }, pluginTools)).toBe(session);
    expect(
      withLocalPluginTools(session, { ...spec, local: true, global: true }, pluginTools)
    ).not.toBe(session);
  });
});
