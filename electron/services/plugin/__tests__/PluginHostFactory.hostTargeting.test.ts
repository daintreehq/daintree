import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consentMock = vi.hoisted(() => ({
  ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined),
}));
const grantMock = vi.hoisted(() => ({ hasGrant: vi.fn((_grant: unknown) => false) }));
const ptyMock = vi.hoisted(() => ({
  client: null as null | Record<string, unknown>,
}));
const leaseMock = vi.hoisted(() => ({
  assertPluginCallerDrives: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectPushTargets: vi.fn(() => []),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => ptyMock.client) }));
vi.mock("../pluginDriveLease.js", () => leaseMock);
vi.mock("../../AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));
vi.mock("../../forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn(() => false),
}));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => consentMock),
  getPluginCapabilityConsentStore: vi.fn(() => grantMock),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { _resetPluginLaunchesForTests, forgetPluginLaunches } from "../pluginLaunchedAgents.js";
import {
  setPluginHostTargets,
  type PluginHostAgentInput,
  type PluginHostAgentInputAnswer,
  type PluginHostTarget,
  type PluginHostTargets,
} from "../pluginHostTargets.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginHostBinding,
} from "../../../../shared/types/plugin.js";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme.orchestrator";
const OTHER_PLUGIN_ID = "acme.other";
const PROJECT_ID = "a".repeat(64);
const BOUND: PluginHostBinding = { projectId: PROJECT_ID, projectRoot: "/repos/alpha" };


function launchResult(terminalId: string | null, launched = true): ActionDispatchResult {
  return {
    ok: true,
    result: { launched, terminalId, spawnStatus: launched ? null : "missing-cli" },
  };
}

interface Harness {
  deps: PluginHostFactoryDeps;
  plugins: Map<string, LoadedPlugin>;
  capabilities: Map<string, Set<string>>;
  sendDispatchToRenderer: ReturnType<typeof vi.fn>;
}

function loaded(id: string, binding: PluginHostBinding | null = null): LoadedPlugin {
  return {
    isBuiltin: false,
    manifest: { name: id, capabilities: ["agent:input"], contributes: {} },
    ...(binding ? { binding } : {}),
  } as unknown as LoadedPlugin;
}

function makeHarness(): Harness {
  const plugins = new Map<string, LoadedPlugin>([
    [PLUGIN_ID, loaded(PLUGIN_ID)],
    [OTHER_PLUGIN_ID, loaded(OTHER_PLUGIN_ID)],
  ]);
  const capabilities = new Map<string, Set<string>>([
    [PLUGIN_ID, new Set(["agent:input"])],
    [OTHER_PLUGIN_ID, new Set(["agent:input"])],
  ]);
  const sendDispatchToRenderer = vi.fn(async (..._args: unknown[]): Promise<ActionDispatchResult> =>
    launchResult("t-1")
  );
  const deps = {
    plugins,
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginToolbarBadges: new Map(),
    emitToolbarBadges: () => {},
    pluginToolbarStates: new Map(),
    emitToolbarStates: () => {},
    pluginWorktreeCardStatuses: new Map(),
    emitWorktreeCardStatuses: () => {},
    worktreeCardStatusGeneration: () => 0,
    pluginWorktreeReviewChecks: new Map(),
    emitWorktreeReviewChecks: () => {},
    worktreeReviewChecksGeneration: () => 0,
    worktreeCardTargetRevision: () => 0,
    isWorktreeCardTargetRetired: () => false,
    pluginPanelMenus: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
    dispatcher: { sendDispatchToRenderer },
    promptDispatcher: { requestPrompt: vi.fn() },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: (id: string) => capabilities.get(id) ?? new Set(),
    getFleetSnapshotService: () => null,
    fetchWorktreeSnapshotsResult: vi.fn(),
    fetchWorktreeSnapshotsForProjectResult: vi.fn(),
    recordPluginLog: vi.fn(),
    serializePluginBadges: () => ({}),
    serializePluginPanelMenus: () => ({}),
    pluginDisplayName: (id: string) => id,
    pluginDataDir: () => "/tmp/data",
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    getWorktreeCustomTitles: vi.fn(() => ({})),
    subscribeWorktreeCustomTitles: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, capabilities, sendDispatchToRenderer };
}

const HOST_ID = "studio";
const REMOTE_PROJECT = "c".repeat(64);

/** A fake of the remote hosts module's client: what reached each host, and its answers. */
function fakeTargets() {
  const dispatched: Array<{ target: PluginHostTarget; request: unknown }> = [];
  const inputs: Array<{ target: PluginHostTarget; terminalId: string; input: PluginHostAgentInput }> =
    [];
  let inputAnswer: PluginHostAgentInputAnswer = { status: "sent" };
  const targets: PluginHostTargets = {
    knows: (hostId) => hostId === HOST_ID,
    nameOf: (hostId) => (hostId === HOST_ID ? "Studio" : hostId),
    listHosts: vi.fn(async () => [
      {
        hostId: HOST_ID,
        name: "Studio",
        connection: "connected" as const,
        projects: [{ projectId: REMOTE_PROJECT, name: "beads" }],
      },
    ]),
    dispatch: vi.fn(async (target: PluginHostTarget, request: unknown) => {
      dispatched.push({ target, request });
      return { ok: true, result: { launched: true, terminalId: "remote-1" } } as ActionDispatchResult;
    }),
    agentInput: vi.fn(async (target: PluginHostTarget, terminalId: string, input: PluginHostAgentInput) => {
      inputs.push({ target, terminalId, input });
      return inputAnswer;
    }),
  };
  return {
    targets,
    dispatched,
    inputs,
    answerInput: (answer: PluginHostAgentInputAnswer) => {
      inputAnswer = answer;
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

let fake: ReturnType<typeof fakeTargets>;
let uninstall: () => void;
let hostTargetingOn: boolean;

beforeEach(() => {
  _resetPluginLaunchesForTests();
  hostTargetingOn = false;
  grantMock.hasGrant.mockReset();
  grantMock.hasGrant.mockImplementation(
    (grant: unknown) =>
      hostTargetingOn && (grant as { capability?: string }).capability === "host:dispatch"
  );
  consentMock.ensureAllowed.mockReset();
  consentMock.ensureAllowed.mockResolvedValue(undefined);
  fake = fakeTargets();
  uninstall = setPluginHostTargets(fake.targets);
});

afterEach(() => {
  uninstall();
});

function grantHosts(h: Harness, pluginId = PLUGIN_ID): void {
  h.capabilities.get(pluginId)!.add("host:dispatch");
  hostTargetingOn = true;
}

describe("host.dispatch with options.hostId (#16767)", () => {
  it("refuses a plugin that hasn't declared host:dispatch, sending nothing", async () => {
    const h = makeHarness();
    hostTargetingOn = true;
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    expect(
      await rejection(
        host.dispatch("worktree.list", {}, { hostId: HOST_ID, projectId: REMOTE_PROJECT })
      )
    ).toMatch(/^PERMISSION_REQUIRED: .*"host:dispatch"/);
    expect(fake.dispatched).toEqual([]);
  });

  it("refuses while Allow host targeting is off, naming the switch", async () => {
    const h = makeHarness();
    h.capabilities.get(PLUGIN_ID)!.add("host:dispatch");
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    expect(
      await rejection(
        host.dispatch("worktree.list", {}, { hostId: HOST_ID, projectId: REMOTE_PROJECT })
      )
    ).toMatch(/^PERMISSION_REQUIRED: .*"Allow host targeting"/);
    expect(fake.dispatched).toEqual([]);
    // The switch is the whole grant: nothing is asked.
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
  });

  it("never lets a project plugin target a host, whatever it declares or was granted", async () => {
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, BOUND).host;

    expect(
      await rejection(
        host.dispatch("worktree.list", {}, { hostId: HOST_ID, projectId: REMOTE_PROJECT })
      )
    ).toMatch(/^PERMISSION_REQUIRED: .*project plugin/);
    await expect(host.remoteHosts.list()).rejects.toThrow(/^PERMISSION_REQUIRED: .*project plugin/);
    expect(fake.dispatched).toEqual([]);
  });

  it.each([
    ["an empty host id", { hostId: "", projectId: REMOTE_PROJECT }, /hostId must be/],
    ["this machine's own id", { hostId: "local", projectId: REMOTE_PROJECT }, /not a Remote Host/],
    ["a host with no project", { hostId: HOST_ID }, /needs options.projectId/],
  ])("refuses %s rather than running it on this machine", async (_label, options, message) => {
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    await expect(host.dispatch("worktree.list", {}, options)).rejects.toThrow(message);
    expect(fake.dispatched).toEqual([]);
    expect(h.sendDispatchToRenderer).not.toHaveBeenCalled();
  });

  it("sends the call to the host as this plugin, without project:dispatch, and audits it", async () => {
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    const result = await host.dispatch(
      "agent.launch",
      { agentId: "claude", prompt: "pick up bd-12" },
      { hostId: HOST_ID, projectId: REMOTE_PROJECT }
    );

    expect(result.ok).toBe(true);
    expect(fake.dispatched).toEqual([
      {
        target: { hostId: HOST_ID, pluginId: PLUGIN_ID },
        request: {
          projectId: REMOTE_PROJECT,
          actionId: "agent.launch",
          args: { agentId: "claude", prompt: "pick up bd-12" },
        },
      },
    ]);
    expect(h.sendDispatchToRenderer).not.toHaveBeenCalled();
    expect(h.deps.safeAppendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        actionId: `dispatch:${HOST_ID}:${REMOTE_PROJECT}:agent.launch`,
        result: "success",
      })
    );
  });

  it("answers NOT_FOUND for a host this machine doesn't drive, sending nothing", async () => {
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    const result = await host.dispatch(
      "worktree.list",
      {},
      { hostId: "elsewhere", projectId: REMOTE_PROJECT }
    );
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(fake.dispatched).toEqual([]);
  });
});

describe("host.remoteHosts.list (#16767)", () => {
  it("lists the hosts and their projects once declared and switched on", async () => {
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;

    const hosts = await host.remoteHosts.list();
    expect(hosts.map((entry) => [entry.hostId, entry.projects?.map((p) => p.projectId)])).toEqual([
      [HOST_ID, [REMOTE_PROJECT]],
    ]);
  });

  it("refuses without the capability or the switch, reading nothing", async () => {
    const h = makeHarness();
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(host.remoteHosts.list()).rejects.toThrow(/"host:dispatch"/);

    h.capabilities.get(PLUGIN_ID)!.add("host:dispatch");
    await expect(host.remoteHosts.list()).rejects.toThrow(/"Allow host targeting"/);
    expect(fake.targets.listHosts).not.toHaveBeenCalled();
  });

  it("answers [] when this machine drives no hosts", async () => {
    uninstall();
    const h = makeHarness();
    grantHosts(h);
    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(host.remoteHosts.list()).resolves.toEqual([]);
  });
});

describe("host.agents input with options.hostId (#16767)", () => {
  async function launchOnHost(h: Harness, pluginId = PLUGIN_ID) {
    const { host } = createHost(h.deps, pluginId, UNBOUND_PLUGIN_HOST_BINDING);
    const result = await host.dispatch(
      "agent.launch",
      { agentId: "claude" },
      { hostId: HOST_ID, projectId: REMOTE_PROJECT }
    );
    expect(result.ok).toBe(true);
  }

  it("reaches the plugin's own remote agent through its host, after the consent check", async () => {
    const h = makeHarness();
    grantHosts(h);
    await launchOnHost(h);
    fake.answerInput({ status: "sent", cancelKey: "advertised" });

    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(host.agents.interrupt("remote-1", { hostId: HOST_ID })).resolves.toEqual({
      status: "sent",
      cancelKey: "advertised",
    });
    expect(fake.inputs).toEqual([
      {
        target: { hostId: HOST_ID, pluginId: PLUGIN_ID },
        terminalId: "remote-1",
        input: { op: "interrupt" },
      },
    ]);
    expect(consentMock.ensureAllowed.mock.calls[0]?.[2]).toBe("agent:input");
  });

  it("answers not-found for another plugin's remote agent, with no prompt and nothing sent", async () => {
    const h = makeHarness();
    grantHosts(h);
    grantHosts(h, OTHER_PLUGIN_ID);
    await launchOnHost(h, OTHER_PLUGIN_ID);

    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(host.agents.interrupt("remote-1", { hostId: HOST_ID })).resolves.toEqual({
      status: "not-found",
    });
    await expect(
      host.agents.submit("remote-1", "continue", { hostId: HOST_ID })
    ).resolves.toEqual({ status: "not-found" });
    expect(fake.inputs).toEqual([]);
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
  });

  it("reaches nothing it launched once the plugin unloads", async () => {
    const h = makeHarness();
    grantHosts(h);
    await launchOnHost(h);
    forgetPluginLaunches(PLUGIN_ID);

    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(
      host.agents.sendKeys("remote-1", { keys: ["Enter"] }, { hostId: HOST_ID })
    ).resolves.toEqual({ status: "not-found" });
    expect(fake.inputs).toEqual([]);
  });

  it("rejects DRIVEN_ELSEWHERE when another screen drives the agent's project there", async () => {
    const h = makeHarness();
    grantHosts(h);
    await launchOnHost(h);
    fake.answerInput({ status: "driven-elsewhere", holderName: "Laptop" });

    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(
      host.agents.submit("remote-1", "continue", { hostId: HOST_ID })
    ).rejects.toThrow(/^DRIVEN_ELSEWHERE: .*Laptop.*Studio/);
  });

  it("needs host targeting as well as agent:input to reach a remote agent", async () => {
    const h = makeHarness();
    grantHosts(h);
    await launchOnHost(h);
    hostTargetingOn = false;

    const host = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
    await expect(host.agents.interrupt("remote-1", { hostId: HOST_ID })).rejects.toThrow(
      /^PERMISSION_REQUIRED: .*"Allow host targeting"/
    );
    expect(fake.inputs).toEqual([]);
  });
});
