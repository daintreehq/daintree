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
import {
  clearPluginCloudProviders,
  listPluginCloudProviders,
  pluginCloudProviderBinding,
  publishPluginCloudProviders,
} from "../pluginCloudProviders.js";
import type { CloudProviderImpl } from "../../../../shared/types/pluginCloudProvider.js";

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

describe("host.registerCloudProvider (#17351)", () => {
  const capabilities = {
    persistence: {
      kept: "Its disk",
      lost: "Memory",
      retentionDays: null,
      saveRetryBilled: false,
      stoppedComputeBilled: false,
    },
    typicalStartSeconds: null,
    lifetime: { kind: "none" as const },
    sshTrust: "confirm-on-first-connect" as const,
    transport: "direct" as const,
    tunnel: null,
    provisioning: {
      location: "none" as const,
      image: "none" as const,
      network: "none" as const,
      sshKey: "at-create" as const,
    },
    deletion: true,
  };
  const providerImpl = (): CloudProviderImpl => {
    const answer = vi.fn(async () => {
      throw new Error("unused");
    });
    return {
      checkCredentials: answer,
      validate: answer,
      catalog: answer,
      list: answer,
      inspect: answer,
      create: answer,
      start: answer,
      stop: answer,
      rename: answer,
      delete: answer,
      sshAccess: answer,
    };
  };

  afterEach(() => clearPluginCloudProviders());

  function declare() {
    publishPluginCloudProviders("acme.clouds", [
      {
        id: "ec2",
        name: "EC2",
        description: "Machines",
        apiUrl: "https://ec2.example.com",
        apiKeyUrl: "https://example.com/keys",
        dashboardUrl: "https://example.com",
        docsUrl: "https://example.com/docs",
        credentialFields: [
          {
            id: "token",
            label: "Token",
            secret: true,
            input: "single-line",
            required: true,
            help: null,
          },
        ],
        capabilities,
      },
    ]);
  }

  it("binds a declared provider, and names the plugin when it refuses one", async () => {
    declare();
    const { deps } = makeDeps();
    const { host } = createHost(deps, "acme.clouds", UNBOUND_PLUGIN_HOST_BINDING);
    expect(() => host.registerCloudProvider({ id: "gce" }, providerImpl())).toThrow(
      /Plugin "acme\.clouds" registerCloudProvider: "gce" is not declared/
    );
    const { sshAccess: _missing, ...partial } = providerImpl();
    expect(() => host.registerCloudProvider({ id: "ec2" }, partial as CloudProviderImpl)).toThrow(
      /has no sshAccess/
    );
    const dispose = await host.registerCloudProvider({ id: "ec2" }, providerImpl());
    expect(pluginCloudProviderBinding(listPluginCloudProviders()[0]!)).toBeDefined();
    dispose();
    expect(pluginCloudProviderBinding(listPluginCloudProviders()[0]!)).toBeUndefined();
  });

  it("refuses a project's plugin, and a host past activation", () => {
    declare();
    const { deps } = makeDeps();
    const project = createHost(deps, "acme.clouds", { projectId: "p1", projectRoot: "/repo" });
    expect(() => project.host.registerCloudProvider({ id: "ec2" }, providerImpl())).toThrow(
      /project plugin can't contribute cloud providers/
    );
    const { host, revoke } = createHost(deps, "acme.clouds", UNBOUND_PLUGIN_HOST_BINDING);
    revoke();
    expect(() => host.registerCloudProvider({ id: "ec2" }, providerImpl())).toThrow(/host revoked/);
    expect(pluginCloudProviderBinding(listPluginCloudProviders()[0]!)).toBeUndefined();
  });
});
