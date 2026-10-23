import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
  clearWorktreeDeleteNotesBindings,
  getWorktreeDeleteNotesBinding,
} from "../worktreeDeleteNotesRegistry.js";
import {
  UNBOUND_PLUGIN_HOST_BINDING,
  type PluginWorktreeSnapshot,
  type WorktreeDeleteNotesProviderImpl,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";

function makeDeps(declared: string[] = ["notes"]) {
  const plugins = new Map<string, LoadedPlugin>([
    [
      PLUGIN_ID,
      {
        isBuiltin: true,
        manifest: {
          name: PLUGIN_ID,
          displayName: "Acme",
          capabilities: [],
          contributes: {
            forgeProviders: [],
            fileDecorationProviders: [],
            panels: [],
            worktreeDeleteNotes: declared.map((id) => ({ id })),
          },
        },
      } as unknown as LoadedPlugin,
    ],
  ]);
  const pluginEventCleanups = new Map<string, Array<() => void>>();
  const deps = {
    plugins,
    pluginEventCleanups,
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
  return { deps, pluginEventCleanups };
}

const WORKTREE = { id: "/repo/wt" } as PluginWorktreeSnapshot;
const impl = (): WorktreeDeleteNotesProviderImpl => ({ provideNotes: vi.fn(async () => []) });

afterEach(() => {
  clearWorktreeDeleteNotesBindings();
});

describe("host.registerWorktreeDeleteNotesProvider (#13805)", () => {
  it("binds the declared check, which the host then calls with the worktree alone", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const provider = impl();
    await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, provider);

    const binding = getWorktreeDeleteNotesBinding(PLUGIN_ID);
    expect(binding?.contributionId).toBe("notes");
    const signal = new AbortController().signal;
    await binding!.provideNotes(WORKTREE, signal);
    expect(provider.provideNotes).toHaveBeenCalledWith(WORKTREE, signal);
  });

  it("refuses a check the manifest doesn't declare, and a malformed impl", async () => {
    const { deps } = makeDeps();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    expect(() => host.registerWorktreeDeleteNotesProvider({ id: "other" }, impl())).toThrow(
      /not declared in contributes.worktreeDeleteNotes/
    );
    expect(() =>
      host.registerWorktreeDeleteNotesProvider(
        { id: "notes" },
        {} as unknown as WorktreeDeleteNotesProviderImpl
      )
    ).toThrow(/impl must expose provideNotes/);
    expect(getWorktreeDeleteNotesBinding(PLUGIN_ID)).toBeUndefined();
  });

  it("refuses to bind once the host is revoked", () => {
    const { deps } = makeDeps();
    const { host, revoke } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    revoke();
    expect(() => host.registerWorktreeDeleteNotesProvider({ id: "notes" }, impl())).toThrow(
      /host revoked/
    );
  });

  it("doesn't count as a subscription holding the worker, and a replaced binding's disposer is inert", async () => {
    const { deps, pluginEventCleanups } = makeDeps();
    const { host } = createHost(deps, PLUGIN_ID, UNBOUND_PLUGIN_HOST_BINDING);
    const disposeFirst = await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, impl());
    const disposeSecond = await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, impl());
    expect(pluginEventCleanups.get(PLUGIN_ID) ?? []).toHaveLength(0);

    const current = getWorktreeDeleteNotesBinding(PLUGIN_ID);
    disposeFirst();
    expect(getWorktreeDeleteNotesBinding(PLUGIN_ID)).toBe(current);
    disposeSecond();
    expect(getWorktreeDeleteNotesBinding(PLUGIN_ID)).toBeUndefined();
  });
});
