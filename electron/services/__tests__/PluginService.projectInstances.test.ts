import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
}));
const ipcMainMock = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
    }),
    removeListener: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(handler);
    }),
    _emit: (channel: string, event: unknown, payload: unknown) => {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(event, payload);
    },
    _listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    _reset: () => listeners.clear(),
  };
});
const windowRefMock = vi.hoisted(() => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
}));
const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const broadcastToProjectRenderersMock = vi.hoisted(() => vi.fn());
const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
}));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: windowRefMock.getWindowRegistry,
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../ipc/utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
  broadcastToProjectRenderers: broadcastToProjectRenderersMock,
}));
vi.mock("../../store.js", () => ({
  store: storeMock,
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", async () => {
  // `toRuntimePanelKindId` is a pure id builder, and a project plugin's panels
  // are registered under the id it returns — stubbing it to undefined would
  // break the load before any of these assertions could run.
  const actual = await vi.importActual<
    typeof import("../../../shared/config/panelKindRegistry.js")
  >("../../../shared/config/panelKindRegistry.js");
  return {
    registerPanelKind: vi.fn(),
    unregisterPluginPanelKinds: vi.fn(),
    onPanelKindRegistered: vi.fn(() => () => {}),
    onPanelKindUnregistered: vi.fn(() => () => {}),
    getPluginPanelKinds: vi.fn(() => []),
    toRuntimePanelKindId: actual.toRuntimePanelKindId,
  };
});
vi.mock("../../../shared/config/toolbarButtonRegistry.js", () => ({
  registerToolbarButton: vi.fn(),
  unregisterPluginToolbarButtons: vi.fn(),
  getAllPluginToolbarButtonConfigs: vi.fn(() => []),
}));
vi.mock("../pluginMenuRegistry.js", () => ({
  registerPluginMenuItem: vi.fn(),
  unregisterPluginMenuItems: vi.fn(),
  getPluginMenuItems: vi.fn(() => []),
}));
vi.mock("../forgeProviderRegistry.js", () => ({
  registerForgeProviders: vi.fn(),
  unregisterForgeProviders: vi.fn(),
  registerForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpl: vi.fn(),
  unregisterForgeProviderImpls: vi.fn(),
  getForgeProviderImpl: vi.fn(),
  getRegisteredForgeProviders: vi.fn(() => []),
  clearForgeProviderImplRegistry: vi.fn(),
}));
// Mocked so unload-cascade tests can simulate a throwing decoration unregister
// without exercising the real (currently no-op) registry. Pre-existing tests
// transitively touched these via unloadPlugin but never asserted call counts.
vi.mock("../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));

// Mocked so MCP-server activation tests don't try to spawn real subprocesses
// or exercise the execa dynamic-import. The supervisor's wiring is verified
// here; PluginMcpSupervisor's own lifecycle is covered by its dedicated test.
const mockPluginMcpSupervisor = {
  start: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  shutdown: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  shutdownAll: vi.fn(async () => undefined) as ReturnType<typeof vi.fn>,
  callTool: vi.fn(),
  restart: vi.fn(),
  list: vi.fn(() => []),
  getStderr: vi.fn(() => ({ pluginId: "", serverId: "", lines: [], totalLines: 0 })),
};
vi.mock("../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => mockPluginMcpSupervisor,
}));

// Dev-mode hot-reload worker (#9304) is mocked so activation doesn't fork a
// real utilityProcess; tests assert routing/lifecycle via the captured spies.
const devWorkerMock = vi.hoisted(() => {
  interface DevWorkerOpts {
    pluginId: string;
    pluginDir: string;
    bundlePath: string;
    mode?: "dev" | "prod";
  }
  const instances: MockPluginDevWorkerHost[] = [];
  const bridges: MockPluginDevWorkerMainBridge[] = [];
  class MockPluginDevWorkerHost {
    opts: DevWorkerOpts;
    start = vi.fn(async () => undefined);
    dispose = vi.fn();
    isReady = (): boolean => true;
    on = vi.fn();
    off = vi.fn();
    constructor(opts: DevWorkerOpts) {
      this.opts = opts;
      instances.push(this);
    }
  }
  // The real worker forks a child that imports the plugin bundle, runs
  // `activate(host)`, and reports the outcome via `onActivationResult`. vitest
  // can't fork, so the mock bridge does that import + activate in-process
  // against the real host and drives the same callback — exercising
  // PluginService's activation/provenance wiring without a worker. (#10526)
  interface MockBridgeDeps {
    workerHost: { opts: DevWorkerOpts };
    host: unknown;
    onActivationResult?: (
      result: { ok: true } | { ok: false; error: string; stack?: string }
    ) => void;
  }
  class MockPluginDevWorkerMainBridge {
    deps: MockBridgeDeps;
    private cleanup: (() => void) | null = null;
    // Mirror the real bridge's getters; tests set these to simulate in-flight
    // main→worker invokes and worker→main host calls (e.g. an open prompt).
    pendingInvokeCount = 0;
    pendingHostCallCount = 0;
    waitForActivation = vi.fn(async () => {
      const bundlePath = this.deps.workerHost?.opts?.bundlePath;
      const onResult = this.deps.onActivationResult;
      if (!bundlePath) {
        onResult?.({ ok: true });
        return;
      }
      const { pathToFileURL } = await import("node:url");
      const { formatErrorMessage } = await import("../../../shared/utils/errorMessage.js");
      try {
        const mod = (await import(pathToFileURL(bundlePath).href)) as { activate?: unknown };
        if (typeof mod.activate === "function") {
          const result = await (mod.activate as (h: unknown) => unknown)(this.deps.host);
          if (typeof result === "function") this.cleanup = result as () => void;
        }
        onResult?.({ ok: true });
      } catch (err) {
        // Mirror the worker entry's failure shaping (formatErrorMessage + raw
        // Error stack) so provenance records match the real path.
        const error = formatErrorMessage(err, "activate() threw");
        onResult?.({
          ok: false,
          error,
          stack: err instanceof Error ? err.stack : undefined,
        });
        // …and then reject, exactly as the real bridge does: `onActivationResult`
        // carries the worker's error and stack, and `waitForActivation()`
        // separately rejects with a freshly-built main-process Error whose stack
        // points at the host. Resolving here would hide which of the two the
        // owner ends up recording.
        throw new Error(error, { cause: err });
      }
    });
    retire = vi.fn();
    dispose = vi.fn(() => {
      try {
        this.cleanup?.();
      } catch {
        // best-effort
      }
      this.cleanup = null;
    });
    constructor(deps: MockBridgeDeps) {
      this.deps = deps;
      bridges.push(this);
    }
  }
  return { instances, bridges, MockPluginDevWorkerHost, MockPluginDevWorkerMainBridge };
});
vi.mock("../plugin/PluginDevWorkerHost.js", () => ({
  PluginDevWorkerHost: devWorkerMock.MockPluginDevWorkerHost,
  CRASH_WINDOW_MS: 30 * 60 * 1000,
}));
vi.mock("../plugin/PluginDevWorkerMainBridge.js", () => ({
  PluginDevWorkerMainBridge: devWorkerMock.MockPluginDevWorkerMainBridge,
}));

import { PluginService } from "../PluginService.js";
import {
  isInstalledProjectInstanceKey,
  makeInstalledProjectInstanceKey,
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
} from "../../../shared/types/plugin.js";
import { getPluginCapabilityConsentStore } from "../plugin-capability/instances.js";

let tmpDir: string;
/** Temp roots created outside `tmpDir` (project roots), removed in `afterEach`. */
const extraTempRoots: string[] = [];
/** Services whose teardown the suite owns, so a native watcher can't outlive a test. */
const openedServices: PluginService[] = [];

function writePlugin(name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, name);
  return fs
    .mkdir(dir, { recursive: true })
    .then(() => fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest)));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
});

afterEach(async () => {
  for (const service of openedServices.splice(0)) {
    try {
      service.dispose();
    } catch {
      // A test may already have disposed it; teardown is best-effort.
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const root of extraTempRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);
const PKG = "acme.ledger";
const KEY_A = makeInstalledProjectInstanceKey(PROJECT_A, PKG);
const KEY_B = makeInstalledProjectInstanceKey(PROJECT_B, PKG);
/** What a repository-local plugin with the same manifest id in project A is keyed. */
const REPO_KEY_A = makeProjectPluginInstanceKey(PROJECT_A, PKG);

type Seam = {
  plugins: Map<string, unknown>;
  projectInstancePackages: Map<string, unknown>;
  installedInstanceKeys: Set<string>;
};

async function startService(): Promise<{ service: PluginService; seam: Seam }> {
  await writePlugin(PKG, {
    name: PKG,
    version: "1.0.0",
    instanceMode: "project",
    main: "dist/index.js",
  });
  const service = new PluginService(tmpDir);
  openedServices.push(service);
  await service.initialize();
  return { service, seam: service as unknown as Seam };
}

describe("installed package instance mode (#14103)", () => {
  it("catalogs an instanced package without registering a singleton", async () => {
    const { seam } = await startService();

    expect(seam.projectInstancePackages.has(PKG)).toBe(true);
    expect(seam.plugins.has(PKG)).toBe(false);
    expect(seam.installedInstanceKeys.size).toBe(0);
  });

  it("loads one independently keyed instance per enabled project", async () => {
    const { service, seam } = await startService();

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    expect(seam.plugins.has(KEY_A)).toBe(true);
    expect(seam.plugins.has(KEY_B)).toBe(true);
    expect(seam.plugins.has(PKG)).toBe(false);
    expect(service.getProjectInstanceProjects(PKG).sort()).toEqual([PROJECT_A, PROJECT_B]);
  });

  it("disabling or closing one project leaves the other instance loaded", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, false);
    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_B)).toBe(true);

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.onProjectClosed(PROJECT_A);
    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_B)).toBe(true);
    // A close is not a disable: the choice survives for the next open.
    expect(service.getProjectInstanceProjects(PKG)).toContain(PROJECT_A);

    await service.onProjectOpened(PROJECT_A, "/repo/a");
    expect(seam.plugins.has(KEY_A)).toBe(true);
  });

  it("resolves each instance's authority to that instance, though they share a dir (#14257)", async () => {
    const { service } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);
    const authorities = (service as unknown as { pluginAuthorities: Map<string, string> })
      .pluginAuthorities;
    const authorityA = authorities.get(KEY_A)!;
    const authorityB = authorities.get(KEY_B)!;
    const dir = service.resolvePluginAuthority(authorityA)!.dir;

    expect(service.resolvePluginAuthority(authorityA)).toEqual({ dir, pluginId: KEY_A });
    expect(service.resolvePluginAuthority(KEY_A)).toEqual({ dir, pluginId: KEY_A });
    expect(service.resolvePluginAuthority(authorityB)).toEqual({ dir, pluginId: KEY_B });
    expect(service.resolvePluginAuthority(KEY_B)).toEqual({ dir, pluginId: KEY_B });

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, false);
    expect(service.resolvePluginAuthority(authorityA)).toBeUndefined();
    expect(service.resolvePluginAuthority(authorityB)).toEqual({ dir, pluginId: KEY_B });
  });

  it("does not load a project's instance that it never enabled", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);

    await service.onProjectOpened(PROJECT_B, "/repo/b");

    expect(seam.plugins.has(KEY_B)).toBe(false);
  });

  it("a close racing an in-flight enable does not resurrect the instance", async () => {
    const { service, seam } = await startService();

    const enabling = service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    const closing = service.onProjectClosed(PROJECT_A);
    await Promise.all([enabling, closing]);

    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.installedInstanceKeys.has(KEY_A)).toBe(false);
  });

  it("refuses to enable a package that did not opt in", async () => {
    await writePlugin("acme.plain", { name: "acme.plain", version: "1.0.0" });
    const { service } = await startService();

    await expect(
      service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", "acme.plain", true)
    ).rejects.toThrow(/not an installed package/);
    await expect(
      service.setProjectInstanceEnabled("not-a-project", "/repo/a", PKG, true)
    ).rejects.toThrow(/not a project id/);
  });

  it("uninstall unloads every instance and forgets where it was enabled", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    await service.uninstallPlugin(PKG);

    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_B)).toBe(false);
    expect(seam.projectInstancePackages.has(PKG)).toBe(false);
    expect(service.getProjectInstanceProjects(PKG)).toEqual([]);
  });

  it("disabling the package unloads its instances and enabling it brings back the enabled ones", async () => {
    projectStoreMock.getProjectById.mockImplementation((id: string) => ({
      path: id === PROJECT_A ? "/repo/a" : "/repo/b",
      status: "active",
    }));
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    await service.setEnabled(PKG, false);
    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_B)).toBe(false);
    expect(service.getProjectInstanceProjects(PKG).sort()).toEqual([PROJECT_A, PROJECT_B]);

    await service.setEnabled(PKG, true);
    await vi.waitFor(() => {
      expect(seam.plugins.has(KEY_A)).toBe(true);
      expect(seam.plugins.has(KEY_B)).toBe(true);
    });
  });

  it("does not adopt an identity a repository-local plugin already holds", async () => {
    const { service, seam } = await startService();
    seam.plugins.set(REPO_KEY_A, { manifest: { name: PKG } });

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);

    expect(seam.installedInstanceKeys.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_A)).toBe(false);
  });

  it("forgets enablements on uninstall even when the package was disabled at startup", async () => {
    const { service } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setEnabled(PKG, false);

    await service.uninstallPlugin(PKG);

    expect(service.getProjectInstanceProjects(PKG)).toEqual([]);
  });

  it("a close during the repository scan stops the same open from loading instances", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.onProjectClosed(PROJECT_A);

    const opening = service.onProjectOpened(PROJECT_A, "/repo/a");
    const closing = service.onProjectClosed(PROJECT_A);
    await Promise.all([opening, closing]);

    expect(seam.plugins.has(KEY_A)).toBe(false);
  });

  it("leaves legacy singleton plugins loading under their bare id", async () => {
    await writePlugin("acme.legacy", { name: "acme.legacy", version: "1.0.0" });
    const { seam } = await startService();

    expect(seam.plugins.has("acme.legacy")).toBe(true);
    expect(seam.projectInstancePackages.has("acme.legacy")).toBe(false);
  });
});

describe("installed instance identity beside a repository plugin of the same id (#14103)", () => {
  type IdentitySeam = Seam & {
    settings: {
      settingsRoot(): string;
      resolveSettingsFilePath(id: string, scope: "user" | "local"): string | undefined;
    };
    storage: {
      storageRoot(): string;
      resolveStorageFilePath(id: string, scope: "user"): Promise<string | undefined>;
    };
    projectPluginDeps: { listGlobalPluginIds(): Set<string> };
  };

  it("never shares a key with the repository plugin, yet reads as bound to the same project", () => {
    expect(KEY_A).not.toBe(REPO_KEY_A);
    expect(parseProjectPluginInstanceKey(KEY_A)).toEqual({
      projectId: PROJECT_A,
      manifestId: PKG,
      installed: true,
    });
    expect(parseProjectPluginInstanceKey(REPO_KEY_A)).toEqual({
      projectId: PROJECT_A,
      manifestId: PKG,
      installed: false,
    });
    expect(isInstalledProjectInstanceKey(KEY_A)).toBe(true);
    expect(isInstalledProjectInstanceKey(REPO_KEY_A)).toBe(false);
  });

  it("keeps capability grants apart, and revoking the instance leaves the repository plugin's", async () => {
    const { service } = await startService();
    const consent = getPluginCapabilityConsentStore();
    const repoGrant = {
      pluginId: REPO_KEY_A,
      capability: "shell:exec" as const,
      scopeKey: PROJECT_A,
    };
    const instanceGrant = {
      pluginId: KEY_A,
      capability: "shell:exec" as const,
      scopeKey: PROJECT_A,
    };
    consent.grant(repoGrant);

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    expect(consent.hasGrant(instanceGrant)).toBe(false);

    consent.grant(instanceGrant);
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, false);

    expect(consent.hasGrant(instanceGrant)).toBe(false);
    expect(consent.hasGrant(repoGrant)).toBe(true);
    consent.revokeAllForPlugin(REPO_KEY_A);
  });

  it("resolves separate user-scope settings, local settings and storage files", async () => {
    const { seam } = await startService();
    const id = seam as unknown as IdentitySeam;

    expect(id.settings.resolveSettingsFilePath(KEY_A, "user")).not.toBe(
      id.settings.resolveSettingsFilePath(REPO_KEY_A, "user")
    );
    const localInstance = id.settings.resolveSettingsFilePath(KEY_A, "local");
    expect(localInstance).toBeDefined();
    expect(localInstance).not.toBe(id.settings.resolveSettingsFilePath(REPO_KEY_A, "local"));
    expect(await id.storage.resolveStorageFilePath(KEY_A, "user")).not.toBe(
      await id.storage.resolveStorageFilePath(REPO_KEY_A, "user")
    );
  });

  it("an uninstall that deletes settings wipes every instance's files and no repository plugin's", async () => {
    const { service, seam } = await startService();
    const id = seam as unknown as IdentitySeam;
    const files = [
      id.settings.resolveSettingsFilePath(KEY_A, "user")!,
      id.settings.resolveSettingsFilePath(KEY_B, "user")!,
      id.settings.resolveSettingsFilePath(KEY_A, "local")!,
      path.join(id.settings.settingsRoot(), "accounts", `${KEY_A}.json`),
      (await id.storage.resolveStorageFilePath(KEY_A, "user"))!,
    ];
    const kept = [
      id.settings.resolveSettingsFilePath(REPO_KEY_A, "user")!,
      id.settings.resolveSettingsFilePath(REPO_KEY_A, "local")!,
      (await id.storage.resolveStorageFilePath(REPO_KEY_A, "user"))!,
    ];
    for (const file of [...files, ...kept]) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, "{}");
    }

    try {
      await service.uninstallPlugin(PKG, true);

      for (const file of files) {
        await expect(fs.access(file)).rejects.toThrow();
      }
      for (const file of kept) {
        await expect(fs.access(file)).resolves.toBeUndefined();
      }
    } finally {
      // The settings and storage roots sit beside the plugins root, outside tmpDir.
      for (const file of [...files, ...kept]) await fs.rm(file, { force: true });
    }
  });

  it("tells the plugin manager a repository plugin's id clashes with a catalogued package", async () => {
    const { seam } = await startService();

    expect((seam as unknown as IdentitySeam).projectPluginDeps.listGlobalPluginIds().has(PKG)).toBe(
      true
    );
  });

  it("forgets a removed project's enablements and unloads its instance", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    service.forgetProjectInstances(PROJECT_A);

    expect(seam.plugins.has(KEY_A)).toBe(false);
    expect(seam.plugins.has(KEY_B)).toBe(true);
    expect(service.getProjectInstanceProjects(PKG)).toEqual([PROJECT_B]);
  });
});
