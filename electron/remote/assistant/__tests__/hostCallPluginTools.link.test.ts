// @vitest-environment node
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { userData, storeMock } = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    userData: { dir: "" },
    storeMock: {
      data,
      get: (key: string) => data.get(key),
      set: (key: string, value: unknown) => {
        data.set(key, value);
      },
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
    getPath: (key: string) => {
      if (key === "userData") return userData.dir;
      throw new Error(`unexpected getPath: ${key}`);
    },
  },
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { GLOBAL_ASSISTANT_ID } from "../../../../shared/config/globalAssistant.js";
import type { LoadedPluginInfo, PluginManifest } from "../../../../shared/types/plugin.js";
import { listDeclaredAgentMcpPlugins } from "../../../services/pluginAgentMcp/declaredEndpoints.js";
import { AgentMcpEndpointRegistry } from "../../../services/pluginAgentMcp/endpointRegistry.js";
import { GlobalAssistantPluginTools } from "../../../services/pluginAgentMcp/globalAssistantTools.js";
import {
  pluginMcpGrantRegistry,
  type PluginMcpGrant,
  type PluginMcpGrantRevokeReason,
} from "../../../services/pluginAgentMcp/grantRegistry.js";
import { resolveLaunchPluginsReport } from "../../../services/pluginAgentMcp/launchPlugins.js";
import { _resetProjectMcpDefaultsForTests } from "../../../services/pluginAgentMcp/projectDefaults.js";
import {
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../../../services/pluginAgentMcp/projectEnablement.js";
import type { AgentMcpToolInvoker } from "../../../services/pluginAgentMcp/types.js";
import { compileAgentMcpTool } from "../../../services/pluginAgentMcp/validateTools.js";
import type { LinkSession } from "../../link/session.js";
import { makeTempDir, openSessionPair, removeTempDir } from "../../link/__tests__/linkTestUtils.js";
import type { MetricsSessionContext } from "../../metrics/hostMetricsHost.js";
import { HostCallRuntime, type ObservedHost, type OpenRun } from "../HostCallRuntime.js";
import { HostControlLinkClient } from "../HostControlLinkClient.js";
import { installHostMcpRelay, type RelayMcpSessionSpec } from "../hostMcpRelay.js";
import {
  createHostPluginTools,
  type AdmittedRelaySession,
  type HostPluginTools,
} from "../hostPluginTools.js";
import { installAssistantSenderHostWith } from "../hostSenders.js";
import { SenderSessions } from "../senderSessions.js";

/**
 * Acceptance evidence for #18256: the Shell's global Assistant listing and
 * calling a plugin's agent tools in a project on another machine, across a
 * real link, through the real sender proof, relay and plugin tool grants on
 * the host. The host's own MCP session behind the relay is a stand-in, since
 * the two operations are answered beside it.
 */

const HOST_ID = "studio";
const PROJECT = "e".repeat(64);
const CREDENTIAL = "C".repeat(43);
const LEDGER = "acme.ledger";
const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
});

const HOST: ObservedHost = {
  hostId: HOST_ID,
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
  lastSeenAt: null,
  summary: null,
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

const GLOBAL_RUN: OpenRun = {
  projectId: GLOBAL_ASSISTANT_ID,
  slot: 0,
  sessionId: "help-g",
  terminalId: "t-g",
  launchGeneration: 1,
  conversationOwnershipId: "conv-g",
};
const PROJECT_RUN: OpenRun = {
  projectId: "proj-1",
  slot: 0,
  sessionId: "help-a",
  terminalId: "t-a",
  launchGeneration: 1,
};

const LIST = { tool: "plugin.tools", args: {} };
const CALL = {
  tool: "plugin.callTool",
  args: { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
};

/** The host: its consent, its drive standing, and what its relay sessions recorded. */
class Host {
  accepts = true;
  /** Whether it answers the two operations: a host from before them doesn't. */
  decorates = true;
  driven: string | null = null;
  readonly innerCalls: string[] = [];
  readonly recorded: Array<{ toolId: string; callId: string; result: unknown }> = [];
  readonly opened: AdmittedRelaySession[] = [];
  private next = 0;

  constructor(readonly pluginTools: HostPluginTools) {}

  async open(spec: RelayMcpSessionSpec) {
    const closed = new AbortController();
    const session: AdmittedRelaySession = {
      sessionId: `relay-${++this.next}`,
      isOpen: () => !closed.signal.aborted,
      closed: closed.signal,
      callTool: async (tool): Promise<CallToolResult> => {
        this.innerCalls.push(tool);
        return { content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true };
      },
      close: () => closed.abort(),
      refuseWrite: () => this.driven,
      recordCall: ({ toolId, callId, outcome }) => {
        this.recorded.push({
          toolId,
          callId,
          result:
            outcome.kind === "result"
              ? outcome.value.ok
                ? "ok"
                : outcome.value.error.code
              : "threw",
        });
      },
    };
    this.opened.push(session);
    return this.decorates ? this.pluginTools.decorate(session, spec) : session;
  }
}

let dir: string;
let links: { host: LinkSession; client: LinkSession };
let host: Host;
let runtime: HostCallRuntime;
let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
let activatePlugin: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let resolvePlugins: ReturnType<
  typeof vi.fn<(projectId: string, root: string) => ReturnType<typeof resolveLaunchPluginsReport>>
>;
let revoked: Array<{ grant: PluginMcpGrant; reason: PluginMcpGrantRevokeReason }>;
let expireLink: (sessionId: string) => void;
let disposeAll: () => void;

function liveHostGrants(): PluginMcpGrant[] {
  return host.opened.flatMap((session) =>
    pluginMcpGrantRegistry.listForHelpSession(`relay-mcp\u0000${session.sessionId}`)
  );
}

beforeEach(async () => {
  dir = await makeTempDir();
  userData.dir = dir;
  storeMock.data.clear();
  pluginMcpGrantRegistry.revokeAll();
  _resetProjectMcpDefaultsForTests();
  // The host project's own answer: the plugin's tools are on for its Assistant.
  setProjectAgentMcpAccess(PROJECT, LEDGER, "read-write");
  setProjectAssistantAgentMcpAccess(PROJECT, LEDGER, "read-write");
  links = await openSessionPair(dir);

  const endpoints = new AgentMcpEndpointRegistry();
  invoke = vi.fn<AgentMcpToolInvoker>(async (_name, args) => ({ found: args.id }));
  endpoints.register({ pluginInstanceId: LEDGER, endpointId: "data", tools: [LOOKUP], invoke });
  const pluginService = {
    waitForCatalog: async () => {},
    waitForProjectPlugins: async () => true,
    listPlugins: () => [ledger],
    hasPlugin: (id: string) => id === LEDGER,
  };
  activatePlugin = vi.fn<(id: string) => Promise<void>>(async () => {});
  resolvePlugins = vi.fn((projectId: string, root: string) =>
    resolveLaunchPluginsReport(projectId, root, "assistant", async () => pluginService as never)
  ) as typeof resolvePlugins;
  const pluginTools = createHostPluginTools({
    createTools: async (policy) =>
      new GlobalAssistantPluginTools({
        projectRoot: async (projectId) => (projectId === PROJECT ? "/nonexistent/project" : null),
        resolvePlugins: (projectId, root) => resolvePlugins(projectId, root),
        declaredPlugin: (projectId, id) =>
          listDeclaredAgentMcpPlugins([ledger], projectId, () => true).find(
            (plugin) => plugin.pluginInstanceId === id
          ) ?? null,
        activatePlugin: (id) => activatePlugin(id),
        isSessionLive: policy.isSessionLive,
        refuseWrite: policy.refuseWrite,
        endpointRegistry: endpoints,
      }),
  });
  host = new Host(pluginTools);
  revoked = [];
  const offRevoked = pluginMcpGrantRegistry.onRevoked((grants, reason) => {
    for (const grant of grants) revoked.push({ grant, reason });
  });

  const senders = new SenderSessions();
  const ctx = {
    session: links.host,
    sessionId: "link-1",
    client: { clientName: "greg-mbp" },
  } as unknown as MetricsSessionContext;
  const expired = new Set<(info: { sessionId: string }) => void>();
  expireLink = (sessionId) => {
    for (const listener of expired) listener({ sessionId });
  };
  const source = {
    sessions: [ctx],
    onSession: () => () => {},
    onSessionExpired: (listener: (info: { sessionId: string }) => void) => {
      expired.add(listener);
      return () => expired.delete(listener);
    },
  };
  const offSenders = installAssistantSenderHostWith(source, { senders });
  const relay = installHostMcpRelay(source, {
    senders: () => senders,
    acceptsRemoteControl: () => host.accepts,
    hasProject: async (projectId) => projectId === PROJECT,
    openSession: (spec) => host.open(spec),
    endPluginGrants: (senderId, helpSessionId) =>
      pluginTools.endHelpSession(senderId, helpSessionId),
    expirePluginGrants: (linkSessionId) => pluginTools.expireLink(linkSessionId),
  });

  let ids = 0;
  const client = new HostControlLinkClient({
    credential: () => CREDENTIAL,
    session: async () => links.client,
    onSessionOpened: (listener) => {
      listener(HOST_ID, links.client);
      return () => {};
    },
    noticeReceiver: () => runtime,
    approvalReceiver: () => runtime,
    noticeStatusDelayMs: 60_000,
  });
  const runs = new Map([
    [GLOBAL_RUN.sessionId, GLOBAL_RUN],
    [PROJECT_RUN.sessionId, PROJECT_RUN],
  ]);
  runtime = new HostCallRuntime({
    getSessionLane: (id) => {
      const run = runs.get(id);
      return run ? { projectId: run.projectId, slot: run.slot } : null;
    },
    callerRun: (id) => runs.get(id) ?? null,
    client: () => client,
    hosts: () => [HOST],
    inLocalView: () => true,
    controlEnabled: (hostId) => hostId === HOST_ID,
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  client.start();
  disposeAll = () => {
    runtime.dispose();
    client.dispose();
    relay.dispose();
    pluginTools.dispose();
    offSenders();
    offRevoked();
  };
});

afterEach(async () => {
  disposeAll();
  pluginMcpGrantRegistry.revokeAll();
  links.host.close("test");
  links.client.close("test");
  await removeTempDir(dir);
});

async function relayed(
  op: { tool: string; args: Record<string, unknown> },
  options: { helpSessionId?: string; tier?: "core" | "full" } = {}
) {
  const settled = await runtime.call(
    options.helpSessionId ?? GLOBAL_RUN.sessionId,
    { hostId: HOST_ID, projectId: PROJECT, tool: op.tool, args: op.args },
    { tier: options.tier ?? "core" }
  );
  if (!settled.ok) throw new Error(`refused: ${JSON.stringify(settled)}`);
  return settled.value;
}

function text(value: Awaited<ReturnType<typeof relayed>>): string {
  return JSON.stringify(value.result);
}

describe("the global Assistant reaching a plugin's agent tools on another machine (#18256)", () => {
  it.each(["core", "full"] as const)(
    "lists and calls the host project's plugin tool, at %s",
    async (tier) => {
      const listed = await relayed(LIST, { tier });
      expect(listed.outcome).toBe("ok");
      expect(listed.result?.structured).toMatchObject({
        tools: [{ pluginInstanceId: LEDGER, name: "lookup", plugin: "Ledger" }],
        nextCursor: null,
      });

      const called = await relayed(CALL, { tier });
      expect(called).toMatchObject({ outcome: "ok", result: { isError: false } });
      expect(called.result?.structured).toEqual({ found: "r-1" });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0][2]).toEqual({
        credentialId: expect.any(String),
        projectId: PROJECT,
        consumer: "global-assistant",
      });
      // Answered beside the host's own session, and recorded there under the Shell's callIds.
      expect(host.innerCalls).toEqual([]);
      expect(host.recorded).toEqual([
        { toolId: "plugin.tools", callId: listed.callId, result: "ok" },
        { toolId: "plugin.callTool", callId: called.callId, result: "ok" },
      ]);
      expect(liveHostGrants()).toHaveLength(1);
    }
  );

  it("refuses both while the host doesn't let other machines' assistants work there", async () => {
    host.accepts = false;

    for (const op of [LIST, CALL]) {
      expect((await relayed(op)).outcome).toBe("policy_rejected");
    }
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(liveHostGrants()).toEqual([]);
  });

  it("runs nothing when the host stops letting them while the plugin starts", async () => {
    activatePlugin.mockImplementation(async () => {
      host.accepts = false;
    });

    const answer = await relayed(CALL);

    expect(answer.result?.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("neither lists nor calls a plugin whose tools the host project's Assistant isn't allowed", async () => {
    await relayed(LIST);
    setProjectAssistantAgentMcpAccess(PROJECT, LEDGER, "off");

    const listed = await relayed(LIST);
    expect(listed.result?.structured).toMatchObject({ tools: [] });
    const called = await relayed(CALL);
    expect(called.result?.isError).toBe(true);
    expect(text(called)).toContain("aren't on for the Assistant in this project");
    expect(invoke).not.toHaveBeenCalled();
    expect(liveHostGrants()).toEqual([]);
  });

  it("refuses a plugin's own tool while another machine drives the host project", async () => {
    host.driven = "laptop-02 has control of this project.";

    const answer = await relayed(CALL);

    expect(answer.result?.isError).toBe(true);
    expect(text(answer)).toContain("laptop-02");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops the host's grant when the Shell's session ends, and refuses that session after", async () => {
    await relayed(LIST);
    expect(liveHostGrants()).toHaveLength(1);

    runtime.endHelpSession(GLOBAL_RUN.sessionId);

    await vi.waitFor(() => expect(liveHostGrants()).toEqual([]));
    expect(revoked.map(({ reason }) => reason)).toEqual(["session-ended"]);
    const after = await relayed(CALL);
    expect(after.result?.isError).toBe(true);
    expect(text(after)).toContain("session has ended");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops the host's grant when the Shell's link expires", async () => {
    await relayed(LIST);
    expect(liveHostGrants()).toHaveLength(1);

    expireLink("link-1");

    await vi.waitFor(() => expect(liveHostGrants()).toEqual([]));
    expect(revoked.map(({ reason }) => reason)).toEqual(["session-ended"]);
  });

  it("stops a plugin call still starting when the Shell's link expires", async () => {
    await relayed(LIST);
    let entered = false;
    let release!: () => void;
    activatePlugin.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          entered = true;
          release = resolve;
        })
    );
    const pending = relayed(CALL);
    await vi.waitFor(() => expect(entered).toBe(true));

    expireLink("link-1");

    await vi.waitFor(() => expect(liveHostGrants()).toEqual([]));
    release();
    expect((await pending).result?.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps them from an ordinary relayed session: a project assistant's", async () => {
    for (const op of [LIST, CALL]) {
      const answer = await relayed(op, { helpSessionId: PROJECT_RUN.sessionId });
      expect(answer.result?.isError).toBe(true);
    }
    expect(host.innerCalls).toEqual(["plugin.tools", "plugin.callTool"]);
    expect(resolvePlugins).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a readable tool error from a host that doesn't offer them", async () => {
    host.decorates = false;

    const answer = await relayed(LIST);

    expect(answer.outcome).toBe("ok");
    expect(answer.result?.isError).toBe(true);
    expect(text(answer)).toContain("Unknown tool");
    expect(invoke).not.toHaveBeenCalled();
  });
});
