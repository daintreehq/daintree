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
import { FocusedPanelTracker, _setFocusedPanelTrackerForTests } from "../../FocusedPanelTracker.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { PluginFocusedPanel, PluginHostBinding } from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

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
