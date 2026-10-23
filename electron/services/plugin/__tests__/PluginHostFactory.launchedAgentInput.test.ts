import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const consentMock = vi.hoisted(() => ({
  ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined),
}));
const ptyMock = vi.hoisted(() => ({
  client: null as null | {
    getLiveGeneration: (id: string) => number | null;
    getTerminalProjectId: (id: string) => string | null;
  },
}));
const viewlessMock = vi.hoisted(() => ({
  runViewlessAction: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
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
vi.mock("../../viewless/index.js", () => viewlessMock);
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
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { _resetPluginLaunchesForTests, forgetPluginLaunches } from "../pluginLaunchedAgents.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginHostBinding,
} from "../../../../shared/types/plugin.js";
import type { ActionDispatchResult } from "../../../../shared/types/actions.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme.orchestrator";
const OTHER_PLUGIN_ID = "acme.other";
const PROJECT_ID = "a".repeat(64);
const OTHER_PROJECT_ID = "b".repeat(64);
const BOUND: PluginHostBinding = { projectId: PROJECT_ID, projectRoot: "/repos/alpha" };

/** Terminals the fake terminal host knows, by id, with their owning project. */
let terminals: Map<string, string>;

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

/** Launch through the plugin's own `host.dispatch`, the only way a record is written. */
async function launch(
  h: Harness,
  pluginId = PLUGIN_ID,
  result: ActionDispatchResult = launchResult("t-1"),
  args: unknown = { agentId: "claude" },
  binding: PluginHostBinding = UNBOUND_PLUGIN_HOST_BINDING
) {
  h.sendDispatchToRenderer.mockImplementationOnce(async () => {
    // The spawn lands once the launch has run, as the renderer's startup queue does.
    if (result.ok) {
      const id = (result.result as { terminalId?: unknown }).terminalId;
      if (typeof id === "string") terminals.set(id, binding.projectId ?? PROJECT_ID);
    }
    return result;
  });
  const { host } = createHost(h.deps, pluginId, binding);
  return host.dispatch("agent.launch", args);
}

beforeEach(() => {
  _resetPluginLaunchesForTests();
  terminals = new Map();
  ptyMock.client = {
    getLiveGeneration: (id) => (terminals.has(id) ? 1 : null),
    getTerminalProjectId: (id) => terminals.get(id) ?? null,
  };
  consentMock.ensureAllowed.mockReset();
  consentMock.ensureAllowed.mockResolvedValue(undefined);
  viewlessMock.runViewlessAction.mockReset();
  leaseMock.assertPluginCallerDrives.mockReset();
  leaseMock.assertPluginCallerDrives.mockResolvedValue(undefined);
});

afterEach(() => {
  ptyMock.client = null;
});

describe("host.agents input on agents the plugin launched (#14018)", () => {
  it("interrupts its own launch through the main-side interrupt, scoped to the agent's project", async () => {
    const h = makeHarness();
    expect((await launch(h)).ok).toBe(true);
    viewlessMock.runViewlessAction.mockResolvedValueOnce({
      ok: true,
      result: { terminalId: "t-1", status: "requested", agentId: "claude" },
    });

    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({
      status: "sent",
      cancelKey: "advertised",
    });
    expect(viewlessMock.runViewlessAction).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      actionId: "terminal.interrupt",
      args: { terminalId: "t-1" },
      confirmed: false,
    });
    expect(consentMock.ensureAllowed).toHaveBeenCalledTimes(1);
    expect(consentMock.ensureAllowed.mock.calls[0]?.[2]).toBe("agent:input");
    expect(leaseMock.assertPluginCallerDrives).toHaveBeenCalledWith(PLUGIN_ID, "agents.interrupt", {
      terminalId: "t-1",
    });
  });

  it("reports an unverified cancel key as such", async () => {
    const h = makeHarness();
    await launch(h);
    viewlessMock.runViewlessAction.mockResolvedValueOnce({
      ok: true,
      result: { terminalId: "t-1", status: "requested-unverified" },
    });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({
      status: "sent",
      cancelKey: "unverified",
    });
  });

  it("answers not-found for a terminal it never launched, without a consent prompt or a write", async () => {
    const h = makeHarness();
    terminals.set("user-1", PROJECT_ID);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(host.agents.interrupt("user-1")).resolves.toEqual({ status: "not-found" });
    await expect(host.agents.sendKeys("user-1", { keys: ["Enter"] })).resolves.toEqual({
      status: "not-found",
    });
    await expect(host.agents.submit("user-1", "continue")).resolves.toEqual({
      status: "not-found",
    });
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("never reaches an agent another plugin launched", async () => {
    const h = makeHarness();
    await launch(h, OTHER_PLUGIN_ID);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.submit("t-1", "continue")).resolves.toEqual({ status: "not-found" });
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it.each([
    ["a launch that started no agent", launchResult("gate-1", false)],
    ["a launch with no terminal", launchResult(null)],
    [
      "a failed dispatch",
      { ok: false, error: { code: "EXECUTION_ERROR", message: "boom" } } as ActionDispatchResult,
    ],
  ])("records nothing for %s", async (_label, result) => {
    const h = makeHarness();
    await launch(h, PLUGIN_ID, result);
    terminals.set("gate-1", PROJECT_ID);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("gate-1")).resolves.toEqual({ status: "not-found" });
  });

  it("records nothing from a dispatch of any other action", async () => {
    const h = makeHarness();
    terminals.set("t-1", PROJECT_ID);
    h.sendDispatchToRenderer.mockResolvedValueOnce(launchResult("t-1"));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await host.dispatch("terminal.list", {});
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
  });

  it("never takes a requested id a running terminal already holds as the plugin's", async () => {
    const h = makeHarness();
    // The user's terminal in another view: the launch's own spawn would be refused
    // over it, but the launch result still names the id.
    terminals.set("users-pane", PROJECT_ID);
    await launch(h, PLUGIN_ID, launchResult("users-pane"), {
      agentId: "claude",
      requestedId: "users-pane",
    });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.submit("users-pane", "rm -rf")).resolves.toEqual({
      status: "not-found",
    });
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("does take a requested id nothing holds yet", async () => {
    const h = makeHarness();
    await launch(h, PLUGIN_ID, launchResult("chosen-id"), {
      agentId: "claude",
      requestedId: "chosen-id",
    });
    viewlessMock.runViewlessAction.mockResolvedValueOnce({ ok: true, result: {} });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.submit("chosen-id", "continue")).resolves.toEqual({
      status: "sent",
    });
  });

  it("keeps a project plugin to the project its launch was sent to", async () => {
    const h = makeHarness();
    h.plugins.set(PLUGIN_ID, loaded(PLUGIN_ID, BOUND));
    await launch(h, PLUGIN_ID, launchResult("t-1"), { agentId: "claude" }, BOUND);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    // The terminal host now places the id in another project.
    terminals.set("t-1", OTHER_PROJECT_ID);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });

    terminals.set("t-1", PROJECT_ID);
    viewlessMock.runViewlessAction.mockResolvedValueOnce({
      ok: true,
      result: { status: "requested" },
    });
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({
      status: "sent",
      cancelKey: "advertised",
    });
    expect(viewlessMock.runViewlessAction).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: PROJECT_ID })
    );
  });

  it("answers not-found while the launch's spawn has not reached the terminal host", async () => {
    const h = makeHarness();
    await launch(h);
    terminals.delete("t-1");
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
  });

  it("rejects PERMISSION_REQUIRED when agent:input is not declared", async () => {
    const h = makeHarness();
    await launch(h);
    h.capabilities.set(PLUGIN_ID, new Set(["agent:read"]));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).rejects.toThrow(/PERMISSION_REQUIRED.*agent:input/);
    await expect(host.agents.sendKeys("t-1", { keys: ["Enter"] })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    await expect(host.agents.submit("t-1", "x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("writes nothing when the user denies consent", async () => {
    const h = makeHarness();
    await launch(h);
    consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.submit("t-1", "continue")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("reads the record again after the consent prompt", async () => {
    const h = makeHarness();
    await launch(h);
    consentMock.ensureAllowed.mockImplementationOnce(async () => {
      forgetPluginLaunches(PLUGIN_ID);
    });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("holds the write to the drive lease", async () => {
    const h = makeHarness();
    await launch(h);
    leaseMock.assertPluginCallerDrives.mockRejectedValueOnce(
      new Error("DRIVEN_ELSEWHERE: another screen drives this project")
    );
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.submit("t-1", "continue")).rejects.toThrow(/DRIVEN_ELSEWHERE/);
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("answers unavailable once the plugin unloads, and with no terminal host", async () => {
    const h = makeHarness();
    await launch(h);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    ptyMock.client = null;
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "unavailable" });

    h.plugins.delete(PLUGIN_ID);
    await expect(host.agents.submit("t-1", "continue")).resolves.toEqual({
      status: "unavailable",
    });
    expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
  });

  it("answers unavailable when main has no form of the project to run in", async () => {
    const h = makeHarness();
    await launch(h);
    viewlessMock.runViewlessAction.mockResolvedValueOnce(null);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("passes a refusal's reason through, as nothing written", async () => {
    const h = makeHarness();
    await launch(h);
    viewlessMock.runViewlessAction.mockResolvedValueOnce({
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "The agent is idle; there is no turn to stop." },
    });
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({
      status: "refused",
      reason: "The agent is idle; there is no turn to stop.",
    });
  });

  describe("sendKeys", () => {
    it("forwards only the keys, and leaves the screen it read back out", async () => {
      const h = makeHarness();
      await launch(h);
      viewlessMock.runViewlessAction.mockResolvedValueOnce({
        ok: true,
        result: { terminalId: "t-1", keys: ["Down", "Enter"], screen: "secret output" },
      });
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const result = await host.agents.sendKeys("t-1", {
        keys: ["Down", "Enter"],
        notify: true,
      } as never);
      expect(result).toEqual({ status: "sent", keys: ["Down", "Enter"] });
      expect(viewlessMock.runViewlessAction).toHaveBeenCalledWith({
        workspaceId: PROJECT_ID,
        actionId: "terminal.sendKeys",
        args: { terminalId: "t-1", keys: ["Down", "Enter"] },
        confirmed: false,
      });
    });

    it("forwards a choice by label", async () => {
      const h = makeHarness();
      await launch(h);
      viewlessMock.runViewlessAction.mockResolvedValueOnce({
        ok: true,
        result: { terminalId: "t-1", keys: ["Down", "Enter"] },
      });
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await expect(host.agents.sendKeys("t-1", { choose: "Yes" })).resolves.toEqual({
        status: "sent",
        keys: ["Down", "Enter"],
      });
      expect(viewlessMock.runViewlessAction).toHaveBeenCalledWith(
        expect.objectContaining({ args: { terminalId: "t-1", choose: "Yes" } })
      );
    });

    it.each([
      ["neither keys nor choose", {}],
      ["both keys and choose", { keys: ["Enter"], choose: "Yes" }],
      ["an unknown key name", { keys: ["Ctrl+C"] }],
      ["no keys", { keys: [] }],
      ["seventeen keys", { keys: Array.from({ length: 17 }, () => "Down") }],
      ["an empty label", { choose: "" }],
      ["no input at all", null],
    ])("rejects %s before the consent prompt", async (_label, input) => {
      const h = makeHarness();
      await launch(h);
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await expect(host.agents.sendKeys("t-1", input as never)).rejects.toThrow(/agents\.sendKeys/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
      expect(viewlessMock.runViewlessAction).not.toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("submits the text alone through the main-side submission", async () => {
      const h = makeHarness();
      await launch(h);
      viewlessMock.runViewlessAction.mockResolvedValueOnce({
        ok: true,
        result: { terminalId: "t-1", submissionToken: "tok" },
      });
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await expect(host.agents.submit("t-1", "/compact")).resolves.toEqual({ status: "sent" });
      expect(viewlessMock.runViewlessAction).toHaveBeenCalledWith({
        workspaceId: PROJECT_ID,
        actionId: "terminal.sendCommand",
        args: { terminalId: "t-1", command: "/compact" },
        confirmed: false,
      });
    });

    it.each(["", "   ", "\n"])("rejects blank text %j before the consent prompt", async (text) => {
      const h = makeHarness();
      await launch(h);
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await expect(host.agents.submit("t-1", text)).rejects.toThrow(/agents\.submit/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    });
  });

  it.each(["", "x".repeat(513), 42])(
    "rejects the malformed terminal id %j before anything else",
    async (terminalId) => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await expect(host.agents.interrupt(terminalId as never)).rejects.toThrow(
        /agents\.interrupt: terminalId/
      );
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    }
  );
});
