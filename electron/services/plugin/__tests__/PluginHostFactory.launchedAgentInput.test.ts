import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeTerminal {
  projectId: string;
  kind?: string;
  detectedAgentId?: string;
  launchAgentId?: string;
  agentState?: string;
  waitingReason?: string;
  hasPty?: boolean;
  isExited?: boolean;
  isTrashed?: boolean;
  /** What the screen shows, for a `choose`. */
  screen?: string;
}

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
const PERMISSION_PROMPT = [
  "Do you want to make this edit to .github/workflows/ci.yml?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
].join("\n");

/** The terminals the fake terminal host holds, by id. */
let terminals: Map<string, FakeTerminal>;
let pty: {
  write: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
  batchDoubleEscape: ReturnType<typeof vi.fn>;
  getTerminalAsync: ReturnType<typeof vi.fn>;
  getSerializedStateAsync: ReturnType<typeof vi.fn>;
  getTerminalProjectId: (id: string) => string | null;
};

function agent(overrides: Partial<FakeTerminal> = {}): FakeTerminal {
  return {
    projectId: PROJECT_ID,
    kind: "terminal",
    detectedAgentId: "claude",
    agentState: "working",
    hasPty: true,
    ...overrides,
  };
}

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

/**
 * Launch through the plugin's own `host.dispatch`, the only way a record is
 * written. The spawn lands once the launch has answered, as the renderer's
 * startup queue does.
 */
async function launch(
  h: Harness,
  {
    pluginId = PLUGIN_ID,
    result = launchResult("t-1"),
    args = { agentId: "claude" } as unknown,
    binding = UNBOUND_PLUGIN_HOST_BINDING,
    options,
    terminal = agent(),
  }: {
    pluginId?: string;
    result?: ActionDispatchResult;
    args?: unknown;
    binding?: PluginHostBinding;
    options?: { projectId: string };
    terminal?: FakeTerminal;
  } = {}
) {
  h.sendDispatchToRenderer.mockImplementationOnce(async () => {
    if (result.ok) {
      const id = (result.result as { terminalId?: unknown }).terminalId;
      if (typeof id === "string") terminals.set(id, terminal);
    }
    return result;
  });
  const { host } = createHost(h.deps, pluginId, binding);
  return host.dispatch("agent.launch", args, options);
}

function hostFor(h: Harness, binding: PluginHostBinding = UNBOUND_PLUGIN_HOST_BINDING) {
  return createHost(h.deps, PLUGIN_ID, binding).host;
}

beforeEach(() => {
  _resetPluginLaunchesForTests();
  terminals = new Map();
  pty = {
    write: vi.fn(),
    submit: vi.fn(),
    batchDoubleEscape: vi.fn(),
    getTerminalAsync: vi.fn(async (id: string) => {
      const t = terminals.get(id);
      return t ? { id, cwd: "/repos/alpha", spawnedAt: 1, ...t } : null;
    }),
    getSerializedStateAsync: vi.fn(async (id: string) => ({
      data: terminals.get(id)?.screen ?? "",
    })),
    getTerminalProjectId: (id) => terminals.get(id)?.projectId ?? null,
  };
  ptyMock.client = pty;
  consentMock.ensureAllowed.mockReset();
  consentMock.ensureAllowed.mockResolvedValue(undefined);
  grantMock.hasGrant.mockReset();
  grantMock.hasGrant.mockReturnValue(false);
  leaseMock.assertPluginCallerDrives.mockReset();
  leaseMock.assertPluginCallerDrives.mockResolvedValue(undefined);
});

afterEach(() => {
  ptyMock.client = null;
});

describe("host.agents input on agents the plugin launched (#14018)", () => {
  it("interrupts its own launch mid-turn, held to consent and the drive lease", async () => {
    const h = makeHarness();
    expect((await launch(h)).ok).toBe(true);

    const result = await hostFor(h).agents.interrupt("t-1");
    expect(result.status).toBe("sent");
    expect(pty.batchDoubleEscape).toHaveBeenCalledWith(["t-1"]);
    expect(consentMock.ensureAllowed).toHaveBeenCalledTimes(1);
    expect(consentMock.ensureAllowed.mock.calls[0]?.[2]).toBe("agent:input");
    expect(leaseMock.assertPluginCallerDrives).toHaveBeenCalledWith(PLUGIN_ID, "agents.interrupt", {
      terminalId: "t-1",
    });
  });

  it("refuses to interrupt an idle agent rather than reporting it stopped", async () => {
    const h = makeHarness();
    await launch(h, { terminal: agent({ agentState: "idle" }) });
    const result = await hostFor(h).agents.interrupt("t-1");
    expect(result.status).toBe("refused");
    expect(pty.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("answers not-found for a terminal it never launched, without a consent prompt or a write", async () => {
    const h = makeHarness();
    terminals.set("user-1", agent());
    const host = hostFor(h);

    await expect(host.agents.interrupt("user-1")).resolves.toEqual({ status: "not-found" });
    await expect(host.agents.sendKeys("user-1", { keys: ["Enter"] })).resolves.toEqual({
      status: "not-found",
    });
    await expect(host.agents.submit("user-1", "continue")).resolves.toEqual({
      status: "not-found",
    });
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.submit).not.toHaveBeenCalled();
    expect(pty.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("never reaches an agent another plugin launched", async () => {
    const h = makeHarness();
    await launch(h, { pluginId: OTHER_PLUGIN_ID });
    await expect(hostFor(h).agents.submit("t-1", "continue")).resolves.toEqual({
      status: "not-found",
    });
    expect(pty.submit).not.toHaveBeenCalled();
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
    await launch(h, { result });
    terminals.set("gate-1", agent());
    await expect(hostFor(h).agents.interrupt("gate-1")).resolves.toEqual({
      status: "not-found",
    });
  });

  it("records nothing from a dispatch of any other action", async () => {
    const h = makeHarness();
    terminals.set("t-1", agent());
    h.sendDispatchToRenderer.mockResolvedValueOnce(launchResult("t-1"));
    const host = hostFor(h);
    await host.dispatch("terminal.list", {});
    await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
  });

  it("never records a launch that named its own panel id", async () => {
    const h = makeHarness();
    // Whatever the id holds by the time it is used — the plugin's own spawn, or
    // a user's pane under an id the plugin picked — it is not the plugin's.
    await launch(h, {
      result: launchResult("chosen"),
      args: { agentId: "claude", requestedId: "chosen" },
    });
    await expect(hostFor(h).agents.submit("chosen", "continue")).resolves.toEqual({
      status: "not-found",
    });
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("records nothing for a launch that resolves after the plugin unloaded", async () => {
    const h = makeHarness();
    h.sendDispatchToRenderer.mockImplementationOnce(async () => {
      h.plugins.delete(PLUGIN_ID);
      terminals.set("t-1", agent());
      return launchResult("t-1");
    });
    await hostFor(h).dispatch("agent.launch", { agentId: "claude" });
    h.plugins.set(PLUGIN_ID, loaded(PLUGIN_ID));
    await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
  });

  describe("project scope", () => {
    it("keeps a project plugin to the project its launch was sent to", async () => {
      const h = makeHarness();
      h.plugins.set(PLUGIN_ID, loaded(PLUGIN_ID, BOUND));
      await launch(h, { binding: BOUND });
      const host = hostFor(h, BOUND);

      terminals.set("t-1", agent({ projectId: OTHER_PROJECT_ID }));
      await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });

      terminals.set("t-1", agent());
      expect((await host.agents.interrupt("t-1")).status).toBe("sent");
    });

    it("records a bound plugin's launch that restates its own project", async () => {
      const h = makeHarness();
      h.plugins.set(PLUGIN_ID, loaded(PLUGIN_ID, BOUND));
      await launch(h, { binding: BOUND, options: { projectId: PROJECT_ID } });
      expect(h.sendDispatchToRenderer).toHaveBeenCalledWith(
        "agent.launch",
        expect.anything(),
        PROJECT_ID,
        PLUGIN_ID
      );
      expect((await hostFor(h, BOUND).agents.interrupt("t-1")).status).toBe("sent");
    });

    it("records a targeted launch against the project it was sent to", async () => {
      const h = makeHarness();
      h.capabilities.set(PLUGIN_ID, new Set(["agent:input", "project:dispatch"]));
      grantMock.hasGrant.mockReturnValue(true);
      await launch(h, {
        options: { projectId: OTHER_PROJECT_ID },
        terminal: agent({ projectId: OTHER_PROJECT_ID }),
      });
      expect(h.sendDispatchToRenderer).toHaveBeenCalledWith(
        "agent.launch",
        expect.anything(),
        OTHER_PROJECT_ID,
        PLUGIN_ID
      );
      const host = hostFor(h);
      expect((await host.agents.interrupt("t-1")).status).toBe("sent");

      // Should the id turn up in another project, the record doesn't follow it there.
      terminals.set("t-1", agent());
      await expect(host.agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
    });

    it("records nothing when the targeting switch is off", async () => {
      const h = makeHarness();
      h.capabilities.set(PLUGIN_ID, new Set(["agent:input", "project:dispatch"]));
      await expect(launch(h, { options: { projectId: OTHER_PROJECT_ID } })).rejects.toThrow(
        /PERMISSION_REQUIRED/
      );
      terminals.set("t-1", agent({ projectId: OTHER_PROJECT_ID }));
      await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({
        status: "not-found",
      });
    });
  });

  it("answers not-found while the launch's spawn has not reached the terminal host", async () => {
    const h = makeHarness();
    await launch(h);
    terminals.delete("t-1");
    await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
  });

  it("lets a reloaded generation of the same plugin drive what it launched", async () => {
    const h = makeHarness();
    await launch(h);
    const before = hostFor(h);
    // A reload swaps the loaded instance under the same id.
    h.plugins.set(PLUGIN_ID, loaded(PLUGIN_ID));
    await expect(before.agents.submit("t-1", "continue")).resolves.toEqual({
      status: "unavailable",
    });
    await expect(hostFor(h).agents.submit("t-1", "continue")).resolves.toEqual({
      status: "sent",
    });
    expect(pty.submit).toHaveBeenCalledTimes(1);
  });

  it("rejects PERMISSION_REQUIRED when agent:input is not declared", async () => {
    const h = makeHarness();
    await launch(h);
    h.capabilities.set(PLUGIN_ID, new Set(["agent:read"]));
    const host = hostFor(h);
    await expect(host.agents.interrupt("t-1")).rejects.toThrow(/PERMISSION_REQUIRED.*agent:input/);
    await expect(host.agents.sendKeys("t-1", { keys: ["Enter"] })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    await expect(host.agents.submit("t-1", "x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("writes nothing when the user denies consent", async () => {
    const h = makeHarness();
    await launch(h);
    consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
    await expect(hostFor(h).agents.submit("t-1", "continue")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("reads the record again after the consent prompt", async () => {
    const h = makeHarness();
    await launch(h);
    consentMock.ensureAllowed.mockImplementationOnce(async () => {
      forgetPluginLaunches(PLUGIN_ID);
    });
    await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({ status: "not-found" });
    expect(pty.batchDoubleEscape).not.toHaveBeenCalled();
  });

  it("holds the write to the drive lease", async () => {
    const h = makeHarness();
    await launch(h);
    leaseMock.assertPluginCallerDrives.mockRejectedValueOnce(
      new Error("DRIVEN_ELSEWHERE: another screen drives this project")
    );
    await expect(hostFor(h).agents.submit("t-1", "continue")).rejects.toThrow(/DRIVEN_ELSEWHERE/);
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("answers unavailable with no terminal host", async () => {
    const h = makeHarness();
    await launch(h);
    ptyMock.client = null;
    await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("answers unavailable once the plugin unloads", async () => {
    const h = makeHarness();
    await launch(h);
    const host = hostFor(h);
    h.plugins.delete(PLUGIN_ID);
    await expect(host.agents.submit("t-1", "continue")).resolves.toEqual({
      status: "unavailable",
    });
    expect(pty.submit).not.toHaveBeenCalled();
  });

  it("answers unavailable when the terminal host doesn't answer for a terminal main tracks", async () => {
    const h = makeHarness();
    await launch(h);
    pty.getTerminalAsync.mockResolvedValueOnce(null);
    await expect(hostFor(h).agents.interrupt("t-1")).resolves.toEqual({ status: "unavailable" });
  });

  describe("sendKeys", () => {
    it("presses the named keys one at a time, and only those", async () => {
      const h = makeHarness();
      await launch(h);
      const result = await hostFor(h).agents.sendKeys("t-1", {
        keys: ["Down", "Enter"],
        notify: true,
      } as never);
      expect(result).toEqual({ status: "sent", keys: ["Down", "Enter"] });
      expect(pty.write).toHaveBeenCalledTimes(2);
      expect(pty.write.mock.calls.map((call) => call[0])).toEqual(["t-1", "t-1"]);
    });

    it("answers a permission prompt by the option's label", async () => {
      const h = makeHarness();
      await launch(h, { terminal: agent({ agentState: "waiting", screen: PERMISSION_PROMPT }) });
      const result = await hostFor(h).agents.sendKeys("t-1", { choose: "Yes" });
      expect(result.status).toBe("sent");
      expect(result.status === "sent" && result.keys.at(-1)).toBe("Enter");
      // The screen read to plan the choice never reaches the plugin.
      expect(JSON.stringify(result)).not.toContain(".github");
    });

    it("refuses a label the screen doesn't show, pressing nothing", async () => {
      const h = makeHarness();
      await launch(h, { terminal: agent({ screen: PERMISSION_PROMPT }) });
      const result = await hostFor(h).agents.sendKeys("t-1", { choose: "Maybe later" });
      expect(result.status).toBe("refused");
      expect(pty.write).not.toHaveBeenCalled();
    });

    it("stops a key sequence partway when the plugin unloads", async () => {
      const h = makeHarness();
      await launch(h);
      pty.write.mockImplementationOnce(() => {
        h.plugins.delete(PLUGIN_ID);
      });
      const result = await hostFor(h).agents.sendKeys("t-1", { keys: ["Down", "Down", "Enter"] });
      expect(result).toEqual({ status: "sent", keys: ["Down"] });
      expect(pty.write).toHaveBeenCalledTimes(1);
    });

    it("stops between keys when another screen takes control", async () => {
      const h = makeHarness();
      await launch(h);
      leaseMock.assertPluginCallerDrives
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("DRIVEN_ELSEWHERE: another screen drives this project"));
      await expect(hostFor(h).agents.sendKeys("t-1", { keys: ["Down", "Enter"] })).rejects.toThrow(
        /DRIVEN_ELSEWHERE/
      );
      expect(pty.write).toHaveBeenCalledTimes(1);
    });

    it("refuses a trashed pane, whose prompt no one can see answered", async () => {
      const h = makeHarness();
      await launch(h, { terminal: agent({ isTrashed: true, screen: PERMISSION_PROMPT }) });
      const result = await hostFor(h).agents.sendKeys("t-1", { choose: "Yes" });
      expect(result.status).toBe("refused");
      expect(pty.write).not.toHaveBeenCalled();
      expect(pty.getSerializedStateAsync).not.toHaveBeenCalled();
    });

    it("refuses an agent with no running process", async () => {
      const h = makeHarness();
      await launch(h, { terminal: agent({ isExited: true }) });
      expect((await hostFor(h).agents.sendKeys("t-1", { keys: ["Enter"] })).status).toBe("refused");
      expect(pty.write).not.toHaveBeenCalled();
    });

    it.each([
      ["neither keys nor choose", {}],
      ["both keys and choose", { keys: ["Enter"], choose: "Yes" }],
      ["an unknown key name", { keys: ["Ctrl+C"] }],
      ["no keys", { keys: [] }],
      ["a sparse key list", { keys: new Array<string>(1) }],
      ["seventeen keys", { keys: Array.from({ length: 17 }, () => "Down") }],
      ["an empty label", { choose: "" }],
      ["no input at all", null],
    ])("rejects %s before the consent prompt", async (_label, input) => {
      const h = makeHarness();
      await launch(h);
      await expect(hostFor(h).agents.sendKeys("t-1", input as never)).rejects.toThrow(
        /agents\.sendKeys/
      );
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
      expect(pty.write).not.toHaveBeenCalled();
    });
  });

  describe("submit", () => {
    it("submits the text as one submission", async () => {
      const h = makeHarness();
      await launch(h);
      await expect(hostFor(h).agents.submit("t-1", "/compact")).resolves.toEqual({
        status: "sent",
      });
      expect(pty.submit).toHaveBeenCalledWith("t-1", "/compact");
    });

    it.each([
      ["trashed", agent({ isTrashed: true })],
      ["exited", agent({ isExited: true })],
      ["without a process", agent({ hasPty: false })],
    ])("refuses an agent that is %s", async (_label, terminal) => {
      const h = makeHarness();
      await launch(h, { terminal });
      expect((await hostFor(h).agents.submit("t-1", "continue")).status).toBe("refused");
      expect(pty.submit).not.toHaveBeenCalled();
    });

    it.each(["", "   ", "\n"])("rejects blank text %j before the consent prompt", async (text) => {
      const h = makeHarness();
      await launch(h);
      await expect(hostFor(h).agents.submit("t-1", text)).rejects.toThrow(/agents\.submit/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    });
  });

  it.each(["", "x".repeat(513), 42])(
    "rejects the malformed terminal id %j before anything else",
    async (terminalId) => {
      const h = makeHarness();
      await expect(hostFor(h).agents.interrupt(terminalId as never)).rejects.toThrow(
        /agents\.interrupt: terminalId/
      );
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    }
  );
});
