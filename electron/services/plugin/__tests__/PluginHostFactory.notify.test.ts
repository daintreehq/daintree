import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  _resetPluginFrontendRoutingForTesting,
  setPluginFrontendRouter,
} from "../pluginFrontendRouting.js";
import { PluginFrontendMethod } from "../pluginFrontendRequests.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import {
  PLUGIN_TOAST_BURST,
  PLUGIN_TOAST_REFILL_MS,
  resetPluginToastBudget,
} from "../pluginToastBudget.js";
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
    panelLifecycleBroker: {
      subscribe: vi.fn(() => () => {}),
      locate: vi.fn(() => ({ kind: "missing" })),
    },
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
    pluginNotificationsBlocked: vi.fn(async () => false),
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
  resetPluginToastBudget();
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
      rateLimitKey: "plugin:acme",
      rateLimitLabel: "Acme",
      pluginActions: [{ label: "Open", actionId: "acme.openRun", args: { runId: "r1" } }],
      replaceKey: "plugin:acme:run-r1",
      context: { plugin: { id: "acme", name: "Acme" } },
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

  it("refuses an own-namespace id that spells a built-in action", async () => {
    const deps = makeDeps();
    (deps.plugins as Map<string, LoadedPlugin>).set(
      "worktree.resource",
      deps.plugins.get(PLUGIN_ID)!
    );
    const { host } = createHost(deps, "worktree.resource", UNBOUND_PLUGIN_HOST_BINDING);

    await expect(
      host.notify({
        title: "t",
        body: "b",
        actions: [{ id: "x", label: "X", actionId: "worktree.resource.teardown" }],
      })
    ).rejects.toThrow(/built-in action/);
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

  it("shares one budget with showToast, and past it shows, pages and retires nothing (#13766)", async () => {
    const { host } = createHost(
      makeDeps(["notification:os"]),
      PLUGIN_ID,
      UNBOUND_PLUGIN_HOST_BINDING
    );
    grants.hasGrant.mockReturnValue(true);
    const toastCount = () =>
      [
        ...ipcUtilsMock.broadcastToRenderer.mock.calls,
        ...ipcUtilsMock.broadcastToProjectRenderers.mock.calls.map((c) => c.slice(1)),
      ].filter((c) => c[0] === CHANNELS.NOTIFICATION_SHOW_TOAST).length;

    let clock = 5_000_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      for (let n = 0; n < PLUGIN_TOAST_BURST; n++) {
        if (n % 2 === 0) await host.showToast({ message: `toast ${n}`, type: "error" });
        else await host.notify({ title: "t", body: `notify ${n}` });
      }
      expect(toastCount()).toBe(PLUGIN_TOAST_BURST);

      const over = await host.notify({ title: "t", body: "over", os: true, dedupeKey: "k" });
      expect(typeof over.id).toBe("string");
      await host.showToast({ message: "over too", type: "warning" });
      expect(toastCount()).toBe(PLUGIN_TOAST_BURST);
      expect(pager.pagePluginNotification).not.toHaveBeenCalled();
      expect(pager.retirePluginNotification).not.toHaveBeenCalled();

      clock += PLUGIN_TOAST_REFILL_MS;
      await host.notify({ title: "t", body: "refilled" });
      expect(toastCount()).toBe(PLUGIN_TOAST_BURST + 1);
      expect(lastToast()).toMatchObject({ message: "refilled", rateLimitKey: "plugin:acme" });
    } finally {
      now.mockRestore();
    }
  });

  it("charges nothing for a call it rejects", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const now = vi.spyOn(performance, "now").mockReturnValue(5_000_000);
    try {
      for (let n = 0; n < PLUGIN_TOAST_BURST * 2; n++) {
        await expect(host.notify({ title: "", body: "b" })).rejects.toThrow(/notify: invalid/);
      }
      await host.notify({ title: "t", body: "valid" });
      expect(lastToast()).toMatchObject({ message: "valid" });
    } finally {
      now.mockRestore();
    }
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

describe("overflow label (#13760)", () => {
  afterEach(() => {
    _resetPluginFrontendRoutingForTesting();
  });

  it("keys a project instance's toasts by its instance key but labels them by display name", async () => {
    const instanceId = `project__${PROJECT_A}__acme`;
    const deps = makeDeps();
    (deps.plugins as Map<string, LoadedPlugin>).set(instanceId, deps.plugins.get(PLUGIN_ID)!);
    const { host } = createHost(deps, instanceId, BOUND);

    await host.showToast({ message: "Synced", type: "success" });
    expect(lastToast()).toMatchObject({
      rateLimitKey: `plugin:${instanceId}`,
      rateLimitLabel: "Acme",
    });

    await host.notify({ title: "t", body: "b" });
    expect(lastToast()).toMatchObject({
      rateLimitKey: `plugin:${instanceId}`,
      rateLimitLabel: "Acme",
    });
  });

  it("sends the display name with a toast for a window on another machine", async () => {
    const request = vi.fn((_method: string, _payload: unknown) => Promise.resolve(null));
    setPluginFrontendRouter({
      resolve: () => ({
        kind: "remote",
        endpoint: { request, isClosed: () => false } as unknown as ClientEndpoint,
      }),
      onChange: () => () => {},
    });
    const { host } = createHost(makeDeps(), PLUGIN_ID, BOUND);

    await host.showToast({ message: "Synced", type: "success" });
    await host.notify({ title: "t", body: "b" });

    const toasts = request.mock.calls.filter(([method]) => method === PluginFrontendMethod.TOAST);
    expect(toasts.map(([, payload]) => payload)).toEqual([
      expect.objectContaining({ message: "Acme: Synced", pluginDisplayName: "Acme" }),
      expect.objectContaining({ message: "Acme: t — b", pluginDisplayName: "Acme" }),
    ]);
  });
});

describe("provenance, delivery and silence (#13818)", () => {
  afterEach(() => {
    _resetPluginFrontendRoutingForTesting();
  });

  function boundInstance(deps: PluginHostFactoryDeps): string {
    const instanceId = `project__${PROJECT_A}__acme`;
    (deps.plugins as Map<string, LoadedPlugin>).set(instanceId, deps.plugins.get(PLUGIN_ID)!);
    return instanceId;
  }

  it("names the plugin and its bound project on a toast and a notification", async () => {
    const deps = makeDeps();
    const instanceId = boundInstance(deps);
    const { host } = createHost(deps, instanceId, BOUND);
    const expected = { projectId: PROJECT_A, plugin: { id: instanceId, name: "Acme" } };

    await host.showToast({ message: "Synced" });
    expect(lastToast().context).toEqual(expected);
    await host.notify({ title: "t", body: "b" });
    expect(lastToast().context).toEqual(expected);
    expect(deps.pluginNotificationsBlocked).toHaveBeenNthCalledWith(1, instanceId, PROJECT_A);
    expect(deps.pluginNotificationsBlocked).toHaveBeenNthCalledWith(2, instanceId, PROJECT_A);
  });

  it("sends the severity as the toast type and keeps a passive one to the inbox", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.notify({ title: "t", body: "b", severity: "warning", delivery: "passive" });
    expect(lastToast()).toMatchObject({ type: "warning", priority: "low" });

    await host.notify({ title: "t", body: "b", delivery: "active" });
    expect(lastToast().type).toBe("info");
    expect(lastToast()).not.toHaveProperty("priority");

    await host.notify({
      title: "t",
      body: "b",
      severity: "error",
      actions: [{ id: "retry", label: "Retry", actionId: "acme.retry" }],
    });
    expect(lastToast().type).toBe("error");
  });

  it.each([
    ["an error with no action", { severity: "error" }, /exactly one action/],
    [
      "an error with two actions",
      {
        severity: "error",
        actions: [
          { id: "a", label: "A", actionId: "acme.a" },
          { id: "b", label: "B", actionId: "acme.b" },
        ],
      },
      /exactly one action/,
    ],
    [
      "a passive error",
      {
        severity: "error",
        delivery: "passive",
        actions: [{ id: "a", label: "A", actionId: "acme.a" }],
      },
      /can't be passive/,
    ],
    ["a passive page", { delivery: "passive", os: true }, /can't page the OS/],
    ["an unknown severity", { severity: "fatal" }, /severity/],
    ["a target naming both", { target: { panelId: "p", worktreeId: "w" } }, /target/],
  ])("rejects %s", async (_name, extra, message) => {
    const { host } = createHost(
      makeDeps(["notification:os"]),
      PLUGIN_ID,
      UNBOUND_PLUGIN_HOST_BINDING
    );

    await expect(host.notify({ title: "t", body: "b", ...extra } as never)).rejects.toThrow(
      message
    );
    expect(lastToast()).toBeUndefined();
  });

  it("points at the plugin's own panel, refuses another's, and drops one it can't check", async () => {
    const deps = makeDeps();
    const locate = deps.panelLifecycleBroker.locate as unknown as ReturnType<typeof vi.fn>;
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    locate.mockReturnValueOnce({ kind: "located", sourceId: 7 });
    await host.notify({ title: "t", body: "b", target: { panelId: "panel-1" } });
    expect(locate).toHaveBeenLastCalledWith("panel-1", PLUGIN_ID);
    expect(lastToast().context).toEqual({
      panelId: "panel-1",
      plugin: { id: PLUGIN_ID, name: "Acme" },
    });

    for (const kind of ["foreign", "non-plugin"]) {
      vi.clearAllMocks();
      locate.mockReturnValueOnce({ kind });
      await expect(
        host.notify({ title: "t", body: "b", target: { panelId: "panel-2" } })
      ).rejects.toThrow(/not one of this plugin's panels/);
      expect(lastToast()).toBeUndefined();
    }

    locate.mockReturnValueOnce({ kind: "missing" });
    await host.notify({ title: "t", body: "b", target: { panelId: "panel-3" } });
    expect(lastToast().context).toEqual({ plugin: { id: PLUGIN_ID, name: "Acme" } });
  });

  it("points an app-wide plugin at a worktree it can see, under that worktree's project", async () => {
    const deps = makeDeps();
    const fetch = deps.fetchWorktreeSnapshotsResult as unknown as ReturnType<typeof vi.fn>;
    fetch.mockResolvedValue({
      status: "ok",
      projectId: "project-b",
      snapshots: [{ id: "/repos/beta/feature" }],
    });
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.notify({ title: "t", body: "b", target: { worktreeId: "/repos/beta/feature" } });
    expect(lastToast().context).toEqual({
      projectId: "project-b",
      worktreeId: "/repos/beta/feature",
      plugin: { id: PLUGIN_ID, name: "Acme" },
    });
    // That project's mute covers it; the silence is still the plugin's own.
    expect(deps.pluginNotificationsBlocked).toHaveBeenLastCalledWith(PLUGIN_ID, "project-b");

    vi.clearAllMocks();
    await expect(
      host.notify({ title: "t", body: "b", target: { worktreeId: "/repos/beta/other" } })
    ).rejects.toThrow(/not a worktree this plugin can see/);
    expect(lastToast()).toBeUndefined();

    fetch.mockResolvedValue({ status: "unavailable", reason: "no-project" });
    await host.notify({ title: "t", body: "b", target: { worktreeId: "/repos/beta/feature" } });
    expect(lastToast().context).toEqual({ plugin: { id: PLUGIN_ID, name: "Acme" } });
    expect(deps.pluginNotificationsBlocked).toHaveBeenLastCalledWith(PLUGIN_ID, null);
  });

  it("holds back a silenced or muted plugin before its budget, so it costs nothing", async () => {
    grants.hasGrant.mockReturnValue(true);
    const deps = makeDeps(["notification:os"]);
    const blocked = deps.pluginNotificationsBlocked as unknown as ReturnType<typeof vi.fn>;
    blocked.mockResolvedValue(true);
    const request = vi.fn((_method: string, _payload: unknown) => Promise.resolve(null));
    setPluginFrontendRouter({
      resolve: () => ({
        kind: "remote",
        endpoint: { request, isClosed: () => false } as unknown as ClientEndpoint,
      }),
      onChange: () => () => {},
    });
    const { host } = createHost(deps, PLUGIN_ID, BOUND);
    const now = vi.spyOn(performance, "now").mockReturnValue(5_000_000);
    try {
      for (let n = 0; n < PLUGIN_TOAST_BURST * 2; n++) {
        await host.showToast({ message: `toast ${n}` });
        await expect(
          host.notify({ title: "t", body: `notify ${n}`, os: true, dedupeKey: "k" })
        ).resolves.toEqual({ id: expect.any(String) });
      }
      expect(lastToast()).toBeUndefined();
      expect(request).not.toHaveBeenCalled();
      expect(pager.pagePluginNotification).not.toHaveBeenCalled();
      expect(pager.retirePluginNotification).not.toHaveBeenCalled();

      blocked.mockResolvedValue(false);
      await host.notify({ title: "t", body: "heard" });
      expect(lastToast()).toMatchObject({ message: "heard" });
    } finally {
      now.mockRestore();
    }
  });

  it("tells a remote Shell the severity and that a notification is passive", async () => {
    const request = vi.fn((_method: string, _payload: unknown) => Promise.resolve(null));
    setPluginFrontendRouter({
      resolve: () => ({
        kind: "remote",
        endpoint: { request, isClosed: () => false } as unknown as ClientEndpoint,
      }),
      onChange: () => () => {},
    });
    const { host } = createHost(makeDeps(), PLUGIN_ID, BOUND);

    await host.notify({ title: "t", body: "b", severity: "warning", delivery: "passive" });
    await host.notify({ title: "t", body: "b" });

    const toasts = request.mock.calls.filter(([method]) => method === PluginFrontendMethod.TOAST);
    expect(toasts[0]![1]).toMatchObject({ type: "warning", passive: true });
    expect(toasts[1]![1]).toMatchObject({ type: "info" });
    expect(toasts[1]![1]).not.toHaveProperty("passive");
  });
});

describe("delivery order and paging (#13818)", () => {
  function toastBodies(): unknown[] {
    return [
      ...ipcUtilsMock.broadcastToRenderer.mock.calls,
      ...ipcUtilsMock.broadcastToProjectRenderers.mock.calls.map((c) => c.slice(1)),
    ]
      .filter((c) => c[0] === CHANNELS.NOTIFICATION_SHOW_TOAST)
      .map((c) => (c[1] as Record<string, unknown>).message);
  }

  it("delivers in the order the plugin raised them, whatever each waits on", async () => {
    const deps = makeDeps();
    const fetch = deps.fetchWorktreeSnapshotsResult as unknown as ReturnType<typeof vi.fn>;
    let release: (value: unknown) => void = () => {};
    fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const first = host.notify({
      title: "t",
      body: "building",
      dedupeKey: "k",
      target: { worktreeId: "/repos/beta/feature" },
    });
    const second = host.notify({ title: "t", body: "done", dedupeKey: "k" });
    const third = host.showToast({ message: "after" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toastBodies()).toEqual([]);

    release({ status: "ok", projectId: "project-b", snapshots: [{ id: "/repos/beta/feature" }] });
    await Promise.all([first, second, third]);
    expect(toastBodies()).toEqual(["building", "done", "Acme: after"]);
  });

  it("keeps delivering after a call it rejects partway through the queue", async () => {
    const deps = makeDeps();
    (deps.fetchWorktreeSnapshotsResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      projectId: "project-b",
      snapshots: [],
    });
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const refused = host.notify({ title: "t", body: "b", target: { worktreeId: "/elsewhere" } });
    const next = host.notify({ title: "t", body: "next" });
    await expect(refused).rejects.toThrow(/not a worktree this plugin can see/);
    await next;
    expect(toastBodies()).toEqual(["next"]);
  });

  it("drops a call from an instance that was replaced while it waited", async () => {
    const deps = makeDeps();
    const blocked = deps.pluginNotificationsBlocked as unknown as ReturnType<typeof vi.fn>;
    let release: (value: boolean) => void = () => {};
    blocked.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        release = resolve;
      })
    );
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    const pending = host.notify({ title: "t", body: "stale" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plugins = deps.plugins as Map<string, LoadedPlugin>;
    plugins.set(PLUGIN_ID, { ...plugins.get(PLUGIN_ID)! } as LoadedPlugin);
    release(false);
    await pending;
    expect(toastBodies()).toEqual([]);
  });

  it("pages under the project an app-wide plugin's worktree belongs to", async () => {
    grants.hasGrant.mockReturnValue(true);
    const deps = makeDeps(["notification:os"]);
    (deps.fetchWorktreeSnapshotsResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ok",
      projectId: "project-b",
      snapshots: [{ id: "/repos/beta/feature" }],
    });
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);

    await host.notify({
      title: "t",
      body: "b",
      os: true,
      target: { worktreeId: "/repos/beta/feature" },
    });
    expect(pager.pagePluginNotification).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-b" })
    );
  });
});
