import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcUtilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectPushTargets: vi.fn((_projectId: string | null): unknown[] => []),
}));
const grants = vi.hoisted(() => ({
  hasGrant: vi.fn((_identity: unknown): boolean => false),
}));
const pager = vi.hoisted(() => ({
  pagePluginNotification: vi.fn((_page: unknown) => true),
  retirePluginNotification: vi.fn((_key: string) => {}),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: ipcUtilsMock.broadcastToRenderer,
  broadcastToProjectRenderers: ipcUtilsMock.broadcastToProjectRenderers,
  getProjectPushTargets: ipcUtilsMock.getProjectPushTargets,
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
  getPluginCapabilityConsentStore: vi.fn(() => grants),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));
vi.mock("../pluginNotificationPager.js", () => pager);

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { resetPluginPushBatcherForTests } from "../pluginPushBatcher.js";
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { PluginHostBinding } from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const PROJECT_A = "project-a";
const BOUND: PluginHostBinding = {
  projectId: PROJECT_A,
  projectRoot: path.join(path.sep, "repos", "alpha"),
};

function makeDeps(capabilities: string[] = []): PluginHostFactoryDeps {
  const plugin = {
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities,
      contributes: { forgeProviders: [], fileDecorationProviders: [] },
    },
  } as unknown as LoadedPlugin;
  return {
    plugins: new Map([[PLUGIN_ID, plugin]]),
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
    dispatcher: {
      sendDispatchToRenderer: vi.fn(),
      sendActionsListToRenderer: vi.fn(),
      sendActionsGetToRenderer: vi.fn(),
    },
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
    pluginDisplayName: () => "Acme",
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
}

function lastToast(): Record<string, unknown> {
  const calls = [
    ...ipcUtilsMock.broadcastToRenderer.mock.calls,
    ...ipcUtilsMock.broadcastToProjectRenderers.mock.calls.map((c) => c.slice(1)),
  ].filter((c) => c[0] === CHANNELS.NOTIFICATION_SHOW_TOAST);
  return calls.at(-1)?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginPushBatcherForTests();
  grants.hasGrant.mockReturnValue(false);
});

describe("host.notify", () => {
  it("pushes a titled toast with the actions rewritten to the instance namespace", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const result = await host.notify({
      title: "Run needs you",
      body: "Approve the plan",
      actions: [{ id: "open", label: "Open", actionId: "acme.openRun", args: { runId: "r1" } }],
      dedupeKey: "run-r1",
    });

    expect(typeof result.id).toBe("string");
    expect(lastToast()).toEqual({
      type: "info",
      title: "Acme: Run needs you",
      message: "Approve the plan",
      rateLimitKey: "plugin:acme:notify",
      pluginActions: [{ label: "Open", actionId: "acme.openRun", args: { runId: "r1" } }],
      replaceKey: "plugin:acme:run-r1",
    });
    expect(pager.pagePluginNotification).not.toHaveBeenCalled();
  });

  it("rewrites a project instance's authored ids into its own namespace", async () => {
    const instanceId = `project__${PROJECT_A}__acme`;
    const deps = makeDeps();
    (deps.plugins as Map<string, LoadedPlugin>).set(instanceId, deps.plugins.get(PLUGIN_ID)!);
    const { host } = createHost(deps, instanceId, BOUND);

    await host.notify({
      title: "t",
      body: "b",
      actions: [{ id: "open", label: "Open", actionId: "acme.openRun" }],
    });

    expect(lastToast().pluginActions).toEqual([
      { label: "Open", actionId: `${instanceId}.openRun` },
    ]);
  });

  it.each([
    ["a foreign plugin's action", "other.openRun"],
    ["a built-in action", "terminal.focus"],
    ["the bare namespace", "acme."],
  ])("refuses %s", async (_name, actionId) => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(
      host.notify({ title: "t", body: "b", actions: [{ id: "x", label: "X", actionId }] })
    ).rejects.toThrow(/must be one of this plugin's own actions/);
    expect(lastToast()).toBeUndefined();
  });

  it("rejects more than two actions, duplicate ids and unknown keys", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const action = (id: string) => ({ id, label: id, actionId: `acme.${id}` });

    await expect(
      host.notify({ title: "t", body: "b", actions: [action("a"), action("b"), action("c")] })
    ).rejects.toThrow(/invalid options/);
    await expect(
      host.notify({ title: "t", body: "b", actions: [action("a"), action("a")] })
    ).rejects.toThrow(/unique/);
    await expect(host.notify({ title: "t", body: "b", priority: "high" } as never)).rejects.toThrow(
      /invalid options/
    );
  });

  it("rejects os: true when notification:os is not declared", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await expect(host.notify({ title: "t", body: "b", os: true })).rejects.toThrow(
      /PERMISSION_REQUIRED.*notification:os/
    );
  });

  it("downgrades os: true to in-app while the user's switch is off", async () => {
    const { host } = createHost(
      makeDeps(["notification:os"]),
      PLUGIN_ID,
      UNBOUND_PLUGIN_HOST_BINDING
    );

    await host.notify({ title: "t", body: "b", os: true });

    expect(lastToast()).toBeDefined();
    expect(grants.hasGrant).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      capability: "notification:os",
      scopeKey: "global",
    });
    expect(pager.pagePluginNotification).not.toHaveBeenCalled();
  });

  it("pages the OS with the first action once the switch is on", async () => {
    grants.hasGrant.mockReturnValue(true);
    const { host } = createHost(makeDeps(["notification:os"]), PLUGIN_ID, BOUND);

    await host.notify({
      title: "Run needs you",
      body: "Approve",
      os: true,
      dedupeKey: "k",
      actions: [
        { id: "open", label: "Open", actionId: "acme.openRun", args: { runId: "r1" } },
        { id: "skip", label: "Skip", actionId: "acme.skipRun" },
      ],
    });

    expect(pager.pagePluginNotification).toHaveBeenCalledWith({
      pluginId: PLUGIN_ID,
      projectId: PROJECT_A,
      title: "Acme: Run needs you",
      body: "Approve",
      replaceKey: "plugin:acme:k",
      firstAction: { actionId: "acme.openRun", args: { runId: "r1" } },
    });
  });

  it("retires the earlier banner when a replacement doesn't page", async () => {
    const { host } = createHost(
      makeDeps(["notification:os"]),
      PLUGIN_ID,
      UNBOUND_PLUGIN_HOST_BINDING
    );

    await host.notify({ title: "t", body: "b", dedupeKey: "k" });

    expect(pager.retirePluginNotification).toHaveBeenCalledWith("plugin:acme:k");
    expect(pager.pagePluginNotification).not.toHaveBeenCalled();
  });

  it("shows nothing once the plugin is unloaded", async () => {
    const deps = makeDeps();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    (deps.plugins as Map<string, LoadedPlugin>).delete(PLUGIN_ID);

    await expect(host.notify({ title: "t", body: "b" })).resolves.toEqual({
      id: expect.any(String),
    });
    expect(lastToast()).toBeUndefined();
  });
});
