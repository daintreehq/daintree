import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

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
vi.mock("../../forgeProviderRegistry.js", () => ({
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
}));
vi.mock("../../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((scope: string, pattern: string) => scope === pattern),
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
vi.mock("../../viewless/index.js", () => ({ runViewlessAction: vi.fn(async () => null) }));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import type { PanelOwnership } from "../PluginPanelLifecycleBroker.js";
import { flushPluginPushes, resetPluginPushBatcherForTests } from "../pluginPushBatcher.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../../shared/config/panelKindRegistry.js";
import {
  PLUGIN_PANEL_ACTIVITY_MAX_PANELS,
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginPanelActivityReport,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";

function fakePlugin(panels: Array<{ id: string; reportsActivity?: boolean }>): LoadedPlugin {
  return {
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities: [],
      contributes: { forgeProviders: [], fileDecorationProviders: [], panels },
    },
  } as unknown as LoadedPlugin;
}

function registerKind(id: string, extensionId: string, reportsActivity?: boolean): void {
  registerPanelKind({
    id,
    name: id,
    iconId: "puzzle",
    color: "#888888",
    hasPty: false,
    canRestart: false,
    canConvert: false,
    extensionId,
    ...(reportsActivity !== undefined ? { reportsActivity } : {}),
  });
}

interface Harness {
  deps: PluginHostFactoryDeps;
  plugins: Map<string, LoadedPlugin>;
  activity: Map<string, Map<string, PluginPanelActivityReport>>;
  emitPanelActivity: ReturnType<typeof vi.fn>;
  ownership: ReturnType<typeof vi.fn>;
  pushTargetsFor: ReturnType<typeof vi.fn>;
}

function makeHarness(
  panels: Array<{ id: string; reportsActivity?: boolean }> = [
    { id: "chat", reportsActivity: true },
    { id: "notes" },
  ]
): Harness {
  const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, fakePlugin(panels)]]);
  const activity = new Map<string, Map<string, PluginPanelActivityReport>>();
  const emitPanelActivity = vi.fn();
  let revision = 0;
  const ownership = vi.fn((): PanelOwnership => ({ kind: "missing" }));
  const pushTargetsFor = vi.fn((): number[] | "closed" => []);
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
    pluginPanelActivity: activity,
    emitPanelActivity,
    nextPanelActivityRevision: () => ++revision,
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
    pluginTerminalStatuses: new Map(),
    emitTerminalStatuses: () => {},
    terminalStatusGeneration: () => 0,
    terminalStatusCloseRevision: () => 0,
    isTerminalStatusProjectClosed: () => false,
    pluginPanelMenus: new Map(),
    pluginFsWatchers: new Map(),
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}), ownership, pushTargetsFor },
    dispatcher: {},
    promptDispatcher: {},
    settings: {},
    storage: {},
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    declaredCapabilities: () => new Set<string>(),
    recordPluginLog: vi.fn(),
    serializePluginBadges: () => ({}),
    serializePluginPanelMenus: () => ({}),
    pluginDisplayName: (id: string) => id,
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, activity, emitPanelActivity, ownership, pushTargetsFor };
}

function hostFor(h: Harness) {
  return createHost(h.deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING).host;
}

beforeEach(() => {
  registerKind("acme.chat", PLUGIN_ID, true);
  registerKind("acme.notes", PLUGIN_ID);
  registerKind("other.chat", "other", true);
});

afterEach(() => {
  unregisterPluginPanelKinds(PLUGIN_ID);
  unregisterPluginPanelKinds("other");
  resetPluginPushBatcherForTests();
});

describe("host.setPanelActivity", () => {
  it("stores and publishes a report on the plugin's own declaring panel", async () => {
    const h = makeHarness();
    h.ownership.mockReturnValue({ kind: "owned", panelKindId: "acme.chat" });
    const host = hostFor(h);

    await host.setPanelActivity("panel-1", { state: "working", reason: " Importing " });

    expect(h.ownership).toHaveBeenCalledWith("panel-1", PLUGIN_ID);
    expect(h.activity.get(PLUGIN_ID)?.get("panel-1")).toEqual({
      state: "working",
      reason: "Importing",
      revision: 1,
    });
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledWith(PLUGIN_ID);
  });

  it("refuses another plugin's panel and a built-in one, storing nothing", async () => {
    const h = makeHarness();
    const host = hostFor(h);

    h.ownership.mockReturnValue({ kind: "foreign" });
    await expect(host.setPanelActivity("p", { state: "working" })).rejects.toThrow(
      /belongs to another plugin/
    );
    h.ownership.mockReturnValue({ kind: "non-plugin" });
    await expect(host.setPanelActivity("p", { state: "working" })).rejects.toThrow(
      /is not a plugin panel/
    );
    h.ownership.mockReturnValue({ kind: "unavailable" });
    await expect(host.setPanelActivity("p", { state: "working" })).rejects.toThrow(
      /cannot be settled/
    );

    expect(h.activity.size).toBe(0);
    expect(h.emitPanelActivity).not.toHaveBeenCalled();
  });

  it("refuses the plugin's own panel of a kind that does not declare reportsActivity", async () => {
    const h = makeHarness();
    h.ownership.mockReturnValue({ kind: "owned", panelKindId: "acme.notes" });

    await expect(hostFor(h).setPanelActivity("p", { state: "waiting" })).rejects.toThrow(
      /"acme\.notes" does not declare reportsActivity/
    );
    expect(h.activity.size).toBe(0);
  });

  it("refuses every report from a plugin with no declaring kind, before asking whose the panel is", async () => {
    const h = makeHarness([{ id: "notes" }]);

    await expect(hostFor(h).setPanelActivity("p", { state: "working" })).rejects.toThrow(
      /none of this plugin's contributes\.panels declares reportsActivity/
    );
    expect(h.ownership).not.toHaveBeenCalled();
  });

  it("holds a report on a panel not reported yet, and drops one on a panel that has closed", async () => {
    const h = makeHarness();
    const host = hostFor(h);

    await host.setPanelActivity("fresh", { state: "working" });
    expect(h.activity.get(PLUGIN_ID)?.has("fresh")).toBe(true);

    h.pushTargetsFor.mockReturnValue("closed");
    flushPluginPushes();
    h.emitPanelActivity.mockClear();
    await host.setPanelActivity("fresh", { state: "finished" });
    expect(h.activity.has(PLUGIN_ID)).toBe(false);
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(1);

    h.emitPanelActivity.mockClear();
    await host.setPanelActivity("gone", { state: "finished" });
    expect(h.activity.has(PLUGIN_ID)).toBe(false);
    flushPluginPushes();
    expect(h.emitPanelActivity).not.toHaveBeenCalled();
  });

  it("sends nothing for the report a panel already holds, and a new revision for a change", async () => {
    const h = makeHarness();
    h.ownership.mockReturnValue({ kind: "owned", panelKindId: "acme.chat" });
    const host = hostFor(h);

    await host.setPanelActivity("p", { state: "finished", reason: "Done" });
    flushPluginPushes();
    await host.setPanelActivity("p", { state: "finished", reason: "Done" });
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(1);

    await host.setPanelActivity("p", { state: "working" });
    flushPluginPushes();
    await host.setPanelActivity("p", { state: "finished", reason: "Done" });
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(3);
    expect(h.activity.get(PLUGIN_ID)?.get("p")?.revision).toBe(3);
  });

  it("clears only its own report, without asking whose the panel is", async () => {
    const h = makeHarness();
    const host = hostFor(h);
    await host.setPanelActivity("p", { state: "working" });
    flushPluginPushes();
    h.ownership.mockClear();
    h.emitPanelActivity.mockClear();

    await host.setPanelActivity("p", null);
    expect(h.activity.has(PLUGIN_ID)).toBe(false);
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(1);
    expect(h.ownership).not.toHaveBeenCalled();

    // A clear of nothing sends nothing.
    await host.setPanelActivity("p", null);
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(1);
  });

  it("publishes a burst of reports across 100 panels once, with every final report (#14128)", async () => {
    const h = makeHarness();
    h.ownership.mockReturnValue({ kind: "owned", panelKindId: "acme.chat" });
    const host = hostFor(h);

    for (let i = 0; i < 100; i++) {
      await host.setPanelActivity(`p${i}`, { state: "working" });
    }
    expect(h.emitPanelActivity).not.toHaveBeenCalled();
    flushPluginPushes();
    expect(h.emitPanelActivity).toHaveBeenCalledTimes(1);
    expect(h.activity.get(PLUGIN_ID)?.size).toBe(100);
  });

  it("rejects an invalid report rather than throwing", async () => {
    const h = makeHarness();
    const host = hostFor(h);
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = host.setPanelActivity("p", { state: "idle" } as never);
    }).not.toThrow();
    await expect(pending).rejects.toThrow(/activity\.state must be/);
    await expect(host.setPanelActivity("", { state: "working" })).rejects.toThrow(
      /panelId must be a non-empty string/
    );
  });

  it("caps new panels but still lets a held one change or clear", async () => {
    const h = makeHarness();
    const host = hostFor(h);
    const held = new Map<string, PluginPanelActivityReport>();
    for (let i = 0; i < PLUGIN_PANEL_ACTIVITY_MAX_PANELS; i++) {
      held.set(`p${i}`, { state: "working", revision: i + 1 });
    }
    h.activity.set(PLUGIN_ID, held);

    await expect(host.setPanelActivity("one-more", { state: "working" })).rejects.toThrow(
      /already reported on 256 panels/
    );
    await expect(host.setPanelActivity("p0", { state: "finished" })).resolves.toBeUndefined();
    await expect(host.setPanelActivity("p1", null)).resolves.toBeUndefined();
  });

  it("is a silent no-op once the plugin is unloaded or replaced", async () => {
    const h = makeHarness();
    const host = hostFor(h);

    h.plugins.set(PLUGIN_ID, fakePlugin([{ id: "chat", reportsActivity: true }]));
    await expect(host.setPanelActivity("p", { state: "working" })).resolves.toBeUndefined();
    h.plugins.delete(PLUGIN_ID);
    await expect(host.setPanelActivity("p", { state: "working" })).resolves.toBeUndefined();

    expect(h.activity.size).toBe(0);
    expect(h.emitPanelActivity).not.toHaveBeenCalled();
  });
});
