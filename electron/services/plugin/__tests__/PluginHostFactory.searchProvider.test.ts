import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import type { RegisteredSearchProvider } from "../pluginSearchProviderRegistry.js";

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
import { UNBOUND_PLUGIN_HOST_BINDING } from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";
import {
  clearSearchProviderRegistry,
  getSearchProviderImpl,
  registerSearchProviders,
} from "../pluginSearchProviderRegistry.js";

const PLUGIN_ID = "acme";

function makeDeps(capabilities: string[] = []): PluginHostFactoryDeps {
  const plugin = {
    isBuiltin: true,
    manifest: {
      name: PLUGIN_ID,
      displayName: "Acme",
      capabilities,
      contributes: {
        forgeProviders: [],
        fileDecorationProviders: [],
        searchProviders: [
          { id: "people", kind: "runtime", title: "People", keyword: "people" },
          {
            id: "notes",
            kind: "declarative",
            title: "Notes",
            keyword: "notes",
            query: "find_notes",
            target: { panel: "notes" },
          },
        ],
      },
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

function registered(providerId: string, kind: "runtime" | "declarative"): RegisteredSearchProvider {
  return {
    key: `${PLUGIN_ID}.${providerId}`,
    pluginId: PLUGIN_ID,
    providerId,
    pluginName: "Acme",
    title: providerId,
    keyword: providerId,
    iconId: "search",
    blend: false,
    kind,
    projectId: null,
    resolveTarget: () => null,
    resolveResultIcon: () => undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSearchProviderRegistry();
  registerSearchProviders(PLUGIN_ID, [
    registered("people", "runtime"),
    registered("notes", "declarative"),
  ]);
});

afterEach(() => {
  clearSearchProviderRegistry();
});

describe("host.registerSearchProvider", () => {
  it("binds a declared runtime provider until its disposer runs", async () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const provider = vi.fn(() => []);
    const dispose = await host.registerSearchProvider("people", provider);
    expect(getSearchProviderImpl("acme.people")).toBe(provider);
    dispose();
    expect(getSearchProviderImpl("acme.people")).toBeUndefined();
  });

  it.each([
    ["an undeclared id", "missing"],
    ["a declarative provider's id", "notes"],
  ])("refuses %s", (_label, id) => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    expect(() => host.registerSearchProvider(id, () => [])).toThrow(
      /not a kind: "runtime" entry of contributes.searchProviders/
    );
  });

  it("refuses a provider that isn't a function", () => {
    const { host } = createHost(makeDeps(), PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    expect(() => host.registerSearchProvider("people", {} as never)).toThrow(/must be a function/);
  });
});
