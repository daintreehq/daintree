import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const ipcUtilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
  getProjectPushTargets: vi.fn((_projectId: string | null): unknown[] => []),
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
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { PluginTaskRegistry } from "../PluginTaskRegistry.js";
import { CHANNELS } from "../../../ipc/channels.js";
import { resetPluginPushBatcherForTests } from "../pluginPushBatcher.js";
import { resetPluginToastBudget } from "../pluginToastBudget.js";
import {
  PLUGIN_TASK_MAX_LIVE,
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginHostApi,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const RETRY = { actionId: "acme.import", args: { source: "csv" } };

interface Harness {
  deps: PluginHostFactoryDeps;
  registry: PluginTaskRegistry;
  host: PluginHostApi;
}

function makeHarness(): Harness {
  const plugin = {
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities: [],
      contributes: { forgeProviders: [], fileDecorationProviders: [] },
    },
  } as unknown as LoadedPlugin;
  const registry = new PluginTaskRegistry(() => {});
  const deps = {
    plugins: new Map([[PLUGIN_ID, plugin]]),
    pluginEventCleanups: new Map(),
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginPanelMenus: new Map(),
    pluginFsWatchers: new Map(),
    pluginTasks: registry,
    broadcaster: { schedulePluginActionsBroadcast: vi.fn() },
    panelLifecycleBroker: {
      subscribe: vi.fn(() => () => {}),
      locate: vi.fn(() => ({ kind: "missing" })),
    },
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
  const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
  return { deps, registry, host };
}

function toasts(): Array<Record<string, unknown>> {
  return ipcUtilsMock.broadcastToRenderer.mock.calls
    .filter((c) => c[0] === CHANNELS.NOTIFICATION_SHOW_TOAST)
    .map((c) => c[1] as Record<string, unknown>);
}

let harness: Harness;

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginPushBatcherForTests();
  resetPluginToastBudget();
  harness = makeHarness();
});

afterEach(() => {
  harness.registry.dispose();
});

describe("host.tasks.start", () => {
  it("admits a task the views see, named for the plugin", async () => {
    const task = await harness.host.tasks.start({
      title: "Importing records",
      cancellable: true,
      retry: RETRY,
    });

    expect(task.signal.aborted).toBe(false);
    expect(harness.registry.snapshot(PLUGIN_ID)).toMatchObject([
      {
        id: task.id,
        pluginName: "Acme",
        title: "Importing records",
        cancellable: true,
        fraction: null,
        state: "working",
      },
    ]);
  });

  it.each([
    ["invalid options", { title: "", retry: RETRY }, /title must not be empty/],
    ["a foreign retry", { title: "T", retry: { actionId: "other.import" } }, /own actions/],
    ["a built-in retry", { title: "T", retry: { actionId: "terminal.focus" } }, /own actions/],
    ["a bare namespace", { title: "T", retry: { actionId: "acme." } }, /own actions/],
  ])("rejects %s and admits nothing", async (_name, options, error) => {
    await expect(harness.host.tasks.start(options as never)).rejects.toThrow(error);
    expect(harness.registry.snapshot(PLUGIN_ID)).toEqual([]);
  });

  it("rejects past the live-task cap", async () => {
    for (let i = 0; i < PLUGIN_TASK_MAX_LIVE; i++) {
      await harness.host.tasks.start({ title: `T${i}`, retry: RETRY });
    }
    await expect(harness.host.tasks.start({ title: "One more", retry: RETRY })).rejects.toThrow(
      /unfinished tasks/
    );
  });

  it("hands an unloaded plugin an inert handle and admits nothing", async () => {
    harness.deps.plugins.delete(PLUGIN_ID);
    const task = await harness.host.tasks.start({ title: "Late", retry: RETRY });

    expect(task.signal.aborted).toBe(true);
    task.report({ fraction: 0.5 });
    await task.finish({ outcome: "failed", message: "x" });
    expect(harness.registry.pluginIds()).toEqual([]);
    expect(toasts()).toEqual([]);
  });
});

describe("PluginTaskHandle", () => {
  it("throws on invalid progress and rejects an invalid result, leaving the task running", async () => {
    const task = await harness.host.tasks.start({ title: "T", retry: RETRY });

    expect(() => task.report({ fraction: 2 })).toThrow(/progress.fraction/);
    await expect(task.finish({ outcome: "failed" } as never)).rejects.toThrow(/needs a message/);
    expect(harness.registry.liveCount(PLUGIN_ID)).toBe(1);
  });

  it("raises one attributed error with Retry running the plugin's own action", async () => {
    const task = await harness.host.tasks.start({ title: "Importing records", retry: RETRY });

    await task.finish({ outcome: "failed", message: "The server didn't answer." });
    await task.finish({ outcome: "failed", message: "Again" });

    expect(toasts()).toEqual([
      expect.objectContaining({
        type: "error",
        title: "Acme: Importing records failed",
        message: "The server didn't answer.",
        pluginActions: [{ label: "Retry", actionId: "acme.import", args: { source: "csv" } }],
        replaceKey: `plugin:acme:task:${task.id}`,
        context: { plugin: { id: "acme", name: "Acme" } },
      }),
    ]);
    expect(toasts()[0]).not.toHaveProperty("priority");
    expect(harness.registry.snapshot(PLUGIN_ID)).toEqual([]);
  });

  it("files at most a passive inbox entry for a success", async () => {
    const quiet = await harness.host.tasks.start({ title: "Rebuilding index", retry: RETRY });
    await quiet.finish({ outcome: "succeeded" });
    expect(toasts()).toEqual([]);

    const told = await harness.host.tasks.start({ title: "Importing records", retry: RETRY });
    await told.finish({ outcome: "succeeded", message: "Imported 1,000 records" });
    expect(toasts()).toEqual([
      expect.objectContaining({
        type: "info",
        priority: "low",
        title: "Acme: Importing records",
        message: "Imported 1,000 records",
      }),
    ]);
  });

  it("shows nothing for a task the plugin cancelled", async () => {
    const task = await harness.host.tasks.start({ title: "T", retry: RETRY });
    await task.finish({ outcome: "cancelled" });
    expect(toasts()).toEqual([]);
  });

  it("shows nothing for a task the user cancelled, however it ended", async () => {
    const task = await harness.host.tasks.start({ title: "T", cancellable: true, retry: RETRY });
    let aborted = false;
    task.signal.addEventListener("abort", () => {
      aborted = true;
    });

    expect(harness.registry.requestCancel(PLUGIN_ID, task.id)).toBe(true);
    expect(aborted).toBe(true);
    await task.finish({ outcome: "failed", message: "Stopped halfway" });

    expect(toasts()).toEqual([]);
    expect(harness.registry.snapshot(PLUGIN_ID)).toEqual([]);
  });

  it("does nothing once the task was interrupted", async () => {
    const task = await harness.host.tasks.start({ title: "T", retry: RETRY });
    harness.registry.interrupt(PLUGIN_ID);

    expect(task.signal.aborted).toBe(true);
    task.report({ fraction: 0.5 });
    await task.finish({ outcome: "failed", message: "Gone" });

    expect(toasts()).toEqual([]);
    expect(harness.registry.snapshot(PLUGIN_ID)).toMatchObject([
      { id: task.id, state: "interrupted", fraction: null },
    ]);
  });
});
