import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (key: string) => data.get(key),
    set: (key: string, value: unknown) => {
      data.set(key, value);
    },
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import type { LoadedPluginInfo, PluginManifest } from "../../../../shared/types/plugin.js";
import { listDeclaredAgentMcpPlugins } from "../../../services/pluginAgentMcp/declaredEndpoints.js";
import { AgentMcpEndpointRegistry } from "../../../services/pluginAgentMcp/endpointRegistry.js";
import { GlobalAssistantPluginTools } from "../../../services/pluginAgentMcp/globalAssistantTools.js";
import {
  pluginMcpGrantRegistry,
  type PluginMcpGrant,
} from "../../../services/pluginAgentMcp/grantRegistry.js";
import { resolveLaunchPluginsReport } from "../../../services/pluginAgentMcp/launchPlugins.js";
import { _resetProjectMcpDefaultsForTests } from "../../../services/pluginAgentMcp/projectDefaults.js";
import {
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../../../services/pluginAgentMcp/projectEnablement.js";
import type { AgentMcpToolInvoker } from "../../../services/pluginAgentMcp/types.js";
import { compileAgentMcpTool } from "../../../services/pluginAgentMcp/validateTools.js";
import {
  createHostPluginTools,
  type AdmittedRelaySession,
  type HostPluginTools,
  type HostPluginToolsAdapter,
  type HostPluginToolsPolicy,
} from "../hostPluginTools.js";
import type { RelayMcpSession, RelayMcpSessionSpec } from "../mcpRelayExecutor.js";

const PROJECT = "f".repeat(64);
const LEDGER = "acme.ledger";
const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});
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
const pluginService = {
  waitForCatalog: async () => {},
  waitForProjectPlugins: async () => true,
  listPlugins: () => [ledger],
  hasPlugin: (id: string) => id === LEDGER,
};

const LIST_ARGS = {};
const CALL_ARGS = { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } };
const OPTIONS = { timeoutMs: 5_000, callId: "c-1" };

function spec(overrides: Partial<RelayMcpSessionSpec> = {}): RelayMcpSessionSpec {
  return {
    linkSessionId: "link-1",
    senderId: "sender-a",
    helpSessionId: "help-1",
    projectId: PROJECT,
    tier: "core",
    shellName: "greg-mbp",
    global: true,
    stillAccepted: () => accepts,
    deliverNotices: () => {},
    requestApproval: async () => ({ decision: "denied" }) as never,
    ...overrides,
  };
}

let accepts: boolean;
let next: number;
let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
let gate: Promise<void> | null;
let resolveEntered: ReturnType<typeof vi.fn<() => void>>;
let activate: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let built: GlobalAssistantPluginTools[];
let pluginTools: HostPluginTools;
let createTools: ReturnType<
  typeof vi.fn<(policy: HostPluginToolsPolicy) => Promise<HostPluginToolsAdapter>>
>;

function admitted(): AdmittedRelaySession & {
  inner: ReturnType<typeof vi.fn>;
  closeUnderneath(): void;
} {
  const closed = new AbortController();
  const inner = vi.fn(async (): Promise<CallToolResult> => ({
    content: [{ type: "text", text: "inner" }],
  }));
  return {
    sessionId: `relay-${++next}`,
    inner,
    isOpen: () => !closed.signal.aborted,
    callTool: inner,
    close: () => closed.abort(),
    closed: closed.signal,
    closeUnderneath: () => closed.abort(),
    refuseWrite: () => null,
    recordCall: vi.fn(),
  };
}

function grantsOf(session: { sessionId: string }): PluginMcpGrant[] {
  return pluginMcpGrantRegistry.listForHelpSession(`relay-mcp\u0000${session.sessionId}`);
}

function text(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

beforeEach(() => {
  storeMock.data.clear();
  pluginMcpGrantRegistry.revokeAll();
  _resetProjectMcpDefaultsForTests();
  setProjectAgentMcpAccess(PROJECT, LEDGER, "read-write");
  setProjectAssistantAgentMcpAccess(PROJECT, LEDGER, "read-write");
  accepts = true;
  next = 0;
  gate = null;
  built = [];
  resolveEntered = vi.fn<() => void>();
  activate = vi.fn<(id: string) => Promise<void>>(async () => {});
  const endpoints = new AgentMcpEndpointRegistry();
  invoke = vi.fn<AgentMcpToolInvoker>(async (_name, args) => ({ found: args.id }));
  endpoints.register({ pluginInstanceId: LEDGER, endpointId: "data", tools: [LOOKUP], invoke });
  createTools = vi.fn<(policy: HostPluginToolsPolicy) => Promise<HostPluginToolsAdapter>>(
    async (policy) => {
      const tools = new GlobalAssistantPluginTools({
        projectRoot: async () => "/nonexistent/project",
        resolvePlugins: async (projectId, root) => {
          resolveEntered();
          if (gate) await gate;
          return resolveLaunchPluginsReport(
            projectId,
            root,
            "assistant",
            async () => pluginService as never
          );
        },
        declaredPlugin: (projectId, id) =>
          listDeclaredAgentMcpPlugins([ledger], projectId, () => true).find(
            (plugin) => plugin.pluginInstanceId === id
          ) ?? null,
        activatePlugin: (id) => activate(id),
        isSessionLive: policy.isSessionLive,
        refuseWrite: policy.refuseWrite,
        endpointRegistry: endpoints,
      });
      built.push(tools);
      return tools;
    }
  );
  pluginTools = createHostPluginTools({ createTools });
});

afterEach(() => {
  pluginTools.dispose();
  pluginMcpGrantRegistry.revokeAll();
});

describe("HostPluginTools (#18256)", () => {
  it("passes every session but another machine's global Assistant's through untouched", async () => {
    const session = admitted();

    const { global: _global, ...ordinary } = spec();
    expect(pluginTools.decorate(session, ordinary)).toBe(session);
    // This machine's own is the in-process relay's, decorated there.
    expect(pluginTools.decorate(session, spec({ local: true }))).toBe(session);
    const decorated = pluginTools.decorate(session, spec());
    expect(decorated).not.toBe(session);
    await decorated.callTool("terminal.list", { owned: true }, OPTIONS);
    expect(session.inner.mock.calls).toEqual([["terminal.list", { owned: true }, OPTIONS]]);
    // An ordinary call builds nothing: a host whose Shells never list plugins loads none.
    expect(createTools).not.toHaveBeenCalled();
  });

  it("holds each relayed session's grants apart, though two Shells name the same help session", async () => {
    const a = admitted();
    const b = admitted();
    const fromA = pluginTools.decorate(a, spec({ senderId: "sender-a" }));
    const fromB = pluginTools.decorate(b, spec({ senderId: "sender-b", linkSessionId: "link-2" }));
    await fromA.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    await fromB.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    // This machine's own global Assistant, under the same text.
    const own = pluginMcpGrantRegistry.issueForGlobalAssistant({
      pluginInstanceId: LEDGER,
      scope: grantsOf(a)[0]!.scope,
      serverName: "ledger",
      projectId: PROJECT,
      helpSessionId: "help-1",
    });

    pluginTools.endHelpSession("sender-a", "help-1");

    await vi.waitFor(() => expect(grantsOf(a)).toEqual([]));
    expect(grantsOf(b)).toHaveLength(1);
    expect(pluginMcpGrantRegistry.isLive(own.credentialId)).toBe(true);
    const still = await fromB.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    expect(still.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(createTools).toHaveBeenCalledTimes(1);
  });

  it("mints nothing for a session whose end arrives while its first call is resolving", async () => {
    let resume!: () => void;
    gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    const pending = decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    await vi.waitFor(() => expect(resolveEntered).toHaveBeenCalled());

    pluginTools.endHelpSession("sender-a", "help-1");
    resume();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("session has ended");
    expect(invoke).not.toHaveBeenCalled();
    expect(grantsOf(session)).toEqual([]);
  });

  it("refuses a list and a call while the host's consent is off, minting nothing", async () => {
    accepts = false;
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());

    for (const [tool, args] of [
      ["plugin.tools", LIST_ARGS],
      ["plugin.callTool", CALL_ARGS],
    ] as const) {
      const result = await decorated.callTool(tool, args, OPTIONS);
      expect(result.isError).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(grantsOf(session)).toEqual([]);
  });

  it("refuses the plugin's own tool by the session's write rule, judged for that session", async () => {
    const session = admitted();
    session.refuseWrite = () => "laptop-02 has control of this project.";
    const decorated = pluginTools.decorate(session, spec());

    const result = await decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("laptop-02");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records each operation in the session's own audit, under its callId", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());

    await decorated.callTool("plugin.tools", LIST_ARGS, { ...OPTIONS, callId: "c-list" });
    await decorated.callTool(
      "plugin.callTool",
      { ...CALL_ARGS, tool: "missing" },
      { ...OPTIONS, callId: "c-call" }
    );

    expect(vi.mocked(session.recordCall).mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        toolId: "plugin.tools",
        callId: "c-list",
        args: LIST_ARGS,
        outcome: { kind: "result", value: { ok: true, result: null } },
      }),
      expect.objectContaining({
        toolId: "plugin.callTool",
        callId: "c-call",
        outcome: expect.objectContaining({
          kind: "result",
          value: expect.objectContaining({ ok: false }),
        }),
      }),
    ]);
  });

  it("drops a session's grants when it closes, and its successor mints its own", async () => {
    const first = admitted();
    const firstDecorated: RelayMcpSession = pluginTools.decorate(first, spec());
    await firstDecorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    expect(grantsOf(first)).toHaveLength(1);

    firstDecorated.close();

    await vi.waitFor(() => expect(grantsOf(first)).toEqual([]));
    expect(first.isOpen()).toBe(false);
    const second = admitted();
    const secondDecorated = pluginTools.decorate(second, spec());
    const called = await secondDecorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    expect(called.isError).not.toBe(true);
    expect(grantsOf(second)).toHaveLength(1);
  });

  it("disposes the plugin tools it built, and one whose build finishes after it went", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    expect(grantsOf(session)).toHaveLength(1);

    pluginTools.dispose();

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));

    let finish!: (tools: HostPluginToolsAdapter) => void;
    const late = { list: vi.fn(), call: vi.fn(), endSession: vi.fn(), dispose: vi.fn() };
    const lateTools = createHostPluginTools({
      createTools: () =>
        new Promise<HostPluginToolsAdapter>((resolve) => {
          finish = resolve;
        }),
    });
    const lateDecorated = lateTools.decorate(admitted(), spec());
    const pending = lateDecorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    await vi.waitFor(() => expect(finish).toBeDefined());
    lateTools.dispose();
    finish(late);

    await expect(pending).rejects.toThrow("session has ended");
    expect(late.dispose).toHaveBeenCalledTimes(1);
    expect(late.list).not.toHaveBeenCalled();
  });

  it("drops a link's grants as it expires, stopping a call still starting, and none for one admitted after", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    expect(grantsOf(session)).toHaveLength(1);
    let entered = false;
    let release!: () => void;
    activate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          entered = true;
          release = resolve;
        })
    );
    const pending = decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    await vi.waitFor(() => expect(entered).toBe(true));

    pluginTools.expireLink("link-1");

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
    release();
    expect((await pending).isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    // The relay drains the link's other calls on the session itself.
    expect(session.isOpen()).toBe(true);
    const late = admitted();
    const refused = await pluginTools
      .decorate(late, spec())
      .callTool("plugin.tools", LIST_ARGS, OPTIONS);
    expect(refused.isError).toBe(true);
    expect(grantsOf(late)).toEqual([]);
  });

  it("drops a session's grants when it closes underneath, as the MCP server stopping does", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    expect(grantsOf(session)).toHaveLength(1);

    session.closeUnderneath();

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
  });

  it("keeps a released session ended after later releases crowd out its fence", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);

    pluginTools.endHelpSession("sender-a", "help-1");
    for (let i = 0; i < 1100; i += 1) pluginTools.endHelpSession("sender-b", `other-${i}`);

    const after = await decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    expect(after.isError).toBe(true);
    expect(text(after)).toContain("session has ended");
    expect(invoke).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
  });

  it("drops every relayed grant when the host withdraws consent, and mints anew once it is back", async () => {
    const session = admitted();
    const decorated = pluginTools.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    const [before] = grantsOf(session);

    accepts = false;
    pluginTools.consentWithdrawn();

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
    expect(pluginMcpGrantRegistry.isLive(before!.credentialId)).toBe(false);
    accepts = true;
    const called = await decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    expect(called.isError).not.toBe(true);
    expect(grantsOf(session)).toHaveLength(1);
    expect(grantsOf(session)[0]!.credentialId).not.toBe(before!.credentialId);
  });

  it("drops a session's grants once its Shell can no longer change the project, not before", async () => {
    let mayChange = true;
    const moved = createHostPluginTools({
      createTools,
      mayStillChange: (projectId, linkSessionId) =>
        projectId === PROJECT && linkSessionId === "link-1" && mayChange,
    });
    const session = admitted();
    const decorated = moved.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    const [held] = grantsOf(session);

    moved.driveTargetChanged();
    await Promise.resolve();
    expect(pluginMcpGrantRegistry.isLive(held!.credentialId)).toBe(true);

    mayChange = false;
    moved.driveTargetChanged();

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
    moved.dispose();
  });

  it("keeps the reads of a Shell that never could change the project, however its drive target moves", async () => {
    let mayChange = false;
    const moved = createHostPluginTools({ createTools, mayStillChange: () => mayChange });
    const session = admitted();
    const decorated = moved.decorate(session, spec());
    await decorated.callTool("plugin.tools", LIST_ARGS, OPTIONS);
    const [held] = grantsOf(session);

    // Another link's view coming and going moves nothing this Shell could do.
    moved.driveTargetChanged();
    moved.driveTargetChanged();
    await Promise.resolve();
    expect(pluginMcpGrantRegistry.isLive(held!.credentialId)).toBe(true);

    // It gains the standing, then loses it: only the loss ends what it holds.
    mayChange = true;
    moved.driveTargetChanged();
    await Promise.resolve();
    expect(pluginMcpGrantRegistry.isLive(held!.credentialId)).toBe(true);
    mayChange = false;
    moved.driveTargetChanged();
    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
    moved.dispose();
  });

  it("counts a change its write rule allowed as standing a later move ends", async () => {
    // Never read as able to change the project, so only the write rule's allowance counts.
    const moved = createHostPluginTools({ createTools, mayStillChange: () => false });
    const session = admitted();
    const decorated = moved.decorate(session, spec());
    // Read as unable when the call starts; its write rule allows it as it dispatches.
    await decorated.callTool("plugin.callTool", CALL_ARGS, OPTIONS);
    expect(grantsOf(session)).toHaveLength(1);

    moved.driveTargetChanged();

    await vi.waitFor(() => expect(grantsOf(session)).toEqual([]));
    moved.dispose();
  });
});
