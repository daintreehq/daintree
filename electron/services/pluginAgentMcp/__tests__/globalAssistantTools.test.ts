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

import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../../shared/config/mcpLimits.js";
import {
  makeProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginManifest,
} from "../../../../shared/types/plugin.js";
import { listDeclaredAgentMcpPlugins } from "../declaredEndpoints.js";
import { AgentMcpEndpointRegistry } from "../endpointRegistry.js";
import {
  DEFAULT_PLUGIN_TOOLS_PAGE_BYTES,
  GlobalAssistantPluginTools,
  type GlobalAssistantPluginToolsDeps,
} from "../globalAssistantTools.js";
import { pluginMcpGrantRegistry } from "../grantRegistry.js";
import { resolveLaunchPluginsReport } from "../launchPlugins.js";
import { _resetProjectMcpDefaultsForTests } from "../projectDefaults.js";
import {
  setProjectAgentMcpAccess,
  setProjectAssistantAgentMcpAccess,
} from "../projectEnablement.js";
import {
  DATABASE_ENDPOINT_ID,
  type AgentMcpToolGroupRef,
  type AgentMcpToolInvoker,
} from "../types.js";
import { compileAgentMcpTool } from "../validateTools.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const SESSION = "help-global-1";
const LEDGER = "acme.ledger";
const CRM = "acme.crm";
const SEARCH: AgentMcpToolGroupRef = { id: "search", access: "read" };
const CHANGES: AgentMcpToolGroupRef = { id: "changes", access: "write" };

const LOOKUP = compileAgentMcpTool({
  name: "lookup",
  description: "Look a record up.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
});
const FIND = compileAgentMcpTool({
  name: "find",
  description: "Find contacts.",
  inputSchema: { type: "object" },
  group: SEARCH,
});
const EDIT = compileAgentMcpTool({
  name: "edit",
  description: "Change a contact.",
  inputSchema: { type: "object" },
  group: CHANGES,
});

function record(
  name: string,
  overrides: {
    instanceId?: string;
    origin?: "global" | "project";
    projectId?: string;
    groups?: boolean;
    databases?: boolean;
  } = {}
): LoadedPluginInfo {
  return {
    manifest: {
      name,
      version: "1.0.0",
      displayName: name === LEDGER ? "Ledger" : "CRM",
      capabilities: ["mcp:expose"],
      contributes: {
        agentMcp: [
          {
            id: "data",
            name: `${name} tools`,
            mode: "tools",
            ...(overrides.groups === true
              ? {
                  groups: [
                    { ...SEARCH, name: "Search contacts" },
                    { ...CHANGES, name: "Change contacts" },
                  ],
                }
              : {}),
          },
        ],
        databases:
          overrides.databases === true
            ? [{ id: "ledger", location: "local", journalMode: "delete" }]
            : [],
      },
    } as unknown as PluginManifest,
    instanceId: overrides.instanceId ?? name,
    origin: overrides.origin ?? "global",
    projectId: overrides.projectId ?? null,
    disabled: false,
  } as unknown as LoadedPluginInfo;
}

let records: LoadedPluginInfo[];
let loaded: Set<string>;
let endpoints: AgentMcpEndpointRegistry;
let invoke: ReturnType<typeof vi.fn<AgentMcpToolInvoker>>;
let live: Set<string>;
let activatePlugin: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;
let getPluginService: ReturnType<typeof vi.fn>;
let tools: GlobalAssistantPluginTools;

const pluginService = {
  waitForCatalog: async () => {},
  waitForProjectPlugins: async () => true,
  listPlugins: () => records,
  hasPlugin: (id: string) => loaded.has(id),
};

function makeTools(overrides: Partial<GlobalAssistantPluginToolsDeps> = {}) {
  return new GlobalAssistantPluginTools({
    projectRoot: async (projectId) =>
      projectId === PROJECT_A || projectId === PROJECT_B ? `/nonexistent/${projectId}` : null,
    resolvePlugins: (projectId, root) =>
      resolveLaunchPluginsReport(projectId, root, "assistant", getPluginService as never),
    declaredPlugin: (projectId, id) =>
      listDeclaredAgentMcpPlugins(records, projectId, (candidate) => loaded.has(candidate)).find(
        (plugin) => plugin.pluginInstanceId === id
      ) ?? null,
    activatePlugin,
    isSessionLive: (id) => live.has(id),
    endpointRegistry: endpoints,
    ...overrides,
  } as GlobalAssistantPluginToolsDeps);
}

function allowLedger(projectId = PROJECT_A, instance = LEDGER): void {
  setProjectAgentMcpAccess(projectId, instance, "read-write");
  setProjectAssistantAgentMcpAccess(projectId, instance, "read-write");
}

const signal = () => new AbortController().signal;

function structured(result: Awaited<ReturnType<GlobalAssistantPluginTools["list"]>>) {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as {
    tools: Array<Record<string, unknown>>;
    nextCursor: string | null;
    unavailable: Array<{ pluginInstanceId: string; reason: string }>;
    off: Array<{ pluginInstanceId: string; plugin: string }>;
    stillLoading: boolean;
  };
}

function text(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

beforeEach(() => {
  storeMock.data.clear();
  storeMock.get.mockReset().mockImplementation((key: string) => storeMock.data.get(key));
  storeMock.set.mockReset().mockImplementation((key: string, value: unknown) => {
    storeMock.data.set(key, value);
  });
  pluginMcpGrantRegistry.revokeAll();
  _resetProjectMcpDefaultsForTests();
  records = [record(LEDGER)];
  loaded = new Set([LEDGER]);
  endpoints = new AgentMcpEndpointRegistry();
  invoke = vi.fn<AgentMcpToolInvoker>(async (_name, args) => ({ found: args.id }));
  endpoints.register({ pluginInstanceId: LEDGER, endpointId: "data", tools: [LOOKUP], invoke });
  live = new Set([SESSION]);
  activatePlugin = vi.fn(async () => {});
  getPluginService = vi.fn(async () => pluginService);
  tools = makeTools();
});

afterEach(() => {
  tools.dispose();
  pluginMcpGrantRegistry.revokeAll();
});

describe("GlobalAssistantPluginTools (#18254)", () => {
  it("lists and calls a project's allowed plugin tool with no launch there", async () => {
    allowLedger();

    const listed = structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    expect(listed.tools).toEqual([
      {
        pluginInstanceId: LEDGER,
        plugin: "Ledger",
        name: "lookup",
        description: "Look a record up.",
        inputSchema: LOOKUP.inputSchema,
      },
    ]);
    expect(listed.nextCursor).toBeNull();

    const called = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    expect(called.isError).not.toBe(true);
    expect(JSON.parse(text(called))).toEqual({ found: "r-1" });

    const caller = invoke.mock.calls[0][2];
    expect(caller).toEqual({
      credentialId: expect.any(String),
      projectId: PROJECT_A,
      consumer: "global-assistant",
    });
    expect(Object.isFrozen(caller)).toBe(true);
    // One grant held by the session for the plugin, reused by the call after the list.
    const grant = pluginMcpGrantRegistry.get(caller.credentialId);
    expect(grant).toMatchObject({
      consumer: "global-assistant",
      helpSessionId: SESSION,
      projectId: PROJECT_A,
      pluginInstanceId: LEDGER,
    });
    expect(grant).not.toHaveProperty("terminalId");
    expect(grant).not.toHaveProperty("bearerSha256");
  });

  it("checks the input against the schema before any plugin code runs", async () => {
    allowLedger();
    const result = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: {} },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("never loads the plugin service for a project whose Assistant has no plugin allowed", async () => {
    setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");

    const listed = structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    expect(listed.tools).toEqual([]);
    const called = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup" },
      signal()
    );
    expect(called.isError).toBe(true);
    expect(text(called)).toContain("aren't on for the Assistant");
    expect(getPluginService).not.toHaveBeenCalled();
    expect(activatePlugin).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("names a plugin whose tools are off for the Assistant without listing them", async () => {
    allowLedger();
    records = [record(LEDGER), record(CRM)];
    loaded.add(CRM);
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-write");

    const listed = structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    expect(listed.tools.map((row) => row.pluginInstanceId)).toEqual([LEDGER]);
    expect(listed.off).toEqual([{ pluginInstanceId: CRM, plugin: "CRM" }]);
  });

  it("refuses another project's plugin, by the project's own reach", async () => {
    const ledgerB = makeProjectPluginInstanceKey(PROJECT_B, LEDGER);
    records = [record(LEDGER, { instanceId: ledgerB, origin: "project", projectId: PROJECT_B })];
    loaded = new Set([ledgerB]);
    endpoints.register({ pluginInstanceId: ledgerB, endpointId: "data", tools: [LOOKUP], invoke });
    allowLedger(PROJECT_B, ledgerB);
    // Even an answer on record for it in project A doesn't reach B's instance.
    allowLedger(PROJECT_A, ledgerB);

    const listed = structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    expect(getPluginService).toHaveBeenCalled();
    expect(listed.tools).toEqual([]);
    const result = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: ledgerB, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();

    // The same plugin in its own project is reached.
    const own = await tools.call(
      SESSION,
      PROJECT_B,
      { pluginInstanceId: ledgerB, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    expect(own.isError).not.toBe(true);
    expect(invoke.mock.calls[0][2].projectId).toBe(PROJECT_B);
  });

  it("refuses a tool in a group the Assistant isn't allowed", async () => {
    records = [record(CRM, { groups: true })];
    loaded = new Set([CRM]);
    endpoints.register({ pluginInstanceId: CRM, endpointId: "data", tools: [FIND, EDIT], invoke });
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH, CHANGES]);
    setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);

    const listed = structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    expect(listed.tools.map((row) => [row.name, row.group])).toEqual([["find", SEARCH]]);

    const refused = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: CRM, tool: "edit" },
      signal()
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Unknown tool");
    expect(invoke).not.toHaveBeenCalled();

    const allowed = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: CRM, tool: "find" },
      signal()
    );
    expect(allowed.isError).not.toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("refuses a call once Agent tools went off between the list and the call", async () => {
    allowLedger();
    structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    const [credentialId] = [...grantIds()];

    setProjectAssistantAgentMcpAccess(PROJECT_A, LEDGER, "off");

    expect(pluginMcpGrantRegistry.isLive(credentialId)).toBe(false);
    const result = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("aren't on for the Assistant");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses at dispatch when a reload changed what the answer reaches", async () => {
    // A read-only answer with the search group reaches `find` while the
    // endpoint is grouped. The plugin reloads during activation, dropping its
    // groups, before any regroup could fire: read only never reaches an
    // ungrouped endpoint, so nothing of the new roster may run.
    records = [record(CRM, { groups: true })];
    loaded = new Set([CRM]);
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);
    setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);
    let release!: () => void;
    activatePlugin.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const pending = tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: CRM, tool: "find" },
      signal()
    );
    await vi.waitFor(() => expect(activatePlugin).toHaveBeenCalled());

    records = [record(CRM)];
    endpoints.register({
      pluginInstanceId: CRM,
      endpointId: "data",
      tools: [
        compileAgentMcpTool({
          name: "find",
          description: "Find.",
          inputSchema: { type: "object" },
        }),
      ],
      invoke,
    });
    release();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an unloaded plugin, whose grant goes with it", async () => {
    allowLedger();
    structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    const [credentialId] = [...grantIds()];

    loaded.delete(LEDGER);
    pluginMcpGrantRegistry.revokePlugin(LEDGER);

    expect(pluginMcpGrantRegistry.isLive(credentialId)).toBe(false);
    const result = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an ended session and revokes what it held", async () => {
    allowLedger();
    structured(await tools.list(SESSION, PROJECT_A, {}, signal()));
    const [credentialId] = [...grantIds()];

    live.delete(SESSION);
    tools.endSession(SESSION);

    expect(pluginMcpGrantRegistry.isLive(credentialId)).toBe(false);
    for (const result of [
      await tools.list(SESSION, PROJECT_A, {}, signal()),
      await tools.call(
        SESSION,
        PROJECT_A,
        { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
        signal()
      ),
    ]) {
      expect(result.isError).toBe(true);
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(grantIds().size).toBe(0);
  });

  it("mints no grant for a session that ended while its first call resolved plugins", async () => {
    allowLedger();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = false;
    tools.dispose();
    tools = makeTools({
      resolvePlugins: async (projectId, root) => {
        entered = true;
        await gate;
        return resolveLaunchPluginsReport(projectId, root, "assistant", getPluginService as never);
      },
    });
    const pending = tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    live.delete(SESSION);
    tools.endSession(SESSION);
    resume();

    expect((await pending).isError).toBe(true);
    expect(grantIds().size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops a call already running when its session ends", async () => {
    allowLedger();
    invoke.mockImplementation(() => new Promise(() => {}));
    const pending = tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    live.delete(SESSION);
    tools.endSession(SESSION);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("session closed");
  });

  it("keeps one session's grants apart from another's", async () => {
    allowLedger();
    live.add("help-global-2");
    await tools.list(SESSION, PROJECT_A, {}, signal());
    await tools.list("help-global-2", PROJECT_A, {}, signal());
    expect(grantIds().size).toBe(2);

    tools.endSession(SESSION);

    const survivors = [...grantIds()].map((id) => pluginMcpGrantRegistry.get(id));
    expect(
      survivors.map((grant) => grant?.consumer === "global-assistant" && grant.helpSessionId)
    ).toEqual(["help-global-2"]);
  });

  it("pages a roster too long for one answer, never cutting a row", async () => {
    allowLedger();
    // As large as a legal roster gets: the most tools an endpoint takes, each
    // with an input schema near the size limit.
    const wide = Array.from({ length: 16 }, (_, index) =>
      compileAgentMcpTool({
        name: `tool_${index}`,
        description: "d".repeat(380),
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 40 }, (_, field) => [
              `field_${field}`,
              { type: "string", description: "x".repeat(150) },
            ])
          ),
        },
      })
    );
    endpoints.register({ pluginInstanceId: LEDGER, endpointId: "data", tools: wide, invoke });

    const names: unknown[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const page = structured(
        await tools.list(SESSION, PROJECT_A, cursor ? { cursor } : {}, signal())
      );
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
        DEFAULT_PLUGIN_TOOLS_PAGE_BYTES
      );
      // The whole host.call answer around it still arrives whole.
      const reply = {
        outcome: "ok",
        detail: null,
        retryAfterMs: null,
        callId: "00000000-0000-4000-8000-000000000000",
        result: { isError: false, structured: page, text: null },
      };
      expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(
        MCP_RESPONSE_TEXT_MAX_BYTES
      );
      names.push(...page.tools.map((row) => row.name));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 20);

    expect(pages).toBeGreaterThan(1);
    expect(names).toEqual(wide.map((tool) => tool.name));
  });

  it("refuses arguments it doesn't take, before resolving anything", async () => {
    allowLedger();
    const list = await tools.list(SESSION, PROJECT_A, { projectId: PROJECT_B }, signal());
    const call = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", consumer: "assistant" },
      signal()
    );
    expect(list.isError).toBe(true);
    expect(call.isError).toBe(true);
    expect(getPluginService).not.toHaveBeenCalled();
  });

  it("refuses a call while another machine drives the project, judged as it dispatches", async () => {
    allowLedger();
    let driven: string | null = null;
    let release!: () => void;
    activatePlugin.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const refuseWrite = vi.fn((_projectId: string) => driven);
    tools.dispose();
    tools = makeTools({ refuseWrite });
    const pending = tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    await vi.waitFor(() => expect(activatePlugin).toHaveBeenCalled());
    // Another machine takes the project while the plugin starts.
    driven = "studio-01 has control of this project.";
    release();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("studio-01");
    expect(refuseWrite).toHaveBeenCalledWith(PROJECT_A);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("doesn't start the plugin for a call refused because another machine drives the project", async () => {
    allowLedger();
    tools.dispose();
    tools = makeTools({ refuseWrite: () => "studio-01 has control of this project." });

    const result = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );

    expect(result.isError).toBe(true);
    expect(activatePlugin).not.toHaveBeenCalled();
    expect(grantIds().size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still answers the host's own reads while another machine drives the project", async () => {
    records = [record(LEDGER, { databases: true })];
    setProjectAgentMcpAccess(PROJECT_A, LEDGER, "read-write");
    setProjectAssistantAgentMcpAccess(PROJECT_A, LEDGER, "read-only");
    const readInvoke = vi.fn<AgentMcpToolInvoker>(async () => ({ rows: [] }));
    endpoints.register({
      pluginInstanceId: LEDGER,
      endpointId: DATABASE_ENDPOINT_ID,
      tools: [
        compileAgentMcpTool({
          name: "database_query",
          description: "Run a read-only query.",
          inputSchema: { type: "object" },
          readOnly: true,
        }),
      ],
      invoke: readInvoke,
    });
    const refuseWrite = vi.fn(() => "studio-01 has control of this project.");
    tools.dispose();
    tools = makeTools({ refuseWrite });

    const read = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "database_query" },
      signal()
    );

    expect(read.isError).not.toBe(true);
    expect(readInvoke).toHaveBeenCalledTimes(1);
    expect(refuseWrite).not.toHaveBeenCalled();
  });

  it("mints nothing and runs nothing once disposed mid-call", async () => {
    allowLedger();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered = false;
    tools.dispose();
    tools = makeTools({
      resolvePlugins: async (projectId, root) => {
        entered = true;
        await gate;
        return resolveLaunchPluginsReport(projectId, root, "assistant", getPluginService as never);
      },
    });
    const pending = tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: LEDGER, tool: "lookup", arguments: { id: "r-1" } },
      signal()
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    tools.dispose();
    resume();

    expect((await pending).isError).toBe(true);
    expect(grantIds().size).toBe(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves out a plugin whose tools were taken away while another was still listing", async () => {
    allowLedger();
    records = [record(LEDGER), record(CRM)];
    loaded.add(CRM);
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-write");
    setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-write");
    endpoints.register({ pluginInstanceId: CRM, endpointId: "data", tools: [LOOKUP], invoke });
    let release!: () => void;
    activatePlugin.mockImplementation(async (id) => {
      if (id !== CRM) return;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = tools.list(SESSION, PROJECT_A, {}, signal());
    await vi.waitFor(() => expect(activatePlugin).toHaveBeenCalledWith(CRM));
    setProjectAssistantAgentMcpAccess(PROJECT_A, LEDGER, "off");
    release();

    const listed = structured(await pending);
    expect(listed.tools.map((row) => row.pluginInstanceId)).toEqual([CRM]);
    // Said, so the Assistant lists again rather than taking the gap as final.
    expect(listed.unavailable).toEqual([
      { pluginInstanceId: LEDGER, reason: expect.stringContaining("List again") },
    ]);
  });

  it("mints at the scope the answer gives now, not the one a slow resolution read", async () => {
    records = [record(CRM, { groups: true })];
    loaded = new Set([CRM]);
    endpoints.register({ pluginInstanceId: CRM, endpointId: "data", tools: [FIND, EDIT], invoke });
    setProjectAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH, CHANGES]);
    setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH, CHANGES]);
    tools.dispose();
    tools = makeTools({
      resolvePlugins: async (projectId, root) => {
        const report = await resolveLaunchPluginsReport(
          projectId,
          root,
          "assistant",
          getPluginService as never
        );
        // The person narrows the answer after this call read it.
        setProjectAssistantAgentMcpAccess(PROJECT_A, CRM, "read-only", undefined, [SEARCH]);
        return report;
      },
    });

    const refused = await tools.call(
      SESSION,
      PROJECT_A,
      { pluginInstanceId: CRM, tool: "edit" },
      signal()
    );

    expect(refused.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(
      pluginMcpGrantRegistry.listForHelpSession(SESSION).map((g) => g.scope.pluginGroups)
    ).toEqual([[SEARCH]]);
  });
});

function grantIds(sessions: readonly string[] = [SESSION, "help-global-2"]): Set<string> {
  return new Set(
    sessions.flatMap((session) =>
      pluginMcpGrantRegistry.listForHelpSession(session).map((grant) => grant.credentialId)
    )
  );
}
