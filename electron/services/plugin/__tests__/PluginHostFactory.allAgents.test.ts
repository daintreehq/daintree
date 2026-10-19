import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const consentMock = vi.hoisted(() => ({
  ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined),
}));
const ptyMock = vi.hoisted(() => ({
  client: null as null | {
    getTerminalProjectId: (id: string) => string | null;
    getTerminalAsync: (id: string) => Promise<unknown>;
    getSerializedStateAsync: (id: string, options?: unknown) => Promise<unknown>;
  },
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
import { agentMcpEndpointRegistry } from "../../pluginAgentMcp/endpointRegistry.js";
import { approvePluginDatabaseBackup } from "../pluginInternalApprovers.js";
import { FocusedPanelTracker, _setFocusedPanelTrackerForTests } from "../../FocusedPanelTracker.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  AGENT_MCP_MAX_DESCRIPTION_BYTES,
  AGENT_MCP_MAX_SCHEMA_BYTES,
  AGENT_MCP_MAX_TOOLS_PER_ENDPOINT,
  UNBOUND_PLUGIN_HOST_BINDING,
  makeProjectPluginInstanceKey,
  type BuiltInPluginCapability,
  type PluginAgentPane,
  type PluginAllAgentsSnapshot,
  type PluginDatabaseContribution,
  type PluginFocusedPanel,
  type PluginHostBinding,
  type PluginMcpCaller,
  type PluginMcpToolDefinition,
} from "../../../../shared/types/plugin.js";
import type { FleetRunRow, FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

// One module graph serves every suite below, so the shared doubles start each
// test from their defaults.
beforeEach(() => {
  ptyMock.client = null;
  consentMock.ensureAllowed.mockReset();
});

describe("app-wide agent list", () => {
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

  function fleetSnapshot(
    runs: FleetRunRow[],
    overrides: Partial<FleetSnapshot> = {}
  ): FleetSnapshot {
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
      pluginToolbarBadges: new Map(),
      emitToolbarBadges: () => {},
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
});

describe("focused panel", () => {
  const PLUGIN_ID = "acme";
  const PROJECT_ID = "a".repeat(64);
  const OTHER_PROJECT_ID = "b".repeat(64);
  const BOUND: PluginHostBinding = { projectId: PROJECT_ID, projectRoot: "/repos/alpha" };
  const WINDOW = 1;
  const VIEW = 10;

  interface Harness {
    deps: PluginHostFactoryDeps;
    plugins: Map<string, LoadedPlugin>;
    capabilities: Set<string>;
  }

  function makeHarness(): Harness {
    const plugins = new Map<string, LoadedPlugin>([
      [
        PLUGIN_ID,
        {
          isBuiltin: true,
          manifest: { name: PLUGIN_ID, capabilities: ["panel:focus-read"], contributes: {} },
        } as unknown as LoadedPlugin,
      ],
    ]);
    const capabilities = new Set<string>(["panel:focus-read"]);
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
      pluginPanelMenus: new Map(),
      pluginFsWatchers: new Map(),
      broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
      panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
      dispatcher: {},
      promptDispatcher: { requestPrompt: vi.fn() },
      settings: {},
      storage: {},
      getHostGitFactory: () => undefined,
      getProcessManager: vi.fn(),
      declaredCapabilities: () => capabilities,
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
      registerHandler: vi.fn(),
      validateAndBuildActionDescriptor: vi.fn(),
      safeAppendAudit: vi.fn(),
      safeArgsHash: () => "",
    } as unknown as PluginHostFactoryDeps;
    return { deps, plugins, capabilities };
  }

  let tracker: FocusedPanelTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new FocusedPanelTracker();
    _setFocusedPanelTrackerForTests(tracker);
    tracker.setFocusedWindow(WINDOW);
  });

  afterEach(() => {
    _setFocusedPanelTrackerForTests(null);
    vi.useRealTimers();
  });

  describe("onDidChangeFocusedPanel", () => {
    it("replays the current focus straight away, frozen, then waits 250ms for changes", async () => {
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "diff", agent: false, worktreeId: "wt-1" });
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];

      await host.onDidChangeFocusedPanel((focus) => seen.push(focus));
      expect(seen).toEqual([{ kind: "diff", agent: false, worktreeId: "wt-1" }]);
      expect(Object.isFrozen(seen[0])).toBe(true);

      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "file", worktreeId: "wt-1" });
      vi.advanceTimersByTime(249);
      expect(seen).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(seen.at(-1)?.kind).toBe("file");
    });

    it("keeps the focus default for a debounceMs that is not a number", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus), { debounceMs: Number.NaN });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "file", worktreeId: "w" });
      vi.advanceTimersByTime(100);
      expect(seen).toHaveLength(1);
      vi.advanceTimersByTime(150);
      expect(seen).toHaveLength(2);
    });

    it("coalesces a burst to where focus settles and never repeats a value", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus));
      expect(seen).toEqual([{ kind: null, agent: false, worktreeId: null }]);

      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", agent: true, worktreeId: "w" });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "browser", worktreeId: "w" });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", agent: true, worktreeId: "w" });
      vi.advanceTimersByTime(250);
      expect(seen.at(-1)).toEqual({ kind: "terminal", agent: true, worktreeId: "w" });
      expect(seen).toHaveLength(2);

      // A burst that settles back on the delivered value delivers nothing.
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "browser", worktreeId: "w" });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", agent: true, worktreeId: "w" });
      vi.advanceTimersByTime(250);
      expect(seen).toHaveLength(2);
    });

    it("honours an explicit raw window", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus), { debounceMs: 0 });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "review", worktreeId: "w" });
      tracker.blurWindow(WINDOW);

      expect(seen.map((f) => f.kind)).toEqual([null, "review", null]);
    });

    it("collapses another plugin's panel kind to plugin and strips extra fields", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus), { debounceMs: 0 });
      tracker.report(VIEW, WINDOW, PROJECT_ID, {
        kind: "other.secret-view",
        agent: true,
        worktreeId: "w",
        title: "Q3 payroll",
        url: "https://example.com/x",
        panelId: "p-1",
      });

      expect(seen.at(-1)).toStrictEqual({ kind: "plugin", agent: false, worktreeId: "w" });
    });

    it("reports the Portal with no worktree", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus), { debounceMs: 0 });
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", worktreeId: "w" });
      tracker.setPortalFocused(WINDOW, true);

      expect(seen.at(-1)).toEqual({ kind: "portal", agent: false, worktreeId: null });
    });

    it("shows a project plugin focus in its own project only", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((focus) => seen.push(focus), { debounceMs: 0 });

      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "file", worktreeId: "w" });
      tracker.report(VIEW + 1, WINDOW, OTHER_PROJECT_ID, { kind: "diff", worktreeId: "x" });
      tracker.removeSender(VIEW + 1);
      tracker.setPortalFocused(WINDOW, true);

      expect(seen.map((f) => f.kind)).toEqual([null, "file", null, "file", null]);
    });

    it("requires panel:focus-read", () => {
      const h = makeHarness();
      h.capabilities.clear();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

      expect(() => host.onDidChangeFocusedPanel(() => {})).toThrow(
        /PERMISSION_REQUIRED:.*panel:focus-read/
      );
    });

    it("is revoke-guarded", () => {
      const h = makeHarness();
      const { host, revoke } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      revoke();

      expect(() => host.onDidChangeFocusedPanel(() => {})).toThrow(/host revoked/);
    });

    it("stops delivering, pending window included, once disposed while still loaded", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      const dispose = await host.onDidChangeFocusedPanel((f) => seen.push(f));
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", worktreeId: "w" });
      dispose();
      dispose();
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "diff", worktreeId: "w" });
      vi.advanceTimersByTime(1_000);

      expect(seen).toEqual([{ kind: null, agent: false, worktreeId: null }]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("is torn down by the plugin's unload cleanups", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const seen: PluginFocusedPanel[] = [];
      await host.onDidChangeFocusedPanel((f) => seen.push(f));
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "terminal", worktreeId: "w" });
      const cleanups = h.deps.pluginEventCleanups.get(PLUGIN_ID) ?? [];
      expect(cleanups.length).toBeGreaterThan(0);
      for (const cleanup of cleanups) cleanup();
      tracker.report(VIEW, WINDOW, PROJECT_ID, { kind: "diff", worktreeId: "w" });
      vi.advanceTimersByTime(1_000);

      expect(seen).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("survives a listener that throws on the replay", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      const listener = vi.fn(() => {
        throw new Error("boom");
      });

      await expect(host.onDidChangeFocusedPanel(listener)).resolves.toBeTypeOf("function");
      await Promise.resolve();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("send to agent", () => {
  const PLUGIN_ID = "acme";
  const PROJECT_A = "project-a";
  const BOUND: PluginHostBinding = {
    projectId: PROJECT_A,
    projectRoot: path.join(path.sep, "repos", "alpha"),
  };

  const PANE: PluginAgentPane = {
    terminalId: "t-1",
    title: "Claude: auth",
    agentId: "claude",
    worktree: { id: "wt-1", name: "main" },
    isFocused: true,
    canDraft: true,
  };

  function makeHarness(
    capabilities: string[] = ["agent:input", "agent:read"],
    displayName = "Acme Board"
  ) {
    const plugin = {
      // Not builtin, so the just-in-time consent gate actually runs.
      isBuiltin: false,
      binding: BOUND,
      manifest: { name: PLUGIN_ID, displayName: "Acme Board", capabilities },
    } as unknown as LoadedPlugin;
    const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, plugin]]);
    const requestPrompt = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
      status: "drafted",
      terminalId: "t-1",
    }));
    const sendAgentsListToRenderer = vi.fn(
      async (..._args: unknown[]): Promise<PluginAgentPane[]> => [PANE]
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
      pluginPanelMenus: new Map(),
      pluginFsWatchers: new Map(),
      broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
      panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
      dispatcher: { sendAgentsListToRenderer },
      promptDispatcher: { requestPrompt },
      settings: {},
      storage: {},
      getHostGitFactory: () => undefined,
      getProcessManager: vi.fn(),
      declaredCapabilities: () => new Set(capabilities),
      fetchWorktreeSnapshotsResult: vi.fn(),
      fetchWorktreeSnapshotsForProjectResult: vi.fn(),
      recordPluginLog: vi.fn(),
      serializePluginBadges: () => ({}),
      serializePluginPanelMenus: () => ({}),
      pluginDisplayName: () => displayName,
      pluginDataDir: () => path.join(path.sep, "tmp", "data"),
      isPathUnder: () => false,
      expandAllowedPathEntries: async () => [],
      subscribeWorktreeEvent: vi.fn(() => () => {}),
      registerHandler: vi.fn(),
      validateAndBuildActionDescriptor: vi.fn(),
      safeAppendAudit: vi.fn(),
      safeArgsHash: () => "",
    } as unknown as PluginHostFactoryDeps;
    return { deps, plugins, requestPrompt, sendAgentsListToRenderer };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    consentMock.ensureAllowed.mockImplementation(async () => undefined);
  });

  describe("host.sendToAgent", () => {
    it("asks the bound project's renderer, with the plugin's own name as the source", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      const result = await host.sendToAgent("Card body", {
        title: "Fix login",
        worktreeId: "wt-1",
      });

      expect(result).toEqual({ status: "drafted", terminalId: "t-1" });
      expect(h.requestPrompt).toHaveBeenCalledWith(
        PLUGIN_ID,
        {
          kind: "sendToAgent",
          request: {
            text: "Card body",
            title: "Fix login",
            worktreeId: "wt-1",
            sourceLabel: "Acme Board",
          },
        },
        PROJECT_A,
        undefined
      );
      expect(consentMock.ensureAllowed).toHaveBeenCalledWith(
        PLUGIN_ID,
        "Acme Board",
        "agent:input",
        ["agent:input", "agent:read"],
        PROJECT_A
      );
    });

    it("holds an unbounded display name to one clean line before it reaches a draft", async () => {
      const h = makeHarness(undefined, `Acme\r\u001b]0;owned\u0007\u009b Board${"!".repeat(300)}`);
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await host.sendToAgent("x");
      const [, params] = h.requestPrompt.mock.calls[0]!;
      const label = (params as { request: { sourceLabel: string } }).request.sourceLabel;
      expect(label.startsWith("Acme ]0;owned")).toBe(true);
      expect(label.length).toBeLessThanOrEqual(80);
      const printable = [...label].every((char) => {
        const code = char.charCodeAt(0);
        return code > 0x1f && (code < 0x7f || code > 0x9f);
      });
      expect(printable).toBe(true);
    });

    it("rejects PERMISSION_REQUIRED without agent:input, before any prompt", async () => {
      const h = makeHarness(["agent:read"]);
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.sendToAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
      expect(h.requestPrompt).not.toHaveBeenCalled();
    });

    it("propagates a consent denial and drafts nothing", async () => {
      consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.sendToAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
      expect(h.requestPrompt).not.toHaveBeenCalled();
    });

    it.each<[string, string, unknown]>([
      ["blank text", "   ", undefined],
      ["over-long text", "x".repeat(32_769), undefined],
      ["an over-long title", "x", { title: "t".repeat(121) }],
      ["a non-string title", "x", { title: 5 }],
      ["an empty terminalId", "x", { terminalId: "" }],
      ["a non-object options", "x", "t-1"],
    ])("validates %s before asking for consent", async (_name, text, options) => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.sendToAgent(text, options as never)).rejects.toThrow(/sendToAgent/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
      expect(h.requestPrompt).not.toHaveBeenCalled();
    });

    it("forwards a named target and a caller signal", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      const controller = new AbortController();
      await host.sendToAgent("x", { terminalId: "t-9" }, { signal: controller.signal });
      const [, params, , signal] = h.requestPrompt.mock.calls[0]!;
      expect(params).toMatchObject({ request: { terminalId: "t-9" } });
      expect(signal).toBe(controller.signal);
    });

    it("refuses as project-unavailable when the project has no view", async () => {
      const h = makeHarness();
      h.requestPrompt.mockRejectedValue(
        new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no view" })
      );
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.sendToAgent("x")).resolves.toEqual({
        status: "refused",
        reason: "project-unavailable",
      });
    });

    it.each<[string, unknown, unknown]>([
      ["a dismissal", { status: "cancelled" }, { status: "cancelled" }],
      [
        "a refusal",
        { status: "refused", reason: "input-locked" },
        { status: "refused", reason: "input-locked" },
      ],
      [
        "a refusal naming a created worktree",
        { status: "refused", reason: "launch-failed", worktreeId: "wt-new", extra: 1 },
        { status: "refused", reason: "launch-failed", worktreeId: "wt-new" },
      ],
      [
        "an unknown refusal reason",
        { status: "refused", reason: "bogus" },
        { status: "cancelled" },
      ],
      ["a malformed answer", "drafted", { status: "cancelled" }],
    ])("normalises %s from the renderer", async (_name, answer, expected) => {
      const h = makeHarness();
      h.requestPrompt.mockResolvedValue(answer);
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.sendToAgent("x")).resolves.toEqual(expected);
    });

    it("resolves cancelled once the plugin is unloaded", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      h.plugins.delete(PLUGIN_ID);
      await expect(host.sendToAgent("x")).resolves.toEqual({ status: "cancelled" });
      expect(h.requestPrompt).not.toHaveBeenCalled();
    });
  });

  describe("host.agents.list", () => {
    it("reads the bound project's renderer and nothing else", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.agents.list()).resolves.toEqual([PANE]);
      expect(h.sendAgentsListToRenderer).toHaveBeenCalledWith(PROJECT_A, PLUGIN_ID);
    });

    it("stays ambient for an unbound plugin", async () => {
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
      await host.agents.list();
      expect(h.sendAgentsListToRenderer).toHaveBeenCalledWith(null, PLUGIN_ID);
    });

    it("requires agent:read", async () => {
      const h = makeHarness(["agent:input"]);
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.agents.list()).rejects.toThrow(/PERMISSION_REQUIRED/);
      expect(h.sendAgentsListToRenderer).not.toHaveBeenCalled();
    });

    it("answers [] when the project has no view", async () => {
      const h = makeHarness();
      h.sendAgentsListToRenderer.mockRejectedValue(
        new AppError({ code: "PROJECT_VIEW_UNAVAILABLE", message: "no view" })
      );
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(host.agents.list()).resolves.toEqual([]);
    });
  });
});

describe("terminal screen reads", () => {
  const PLUGIN_ID = "acme";
  const PROJECT_A = "project-a";
  const BOUND: PluginHostBinding = {
    projectId: PROJECT_A,
    projectRoot: path.join(path.sep, "repos", "alpha"),
  };

  function makeHarness(capabilities: string[] = ["terminal:read"], isBuiltin = false) {
    const plugin = {
      isBuiltin,
      binding: BOUND,
      manifest: { name: PLUGIN_ID, displayName: "Acme Grid", capabilities },
    } as unknown as LoadedPlugin;
    const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, plugin]]);
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
      pluginPanelMenus: new Map(),
      pluginFsWatchers: new Map(),
      broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
      panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
      dispatcher: { sendAgentsListToRenderer: vi.fn() },
      promptDispatcher: { requestPrompt: vi.fn() },
      settings: {},
      storage: {},
      getHostGitFactory: () => undefined,
      getProcessManager: vi.fn(),
      declaredCapabilities: () => new Set(capabilities),
      fetchWorktreeSnapshotsResult: vi.fn(),
      fetchWorktreeSnapshotsForProjectResult: vi.fn(),
      recordPluginLog: vi.fn(),
      serializePluginBadges: () => ({}),
      serializePluginPanelMenus: () => ({}),
      pluginDisplayName: () => "Acme Grid",
      pluginDataDir: () => path.join(path.sep, "tmp", "data"),
      isPathUnder: () => false,
      expandAllowedPathEntries: async () => [],
      subscribeWorktreeEvent: vi.fn(() => () => {}),
      registerHandler: vi.fn(),
      validateAndBuildActionDescriptor: vi.fn(),
      safeAppendAudit: vi.fn(),
      safeArgsHash: () => "",
    } as unknown as PluginHostFactoryDeps;
    return { deps, plugins, plugin };
  }

  function installPty(projectId = PROJECT_A, data = "\x1b[1mWaiting\x1b[0m for input") {
    const client = {
      getTerminalProjectId: vi.fn((_id: string) => projectId),
      getTerminalAsync: vi.fn(async (id: string) => ({ id, projectId, kind: "terminal" })),
      getSerializedStateAsync: vi.fn(async (_id: string, _options?: unknown) => ({
        data,
        cols: 80,
        rows: 24,
      })),
    };
    ptyMock.client = client;
    return client;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    ptyMock.client = null;
    consentMock.ensureAllowed.mockImplementation(async () => undefined);
  });

  describe("host.terminals.readScreen", () => {
    it("reads the bound project's terminal as plain text after first-use consent", async () => {
      const pty = installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      await expect(host.terminals.readScreen("t-1")).resolves.toEqual({
        status: "ok",
        text: "Waiting for input",
        lineCount: 1,
        truncated: false,
      });
      expect(consentMock.ensureAllowed).toHaveBeenCalledWith(
        PLUGIN_ID,
        "Acme Grid",
        "terminal:read",
        ["terminal:read"],
        PROJECT_A
      );
      expect(pty.getSerializedStateAsync).toHaveBeenCalledWith("t-1", { tailRows: 0 });
    });

    it("is not granted by agent:read", async () => {
      installPty();
      const h = makeHarness(["agent:read"]);
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      await expect(host.terminals.readScreen("t-1")).rejects.toThrow(
        /PERMISSION_REQUIRED: .*"terminal:read"/
      );
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    });

    it("rejects bad arguments before prompting for consent", async () => {
      const pty = installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      await expect(host.terminals.readScreen("")).rejects.toThrow(/terminalId/);
      await expect(host.terminals.readScreen("t-1", { lines: 0 })).rejects.toThrow(/lines/);
      await expect(host.terminals.readScreen("t-1", { lines: 101 })).rejects.toThrow(/lines/);
      await expect(host.terminals.readScreen("t-1", { lines: 2.5 })).rejects.toThrow(/lines/);
      expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
      expect(pty.getTerminalAsync).not.toHaveBeenCalled();
    });

    it("surfaces a consent denial and reads nothing", async () => {
      const pty = installPty();
      consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      await expect(host.terminals.readScreen("t-1")).rejects.toThrow(/PERMISSION_REQUIRED/);
      expect(pty.getTerminalAsync).not.toHaveBeenCalled();
    });

    it("answers another project's terminal as not-found", async () => {
      installPty("project-b");
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

      await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "not-found" });
    });

    it("fails fast with RATE_LIMITED past 60 calls in a second", async () => {
      installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      vi.spyOn(Date, "now").mockReturnValue(1_000_000);
      try {
        for (let i = 0; i < 60; i++) {
          await expect(host.terminals.readScreen("t-1")).resolves.toMatchObject({ status: "ok" });
        }
        const err = await host.terminals.readScreen("t-1").catch((e: unknown) => e);
        expect(String(err)).toMatch(/^Error: RATE_LIMITED:/);
        expect((err as { code?: string }).code).toBe("RATE_LIMITED");
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });

    it("shares the rate window across hosts of the same loaded plugin", async () => {
      installPty();
      const h = makeHarness();
      const first = createHost(h.deps, PLUGIN_ID, BOUND).host;
      const second = createHost(h.deps, PLUGIN_ID, BOUND).host;
      vi.spyOn(Date, "now").mockReturnValue(2_000_000);
      try {
        for (let i = 0; i < 60; i++) await first.terminals.readScreen("t-1");
        await expect(second.terminals.readScreen("t-1")).rejects.toThrow(/RATE_LIMITED/);
      } finally {
        vi.mocked(Date.now).mockRestore();
      }
    });

    it("resolves unavailable once the plugin is unloaded, without a capability error", async () => {
      installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      h.plugins.delete(PLUGIN_ID);

      await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "unavailable" });
    });

    it("drops the answer when the plugin unloads during the consent prompt", async () => {
      const pty = installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      consentMock.ensureAllowed.mockImplementation(async () => {
        h.plugins.delete(PLUGIN_ID);
      });

      await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "unavailable" });
      expect(pty.getTerminalAsync).not.toHaveBeenCalled();
    });
  });

  describe("host.terminals.readScreen null lines", () => {
    it("rejects lines: null like any other non-integer", async () => {
      installPty();
      const h = makeHarness();
      const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
      await expect(
        host.terminals.readScreen("t-1", { lines: null as unknown as number })
      ).rejects.toThrow(/lines/);
    });
  });
});

describe("agent MCP tools", () => {
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
      expect(() =>
        host.mcp.registerTools("data", {
          list_transactions: tool({ inputSchema: { type: "object", $async: true } }),
        })
      ).toThrow(/async/);

      expect(registered().tools.map((t) => t.name)).toEqual(["list_transactions"]);
      expect(registered().tools[0].checkInput({})).toBeNull();
    });

    it("leaves room and names for the database queries the manifest declares", async () => {
      const { deps, plugins } = makeDeps();
      const plugin = fakePlugin();
      const query = (name: string) => ({
        name,
        mode: "read" as const,
        description: "A declared read.",
        params: {},
        sql: "SELECT 1",
      });
      (plugin.manifest.contributes as { databases: unknown }).databases = [
        { id: "ledger", location: "local", journalMode: "delete", queries: [query("month_total")] },
        {
          id: "archive",
          location: "local",
          journalMode: "delete",
          queries: [query("old_total"), query("year_total")],
        },
      ];
      plugins.set(INSTANCE, plugin);
      const { host } = createHost(deps, INSTANCE, BINDING);
      const room = AGENT_MCP_MAX_TOOLS_PER_ENDPOINT - 3;
      const roster = (count: number) =>
        Object.fromEntries(Array.from({ length: count }, (_, i) => [`tool_${i}`, tool()]));

      expect(() => host.mcp.registerTools("data", roster(room + 1))).toThrow(
        /beside the 3 database queries the manifest declares/
      );
      expect(() => host.mcp.registerTools("data", { list: tool(), year_total: tool() })).toThrow(
        /"year_total" is a database query the manifest declares/
      );
      expect(agentMcpEndpointRegistry.get(INSTANCE, "data")).toBeUndefined();

      await host.mcp.registerTools("data", roster(room));
      expect(registered().tools).toHaveLength(room);
    });

    describe("rejects the whole roster", () => {
      const tooMany = Object.fromEntries(
        Array.from({ length: AGENT_MCP_MAX_TOOLS_PER_ENDPOINT + 1 }, (_, i) => [
          `tool_${i}`,
          tool(),
        ])
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
          "for a plugin's own read-only claim",
          "data",
          { list: tool({ annotations: { readOnlyHint: true } as never }) },
          /only the host may mark a tool read-only/,
        ],
        [
          "for a plugin vouching its tool is closed-world",
          "data",
          { list: tool({ annotations: { openWorldHint: false } }) },
          /openWorldHint may only be true/,
        ],
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
        [
          "for a schema that refers outside itself",
          "data",
          {
            list: tool({
              inputSchema: { type: "object", properties: { a: { $ref: "https://example.com/a" } } },
            }),
          },
          /^Plugin ".*" mcp\.registerTools\("data"\): tool "list" inputSchema references "https:\/\/example\.com\/a"/,
        ],
        [
          "for an output schema naming a format the host does not know",
          "data",
          {
            list: tool({
              outputSchema: {
                type: "object",
                properties: { at: { type: "string", format: "when" } },
              },
            }),
          },
          /tool "list" outputSchema cannot be compiled: unknown format "when"/,
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
});

describe("plugin databases", () => {
  const ensureAllowed = consentMock.ensureAllowed;

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

  const PROJECT_ID = "b".repeat(64);
  const INSTANCE = makeProjectPluginInstanceKey(PROJECT_ID, "acme.ledger");

  let tmp: string;
  let projectRoot: string;
  let dataDir: string;

  function loadedPlugin(databases: PluginDatabaseContribution[]): LoadedPlugin {
    return {
      isBuiltin: false,
      manifest: {
        name: "acme.ledger",
        capabilities: ["fs:project-read", "fs:project-write"],
        contributes: { forgeProviders: [], fileDecorationProviders: [], databases },
      },
    } as unknown as LoadedPlugin;
  }

  function makeDeps(databases: PluginDatabaseContribution[]) {
    const plugins = new Map<string, LoadedPlugin>([[INSTANCE, loadedPlugin(databases)]]);
    const pluginEventCleanups = new Map<string, Array<() => void>>();
    const deps = {
      plugins,
      pluginEventCleanups,
      declaredCapabilities: () => new Set(["fs:project-read", "fs:project-write"]),
      pluginDataDir: () => dataDir,
      getHostGitFactory: () => undefined,
      getProcessManager: vi.fn(),
      // What the host.fs write gate behind db.backup consults: the project is
      // the one declared root.
      isPathUnder: (root: string, candidate: string) => {
        const rel = path.relative(root, candidate);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      },
      expandAllowedPathEntries: async () => [{ path: projectRoot, rootClass: "project" }],
      safeAppendAudit: vi.fn(),
      safeArgsHash: () => "hash",
    } as unknown as PluginHostFactoryDeps;
    return { deps, plugins, pluginEventCleanups };
  }

  beforeEach(async () => {
    tmp = await fsp.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "host-db-")));
    projectRoot = path.join(tmp, "project");
    dataDir = path.join(tmp, "plugin-data");
    fs.mkdirSync(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("host.db (in-process host)", () => {
    it("opens a declared project database against the bound project root", async () => {
      const { deps } = makeDeps([
        { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      const db = await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] });
      expect(db.location.path).toBe(path.join(projectRoot, "data/finance.db"));
      await db.run("INSERT INTO t VALUES (1)");
      expect(fs.existsSync(path.join(projectRoot, "data/finance.db"))).toBe(true);
      await db.close();
    });

    it("asks for project-write consent before touching the repository, and not for a local database", async () => {
      ensureAllowed.mockClear();
      const { deps } = makeDeps([
        { id: "ledger", location: "project", journalMode: "delete" },
        { id: "cache", location: "local", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      await (await host.db.open("cache")).close();
      expect(ensureAllowed).not.toHaveBeenCalled();
      ensureAllowed.mockRejectedValueOnce(new Error("CONSENT_DENIED: no"));
      await expect(host.db.open("ledger")).rejects.toThrow(/CONSENT_DENIED/);
      expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
    });

    it.each([
      ["a non-array migrations", { migrations: "CREATE TABLE t (x)" }, /VALIDATION/],
      ["a non-string migration", { migrations: [42] }, /VALIDATION/],
      ["non-string definitions", { definitions: 7 }, /VALIDATION/],
      ["an ATTACH migration", { migrations: ["ATTACH 'x.db' AS x"] }, /DB_STATEMENT_NOT_ALLOWED/],
    ])("rejects %s before asking for project-write consent", async (_name, options, error) => {
      ensureAllowed.mockClear();
      const { deps } = makeDeps([{ id: "ledger", location: "project", journalMode: "delete" }]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      await expect(
        host.db.open("ledger", options as unknown as Parameters<typeof host.db.open>[1])
      ).rejects.toThrow(error);
      expect(ensureAllowed).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
    });

    it("opens with the migrations it checked, not ones swapped in during the consent prompt", async () => {
      const { deps } = makeDeps([{ id: "ledger", location: "project", journalMode: "delete" }]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      const migrations = ["CREATE TABLE t (x)"];
      ensureAllowed.mockImplementationOnce(async () => {
        migrations[0] = "ATTACH 'x.db' AS x";
      });
      const db = await host.db.open("ledger", { migrations });
      expect(await db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
      await db.close();
    });

    it("opens a project database readonly without consent and without creating anything", async () => {
      ensureAllowed.mockClear();
      const { deps } = makeDeps([{ id: "ledger", location: "project", journalMode: "delete" }]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      await expect(host.db.open("ledger", { readonly: true })).rejects.toThrow(/DB_NOT_FOUND/);
      expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
      expect(ensureAllowed).not.toHaveBeenCalled();
      await (await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })).close();
      ensureAllowed.mockClear();
      const reader = await host.db.open("ledger", { readonly: true });
      expect(await reader.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
      expect(ensureAllowed).not.toHaveBeenCalled();
      await reader.close();
    });

    it("stops tracking a handle the plugin closed itself", async () => {
      const { deps, pluginEventCleanups } = makeDeps([
        { id: "cache", location: "local", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      const db = await host.db.open("cache");
      expect(pluginEventCleanups.get(INSTANCE)?.length).toBe(1);
      await db.close();
      expect(pluginEventCleanups.get(INSTANCE)).toBeUndefined();
    });

    it("backs up only to a destination the fs write gate approves", async () => {
      const { deps } = makeDeps([
        { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      const db = await host.db.open("ledger", {
        migrations: ["CREATE TABLE t (x); INSERT INTO t VALUES (7)"],
      });
      const outside = path.join(tmp, "elsewhere.db");
      await expect(db.backup(outside)).rejects.toThrow(/PATH_NOT_ALLOWED/);
      expect(fs.existsSync(outside)).toBe(false);

      ensureAllowed.mockClear();
      fs.mkdirSync(path.join(projectRoot, "backups"));
      const dest = path.join(projectRoot, "backups", "finance.db");
      expect(await db.backup(dest)).toEqual({ path: dest, bytes: fs.statSync(dest).size });
      expect(ensureAllowed.mock.calls.map((call) => call[2])).toEqual(["fs:project-write"]);
      const copy = new DatabaseSync(dest, { readOnly: true });
      expect(copy.prepare("SELECT x FROM t").all()).toEqual([{ x: 7 }]);
      copy.close();
      await db.close();
    });

    it("approves a worker's backup destination through the same gate", async () => {
      const { deps } = makeDeps([
        { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      await (await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })).close();
      const dest = path.join(projectRoot, "ledger-copy.db");
      // What the main bridge runs for the worker's `db.prepareBackup` call.
      await expect(approvePluginDatabaseBackup(host.db, "ledger", dest)).resolves.toBe(dest);
      await expect(
        approvePluginDatabaseBackup(host.db, "ledger", path.join(tmp, "elsewhere.db"))
      ).rejects.toThrow(/PATH_NOT_ALLOWED/);
      await expect(approvePluginDatabaseBackup(host.db, "other", dest)).rejects.toThrow(
        /DB_NOT_DECLARED/
      );
    });

    it("gives a host kept across a same-id reload no access to the new instance's databases", async () => {
      const declared: PluginDatabaseContribution[] = [
        { id: "cache", location: "local", journalMode: "delete" },
      ];
      const { deps, plugins, pluginEventCleanups } = makeDeps(declared);
      const { host: stale } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      plugins.set(
        INSTANCE,
        loadedPlugin([...declared, { id: "fresh", location: "local", journalMode: "delete" }])
      );
      await expect(stale.db.open("cache")).rejects.toThrow(/PLUGIN_UNLOADED/);
      await expect(stale.db.resolve("fresh")).rejects.toThrow(/PLUGIN_UNLOADED/);
      expect(pluginEventCleanups.get(INSTANCE)).toBeUndefined();
    });

    it("abandons an open whose plugin reloaded while it waited for consent", async () => {
      const declared: PluginDatabaseContribution[] = [
        { id: "ledger", location: "project", journalMode: "delete" },
      ];
      const { deps, plugins, pluginEventCleanups } = makeDeps(declared);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      ensureAllowed.mockImplementationOnce(async () => {
        plugins.set(INSTANCE, loadedPlugin(declared));
      });
      await expect(host.db.open("ledger")).rejects.toThrow(/PLUGIN_UNLOADED/);
      expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
      expect(pluginEventCleanups.get(INSTANCE)).toBeUndefined();
    });

    it("refuses an undeclared id", async () => {
      const { deps } = makeDeps([]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      await expect(host.db.open("ledger")).rejects.toThrow(/DB_NOT_DECLARED/);
      await expect(host.db.resolve("ledger")).rejects.toThrow(/DB_NOT_DECLARED/);
    });

    it("closes open handles through the plugin's unload cleanups", async () => {
      const { deps, pluginEventCleanups } = makeDeps([
        { id: "cache", location: "local", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      const db = await host.db.open("cache");
      const cleanups = pluginEventCleanups.get(INSTANCE) ?? [];
      expect(cleanups.length).toBeGreaterThan(0);
      for (const cleanup of [...cleanups]) cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(db.query("SELECT 1")).rejects.toMatchObject({ code: "DB_CLOSED" });
    });

    it("refuses to open once the plugin has unloaded", async () => {
      const { deps, plugins } = makeDeps([
        { id: "cache", location: "local", journalMode: "delete" },
      ]);
      const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
      plugins.delete(INSTANCE);
      await expect(host.db.open("cache")).rejects.toThrow(/PLUGIN_UNLOADED/);
    });
  });
});
