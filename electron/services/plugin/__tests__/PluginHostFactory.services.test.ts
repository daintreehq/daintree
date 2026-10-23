import { describe, expect, it, vi } from "vitest";
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
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed: vi.fn(async () => undefined) })),
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../viewless/index.js", () => ({ runViewlessAction: vi.fn(async () => null) }));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { PluginServiceBroker } from "../PluginServiceBroker.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  makeProjectPluginInstanceKey,
} from "../../../../shared/types/plugin.js";
import type { PluginServicesContribution } from "../../../../shared/types/pluginServices.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const ISSUES = "acme.jira.issues";
const PROJECT = "c".repeat(64);

function loaded(name: string, services: Partial<PluginServicesContribution>): LoadedPlugin {
  return {
    isBuiltin: true,
    manifest: {
      name,
      capabilities: [],
      contributes: { panels: [], services: { provides: [], requires: [], ...services } },
    },
  } as unknown as LoadedPlugin;
}

function setup() {
  const plugins = new Map<string, LoadedPlugin>([
    [
      "acme.jira",
      loaded("acme.jira", {
        provides: [{ name: ISSUES, version: "1.0.0", methods: ["lookup", "count"] }],
      }),
    ],
    ["acme.app", loaded("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] })],
  ]);
  const broker = new PluginServiceBroker({
    getPlugin: (id) => plugins.get(id),
    isVisibleInProject: () => true,
    isActivated: (id) => plugins.has(id),
    activatePlugin: async () => {},
    reportUnresolvedRequired: () => {},
  });
  const pluginEventCleanups = new Map<string, Array<() => void>>();
  const deps = {
    plugins,
    pluginEventCleanups,
    services: broker,
    pluginActions: new Map(),
    pluginActionHandlers: new Map(),
    pluginActionOwners: new Map(),
    actionValidators: new Map(),
    pluginBadges: new Map(),
    pluginToolbarBadges: new Map(),
    emitToolbarBadges: () => {},
    pluginPanelActivity: new Map(),
    emitPanelActivity: () => {},
    nextPanelActivityRevision: () => 0,
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
    panelLifecycleBroker: { subscribe: vi.fn(() => () => {}) },
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
  const hostFor = (id: string, binding = UNBOUND_PLUGIN_HOST_BINDING) =>
    createHost(deps, id, binding);
  return { plugins, pluginEventCleanups, hostFor };
}

describe("host.registerService and host.services (#14105)", () => {
  it("binds a declared service that another plugin's host can call", async () => {
    const t = setup();
    const provider = t.hostFor("acme.jira").host;
    const consumer = t.hostFor("acme.app").host;
    const handlers = {
      lookup(this: unknown, args: unknown) {
        return { self: this === handlers, args };
      },
      count: () => 3,
    };
    await provider.registerService(ISSUES, handlers);

    await expect(consumer.services.call(ISSUES, "lookup", { key: "A-1" })).resolves.toEqual({
      ok: true,
      value: { self: true, args: { key: "A-1" } },
    });
    await expect(consumer.services.status(ISSUES)).resolves.toMatchObject({
      available: true,
      running: true,
    });
  });

  it("names the caller from its own binding, never from anything it passes", async () => {
    const t = setup();
    const consumerId = makeProjectPluginInstanceKey(PROJECT, "acme.app");
    t.plugins.set(consumerId, t.plugins.get("acme.app")!);
    const provider = t.hostFor("acme.jira").host;
    const consumer = t.hostFor(consumerId, { projectId: PROJECT, projectRoot: "/p" }).host;
    await provider.registerService(ISSUES, {
      lookup: (_args: unknown, ctx: { caller: unknown }) => ctx.caller,
      count: () => 0,
    });
    await expect(
      consumer.services.call(ISSUES, "lookup", { caller: { pluginId: "acme.jira" } })
    ).resolves.toEqual({ ok: true, value: { pluginId: "acme.app", projectId: PROJECT } });
  });

  it("refuses an undeclared service and handlers that don't match the declared methods", async () => {
    const t = setup();
    const provider = t.hostFor("acme.jira").host;
    await expect(provider.registerService("acme.jira.other", { lookup: () => 1 })).rejects.toThrow(
      "not declared in contributes.services.provides"
    );
    await expect(provider.registerService(ISSUES, { lookup: () => 1 })).rejects.toThrow(
      'declared method "count" has no function'
    );
    await expect(
      provider.registerService(ISSUES, { lookup: () => 1, count: () => 1, extra: () => 1 })
    ).rejects.toThrow('"extra" is not one of the declared methods');
  });

  it("refuses to bind once activation is over", async () => {
    const t = setup();
    const { host, revoke } = t.hostFor("acme.jira");
    revoke();
    await expect(host.registerService(ISSUES, { lookup: () => 1, count: () => 1 })).rejects.toThrow(
      "host revoked"
    );
  });

  it("unbinds through its disposer and on unload's cleanup flush", async () => {
    const t = setup();
    const provider = t.hostFor("acme.jira").host;
    const consumer = t.hostFor("acme.app").host;
    const handlers = { lookup: () => 1, count: () => 1 };

    const dispose = await provider.registerService(ISSUES, handlers);
    dispose();
    await expect(consumer.services.status(ISSUES)).resolves.toMatchObject({ running: false });

    await provider.registerService(ISSUES, handlers);
    for (const cleanup of [...(t.pluginEventCleanups.get("acme.jira") ?? [])]) cleanup();
    await expect(consumer.services.status(ISSUES)).resolves.toMatchObject({ running: false });
  });

  it("answers unavailable from a host whose instance has been unloaded or replaced", async () => {
    const t = setup();
    const consumer = t.hostFor("acme.app").host;
    t.plugins.set(
      "acme.app",
      loaded("acme.app", { requires: [{ name: ISSUES, range: "^1.0.0" }] })
    );
    await expect(consumer.services.call(ISSUES, "lookup", {})).resolves.toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    await expect(consumer.services.status(ISSUES)).resolves.toMatchObject({
      available: false,
      reason: "unavailable",
    });
  });
});
