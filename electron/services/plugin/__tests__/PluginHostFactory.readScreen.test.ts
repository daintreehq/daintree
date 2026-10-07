import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";

const consentMock = vi.hoisted(() => ({
  ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
const ptyMock = vi.hoisted(() => ({
  client: null as null | {
    getTerminalProjectId: (id: string) => string | null;
    getTerminalAsync: (id: string) => Promise<unknown>;
    getSerializedStateAsync: (id: string, options?: unknown) => Promise<unknown>;
  },
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => ptyMock.client) }));
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
  getPluginCapabilityConsentService: vi.fn(() => consentMock),
}));
vi.mock("../../forge/forgeCredentialUtils.js", () => ({
  buildStoredCredentials: vi.fn(() => null),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import type { PluginHostBinding } from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PLUGIN_ID = "acme";
const PROJECT_A = "project-a";
const BOUND: PluginHostBinding = {
  projectId: PROJECT_A,
  projectRoot: path.join(path.sep, "repos", "alpha"),
};

function makeHarness(capabilities: string[] = ["terminal:read"], isBuiltin = false) {
  const plugin = {
    isBuiltin,
    binding: BOUND,
    manifest: { name: PLUGIN_ID, displayName: "Acme Grid", capabilities },
  } as unknown as LoadedPlugin;
  const plugins = new Map<string, LoadedPlugin>([[PLUGIN_ID, plugin]]);
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
    dispatcher: { sendAgentsListToRenderer: vi.fn() },
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
    pluginDisplayName: () => "Acme Grid",
    pluginDataDir: () => path.join(path.sep, "tmp", "data"),
    isPathUnder: () => false,
    expandAllowedPathEntries: async () => [],
    subscribeWorktreeEvent: vi.fn(() => () => {}),
    registerHandler: vi.fn(),
    validateAndBuildActionDescriptor: vi.fn(),
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "",
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, plugin };
}

function installPty(projectId = PROJECT_A, data = "\x1b[1mWaiting\x1b[0m for input") {
  const client = {
    getTerminalProjectId: vi.fn((_id: string) => projectId),
    getTerminalAsync: vi.fn(async (id: string) => ({ id, projectId, kind: "terminal" })),
    getSerializedStateAsync: vi.fn(async (_id: string, _options?: unknown) => ({
      data,
      cols: 80,
      rows: 24,
    })),
  };
  ptyMock.client = client;
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  ptyMock.client = null;
  consentMock.ensureAllowed.mockImplementation(async () => undefined);
});

describe("host.terminals.readScreen", () => {
  it("reads the bound project's terminal as plain text after first-use consent", async () => {
    const pty = installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.terminals.readScreen("t-1")).resolves.toEqual({
      status: "ok",
      text: "Waiting for input",
      lineCount: 1,
      truncated: false,
    });
    expect(consentMock.ensureAllowed).toHaveBeenCalledWith(
      PLUGIN_ID,
      "Acme Grid",
      "terminal:read",
      ["terminal:read"],
      PROJECT_A
    );
    expect(pty.getSerializedStateAsync).toHaveBeenCalledWith("t-1", { tailRows: 0 });
  });

  it("is not granted by agent:read", async () => {
    installPty();
    const h = makeHarness(["agent:read"]);
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.terminals.readScreen("t-1")).rejects.toThrow(
      /PERMISSION_REQUIRED: .*"terminal:read"/
    );
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
  });

  it("rejects bad arguments before prompting for consent", async () => {
    const pty = installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.terminals.readScreen("")).rejects.toThrow(/terminalId/);
    await expect(host.terminals.readScreen("t-1", { lines: 0 })).rejects.toThrow(/lines/);
    await expect(host.terminals.readScreen("t-1", { lines: 101 })).rejects.toThrow(/lines/);
    await expect(host.terminals.readScreen("t-1", { lines: 2.5 })).rejects.toThrow(/lines/);
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
    expect(pty.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("surfaces a consent denial and reads nothing", async () => {
    const pty = installPty();
    consentMock.ensureAllowed.mockRejectedValue(new Error("PERMISSION_REQUIRED: denied"));
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.terminals.readScreen("t-1")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(pty.getTerminalAsync).not.toHaveBeenCalled();
  });

  it("answers another project's terminal as not-found", async () => {
    installPty("project-b");
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);

    await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "not-found" });
  });

  it("fails fast with RATE_LIMITED past 60 calls in a second", async () => {
    installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      for (let i = 0; i < 60; i++) {
        await expect(host.terminals.readScreen("t-1")).resolves.toMatchObject({ status: "ok" });
      }
      const err = await host.terminals.readScreen("t-1").catch((e: unknown) => e);
      expect(String(err)).toMatch(/^Error: RATE_LIMITED:/);
      expect((err as { code?: string }).code).toBe("RATE_LIMITED");
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("shares the rate window across hosts of the same loaded plugin", async () => {
    installPty();
    const h = makeHarness();
    const first = createHost(h.deps, PLUGIN_ID, BOUND).host;
    const second = createHost(h.deps, PLUGIN_ID, BOUND).host;
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    try {
      for (let i = 0; i < 60; i++) await first.terminals.readScreen("t-1");
      await expect(second.terminals.readScreen("t-1")).rejects.toThrow(/RATE_LIMITED/);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("resolves unavailable once the plugin is unloaded, without a capability error", async () => {
    installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    h.plugins.delete(PLUGIN_ID);

    await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "unavailable" });
  });

  it("drops the answer when the plugin unloads during the consent prompt", async () => {
    const pty = installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    consentMock.ensureAllowed.mockImplementation(async () => {
      h.plugins.delete(PLUGIN_ID);
    });

    await expect(host.terminals.readScreen("t-1")).resolves.toEqual({ status: "unavailable" });
    expect(pty.getTerminalAsync).not.toHaveBeenCalled();
  });
});

describe("host.terminals.readScreen null lines", () => {
  it("rejects lines: null like any other non-integer", async () => {
    installPty();
    const h = makeHarness();
    const { host } = createHost(h.deps, PLUGIN_ID, BOUND);
    await expect(
      host.terminals.readScreen("t-1", { lines: null as unknown as number })
    ).rejects.toThrow(/lines/);
  });
});
