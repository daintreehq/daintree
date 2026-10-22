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
  getProjectPushTargets: vi.fn(() => []),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => null) }));
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
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn() })),
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import {
  ProjectPresenceTracker,
  _setProjectPresenceTrackerForTests,
} from "../../ProjectPresenceTracker.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginHostBinding,
  type PluginProjectPresence,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const ALPHA = "a".repeat(64);
const BETA = "b".repeat(64);
const SCRATCH = "11111111-2222-4333-8444-555555555555";
const BOUND: PluginHostBinding = { projectId: ALPHA, projectRoot: "/repos/alpha" };

interface Harness {
  deps: PluginHostFactoryDeps;
  plugins: Map<string, LoadedPlugin>;
}

function makeHarness(): Harness {
  const plugins = new Map<string, LoadedPlugin>([
    [
      PLUGIN_ID,
      {
        isBuiltin: true,
        manifest: { name: PLUGIN_ID, capabilities: [], contributes: {} },
      } as unknown as LoadedPlugin,
    ],
  ]);
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
    dispatcher: {},
    promptDispatcher: { requestPrompt: vi.fn() },
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set<string>(),
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
  return { deps, plugins };
}

let shown: string[];
let tracker: ProjectPresenceTracker;

function show(...ids: string[]): void {
  shown = ids;
  tracker.refresh();
}

beforeEach(() => {
  vi.useFakeTimers();
  shown = [];
  tracker = new ProjectPresenceTracker(() => shown);
  _setProjectPresenceTrackerForTests(tracker);
});

afterEach(() => {
  _setProjectPresenceTrackerForTests(null);
  vi.useRealTimers();
});

const flushReplay = () => vi.advanceTimersByTimeAsync(0);

describe("onDidChangeProjectPresence", () => {
  it("replays every open project to an installed plugin, frozen, without a capability", async () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    show(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];

    await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();

    expect(seen).toEqual([
      { projectId: ALPHA, state: "foreground" },
      { projectId: BETA, state: "background" },
    ]);
    expect(seen.every((presence) => Object.isFrozen(presence))).toBe(true);
  });

  it("coalesces a switch per project with the 100ms default", async () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    show(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();
    seen.length = 0;

    show(BETA);
    show(ALPHA);
    show(BETA);
    vi.advanceTimersByTime(99);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(seen).toEqual([
      { projectId: BETA, state: "foreground" },
      { projectId: ALPHA, state: "background" },
    ]);
  });

  it("does not repeat a state a burst settled back on", async () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    show(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();
    seen.length = 0;

    show(BETA);
    show(ALPHA);
    vi.advanceTimersByTime(100);

    expect(seen).toEqual([]);
  });

  it("tells a project plugin about its own project only, closes included", async () => {
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
    show(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, BOUND);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence), { debounceMs: 0 });
    await flushReplay();

    show(BETA);
    tracker.markClosed(BETA);
    tracker.markClosed(ALPHA);

    expect(seen).toEqual([
      { projectId: ALPHA, state: "foreground" },
      { projectId: ALPHA, state: "background" },
      { projectId: ALPHA, state: "closed" },
    ]);
  });

  it("answers a project plugin whose project is not open with closed", async () => {
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, BOUND);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();

    expect(seen).toEqual([{ projectId: ALPHA, state: "closed" }]);
  });

  it("never shows an installed plugin a scratch", async () => {
    tracker.markOpened(ALPHA);
    show(SCRATCH);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence), { debounceMs: 0 });
    await flushReplay();
    show(ALPHA);

    expect(seen.map((presence) => presence.projectId)).toEqual([ALPHA, ALPHA]);
  });

  it("keeps an installed plugin quiet about a project that came and went in one window", async () => {
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();

    tracker.markOpened(BETA);
    tracker.markClosed(BETA);
    vi.advanceTimersByTime(100);
    expect(seen).toEqual([]);

    // Seen open, so its close is news, and reopening it later is news again.
    tracker.markOpened(BETA);
    vi.advanceTimersByTime(100);
    tracker.markClosed(BETA);
    vi.advanceTimersByTime(100);
    tracker.markOpened(BETA);
    vi.advanceTimersByTime(100);
    expect(seen.map((presence) => presence.state)).toEqual(["background", "closed", "background"]);
  });

  it("delivers a change made before the replay ran, once", async () => {
    tracker.markOpened(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    const subscribing = host.onDidChangeProjectPresence((presence) => seen.push(presence));
    show(ALPHA);
    await subscribing;
    await flushReplay();
    vi.advanceTimersByTime(100);

    expect(seen).toEqual([{ projectId: ALPHA, state: "foreground" }]);
  });

  it("is revoke-guarded", () => {
    const { host, revoke } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    revoke();

    expect(() => host.onDidChangeProjectPresence(() => {})).toThrow(/host revoked/);
  });

  it("stops delivering, pending window included, once disposed", async () => {
    tracker.markOpened(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    const dispose = await host.onDidChangeProjectPresence((presence) => seen.push(presence));
    await flushReplay();
    show(ALPHA);
    dispose();
    dispose();
    vi.advanceTimersByTime(1_000);

    expect(seen).toEqual([{ projectId: ALPHA, state: "background" }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is torn down by the plugin's unload cleanups and goes quiet once unloaded", async () => {
    tracker.markOpened(ALPHA);
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const seen: PluginProjectPresence[] = [];
    // Unloaded before the replay's microtask runs, so even that stays quiet.
    const subscribing = host.onDidChangeProjectPresence((presence) => seen.push(presence));
    h.plugins.delete(PLUGIN_ID);
    await subscribing;
    await flushReplay();
    const cleanups = h.deps.pluginEventCleanups.get(PLUGIN_ID) ?? [];
    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of cleanups) cleanup();
    show(ALPHA);
    vi.advanceTimersByTime(1_000);

    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("quarantines a listener that keeps throwing, and keeps others alive", async () => {
    tracker.markOpened(ALPHA);
    const { host } = createHost(makeHarness().deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const healthy = vi.fn();
    await host.onDidChangeProjectPresence(throwing, { debounceMs: 0 });
    await host.onDidChangeProjectPresence(healthy, { debounceMs: 0 });
    await flushReplay();
    show(ALPHA);
    show();
    show(ALPHA);
    show();

    expect(throwing).toHaveBeenCalledTimes(3);
    expect(healthy).toHaveBeenCalledTimes(5);
    error.mockRestore();
  });
});
