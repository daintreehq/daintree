import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectRendererTargets: vi.fn(() => []),
}));
vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: vi.fn(() => null),
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
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type {
  PluginAllAgentsSnapshot,
  PluginHostBinding,
} from "../../../../shared/types/plugin.js";
import type { FleetRunRow, FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const PROJECT_ID = "a".repeat(64);
const SCRATCH_ID = "12345678-1234-4abc-8def-123456789abc";
const BOUND: PluginHostBinding = { projectId: PROJECT_ID, projectRoot: "/repos/alpha" };

function row(overrides: Partial<FleetRunRow>): FleetRunRow {
  return {
    runId: "t-1",
    workspaceId: PROJECT_ID,
    spawnedAt: 1,
    cwd: "/secret/path",
    ...overrides,
  };
}

function fleetSnapshot(runs: FleetRunRow[], overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return { runs, changedAt: 10, degraded: false, lastSuccessfulAt: 20, ...overrides };
}

interface FakeFleet {
  current: FleetSnapshot | null;
  listeners: Set<(snapshot: FleetSnapshot) => void>;
  getLastBroadcast: () => FleetSnapshot | null;
  subscribe: (listener: (snapshot: FleetSnapshot) => void) => () => void;
  publish: (snapshot: FleetSnapshot) => void;
}

function makeFleet(initial: FleetSnapshot | null = null): FakeFleet {
  const fleet: FakeFleet = {
    current: initial,
    listeners: new Set(),
    getLastBroadcast: () => fleet.current,
    subscribe: (listener) => {
      fleet.listeners.add(listener);
      return () => fleet.listeners.delete(listener);
    },
    publish: (snapshot) => {
      fleet.current = snapshot;
      for (const listener of [...fleet.listeners]) listener(snapshot);
    },
  };
  return fleet;
}

interface Harness {
  deps: PluginHostFactoryDeps;
  plugins: Map<string, LoadedPlugin>;
  capabilities: Set<string>;
  fleet: FakeFleet | null;
  sendAgentsListToRenderer: ReturnType<typeof vi.fn>;
}

function makeHarness(fleet: FakeFleet | null = makeFleet()): Harness {
  const plugins = new Map<string, LoadedPlugin>([
    [
      PLUGIN_ID,
      {
        isBuiltin: true,
        manifest: { name: PLUGIN_ID, capabilities: ["agent:read"], contributes: {} },
      } as unknown as LoadedPlugin,
    ],
  ]);
  const capabilities = new Set<string>(["agent:read"]);
  const sendAgentsListToRenderer = vi.fn(async () => []);
  const harness: Harness = {
    plugins,
    capabilities,
    fleet,
    sendAgentsListToRenderer,
    deps: {} as PluginHostFactoryDeps,
  };
  harness.deps = {
    plugins,
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginPanelMenus: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
    dispatcher: { sendAgentsListToRenderer },
    promptDispatcher: { requestPrompt: vi.fn() },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => capabilities,
    getFleetSnapshotService: () => harness.fleet,
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
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
  return harness;
}

describe("agents.listAll", () => {
  it("projects every run across projects and scratch to the allowlist, frozen", async () => {
    const h = makeHarness(
      makeFleet(
        fleetSnapshot([
          row({
            runId: "t-1",
            worktreeId: "wt-1",
            agentId: "claude",
            agentState: "working",
            title: "Fix auth",
            lastObservedTitle: "raw osc",
            launchAgentId: "claude",
            park: { parkedAt: 5, note: "private note" },
            quietSince: 3,
          }),
          row({ runId: "t-2", workspaceId: SCRATCH_ID }),
        ])
      )
    );
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const result = await host.agents.listAll();

    expect(result).toEqual({
      agents: [
        {
          workspaceId: PROJECT_ID,
          workspaceKind: "project",
          terminalId: "t-1",
          worktreeId: "wt-1",
          title: "Fix auth",
          agentId: "claude",
          observedState: "working",
        },
        { workspaceId: SCRATCH_ID, workspaceKind: "scratch", terminalId: "t-2" },
      ],
      degraded: false,
      lastSuccessfulAt: 20,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.agents)).toBe(true);
    expect(Object.isFrozen(result.agents[0])).toBe(true);
    // Answered by main, never a project view.
    expect(h.sendAgentsListToRenderer).not.toHaveBeenCalled();
  });

  it("keeps a degraded snapshot's retained runs marked as stale", async () => {
    const h = makeHarness(
      makeFleet(fleetSnapshot([row({})], { degraded: true, lastSuccessfulAt: 7 }))
    );
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const result = await host.agents.listAll();

    expect(result.degraded).toBe(true);
    expect(result.lastSuccessfulAt).toBe(7);
    expect(result.agents).toHaveLength(1);
  });

  it.each([
    ["no fleet service", null],
    ["no snapshot yet", makeFleet(null)],
  ])("answers unavailable, not empty, with %s", async (_label, fleet) => {
    const h = makeHarness(fleet);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(host.agents.listAll()).resolves.toEqual({
      agents: [],
      degraded: true,
      lastSuccessfulAt: null,
    });
  });

  it("requires agent:read", async () => {
    const h = makeHarness();
    h.capabilities.clear();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(host.agents.listAll()).rejects.toThrow(/PERMISSION_REQUIRED:.*agent:read/);
  });

  it.each([
    ["a project plugin", BOUND],
    ["a rootless project binding", { projectId: PROJECT_ID, projectRoot: null }],
  ])("refuses %s even with agent:read", async (_label, binding) => {
    const h = makeHarness(makeFleet(fleetSnapshot([row({})])));
    const { host } = createHost(h.deps, PLUGIN_ID, binding as PluginHostBinding);

    await expect(host.agents.listAll()).rejects.toThrow(/PERMISSION_REQUIRED:.*project plugin/);
  });

  it("answers unavailable once the plugin is unloaded", async () => {
    const h = makeHarness(makeFleet(fleetSnapshot([row({})])));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    h.plugins.delete(PLUGIN_ID);

    const result = await host.agents.listAll();

    expect(result).toEqual({ agents: [], degraded: true, lastSuccessfulAt: null });
  });

  it("stays callable after activation is revoked", async () => {
    const h = makeHarness(makeFleet(fleetSnapshot([row({})])));
    const { host, revoke } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    revoke();

    await expect(host.agents.listAll()).resolves.toMatchObject({ degraded: false });
  });
});

describe("onDidChangeAllAgents", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers each published fleet snapshot, projected and frozen", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const received: PluginAllAgentsSnapshot[] = [];
    await host.onDidChangeAllAgents((snapshot) => received.push(snapshot), { debounceMs: 0 });

    h.fleet!.publish(fleetSnapshot([row({ agentState: "waiting", cwd: "/x" })]));

    expect(received).toHaveLength(1);
    expect(received[0].agents[0]).toEqual({
      workspaceId: PROJECT_ID,
      workspaceKind: "project",
      terminalId: "t-1",
      observedState: "waiting",
    });
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  it("coalesces a burst to the latest snapshot by default", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAllAgents(callback);

    h.fleet!.publish(fleetSnapshot([row({ agentState: "working" })]));
    h.fleet!.publish(fleetSnapshot([row({ agentState: "waiting" })]));
    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].agents[0].observedState).toBe("waiting");
  });

  it("stops delivering after dispose, and disposing twice is a no-op", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    const dispose = await host.onDidChangeAllAgents(callback, { debounceMs: 0 });

    dispose();
    dispose();
    h.fleet!.publish(fleetSnapshot([]));

    expect(callback).not.toHaveBeenCalled();
    expect(h.fleet!.listeners.size).toBe(0);
    expect(h.deps.pluginEventCleanups.has(PLUGIN_ID)).toBe(false);
  });

  it("is torn down with the plugin's other subscriptions on unload", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    await host.onDidChangeAllAgents(vi.fn(), { debounceMs: 0 });

    for (const cleanup of [...(h.deps.pluginEventCleanups.get(PLUGIN_ID) ?? [])]) cleanup();

    expect(h.fleet!.listeners.size).toBe(0);
  });

  it("falls silent once the plugin is unloaded", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAllAgents(callback, { debounceMs: 0 });
    h.plugins.delete(PLUGIN_ID);

    h.fleet!.publish(fleetSnapshot([]));

    expect(callback).not.toHaveBeenCalled();
  });

  it("falls silent, including a pending delivery, once a same-id reload replaces the plugin", async () => {
    vi.useFakeTimers();
    const h = makeHarness(makeFleet(fleetSnapshot([row({})])));
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn();
    await host.onDidChangeAllAgents(callback);

    h.fleet!.publish(fleetSnapshot([row({ agentState: "working" })]));
    h.plugins.set(PLUGIN_ID, { ...h.plugins.get(PLUGIN_ID)! } as LoadedPlugin);
    vi.advanceTimersByTime(100);
    h.fleet!.publish(fleetSnapshot([row({ agentState: "waiting" })]));
    vi.advanceTimersByTime(100);

    expect(callback).not.toHaveBeenCalled();
    await expect(host.agents.listAll()).resolves.toEqual({
      agents: [],
      degraded: true,
      lastSuccessfulAt: null,
    });
  });

  it("unsubscribes a listener after three consecutive throws", async () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const callback = vi.fn(() => {
      throw new Error("boom");
    });
    await host.onDidChangeAllAgents(callback, { debounceMs: 0 });

    for (let i = 0; i < 4; i++) h.fleet!.publish(fleetSnapshot([]));

    expect(callback).toHaveBeenCalledTimes(3);
    expect(h.fleet!.listeners.size).toBe(0);
    expect(h.deps.pluginEventCleanups.has(PLUGIN_ID)).toBe(false);
  });

  it("requires agent:read", () => {
    const h = makeHarness();
    h.capabilities.clear();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect(() => host.onDidChangeAllAgents(vi.fn())).toThrow(/PERMISSION_REQUIRED:.*agent:read/);
    expect(h.fleet!.listeners.size).toBe(0);
  });

  it("refuses a project plugin without touching the fleet", () => {
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    expect(() => host.onDidChangeAllAgents(vi.fn())).toThrow(
      /PERMISSION_REQUIRED:.*project plugin/
    );
    expect(h.fleet!.listeners.size).toBe(0);
  });

  it("refuses to subscribe after activation is revoked", () => {
    const h = makeHarness();
    const { host, revoke } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    revoke();

    expect(() => host.onDidChangeAllAgents(vi.fn())).toThrow(/revoked/);
  });

  it("reports an untracked fleet rather than handing back an inert subscription", () => {
    const h = makeHarness(null);
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    expect(() => host.onDidChangeAllAgents(vi.fn())).toThrow(/FLEET_UNAVAILABLE/);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
