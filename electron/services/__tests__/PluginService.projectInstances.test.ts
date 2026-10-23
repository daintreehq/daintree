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
  getCurrentProject: vi.fn((): { id?: string; path: string } | null => null),
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

// A reversible stand-in for Electron `safeStorage`, so a secret setting can be
// written and its envelope found on disk.
const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptStringAsync: async (plaintext: string) => Buffer.from(`enc:${plaintext}`, "utf-8"),
  decryptStringAsync: async (cipher: Buffer) => ({
    result: cipher.toString("utf-8").slice("enc:".length),
    shouldReEncrypt: false,
  }),
}));
// Holds a settings or storage write inside its drive-lease check — after the
// host has resolved the file, before the store writes it — so a test can move
// focus or forget a project while the write is in flight.
const driveLeaseGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));
vi.mock("../plugin/pluginDriveLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin/pluginDriveLease.js")>();
  return {
    ...actual,
    assertPluginCallerDrives: async (
      ...args: Parameters<typeof actual.assertPluginCallerDrives>
    ) => {
      const hold = driveLeaseGate.hold;
      if (hold) {
        driveLeaseGate.entered?.();
        await hold;
      }
      return actual.assertPluginCallerDrives(...args);
    },
  };
});
// The project views the contribution broadcaster fans out to. Empty by default,
// which is what the real registry reports with no window open.
const projectViewsMock = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { id: number; isDestroyed(): boolean }; projectId: string }>,
}));
vi.mock("../../window/webContentsRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../window/webContentsRegistry.js")>();
  return {
    ...actual,
    getRegisteredProjectViews: () => projectViewsMock.views,
    getAllAppWebContents: () => [],
  };
});
// Holds what the loader registers, so a broadcast snapshot carries the real
// configs `loadPlugin` built rather than an empty list.
const toolbarRegistryMock = vi.hoisted(() => ({
  buttons: [] as Array<{ id: string; pluginId: string }>,
}));

vi.mock("electron", () => ({
  app: appMock,
  ipcMain: ipcMainMock,
  safeStorage: safeStorageMock,
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
  registerToolbarButton: vi.fn((config: { id: string; pluginId: string }) => {
    toolbarRegistryMock.buttons.push(config);
  }),
  unregisterPluginToolbarButtons: vi.fn((pluginId: string) => {
    toolbarRegistryMock.buttons = toolbarRegistryMock.buttons.filter(
      (b) => b.pluginId !== pluginId
    );
  }),
  getAllPluginToolbarButtonConfigs: vi.fn(() => [...toolbarRegistryMock.buttons]),
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
import { packPluginArchive } from "../PluginArchive.js";
import {
  isInstalledProjectInstanceKey,
  makeInstalledProjectInstanceKey,
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
} from "../../../shared/types/plugin.js";
import { getPluginCapabilityConsentStore } from "../plugin-capability/instances.js";
import { _resetSecretStorageSessionForTests } from "../plugin/secretCipher.js";

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
  projectStoreMock.getCurrentProject.mockImplementation(() => null);
  projectStoreMock.getProjectById.mockImplementation(() => null);
  storeMock._state.clear();
  driveLeaseGate.hold = null;
  driveLeaseGate.entered = null;
  projectViewsMock.views = [];
  toolbarRegistryMock.buttons = [];
  _resetSecretStorageSessionForTests();
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

describe("updates that change the instance mode (#14256)", () => {
  async function packArchive(manifest: Record<string, unknown>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-archive-"));
    extraTempRoots.push(root);
    const src = path.join(root, "src");
    await fs.mkdir(path.join(src, "dist"), { recursive: true });
    await fs.writeFile(path.join(src, "plugin.json"), JSON.stringify(manifest));
    await fs.writeFile(path.join(src, "dist", "index.js"), "module.exports = {};");
    const out = path.join(root, "plugin.dntr");
    await packPluginArchive(src, out);
    return out;
  }

  async function installedVersionOnDisk(pluginId: string): Promise<string> {
    const raw = await fs.readFile(path.join(tmpDir, pluginId, "plugin.json"), "utf-8");
    return (JSON.parse(raw) as { version: string }).version;
  }

  const instanceGrant = {
    pluginId: KEY_A,
    capability: "shell:exec" as const,
    scopeKey: PROJECT_A,
  };

  beforeEach(() => {
    projectStoreMock.getProjectById.mockImplementation((id: string) => ({
      path: id === PROJECT_A ? "/repo/a" : "/repo/b",
      status: "active",
    }));
  });

  afterEach(() => {
    const consent = getPluginCapabilityConsentStore();
    for (const id of [KEY_A, KEY_B, "acme.flip"]) consent.revokeAllForPlugin(id);
  });

  it("refuses a singleton update that would make the package run per project", async () => {
    await writePlugin("acme.flip", { name: "acme.flip", version: "1.0.0" });
    const { service, seam } = await startService();
    const loaded = seam.plugins.get("acme.flip");
    const consent = getPluginCapabilityConsentStore();
    const grant = { pluginId: "acme.flip", capability: "shell:exec" as const, scopeKey: "*" };
    consent.grant(grant);

    const result = await service.installPlugin(
      await packArchive({
        name: "acme.flip",
        version: "2.0.0",
        instanceMode: "project",
        main: "dist/index.js",
      })
    );

    expect(result.status === "failed" && result.errors[0]).toMatchObject({
      code: "instance_mode_changed",
      message: expect.stringMatching(/Uninstall it first/),
    });
    expect(seam.plugins.get("acme.flip")).toBe(loaded);
    expect(seam.projectInstancePackages.has("acme.flip")).toBe(false);
    expect(consent.hasGrant(grant)).toBe(true);
    expect(await installedVersionOnDisk("acme.flip")).toBe("1.0.0");
  });

  it("refuses a per-project update that would make the package a singleton", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    const consent = getPluginCapabilityConsentStore();
    consent.grant(instanceGrant);
    const instance = seam.plugins.get(KEY_A);
    const catalogued = seam.projectInstancePackages.get(PKG);

    const result = await service.installPlugin(
      await packArchive({ name: PKG, version: "2.0.0", main: "dist/index.js" })
    );

    expect(result.status === "failed" && result.errors[0]).toMatchObject({
      code: "instance_mode_changed",
      message: expect.stringMatching(/Uninstall it first/),
    });
    expect(seam.plugins.get(KEY_A)).toBe(instance);
    expect(seam.plugins.has(PKG)).toBe(false);
    expect(seam.projectInstancePackages.get(PKG)).toBe(catalogued);
    expect(consent.hasGrant(instanceGrant)).toBe(true);
    expect(service.getProjectInstanceProjects(PKG)).toEqual([PROJECT_A]);
    expect(await installedVersionOnDisk(PKG)).toBe("1.0.0");
  });

  it("refuses the mode change for a disabled package too", async () => {
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setEnabled(PKG, false);

    const result = await service.installPlugin(
      await packArchive({ name: PKG, version: "2.0.0", main: "dist/index.js" })
    );

    expect(result.status === "failed" && result.errors[0]?.code).toBe("instance_mode_changed");
    expect(seam.plugins.has(PKG)).toBe(false);
    expect(service.getProjectInstanceProjects(PKG)).toEqual([PROJECT_A]);
    expect(await installedVersionOnDisk(PKG)).toBe("1.0.0");
  });

  it("a same-mode update purges instance grants and reloads enabled open projects", async () => {
    projectStoreMock.getProjectById.mockImplementation((id: string) => ({
      path: id === PROJECT_A ? "/repo/a" : "/repo/b",
      status: id === PROJECT_A ? "active" : "closed",
    }));
    const { service, seam } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);
    await service.onProjectClosed(PROJECT_B);
    const consent = getPluginCapabilityConsentStore();
    consent.grant(instanceGrant);
    const closedGrant = { ...instanceGrant, pluginId: KEY_B, scopeKey: PROJECT_B };
    consent.grant(closedGrant);

    const result = await service.installPlugin(
      await packArchive({
        name: PKG,
        version: "2.0.0",
        instanceMode: "project",
        main: "dist/index.js",
      })
    );

    expect(result).toEqual({ status: "installed", pluginId: PKG });
    expect(consent.hasGrant(instanceGrant)).toBe(false);
    expect(consent.hasGrant(closedGrant)).toBe(false);
    await vi.waitFor(() => {
      const instance = seam.plugins.get(KEY_A) as { manifest: { version: string } } | undefined;
      expect(instance?.manifest.version).toBe("2.0.0");
    });
    expect(seam.plugins.has(KEY_B)).toBe(false);
    expect(seam.plugins.has(PKG)).toBe(false);
    expect(service.getProjectInstanceProjects(PKG).sort()).toEqual([PROJECT_A, PROJECT_B]);
  });

  it.each([
    { label: "is unreadable", contents: "not json" },
    { label: "says singleton", contents: JSON.stringify({ name: PKG, version: "1.0.0" }) },
    {
      label: "is another plugin's",
      contents: JSON.stringify({ name: "acme.other", version: "1.0.0" }),
    },
  ])("refuses by what the service runs when the folder's manifest $label", async ({ contents }) => {
    const { service, seam } = await startService();
    await fs.writeFile(path.join(tmpDir, PKG, "plugin.json"), contents);

    const result = await service.installPlugin(
      await packArchive({ name: PKG, version: "2.0.0", main: "dist/index.js" })
    );

    expect(result.status === "failed" && result.errors[0]?.code).toBe("instance_mode_changed");
    expect(seam.projectInstancePackages.has(PKG)).toBe(true);
    expect(await fs.readFile(path.join(tmpDir, PKG, "plugin.json"), "utf-8")).toBe(contents);
  });
});

describe("plugin list projection of installed per-project packages (#14255)", () => {
  const packageRows = (service: PluginService) =>
    service.listPlugins().filter((info) => info.instanceId === PKG);

  it("lists a catalog-only package once, never as running, with the projects it is enabled in", async () => {
    const { service } = await startService();
    expect(packageRows(service)).toEqual([
      expect.objectContaining({
        origin: "global",
        loadedAt: 0,
        disabled: false,
        pendingRestart: false,
        instanceMode: "project",
        enabledInProjects: [],
      }),
    ]);

    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, "/repo/b", PKG, true);

    const rows = packageRows(service);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabledInProjects?.sort()).toEqual([PROJECT_A, PROJECT_B]);
    // Each instance is its own project row, not a second copy of the package.
    const instanceRows = service.listPlugins().filter((info) => info.manifest.name === PKG);
    expect(instanceRows.map((info) => info.instanceId).sort()).toEqual([PKG, KEY_A, KEY_B].sort());
    expect(instanceRows.filter((info) => info.instanceMode === "project")).toHaveLength(1);
  });

  it("keeps the package listed after it is disabled and enabled again", async () => {
    const { service } = await startService();
    await service.setProjectInstanceEnabled(PROJECT_A, "/repo/a", PKG, true);

    await service.setEnabled(PKG, false);
    expect(packageRows(service)).toEqual([
      expect.objectContaining({
        disabled: true,
        instanceMode: "project",
        enabledInProjects: [PROJECT_A],
      }),
    ]);

    await service.setEnabled(PKG, true);
    expect(packageRows(service)).toEqual([
      expect.objectContaining({
        disabled: false,
        pendingRestart: false,
        instanceMode: "project",
        enabledInProjects: [PROJECT_A],
      }),
    ]);
  });

  it("tells an instanced package apart from a singleton, a switched-off one and an unknown id", async () => {
    await writePlugin("acme.plain", { name: "acme.plain", version: "1.0.0" });
    const { service } = await startService();

    expect(service.getInstalledPackageMode(PKG)).toBe("project");
    expect(service.getInstalledPackageMode("acme.plain")).toBe("singleton");
    expect(service.getInstalledPackageMode("acme.ghost")).toBeNull();

    await service.setEnabled(PKG, false);
    expect(service.getInstalledPackageMode(PKG)).toBe("project-unavailable");
  });

  it("leaves a singleton plugin's row without per-project fields", async () => {
    await writePlugin("acme.plain", { name: "acme.plain", version: "1.0.0" });
    const { service } = await startService();
    const row = service.listPlugins().find((info) => info.instanceId === "acme.plain");
    expect(row).toBeDefined();
    expect(row?.instanceMode).toBeUndefined();
    expect(row?.enabledInProjects).toBeUndefined();
  });
});

describe("an instance stays bound to its own project while another is focused (#14258)", () => {
  let rootA: string;
  let rootB: string;
  let heldWrite: { pending: Promise<void>; release: () => void } | null = null;

  beforeEach(() => {
    rootA = path.join(tmpDir, "repo-a");
    rootB = path.join(tmpDir, "repo-b");
  });

  afterEach(async () => {
    // A test that failed between holding a write and releasing it must not
    // leave the write parked behind the gate, or still running into teardown.
    if (heldWrite) {
      heldWrite.release();
      await heldWrite.pending.catch(() => {});
      heldWrite = null;
    }
  });

  const rootOf = (projectId: string): string => (projectId === PROJECT_A ? rootA : rootB);
  const keyOf = (projectId: string): string => (projectId === PROJECT_A ? KEY_A : KEY_B);

  function focus(projectId: string): void {
    projectStoreMock.getCurrentProject.mockReturnValue({ id: projectId, path: rootOf(projectId) });
  }

  async function startBound(
    contributes: Record<string, unknown> = {}
  ): Promise<{ service: PluginService; seam: Seam }> {
    const pluginsRoot = path.join(tmpDir, "plugins");
    const dir = path.join(pluginsRoot, PKG);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: PKG,
        version: "1.0.0",
        instanceMode: "project",
        main: "dist/index.js",
        contributes: {
          settings: [
            { id: "projectNote", type: "string", scope: "project" },
            { id: "localNote", type: "string", scope: "local" },
            { id: "projectToken", type: "secret", scope: "project" },
          ],
          ...contributes,
        },
      })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "module.exports = {};");
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      id === PROJECT_A || id === PROJECT_B ? { path: rootOf(id), status: "active" } : null
    );
    // Plugins root inside tmpDir, so the settings and storage roots beside it
    // are this test's own and go with it.
    const service = new PluginService(pluginsRoot);
    openedServices.push(service);
    await service.initialize();
    await service.setProjectInstanceEnabled(PROJECT_A, rootA, PKG, true);
    await service.setProjectInstanceEnabled(PROJECT_B, rootB, PKG, true);
    const seam = service as unknown as Seam;
    expect(seam.plugins.has(KEY_A)).toBe(true);
    expect(seam.plugins.has(KEY_B)).toBe(true);
    return { service, seam };
  }

  /**
   * Starts `write` and parks it at its drive-lease check, after its file is
   * resolved and before the store writes it. Resolves once it is parked.
   */
  async function startHeldWrite(
    write: () => Promise<void>
  ): Promise<{ pending: Promise<void>; release: () => void }> {
    let open!: () => void;
    driveLeaseGate.hold = new Promise<void>((resolve) => (open = resolve));
    let parked = false;
    const entered = new Promise<void>((resolve) => {
      driveLeaseGate.entered = () => {
        parked = true;
        resolve();
      };
    });
    const release = (): void => {
      driveLeaseGate.hold = null;
      driveLeaseGate.entered = null;
      open();
    };
    const pending = write();
    heldWrite = { pending, release };
    // A write that fails, or finishes without reaching the gate, fails here
    // rather than as a timeout.
    await Promise.race([entered, pending]);
    if (!parked) throw new Error("the write finished without reaching the drive-lease check");
    return { pending, release };
  }

  async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
    try {
      return JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  type Host = ReturnType<PluginService["_createHostForTests"]>;
  interface BoundWrite {
    label: string;
    key: string;
    write(host: Host, value: string): Promise<void>;
    /** The file a write by `projectId`'s instance belongs in. */
    fileFor(projectId: string): string;
  }

  const localFile = (projectId: string, key: string): string =>
    path.join(tmpDir, "plugin-settings", "local", projectId, `${key}.json`);

  const WRITES: BoundWrite[] = [
    {
      label: "project settings",
      key: "projectNote",
      write: (host, value) => host.settings.set("projectNote", value, "project"),
      fileFor: (id) => path.join(rootOf(id), ".daintree", "plugin-settings", `${PKG}.json`),
    },
    {
      label: "local settings",
      key: "localNote",
      write: (host, value) => host.settings.set("localNote", value, "local"),
      fileFor: (id) => localFile(id, keyOf(id)),
    },
    {
      label: "project-scoped secret settings",
      key: "projectToken",
      write: (host, value) => host.settings.set("projectToken", value, "project"),
      // A project secret is kept in this machine's local file, never the repository's.
      fileFor: (id) => localFile(id, keyOf(id)),
    },
    {
      label: "project storage",
      key: "cursor",
      write: (host, value) => host.storage.set("cursor", value, "project"),
      fileFor: (id) => path.join(rootOf(id), ".daintree", "plugin-storage", `${PKG}.json`),
    },
    {
      label: "user storage",
      key: "cursor",
      write: (host, value) => host.storage.set("cursor", value, "user"),
      fileFor: (id) => path.join(tmpDir, "plugin-storage", `${keyOf(id)}.json`),
    },
  ];

  /** `value` landed in A's file for `w`, and nothing of A's reached B's. */
  async function expectWrittenToA(w: BoundWrite, value: string): Promise<void> {
    const stored = (await readJson(w.fileFor(PROJECT_A)))?.[w.key];
    if (w.key === "projectToken") {
      expect(stored).toMatchObject({ __daintreeSecret: "daintree:secret:v1" });
      expect(JSON.stringify(stored)).not.toContain(value);
      for (const id of [PROJECT_A, PROJECT_B]) {
        const repoFile = path.join(rootOf(id), ".daintree", "plugin-settings", `${PKG}.json`);
        expect((await readJson(repoFile))?.projectToken).toBeUndefined();
      }
    } else {
      expect(stored).toBe(value);
    }
    expect((await readJson(w.fileFor(PROJECT_B)))?.[w.key]).toBeUndefined();
    // Nor A's own file filed under B's project.
    expect(await readJson(localFile(PROJECT_B, KEY_A))).toBeUndefined();
  }

  it.each(WRITES)("lands A's $label write in A's file while B is focused", async (w) => {
    const { service } = await startBound();
    const host = service._createHostForTests(KEY_A);
    focus(PROJECT_B);

    await w.write(host, "from-a");

    await expectWrittenToA(w, "from-a");
  });

  it.each(WRITES)(
    "finishes A's $label write started with A focused in A after focus moves to B",
    async (w) => {
      const { service } = await startBound();
      const host = service._createHostForTests(KEY_A);
      focus(PROJECT_A);

      const gate = await startHeldWrite(() => w.write(host, "started-in-a"));
      focus(PROJECT_B);
      gate.release();
      await gate.pending;
      await expectWrittenToA(w, "started-in-a");

      // The same host, called again now B is focused, still writes A's file.
      await w.write(host, "after-switch");
      await expectWrittenToA(w, "after-switch");
    }
  );

  it.each(WRITES)(
    "forgetting B in the middle of A's $label write leaves A's instance and write alone",
    async (w) => {
      const { service, seam } = await startBound();
      const host = service._createHostForTests(KEY_A);
      focus(PROJECT_B);
      const instanceA = seam.plugins.get(KEY_A);

      const gate = await startHeldWrite(() => w.write(host, "held"));
      service.forgetProjectInstances(PROJECT_B);

      expect(seam.plugins.has(KEY_B)).toBe(false);
      expect(seam.plugins.get(KEY_A)).toBe(instanceA);
      expect(seam.installedInstanceKeys.has(KEY_A)).toBe(true);
      expect(service.getProjectInstanceProjects(PKG)).toEqual([PROJECT_A]);

      gate.release();
      await gate.pending;
      await expectWrittenToA(w, "held");

      await w.write(host, "after-forget");
      await expectWrittenToA(w, "after-forget");
    }
  );

  it("sends each instance's toolbar button only to its own project's views", async () => {
    projectViewsMock.views = [
      { webContents: { id: 1, isDestroyed: () => false }, projectId: PROJECT_A },
      { webContents: { id: 2, isDestroyed: () => false }, projectId: PROJECT_B },
    ];
    // B is focused while both instances load and publish.
    focus(PROJECT_B);
    await startBound({
      toolbarButtons: [{ id: "open", label: "Ledger", iconId: "list", actionId: `${PKG}.open` }],
    });

    const owners = (projectId: string): string[][] =>
      broadcastToProjectRenderersMock.mock.calls
        .filter(
          ([target, , event]) =>
            target === projectId &&
            (event as { name: string }).name === "plugin:toolbar-buttons-changed"
        )
        .map(([, , event]) =>
          (event as { payload: { buttons: Array<{ pluginId: string }> } }).payload.buttons.map(
            (b) => b.pluginId
          )
        );

    await vi.waitFor(() => {
      expect(owners(PROJECT_A).at(-1)).toEqual([KEY_A]);
      expect(owners(PROJECT_B).at(-1)).toEqual([KEY_B]);
    });
    expect(owners(PROJECT_A).flat()).not.toContain(KEY_B);
    expect(owners(PROJECT_B).flat()).not.toContain(KEY_A);
    const unscoped = broadcastToRendererMock.mock.calls
      .filter(
        ([, event]) => (event as { name?: string })?.name === "plugin:toolbar-buttons-changed"
      )
      .flatMap(([, event]) =>
        (event as { payload: { buttons: Array<{ pluginId: string }> } }).payload.buttons.map(
          (b) => b.pluginId
        )
      );
    expect(unscoped).not.toContain(KEY_A);
    expect(unscoped).not.toContain(KEY_B);
  });
});
