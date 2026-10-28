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
// Defaults: no remote-bound views and no project views. A test that needs
// either overrides the implementation and restores it.
const ipcViewMocks = vi.hoisted(() => ({
  isWithheldFromView: vi.fn((_id: number, _channel: string, _args: unknown[]) => false),
  getProjectRendererTargets: vi.fn((_projectId: string): Array<{ id: number }> => []),
  broadcastToProjectRenderers: vi.fn(),
}));
const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { id?: string; path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));
// A reversible stand-in for Electron `safeStorage`, off by default: most of this
// suite never touches a secret, and a host with no keychain is the fail-safe.
const safeStorageMock = vi.hoisted(() => {
  const state = { available: false };
  return {
    state,
    isEncryptionAvailable: () => state.available,
    // Linux gates the keychain tier on the backend; name a real keychain one.
    getSelectedStorageBackend: () => (state.available ? "gnome_libsecret" : "basic_text"),
    encryptStringAsync: async (plaintext: string) => {
      if (!state.available) throw new Error("Error while encrypting");
      return Buffer.from(`enc:${plaintext}`, "utf-8");
    },
    decryptStringAsync: async (cipher: Buffer) => ({
      result: cipher.toString("utf-8").slice("enc:".length),
      shouldReEncrypt: false,
    }),
  };
});
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});

// Holds a settings write inside its drive-lease check, so a test can unload or
// replace the plugin while the write is awaiting authorization.
const driveLeaseGate = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: vi.fn(),
}));
vi.mock("../plugin/pluginDriveLease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugin/pluginDriveLease.js")>();
  return {
    ...actual,
    assertPluginCallerDrives: async (
      ...args: Parameters<typeof actual.assertPluginCallerDrives>
    ) => {
      driveLeaseGate.entered();
      if (driveLeaseGate.hold) await driveLeaseGate.hold;
      return actual.assertPluginCallerDrives(...args);
    },
  };
});

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
  // No remote-bound views here unless a test says so: every local push reaches its view.
  isWithheldFromView: (id: number, channel: string, args: unknown[]) =>
    ipcViewMocks.isWithheldFromView(id, channel, args),
  // A project plugin's settings writes are announced to its own project only.
  broadcastToProjectRenderers: (projectId: string, channel: string, ...args: unknown[]) =>
    ipcViewMocks.broadcastToProjectRenderers(projectId, channel, ...args),
  // No project views unless a test says so: a project plugin's replay has nowhere to go.
  getProjectRendererTargets: (projectId: string) =>
    ipcViewMocks.getProjectRendererTargets(projectId),
  getProjectPushTargets: () => [],
  endpointPushTarget: (endpoint: {
    handle: number;
    isClosed: () => boolean;
    send: (frame: unknown) => void;
  }) => ({
    id: endpoint.handle,
    isDestroyed: () => endpoint.isClosed(),
    send: (channel: string, ...args: unknown[]) => endpoint.send({ type: "event", channel, args }),
  }),
}));
vi.mock("../../store.js", () => ({
  store: storeMock,
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));
vi.mock("../../../shared/config/panelKindRegistry.js", () => ({
  registerPanelKind: vi.fn(),
  unregisterPluginPanelKinds: vi.fn(),
  onPanelKindRegistered: vi.fn(() => () => {}),
  onPanelKindUnregistered: vi.fn(() => () => {}),
  getPluginPanelKinds: vi.fn(() => []),
}));
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
  // A settings write from the manager restarts the plugin's MCP servers that read it.
  notifySettingChanged: vi.fn(),
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
        onResult?.({
          ok: false,
          error: formatErrorMessage(err, "activate() threw"),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    });
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
import { _resetSecretStorageSessionForTests } from "../plugin/secretCipher.js";
import type { PluginManifest, SettingDefinition } from "../../../shared/types/plugin.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
  safeStorageMock.state.available = false;
  driveLeaseGate.hold = null;
  // The real cipher remembers a keychain that gave no key for the process;
  // each test here is a fresh run.
  _resetSecretStorageSessionForTests();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type SettingsScope = "user" | "project" | "local";
type SettingsHostShape = (
  pluginId: string,
  binding?: { projectId: string | null; projectRoot: string | null }
) => {
  host: {
    settings: {
      get: <T = unknown>(key: string, scope?: SettingsScope) => Promise<T | undefined>;
      set: <T = unknown>(key: string, value: T, scope?: SettingsScope) => Promise<void>;
      unset: (key: string, scope?: SettingsScope) => Promise<void>;
      missingRequired: () => Promise<string[]>;
      onDidChange: <T = unknown>(
        key: string,
        cb: (value: T | undefined) => void,
        scope?: SettingsScope
      ) => () => void;
    };
  };
  revoke: () => void;
};

/** The private settings manager, for the paths the host doesn't yet exercise. */
type ServiceWithSettingsManager = {
  settings: {
    resolveSettingsFilePath: (
      pluginId: string,
      scope: SettingsScope,
      projectRoot?: string | null
    ) => string | undefined;
    getOrCreateSettingsStore: (
      pluginId: string,
      filePath: string
    ) => {
      get: <T = unknown>(key: string) => Promise<T | undefined>;
      set: (key: string, value: unknown) => Promise<boolean>;
    };
  };
};

async function setupSettingsService(
  pluginId: string,
  settings?: Array<{
    id: string;
    type?: string;
    scope?: SettingsScope;
    default?: unknown;
    required?: boolean;
  }>
): Promise<{ service: PluginService; settingsRoot: string }> {
  const pluginsRoot = path.join(tmpDir, "plugins");
  const dir = path.join(pluginsRoot, pluginId);
  await fs.mkdir(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name: pluginId, version: "1.0.0" };
  if (settings) manifest.contributes = { settings };
  await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  const service = new PluginService(pluginsRoot);
  await service.initialize();
  // User-scope settings live as a sibling of the plugins dir.
  return { service, settingsRoot: path.join(tmpDir, "plugin-settings") };
}

function createSettingsHost(
  service: PluginService,
  pluginId: string,
  binding?: { projectId: string | null; projectRoot: string | null }
) {
  return (service as unknown as { createHost: SettingsHostShape }).createHost(pluginId, binding);
}

describe("createHost — settings", () => {
  beforeEach(() => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
  });

  it("round-trips a value in user scope and persists it as JSON", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-rt");
    const { host } = createSettingsHost(service, "acme.settings-rt");
    await host.settings.set("token", "sk-test");
    expect(await host.settings.get<string>("token")).toBe("sk-test");
    const raw = await fs.readFile(path.join(settingsRoot, "acme.settings-rt.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ token: "sk-test" });
  });

  const chmodIt = process.platform === "win32" ? it.skip : it;
  chmodIt("writes the user-scope file with mode 0o600", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-mode");
    const { host } = createSettingsHost(service, "acme.settings-mode");
    await host.settings.set("token", "secret");
    const stat = await fs.stat(path.join(settingsRoot, "acme.settings-mode.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("project scope get returns undefined when no project is active", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    const { service } = await setupSettingsService("acme.settings-noproj");
    const { host } = createSettingsHost(service, "acme.settings-noproj");
    expect(await host.settings.get("token", "project")).toBeUndefined();
  });

  it("project scope set throws when no project is active", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    const { service } = await setupSettingsService("acme.settings-noproj2");
    const { host } = createSettingsHost(service, "acme.settings-noproj2");
    await expect(host.settings.set("token", "x", "project")).rejects.toThrow(/no active project/);
  });

  it("project scope writes under the active project root", async () => {
    const projectDir = path.join(tmpDir, "proj");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-proj");
    const { host } = createSettingsHost(service, "acme.settings-proj");
    await host.settings.set("token", "in-project", "project");
    expect(await host.settings.get<string>("token", "project")).toBe("in-project");
    const raw = await fs.readFile(
      path.join(projectDir, ".daintree", "plugin-settings", "acme.settings-proj.json"),
      "utf-8"
    );
    expect(JSON.parse(raw)).toEqual({ token: "in-project" });
  });

  // With no keychain the secret is refused, and nothing of it may reach the
  // repository either way.
  it("refuses a project-scoped secret without a keychain and writes nothing under the project root (#12613)", async () => {
    const projectDir = path.join(tmpDir, "proj-secret");
    projectStoreMock.getCurrentProject.mockReturnValue({ id: "a".repeat(64), path: projectDir });
    const { service, settingsRoot } = await setupSettingsService("acme.settings-secret", [
      { id: "token", type: "secret", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-secret");
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb, "project");

    // Linux has no keyring backend here; macOS reads an encrypt with no key as
    // a Keychain unavailable this session. Either way the secret isn't saved.
    await expect(host.settings.set("token", "sk-host", "project")).rejects.toThrow(
      /so the secret "token" wasn't saved/
    );

    await expect(fs.access(path.join(projectDir, ".daintree"))).rejects.toThrow();
    await expect(fs.access(path.join(settingsRoot, "local"))).rejects.toThrow();
    expect(await host.settings.get("token")).toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps a project-scoped secret in this machine's local file and reads it back (#12613)", async () => {
    safeStorageMock.state.available = true;
    const projectId = "a".repeat(64);
    const projectDir = path.join(tmpDir, "proj-secret-ok");
    projectStoreMock.getCurrentProject.mockReturnValue({ id: projectId, path: projectDir });
    const pluginId = "acme.settings-secret-ok";
    const { service, settingsRoot } = await setupSettingsService(pluginId, [
      { id: "token", type: "secret", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, pluginId);
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb, "project");

    await host.settings.set("token", "sk-host", "project");

    expect(cb).toHaveBeenCalledWith("sk-host");
    // An omitted scope reads the declared one, from the same file the write used.
    expect(await host.settings.get<string>("token")).toBe("sk-host");
    const local = JSON.parse(
      await fs.readFile(path.join(settingsRoot, "local", projectId, `${pluginId}.json`), "utf-8")
    ) as Record<string, unknown>;
    expect(local.token).toMatchObject({ __daintreeSecret: "daintree:secret:v1" });
    await expect(fs.access(path.join(projectDir, ".daintree"))).rejects.toThrow();
  });

  it("pins a bound project plugin's secret to its own project while another is active (#12613)", async () => {
    safeStorageMock.state.available = true;
    const ownId = "a".repeat(64);
    const activeId = "b".repeat(64);
    const ownRoot = path.join(tmpDir, "own");
    const activeRoot = path.join(tmpDir, "active");
    projectStoreMock.getCurrentProject.mockReturnValue({ id: activeId, path: activeRoot });
    const manifestId = "acme.settings-secret-bound";
    const { service, settingsRoot } = await setupSettingsService(manifestId, [
      { id: "token", type: "secret", scope: "project" },
    ]);
    // Register the loaded plugin under a project instance key, the shape the
    // real loader gives a project-owned plugin.
    const instanceKey = `project__${ownId}__${manifestId}`;
    const seam = service as unknown as {
      plugins: Map<string, unknown>;
      _registerFakePluginForTests: (plugin: unknown, instanceKey?: string) => void;
    };
    seam._registerFakePluginForTests(seam.plugins.get(manifestId), instanceKey);
    const { host } = createSettingsHost(service, instanceKey, {
      projectId: ownId,
      projectRoot: ownRoot,
    });

    await host.settings.set("token", "sk-own", "project");

    expect(await host.settings.get<string>("token")).toBe("sk-own");
    await expect(
      fs.access(path.join(settingsRoot, "local", ownId, `${instanceKey}.json`))
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(settingsRoot, "local", activeId))).rejects.toThrow();
    await expect(fs.access(path.join(ownRoot, ".daintree"))).rejects.toThrow();
    await expect(fs.access(path.join(activeRoot, ".daintree"))).rejects.toThrow();
  });

  // The host supplies no project root, so it stays on the ambient path: an
  // unbound (installed/builtin) plugin has no project of its own to pin.
  it("resolves the active project at call time when no project root is supplied", async () => {
    const projA = path.join(tmpDir, "projA");
    const projB = path.join(tmpDir, "projB");
    const { service } = await setupSettingsService("acme.settings-switch");
    const { host } = createSettingsHost(service, "acme.settings-switch");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projA });
    await host.settings.set("k", "a-value", "project");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projB });
    expect(await host.settings.get("k", "project")).toBeUndefined();
    await host.settings.set("k", "b-value", "project");
    expect(await host.settings.get<string>("k", "project")).toBe("b-value");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: projA });
    expect(await host.settings.get<string>("k", "project")).toBe("a-value");
  });

  it("an explicit project root wins over the active project and survives a switch", async () => {
    const pluginId = "acme.settings-bound";
    const bound = path.join(tmpDir, "bound");
    const { service } = await setupSettingsService(pluginId);
    const { settings } = service as unknown as ServiceWithSettingsManager;
    const boundFile = path.join(bound, ".daintree", "plugin-settings", `${pluginId}.json`);

    projectStoreMock.getCurrentProject.mockReturnValue({ path: path.join(tmpDir, "projA") });
    expect(settings.resolveSettingsFilePath(pluginId, "project", bound)).toBe(boundFile);
    await settings.getOrCreateSettingsStore(pluginId, boundFile).set("k", "bound-value");

    projectStoreMock.getCurrentProject.mockReturnValue({ path: path.join(tmpDir, "projB") });
    expect(settings.resolveSettingsFilePath(pluginId, "project", bound)).toBe(boundFile);
    expect(await settings.getOrCreateSettingsStore(pluginId, boundFile).get<string>("k")).toBe(
      "bound-value"
    );
    // Only the bound read is pinned — the unbound one still follows the switch.
    expect(settings.resolveSettingsFilePath(pluginId, "project")).toBe(
      path.join(tmpDir, "projB", ".daintree", "plugin-settings", `${pluginId}.json`)
    );
  });

  it("a supplied-but-empty project root has no target rather than falling back", async () => {
    const pluginId = "acme.settings-empty-root";
    const { service } = await setupSettingsService(pluginId);
    const { settings } = service as unknown as ServiceWithSettingsManager;

    projectStoreMock.getCurrentProject.mockReturnValue({ path: path.join(tmpDir, "projA") });
    expect(settings.resolveSettingsFilePath(pluginId, "project", "")).toBeUndefined();
  });

  it("set rejects undefined and non-serializable values", async () => {
    const { service } = await setupSettingsService("acme.settings-bad");
    const { host } = createSettingsHost(service, "acme.settings-bad");
    await expect(host.settings.set("k", undefined as unknown as string)).rejects.toThrow(
      /undefined/
    );
    await expect(host.settings.set("k", (() => {}) as unknown as string)).rejects.toThrow(
      /not JSON-serializable/
    );
  });

  it("set rejects an empty key", async () => {
    const { service } = await setupSettingsService("acme.settings-emptykey");
    const { host } = createSettingsHost(service, "acme.settings-emptykey");
    await expect(host.settings.set("", "x")).rejects.toThrow(/non-empty string/);
  });

  it("onDidChange fires with the new value after a changing set", async () => {
    const { service } = await setupSettingsService("acme.settings-watch");
    const { host } = createSettingsHost(service, "acme.settings-watch");
    const cb = vi.fn();
    await host.settings.onDidChange<string>("token", cb);
    await host.settings.set("token", "v1");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("v1");
  });

  it("onDidChange delivers a non-finite number as the null a read returns", async () => {
    const { service } = await setupSettingsService("acme.settings-nonfinite");
    const { host } = createSettingsHost(service, "acme.settings-nonfinite");
    const cb = vi.fn();
    await host.settings.onDidChange("count", cb);
    await host.settings.set("count", Infinity);
    expect(cb).toHaveBeenCalledWith(null);
    expect(await host.settings.get("count")).toBeNull();
  });

  it("onDidChange delivers a secret's non-string value as passed", async () => {
    safeStorageMock.state.available = true;
    const pluginId = "acme.settings-secret-raw";
    const { service } = await setupSettingsService(pluginId, [{ id: "token", type: "secret" }]);
    const { host } = createSettingsHost(service, pluginId);
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb);
    await host.settings.set("token", NaN);
    expect(cb).toHaveBeenCalledWith(NaN);
    expect(await host.settings.get("token")).toBe("null");
  });

  it("onDidChange does not fire for a no-op write", async () => {
    const { service } = await setupSettingsService("acme.settings-noop");
    const { host } = createSettingsHost(service, "acme.settings-noop");
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb);
    await host.settings.set("token", "same");
    await host.settings.set("token", "same");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDidChange only fires for its subscribed scope", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: path.join(tmpDir, "proj-scope") });
    const { service } = await setupSettingsService("acme.settings-scope");
    const { host } = createSettingsHost(service, "acme.settings-scope");
    const userCb = vi.fn();
    await host.settings.onDidChange("token", userCb, "user");
    await host.settings.set("token", "proj-value", "project");
    expect(userCb).not.toHaveBeenCalled();
  });

  it("onDidChange disposer stops further callbacks", async () => {
    const { service } = await setupSettingsService("acme.settings-dispose");
    const { host } = createSettingsHost(service, "acme.settings-dispose");
    const cb = vi.fn();
    const dispose = await host.settings.onDidChange("token", cb);
    dispose();
    await host.settings.set("token", "v1");
    expect(cb).not.toHaveBeenCalled();
  });

  it("unloadPlugin disposes settings subscriptions", async () => {
    const { service } = await setupSettingsService("acme.settings-unload");
    const { host } = createSettingsHost(service, "acme.settings-unload");
    const cb = vi.fn();
    await host.settings.onDidChange("token", cb);
    service.unloadPlugin("acme.settings-unload");
    await host.settings.set("token", "after-unload");
    expect(cb).not.toHaveBeenCalled();
  });

  it("revoked host rejects settings.onDidChange but still allows get/set", async () => {
    const { service } = await setupSettingsService("acme.settings-revoke");
    const { host, revoke } = createSettingsHost(service, "acme.settings-revoke");
    revoke();
    expect(() => host.settings.onDidChange("token", () => {})).toThrow(/host revoked/);
    await expect(host.settings.set("token", "still-works")).resolves.toBeUndefined();
    expect(await host.settings.get<string>("token")).toBe("still-works");
  });

  // #14092: a write classifies its key from the instance that declared it, so
  // an unload — before the write or while it awaits authorization — can't
  // downgrade a secret to plaintext or move it under the project root, and a
  // write from a replaced instance never commits.
  describe("writes stay bound to the declaring instance (#14092)", () => {
    const projectId = "c".repeat(64);
    type Timing = "before the write" | "while awaiting authorization";
    const timings: Timing[] = ["before the write", "while awaiting authorization"];

    /** Run `write` with `retire` landing at `timing`. */
    async function writeAround(
      timing: Timing,
      write: () => Promise<void>,
      retire: () => void
    ): Promise<void> {
      driveLeaseGate.entered.mockClear();
      if (timing === "before the write") {
        retire();
        return write();
      }
      let release!: () => void;
      driveLeaseGate.hold = new Promise<void>((resolve) => (release = resolve));
      const pending = write();
      expect(driveLeaseGate.entered).toHaveBeenCalled();
      retire();
      release();
      return pending;
    }

    function replacePlugin(
      service: PluginService,
      pluginId: string,
      settings: SettingDefinition[] | undefined
    ): void {
      const seam = service as unknown as {
        plugins: Map<string, { manifest: PluginManifest }>;
        _registerFakePluginForTests: (plugin: unknown) => void;
      };
      const current = seam.plugins.get(pluginId)!;
      seam._registerFakePluginForTests({
        ...current,
        manifest: {
          ...current.manifest,
          contributes: { ...current.manifest.contributes, settings: settings ?? [] },
        },
      });
    }

    const secretScopes: Array<{
      scope: "user" | "project" | "local";
      file: (settingsRoot: string, pluginId: string) => string;
    }> = [
      { scope: "user", file: (root, id) => path.join(root, `${id}.json`) },
      { scope: "project", file: (root, id) => path.join(root, "local", projectId, `${id}.json`) },
      { scope: "local", file: (root, id) => path.join(root, "local", projectId, `${id}.json`) },
    ];

    describe.each(timings)("unloaded %s", (timing) => {
      it.each(secretScopes)(
        "keeps a $scope-scoped secret encrypted in its own file",
        async ({ scope, file }) => {
          safeStorageMock.state.available = true;
          const projectDir = path.join(tmpDir, `proj-${scope}`);
          projectStoreMock.getCurrentProject.mockReturnValue({ id: projectId, path: projectDir });
          const pluginId = `acme.bound-secret-${scope}`;
          const { service, settingsRoot } = await setupSettingsService(pluginId, [
            { id: "token", type: "secret", scope },
          ]);
          const { host } = createSettingsHost(service, pluginId);

          await writeAround(
            timing,
            () => host.settings.set("token", "synthetic-secret-value", scope),
            () => service.unloadPlugin(pluginId)
          );

          const raw = await fs.readFile(file(settingsRoot, pluginId), "utf-8");
          expect(raw).not.toContain("synthetic-secret-value");
          expect((JSON.parse(raw) as Record<string, unknown>).token).toMatchObject({
            __daintreeSecret: "daintree:secret:v1",
          });
          await expect(fs.access(path.join(projectDir, ".daintree"))).rejects.toThrow();
        }
      );

      // Cleanup-time writes of ordinary settings (a deactivate() saving state)
      // keep landing, in the scope the instance declared.
      it("still persists an ordinary declared setting in its declared scope", async () => {
        const projectDir = path.join(tmpDir, "proj-ordinary");
        projectStoreMock.getCurrentProject.mockReturnValue({ id: projectId, path: projectDir });
        const pluginId = "acme.bound-ordinary";
        const { service } = await setupSettingsService(pluginId, [
          { id: "channel", type: "string", scope: "project" },
        ]);
        const { host } = createSettingsHost(service, pluginId);

        await writeAround(
          timing,
          () => host.settings.set("channel", "after-unload"),
          () => service.unloadPlugin(pluginId)
        );

        const file = path.join(projectDir, ".daintree", "plugin-settings", `${pluginId}.json`);
        expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({ channel: "after-unload" });
      });

      it.each(secretScopes)(
        "still clears a $scope-scoped secret from its own file",
        async ({ scope, file }) => {
          safeStorageMock.state.available = true;
          const projectDir = path.join(tmpDir, `proj-unset-${scope}`);
          projectStoreMock.getCurrentProject.mockReturnValue({ id: projectId, path: projectDir });
          const pluginId = `acme.bound-unset-${scope}`;
          const { service, settingsRoot } = await setupSettingsService(pluginId, [
            { id: "token", type: "secret", scope },
            { id: "keep", type: "string", scope },
          ]);
          const { host } = createSettingsHost(service, pluginId);
          await host.settings.set("token", "synthetic-secret-value");
          await host.settings.set("keep", "kept");

          await writeAround(
            timing,
            () => host.settings.unset("token"),
            () => service.unloadPlugin(pluginId)
          );

          const secretFile = JSON.parse(
            await fs.readFile(file(settingsRoot, pluginId), "utf-8")
          ) as Record<string, unknown>;
          expect(secretFile).not.toHaveProperty("token");
        }
      );
    });

    describe.each(timings)("replaced %s", (timing) => {
      it.each([
        {
          change: "a secret the new instance no longer declares",
          before: [{ id: "token", type: "secret" }],
          after: undefined,
        },
        {
          change: "an ordinary key the new instance declares secret",
          before: [{ id: "token", type: "string" }],
          after: [{ id: "token", type: "secret" }] as SettingDefinition[],
        },
      ])("rejects a write of $change and stores nothing", async ({ before, after }) => {
        safeStorageMock.state.available = true;
        const pluginId = "acme.bound-replaced";
        const { service, settingsRoot } = await setupSettingsService(pluginId, before);
        const { host } = createSettingsHost(service, pluginId);

        await expect(
          writeAround(
            timing,
            () => host.settings.set("token", "synthetic-secret-value"),
            () => replacePlugin(service, pluginId, after)
          )
        ).rejects.toThrow(/^PLUGIN_UNLOADED: .*was replaced/);

        if (timing === "before the write") expect(driveLeaseGate.entered).not.toHaveBeenCalled();
        await expect(fs.access(path.join(settingsRoot, `${pluginId}.json`))).rejects.toThrow();
      });

      it("rejects an unset from the replaced instance", async () => {
        const pluginId = "acme.bound-replaced-unset";
        const declared: SettingDefinition[] = [{ id: "channel", type: "string" }];
        const { service, settingsRoot } = await setupSettingsService(pluginId, declared);
        const { host } = createSettingsHost(service, pluginId);
        await host.settings.set("channel", "stored");

        await expect(
          writeAround(
            timing,
            () => host.settings.unset("channel"),
            () => replacePlugin(service, pluginId, declared)
          )
        ).rejects.toThrow(/^PLUGIN_UNLOADED: .*was replaced/);

        const file = path.join(settingsRoot, `${pluginId}.json`);
        expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({ channel: "stored" });
      });
    });

    // The successor unloading doesn't hand authority back to the instance it
    // replaced: that instance declared the key ordinary, so its write would
    // overwrite the successor's encrypted value with plaintext.
    // A successor that never made a host (a lazy plugin whose secret was saved
    // from the settings form) retires its predecessor just the same.
    it.each(["made a host", "never made a host"])(
      "keeps a replaced instance retired after a successor that %s unloads",
      async (successorShape) => {
        safeStorageMock.state.available = true;
        const pluginId = `acme.bound-successor-${successorShape === "made a host" ? "hosted" : "hostless"}`;
        const { service, settingsRoot } = await setupSettingsService(pluginId, [
          { id: "token", type: "string" },
        ]);
        const { host: retired } = createSettingsHost(service, pluginId);
        replacePlugin(service, pluginId, [{ id: "token", type: "secret" }]);
        if (successorShape === "made a host") {
          const { host: successor } = createSettingsHost(service, pluginId);
          await successor.settings.set("token", "synthetic-secret-value");
        } else {
          const settings = (service as unknown as ServiceWithSettingsManager).settings;
          const file = settings.resolveSettingsFilePath(pluginId, "user")!;
          const store = settings.getOrCreateSettingsStore(pluginId, file) as unknown as {
            set: (key: string, value: unknown, opts: { secret: boolean }) => Promise<boolean>;
          };
          await store.set("token", "synthetic-secret-value", { secret: true });
        }
        service.unloadPlugin(pluginId);

        await expect(retired.settings.set("token", "synthetic-plain-value")).rejects.toThrow(
          /^PLUGIN_UNLOADED: .*was replaced/
        );
        await expect(retired.settings.unset("token")).rejects.toThrow(
          /^PLUGIN_UNLOADED: .*was replaced/
        );

        const raw = await fs.readFile(path.join(settingsRoot, `${pluginId}.json`), "utf-8");
        expect(raw).not.toContain("synthetic-plain-value");
        expect((JSON.parse(raw) as Record<string, unknown>).token).toMatchObject({
          __daintreeSecret: "daintree:secret:v1",
        });
      }
    );
  });

  // #10586: get must honor a key's manifest-declared scope rather than silently
  // defaulting to "user", mirroring the set/onDidChange scope guards.
  it("get resolves a project-scoped declared key from the project store with no scope arg", async () => {
    const projectDir = path.join(tmpDir, "proj-declared");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-declared-proj", [
      { id: "ref", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-proj");
    // Written to project scope; a no-scope read must resolve there, not "user".
    await host.settings.set("ref", "branch-x", "project");
    expect(await host.settings.get<string>("ref")).toBe("branch-x");
    // The value lives in the project file — proving the read didn't fall back to
    // the (empty) user store.
    const raw = await fs.readFile(
      path.join(projectDir, ".daintree", "plugin-settings", "acme.settings-declared-proj.json"),
      "utf-8"
    );
    expect(JSON.parse(raw)).toEqual({ ref: "branch-x" });
  });

  it("set and onDidChange target the declared scope when no scope is given", async () => {
    const projectDir = path.join(tmpDir, "proj-declared-set");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-declared-set", [
      { id: "channel", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-set");
    const heard: unknown[] = [];
    await host.settings.onDidChange("channel", (v) => heard.push(v));

    await host.settings.set("channel", "x");

    const raw = await fs.readFile(
      path.join(projectDir, ".daintree", "plugin-settings", "acme.settings-declared-set.json"),
      "utf-8"
    );
    expect(JSON.parse(raw)).toEqual({ channel: "x" });
    expect(heard).toEqual(["x"]);
    await expect(host.settings.set("channel", "y", "user")).rejects.toThrow(
      /declared in "project"/
    );
  });

  it("get answers the declared default while nothing is stored", async () => {
    const projectDir = path.join(tmpDir, "proj-default");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-default", [
      { id: "channel", type: "string", scope: "project", default: "blog" },
      { id: "tags", type: "json", default: ["a"] },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-default");

    expect(await host.settings.get("channel")).toBe("blog");
    const tags = await host.settings.get<string[]>("tags");
    tags?.push("mutated");
    expect(await host.settings.get("tags")).toEqual(["a"]);
    await host.settings.set("channel", "x");
    expect(await host.settings.get("channel")).toBe("x");
  });

  it("unset clears a stored value, reads as the default, and fires onDidChange with it", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-unset", [
      { id: "region", type: "string", default: "eu" },
      { id: "name", type: "string" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-unset");
    const heard: unknown[] = [];
    await host.settings.onDidChange("region", (v) => heard.push(v));
    await host.settings.onDidChange("name", (v) => heard.push(v));
    await host.settings.set("region", "us");
    await host.settings.set("name", "n");
    heard.length = 0;

    await host.settings.unset("region");
    await host.settings.unset("name");

    expect(heard).toEqual(["eu", undefined]);
    expect(await host.settings.get("region")).toBe("eu");
    expect(await host.settings.get("name")).toBeUndefined();
    const raw = await fs.readFile(path.join(settingsRoot, "acme.settings-unset.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({});

    heard.length = 0;
    await host.settings.unset("region");
    expect(heard).toEqual([]);
  });

  it("unset only clears declared keys, in their declared scope", async () => {
    const projectDir = path.join(tmpDir, "proj-unset-guard");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-unset-guard", [
      { id: "channel", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-unset-guard");
    await expect(host.settings.unset("other")).rejects.toThrow(/not declared/);
    await expect(host.settings.unset("channel", "user")).rejects.toThrow(/declared in "project"/);
    await expect(host.settings.unset("")).rejects.toThrow(/non-empty string/);

    const { service: bare } = await setupSettingsService("acme.settings-unset-bare");
    const { host: bareHost } = createSettingsHost(bare, "acme.settings-unset-bare");
    await expect(bareHost.settings.unset("anything")).rejects.toThrow(/not declared/);
  });

  it("unset clears the active project's value and leaves another project's alone", async () => {
    const projA = path.join(tmpDir, "unset-projA");
    const projB = path.join(tmpDir, "unset-projB");
    const { service } = await setupSettingsService("acme.settings-unset-proj", [
      { id: "channel", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-unset-proj");
    const file = (root: string) =>
      path.join(root, ".daintree", "plugin-settings", "acme.settings-unset-proj.json");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projA });
    await host.settings.set("channel", "a");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projB });
    await host.settings.set("channel", "b");
    const heard: unknown[] = [];
    await host.settings.onDidChange("channel", (v) => heard.push(v));

    await host.settings.unset("channel");

    expect(JSON.parse(await fs.readFile(file(projB), "utf-8"))).toEqual({});
    expect(JSON.parse(await fs.readFile(file(projA), "utf-8"))).toEqual({ channel: "a" });
    expect(heard).toEqual([undefined]);
  });

  it("unset on a bound project plugin clears its own project's value while another is active", async () => {
    const ownId = "a".repeat(64);
    const ownRoot = path.join(tmpDir, "unset-own");
    const activeRoot = path.join(tmpDir, "unset-active");
    const manifestId = "acme.settings-unset-bound";
    const { service } = await setupSettingsService(manifestId, [
      { id: "channel", type: "string", scope: "project" },
    ]);
    const instanceKey = `project__${ownId}__${manifestId}`;
    const seam = service as unknown as {
      plugins: Map<string, unknown>;
      _registerFakePluginForTests: (plugin: unknown, instanceKey?: string) => void;
    };
    seam._registerFakePluginForTests(seam.plugins.get(manifestId), instanceKey);
    const { host } = createSettingsHost(service, instanceKey, {
      projectId: ownId,
      projectRoot: ownRoot,
    });
    projectStoreMock.getCurrentProject.mockReturnValue({ id: ownId, path: ownRoot });
    await host.settings.set("channel", "own");
    projectStoreMock.getCurrentProject.mockReturnValue({ id: "b".repeat(64), path: activeRoot });
    const file = path.join(ownRoot, ".daintree", "plugin-settings", `${manifestId}.json`);
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({ channel: "own" });

    await host.settings.unset("channel");

    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({});
    await expect(fs.access(path.join(activeRoot, ".daintree"))).rejects.toThrow();
  });

  it("unset on a project key with no active project resolves without touching disk", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
    const { service, settingsRoot } = await setupSettingsService("acme.settings-unset-noproj", [
      { id: "channel", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-unset-noproj");
    const cb = vi.fn();
    await host.settings.onDidChange("channel", cb);
    await expect(host.settings.unset("channel")).resolves.toBeUndefined();
    expect(cb).not.toHaveBeenCalled();
    await expect(fs.access(settingsRoot)).rejects.toThrow();
  });

  it("unset makes a required key missing again, and removes a secret's stored envelope", async () => {
    safeStorageMock.state.available = true;
    const pluginId = "acme.settings-unset-secret";
    const { service, settingsRoot } = await setupSettingsService(pluginId, [
      { id: "token", type: "secret", required: true },
    ]);
    const { host } = createSettingsHost(service, pluginId);
    const heard: unknown[] = [];
    await host.settings.onDidChange("token", (v) => heard.push(v));

    await host.settings.set("token", "sk-1");
    expect(await host.settings.missingRequired()).toEqual([]);
    heard.length = 0;

    await host.settings.unset("token");

    expect(heard).toEqual([undefined]);
    expect(await host.settings.get("token")).toBeUndefined();
    expect(await host.settings.missingRequired()).toEqual(["token"]);
    const raw = await fs.readFile(path.join(settingsRoot, `${pluginId}.json`), "utf-8");
    expect(raw).not.toContain("daintree:secret");
  });

  it("get throws when the explicit scope conflicts with the declared scope", async () => {
    const projectDir = path.join(tmpDir, "proj-conflict");
    projectStoreMock.getCurrentProject.mockReturnValue({ path: projectDir });
    const { service } = await setupSettingsService("acme.settings-declared-conflict", [
      { id: "ref", type: "string", scope: "project" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-conflict");
    await expect(host.settings.get("ref", "user")).rejects.toThrow(
      /settings\.get: key "ref" is declared in "project" scope, not "user"/
    );
  });

  it("get falls back to user scope for an undeclared key", async () => {
    const { service, settingsRoot } = await setupSettingsService("acme.settings-undeclared", [
      { id: "declared", type: "string", scope: "user" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-undeclared");
    // "loose" isn't declared, so a write would be rejected — seed the user-scope
    // file directly to prove the read still resolves the permissive "user"
    // default for undeclared keys.
    await fs.mkdir(settingsRoot, { recursive: true });
    await fs.writeFile(
      path.join(settingsRoot, "acme.settings-undeclared.json"),
      JSON.stringify({ loose: "v" })
    );
    expect(await host.settings.get<string>("loose")).toBe("v");
  });
});

describe("init gate — waitForInit() and pushSnapshotTo() (#9285)", () => {
  it("waitForInit() stays pending until activateStartupFinishedPlugins() settles", async () => {
    const service = new PluginService(tmpDir);
    let resolved = false;
    const waiter = service.waitForInit().then(() => {
      resolved = true;
    });
    // Yield through several microtasks to make sure nothing leaks out of init.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    await service.activateStartupFinishedPlugins();
    await waiter;
    expect(resolved).toBe(true);
  });

  it("dispose() resolves a pending waitForInit() so callers don't deadlock", async () => {
    const service = new PluginService(tmpDir);
    const waiter = service.waitForInit();
    service.dispose();
    await expect(waiter).resolves.toBeUndefined();
  });

  it("holds the catalog, cold replay and complete snapshots until the scan settles (#14127)", async () => {
    let releaseBlocklist!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseBlocklist = resolve;
    });
    let entered!: () => void;
    const scanReached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocklistService = {
      getStartupBlocklist: async () => {
        entered();
        await gate;
        return { blocklist: null, refreshed: null };
      },
    } as unknown as NonNullable<ConstructorParameters<typeof PluginService>[2]>["blocklistService"];
    const service = new PluginService(tmpDir, undefined, { blocklistService });
    const toolbarCompleteFlags = () =>
      broadcastToRendererMock.mock.calls
        .map((c) => c[1] as { name?: string; payload?: { complete?: boolean } })
        .filter((e) => e.name === "plugin:toolbar-buttons-changed")
        .map((e) => e.payload?.complete);

    const init = service.initialize();
    // A concurrent call joins the scan rather than starting a second one.
    expect(service.initialize()).toBe(init);
    await scanReached;
    let catalogReady = false;
    void service.waitForCatalog().then(() => (catalogReady = true));
    const send = vi.fn();
    const wc = { id: 4251, send, isDestroyed: () => false } as unknown as Electron.WebContents;
    const replay = service.pushSnapshotTo(wc);

    broadcastToRendererMock.mockClear();
    // An unload while the catalog is still partial owes an authoritative snapshot.
    (
      service as unknown as {
        broadcaster: { scheduleToolbarButtonsBroadcast: (complete: boolean) => void };
      }
    ).broadcaster.scheduleToolbarButtonsBroadcast(true);
    await vi.waitFor(() => expect(toolbarCompleteFlags()).toEqual([false]));
    expect(catalogReady).toBe(false);
    expect(send).not.toHaveBeenCalled();

    releaseBlocklist();
    await init;
    await replay;
    expect(catalogReady).toBe(true);
    expect(send).toHaveBeenCalled();
    await vi.waitFor(() => expect(toolbarCompleteFlags()).toEqual([false, true]));
    service.dispose();
  });

  it.each([
    { outcome: "fails", loadError: { message: "boom", at: 1 }, pushes: 1 },
    { outcome: "succeeds", loadError: null, pushes: 0 },
  ])(
    "re-pulls the plugin list only when a startup activation changes its load error ($outcome)",
    async ({ loadError, pushes }) => {
      const service = new PluginService(tmpDir);
      const internals = service as unknown as {
        plugins: Map<string, unknown>;
        records: { upsertInstalledRecord: (id: string, patch: object) => void };
      };
      const activate = vi.spyOn(service, "activatePlugin").mockImplementation(async (id) => {
        internals.records.upsertInstalledRecord(id, { loadError });
      });
      internals.plugins.set("acme.early", {
        resolvedMain: "/x/main.mjs",
        manifest: { name: "acme.early", activationEvents: ["onStartupFinished"] },
      });
      broadcastToRendererMock.mockClear();

      await service.activateStartupFinishedPlugins();
      expect(activate).toHaveBeenCalledWith("acme.early");
      const provenancePushes = broadcastToRendererMock.mock.calls.filter(
        (c) => (c[1] as { name?: string })?.name === "plugin:provenance-changed"
      );
      expect(provenancePushes).toHaveLength(pushes);
      internals.plugins.clear();
      service.dispose();
    }
  );

  it("dispose() resolves a pending waitForCatalog() too", async () => {
    const service = new PluginService(tmpDir);
    const waiter = service.waitForCatalog();
    service.dispose();
    await expect(waiter).resolves.toBeUndefined();
  });

  it("waitForCatalog() settles when the scan does, even if a prerequisite throws", async () => {
    const service = new PluginService(tmpDir);
    (
      service as unknown as { installer: { sweepStalePluginTempDirs: () => Promise<void> } }
    ).installer.sweepStalePluginTempDirs = async () => {
      throw new Error("EACCES");
    };
    await expect(service.initialize()).rejects.toThrow("EACCES");
    await expect(service.waitForCatalog()).resolves.toBeUndefined();
    service.dispose();
  });

  it("a held startup activation holds waitForInit() but not the catalog, and its own callers (#14127)", async () => {
    const dir = path.join(tmpDir, "slow");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.slow",
        version: "1.0.0",
        main: "main.mjs",
        activationEvents: ["onStartupFinished"],
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#ff0000" }],
        },
      })
    );
    await fs.writeFile(path.join(dir, "main.mjs"), "export function activate() {}\n");
    const service = new PluginService(tmpDir);
    let releaseActivation!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    (service as unknown as { _doActivate: (id: string) => Promise<void> })._doActivate = () => held;

    await service.initialize();
    const startup = service.activateStartupFinishedPlugins();
    let fullyStarted = false;
    void service.waitForInit().then(() => (fullyStarted = true));
    let ownerActivated = false;
    const owner = service.activatePlugin("acme.slow").then(() => (ownerActivated = true));

    await service.waitForCatalog();
    expect(service.hasPlugin("acme.slow")).toBe(true);
    const send = vi.fn();
    const wc = { id: 4250, send, isDestroyed: () => false } as unknown as Electron.WebContents;
    await service.pushSnapshotTo(wc);
    expect(send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ name: "plugin:panel-kinds-changed" })
    );
    expect(fullyStarted).toBe(false);
    expect(ownerActivated).toBe(false);

    releaseActivation();
    await startup;
    await owner;
    expect(fullyStarted).toBe(true);
    expect(ownerActivated).toBe(true);
    service.dispose();
  });

  it("pushSnapshotTo() replays a global plugin's runtime panel menus, and skips a project plugin's for another view (#13213)", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const menus = (
      service as unknown as {
        pluginPanelMenus: Map<string, Map<string, readonly { actionId: string }[]>>;
      }
    ).pluginPanelMenus;
    menus.set("acme.global", new Map([["panel-a", [{ actionId: "acme.global.open" }]]]));
    menus.set(
      "project__other-project__acme.local",
      new Map([["panel-b", [{ actionId: "project__other-project__acme.local.open" }]]])
    );
    const send = vi.fn();
    const wc = { id: 4242, send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    const menuEvents = send.mock.calls
      .map((c) => c[1] as { name?: string; payload?: unknown })
      .filter((event) => event.name === "plugin:panel-menus-changed");
    expect(menuEvents).toEqual([
      {
        name: "plugin:panel-menus-changed",
        payload: {
          pluginId: "acme.global",
          menus: { "panel-a": [{ actionId: "acme.global.open" }] },
        },
      },
    ]);
  });

  it("pushSnapshotTo() replays a global plugin's toolbar badges, and skips a project plugin's for another view (#13503)", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const badges = (
      service as unknown as {
        pluginToolbarBadges: Map<string, Map<string, { kind: string; text?: string }>>;
      }
    ).pluginToolbarBadges;
    badges.set("acme.global", new Map([["needs", { kind: "label", text: "3" }]]));
    badges.set("project__other-project__acme.local", new Map([["needs", { kind: "dot" }]]));
    const send = vi.fn();
    const wc = { id: 4243, send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    const badgeEvents = send.mock.calls
      .map((c) => c[1] as { name?: string; payload?: unknown })
      .filter((event) => event.name === "plugin:toolbar-badges-changed");
    expect(badgeEvents).toEqual([
      {
        name: "plugin:toolbar-badges-changed",
        payload: { pluginId: "acme.global", badges: { needs: { kind: "label", text: "3" } } },
      },
    ]);
  });

  it("pushSnapshotTo() replays toolbar-button state to entitled views, withholding it from a remote-bound one (#13785)", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const states = (
      service as unknown as {
        pluginToolbarStates: Map<string, Map<string, { pressed?: boolean; busy?: boolean }>>;
      }
    ).pluginToolbarStates;
    states.set("acme.global", new Map([["sync", { pressed: true }]]));
    states.set("project__other-project__acme.local", new Map([["sync", { busy: true }]]));
    const send = vi.fn();
    const wc = { id: 4245, send, isDestroyed: () => false } as unknown as Electron.WebContents;
    const stateEvents = () =>
      send.mock.calls
        .map((c) => c[1] as { name?: string; payload?: unknown })
        .filter((event) => event.name === "plugin:toolbar-states-changed");

    try {
      await service.pushSnapshotTo(wc);
      expect(stateEvents()).toEqual([
        {
          name: "plugin:toolbar-states-changed",
          payload: { pluginId: "acme.global", states: { sync: { pressed: true } } },
        },
      ]);

      send.mockClear();
      ipcViewMocks.isWithheldFromView.mockImplementation(
        (_id, _channel, args) =>
          (args[0] as { name?: string } | undefined)?.name === "plugin:toolbar-states-changed"
      );
      await service.pushSnapshotTo(wc);
      expect(stateEvents()).toEqual([]);
    } finally {
      ipcViewMocks.isWithheldFromView.mockImplementation(() => false);
    }
  });

  it("pushSnapshotTo() replays context keys to the views entitled to them, empty ones too (#13506)", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const keys = (
      service as unknown as { pluginContextKeys: Map<string, Map<string, boolean | string>> }
    ).pluginContextKeys;
    keys.set("acme.global", new Map<string, boolean | string>([["needsYou", true]]));
    keys.set("project__proj-a__acme.mine", new Map());
    keys.set("project__other-project__acme.local", new Map([["busy", true]]));
    const send = vi.fn();
    const wc = { id: 4244, send, isDestroyed: () => false } as unknown as Electron.WebContents;
    ipcViewMocks.getProjectRendererTargets.mockImplementation((projectId) =>
      projectId === "proj-a" ? [{ id: 4244 }] : []
    );
    const keyEvents = () =>
      send.mock.calls
        .map((c) => c[1] as { name?: string; payload?: unknown })
        .filter((event) => event.name === "plugin:context-keys-changed");

    try {
      await service.pushSnapshotTo(wc);
      expect(keyEvents()).toEqual([
        {
          name: "plugin:context-keys-changed",
          payload: { pluginId: "acme.global", keys: { needsYou: true } },
        },
        {
          name: "plugin:context-keys-changed",
          payload: { pluginId: "project__proj-a__acme.mine", keys: {} },
        },
      ]);

      // A view bound to a remote host takes that host's keys, not this machine's.
      send.mockClear();
      ipcViewMocks.isWithheldFromView.mockImplementation(
        (_id, _channel, args) =>
          (args[0] as { name?: string } | undefined)?.name === "plugin:context-keys-changed"
      );
      await service.pushSnapshotTo(wc);
      expect(keyEvents()).toEqual([]);
    } finally {
      ipcViewMocks.getProjectRendererTargets.mockImplementation(() => []);
      ipcViewMocks.isWithheldFromView.mockImplementation(() => false);
    }
  });

  it("a project instance keeps its context namespace through worker retirement; an installed one lets go (#13506)", () => {
    const service = new PluginService(tmpDir);
    const internals = service as unknown as {
      pluginContextKeys: Map<string, Map<string, boolean | string>>;
      claimProjectContextNamespace: (pluginId: string) => void;
      resetPluginContextKeys: (pluginId: string) => void;
    };
    internals.claimProjectContextNamespace("acme.global");
    expect(internals.pluginContextKeys.has("acme.global")).toBe(false);

    internals.claimProjectContextNamespace("project__proj-a__acme.mine");
    expect(internals.pluginContextKeys.get("project__proj-a__acme.mine")?.size).toBe(0);

    internals.pluginContextKeys.get("project__proj-a__acme.mine")!.set("busy", true);
    internals.pluginContextKeys.set("acme.global", new Map([["ready", true]]));
    internals.resetPluginContextKeys("project__proj-a__acme.mine");
    internals.resetPluginContextKeys("acme.global");
    expect(internals.pluginContextKeys.get("project__proj-a__acme.mine")?.size).toBe(0);
    expect(internals.pluginContextKeys.has("acme.global")).toBe(false);
  });

  it("pushSnapshotToEndpoint() replays to a remote view scoped to its endpoint's project", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const menus = (
      service as unknown as {
        pluginPanelMenus: Map<string, Map<string, readonly { actionId: string }[]>>;
      }
    ).pluginPanelMenus;
    menus.set("acme.global", new Map([["panel-a", [{ actionId: "acme.global.open" }]]]));
    menus.set(
      "project__other-project__acme.local",
      new Map([["panel-b", [{ actionId: "project__other-project__acme.local.open" }]]])
    );
    const remote = (projectId: string | null) => ({
      kind: "remote-view" as const,
      handle: -7,
      projectId,
      endpointId: "e",
      clientId: "c",
      send: vi.fn(),
      request: vi.fn(),
      onClose: () => ({ dispose: () => {} }),
      isClosed: () => false,
    });
    const menuPluginsFor = async (projectId: string | null) => {
      const endpoint = remote(projectId);
      await service.pushSnapshotToEndpoint(endpoint);
      return endpoint.send.mock.calls
        .map((c) => c[0] as { channel: string; args: [{ name?: string; payload?: unknown }] })
        .filter((frame) => frame.args[0].name === "plugin:panel-menus-changed")
        .map((frame) => (frame.args[0].payload as { pluginId: string }).pluginId);
    };

    expect(await menuPluginsFor("other-project")).toEqual([
      "acme.global",
      "project__other-project__acme.local",
    ]);
    expect(await menuPluginsFor(null)).toEqual(["acme.global"]);
  });

  it("pushSnapshotTo() waits for init before sending — no empty snapshot races startup", async () => {
    const service = new PluginService(tmpDir);
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    // Fire pushSnapshotTo before init has resolved — it must hold off the
    // webContents.send calls until activateStartupFinishedPlugins() settles.
    const inFlight = service.pushSnapshotTo(wc);
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();

    await service.activateStartupFinishedPlugins();
    await inFlight;
    expect(send).toHaveBeenCalledTimes(12);
  });

  it("pushSnapshotTo() does not send after dispose()", async () => {
    const service = new PluginService(tmpDir);
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;
    const inFlight = service.pushSnapshotTo(wc);
    service.dispose();
    await inFlight;
    expect(send).not.toHaveBeenCalled();
  });
});

describe("dev-mode hot reload (#9304)", () => {
  beforeEach(() => {
    devWorkerMock.instances.length = 0;
    devWorkerMock.bridges.length = 0;
  });

  async function writeDevPlugin(name: string, pluginName: string): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");
  }

  it("flags a .dev-marker plugin as devMode in listPlugins (drives the DEV badge)", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    const info = service.listPlugins().find((p) => p.manifest.name === "acme.dev");
    expect(info?.devMode).toBe(true);
  });

  it("routes activation of a dev plugin through the hot-reload worker", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    expect(devWorkerMock.instances).toHaveLength(1);
    expect(devWorkerMock.instances[0].opts.pluginId).toBe("acme.dev");
    expect(devWorkerMock.instances[0].opts.bundlePath).toMatch(/dist[/\\]index\.js$/);
    expect(devWorkerMock.instances[0].opts.mode).toBe("dev");
    expect(devWorkerMock.instances[0].start).toHaveBeenCalledTimes(1);
    expect(devWorkerMock.bridges[0].waitForActivation).toHaveBeenCalledTimes(1);
  });

  it("forks a prod-mode worker for a plugin without a dev marker (#10526)", async () => {
    const dir = path.join(tmpDir, "prod-plugin");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: "acme.prod", version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.prod");

    // Every user plugin runs out-of-process now: a prod plugin forks the same
    // worker as a dev plugin, but in "prod" mode (no hot-reload file watcher).
    expect(devWorkerMock.instances).toHaveLength(1);
    expect(devWorkerMock.instances[0].opts.pluginId).toBe("acme.prod");
    expect(devWorkerMock.instances[0].opts.mode).toBe("prod");
    const info = service.listPlugins().find((p) => p.manifest.name === "acme.prod");
    expect(info?.devMode).toBe(false);
  });

  it("activates a built-in plugin in-process, NOT via a worker (#10526)", async () => {
    // Built-ins stay on the in-process loader: they're trusted app-bundled code
    // that may use synchronous host surfaces (registerForgeProvider) which can't
    // cross the worker's async port — routing them through it would break forge.
    const builtinRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-route-"));
    try {
      const dir = path.join(builtinRoot, "daintree.builtin");
      await fs.mkdir(path.join(dir, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.builtin", version: "1.0.0", main: "dist/index.js" })
      );
      await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinRoot });
      await service.initialize();
      await service.activatePlugin("daintree.builtin");

      // No worker forked for the built-in; it activated via the in-process loader.
      expect(devWorkerMock.instances).toHaveLength(0);
      const info = service.listPlugins().find((p) => p.manifest.name === "daintree.builtin");
      expect(info?.isBuiltin).toBe(true);
    } finally {
      await fs.rm(builtinRoot, { recursive: true, force: true });
    }
  });

  it("disposes the worker and bridge when the dev plugin is unloaded", async () => {
    await writeDevPlugin("dev-plugin", "acme.dev");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    const worker = devWorkerMock.instances[0];
    const bridge = devWorkerMock.bridges[0];
    service.unloadPlugin("acme.dev");
    expect(bridge.dispose).toHaveBeenCalled();
    expect(worker.dispose).toHaveBeenCalled();
  });

  it("keeps manifest commands registered across a reload (clearPriorRegistrations)", async () => {
    const dir = path.join(tmpDir, "dev-cmd");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.dev",
        version: "1.0.0",
        main: "dist/index.js",
        contributes: {
          commands: [
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Run the thing",
              category: "Dev",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.dev");

    // Manifest command is registered at load time.
    expect(service.listPluginActions().some((a) => a.id === "acme.dev.do-thing")).toBe(true);

    // Simulate a hot reload: the bridge calls clearPriorRegistrations before the
    // worker re-registers. Manifest commands must survive — only imperative
    // (host.registerAction) actions are dropped.
    const clearPriorRegistrations = (
      devWorkerMock.bridges[0].deps as unknown as { clearPriorRegistrations: () => void }
    ).clearPriorRegistrations;
    clearPriorRegistrations();

    expect(service.listPluginActions().some((a) => a.id === "acme.dev.do-thing")).toBe(true);
  });
});

describe("worktree card statuses (#13704)", () => {
  type Status = { label: string; tooltip?: string };
  type Statuses = Map<string, Map<string, Map<string, Status>>>;
  const statusesOf = (service: PluginService): Statuses =>
    (service as unknown as { pluginWorktreeCardStatuses: Statuses }).pluginWorktreeCardStatuses;
  const statusEvents = () =>
    ipcViewMocks.broadcastToProjectRenderers.mock.calls
      .map((call) => ({
        to: call[0],
        ...(call[2] as { name: string; payload: unknown }),
      }))
      .filter((event) => event.name === "plugin:worktree-card-statuses-changed");

  beforeEach(() => {
    devWorkerMock.instances.length = 0;
    devWorkerMock.bridges.length = 0;
  });
  afterEach(() => {
    ipcViewMocks.getProjectRendererTargets.mockImplementation(() => []);
  });

  async function writeDevPlugin(name: string, pluginName: string): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");
  }

  it("pushSnapshotTo() replays only the buckets for the view's own project", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    statusesOf(service).set(
      "acme.global",
      new Map([
        ["proj-a", new Map([["/a/wt", { label: "up" }]])],
        ["proj-b", new Map([["/b/wt", { label: "down" }]])],
      ])
    );
    statusesOf(service).set(
      "project__proj-b__acme.local",
      new Map([["proj-b", new Map([["/b/wt", { label: "b only" }]])]])
    );
    ipcViewMocks.getProjectRendererTargets.mockImplementation((projectId) =>
      projectId === "proj-a" ? [{ id: 4250 }] : []
    );
    const send = vi.fn();
    const wc = { id: 4250, send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    const replayed = send.mock.calls
      .map((c) => c[1] as { name?: string; payload?: unknown })
      .filter((event) => event.name === "plugin:worktree-card-statuses-changed");
    expect(replayed).toEqual([
      {
        name: "plugin:worktree-card-statuses-changed",
        payload: {
          pluginId: "acme.global",
          projectId: "proj-a",
          statuses: { "/a/wt": { label: "up" } },
        },
      },
    ]);
  });

  it("withholds replayed statuses from a local view bound to a remote host", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    statusesOf(service).set(
      "acme.global",
      new Map([["proj-a", new Map([["/a/wt", { label: "up" }]])]])
    );
    ipcViewMocks.getProjectRendererTargets.mockImplementation(() => [{ id: 4251 }]);
    ipcViewMocks.isWithheldFromView.mockImplementation((id) => id === 4251);
    const send = vi.fn();
    const wc = { id: 4251, send, isDestroyed: () => false } as unknown as Electron.WebContents;

    try {
      await service.pushSnapshotTo(wc);
    } finally {
      ipcViewMocks.isWithheldFromView.mockImplementation(() => false);
    }

    const replayed = send.mock.calls
      .map((c) => c[1] as { name?: string })
      .filter((event) => event.name === "plugin:worktree-card-statuses-changed");
    expect(replayed).toEqual([]);
  });

  it("remembers removals and closes, so a setter whose read predates them is refused", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const handlers = new Map<string, (payload: unknown) => void>();
    service.setWorkspaceClient({
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      off: () => {},
    } as never);
    type Since = { revision: number; at: number };
    const internals = service as unknown as {
      worktreeCardTargetRevision: number;
      isWorktreeCardTargetRetired: (p: string, w: string, s: Since) => boolean;
    };
    const retired = (projectId: string, worktreeId: string, since: Since) =>
      internals.isWorktreeCardTargetRetired(projectId, worktreeId, since);

    // A call made before the removal, however long its read then took.
    const before = { revision: internals.worktreeCardTargetRevision, at: Date.now() - 60_000 };
    expect(retired("proj-a", "/a/gone", before)).toBe(false);
    handlers.get("worktree-removed")!({ worktreeId: "/a/gone", projectPath: "/a" });
    expect(retired("proj-a", "/a/gone", before)).toBe(true);
    expect(retired("proj-a", "/a/other", before)).toBe(false);

    // A call made just after it can still be answered by a coalesced read.
    const justAfter = { revision: internals.worktreeCardTargetRevision, at: Date.now() };
    expect(retired("proj-a", "/a/gone", justAfter)).toBe(true);
    // One made once the worktree exists again, past that grace, is about the new one.
    const recreated = { revision: internals.worktreeCardTargetRevision, at: Date.now() + 5_000 };
    expect(retired("proj-a", "/a/gone", recreated)).toBe(false);

    await service.onProjectClosed("proj-b");
    expect(retired("proj-b", "/b/any", before)).toBe(true);
    expect(
      retired("proj-b", "/b/any", { ...recreated, revision: internals.worktreeCardTargetRevision })
    ).toBe(false);
    service.dispose();
  });

  it("clears every project a plugin marked when it unloads", async () => {
    await writeDevPlugin("dev-status", "acme.status");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.status");
    statusesOf(service).set(
      "acme.status",
      new Map([
        ["proj-a", new Map([["/a/wt", { label: "up" }]])],
        ["proj-b", new Map([["/b/wt", { label: "up" }]])],
      ])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    service.unloadPlugin("acme.status");

    expect(statusesOf(service).has("acme.status")).toBe(false);
    expect(statusEvents()).toEqual([
      expect.objectContaining({
        to: "proj-a",
        payload: { pluginId: "acme.status", projectId: "proj-a", statuses: {} },
      }),
      expect.objectContaining({
        to: "proj-b",
        payload: { pluginId: "acme.status", projectId: "proj-b", statuses: {} },
      }),
    ]);
  });

  it("clears a plugin's statuses when its worker is replaced", async () => {
    await writeDevPlugin("dev-status-reload", "acme.status-reload");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.status-reload");
    statusesOf(service).set(
      "acme.status-reload",
      new Map([["proj-a", new Map([["/a/wt", { label: "up" }]])]])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    (
      devWorkerMock.bridges[0].deps as unknown as { clearPriorRegistrations: () => void }
    ).clearPriorRegistrations();

    expect(statusesOf(service).size).toBe(0);
    expect(statusEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.status-reload", projectId: "proj-a", statuses: {} },
    ]);
    const generation = (
      service as unknown as { worktreeCardStatusGenerations: Map<string, number> }
    ).worktreeCardStatusGenerations.get("acme.status-reload");
    expect(generation).toBe(1);
  });

  it("clears every plugin's statuses on a closed project and leaves other projects alone", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    statusesOf(service).set(
      "acme.global",
      new Map([
        ["proj-a", new Map([["/a/wt", { label: "up" }]])],
        ["proj-b", new Map([["/b/wt", { label: "up" }]])],
      ])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    await service.onProjectClosed("proj-a");

    expect([...statusesOf(service).get("acme.global")!.keys()]).toEqual(["proj-b"]);
    expect(statusEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.global", projectId: "proj-a", statuses: {} },
    ]);
  });

  it("prunes a removed worktree from every plugin, and only that worktree", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    const client = {
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      }),
      off: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      }),
    };
    service.setWorkspaceClient(client as never);
    statusesOf(service).set(
      "acme.one",
      new Map([
        [
          "proj-a",
          new Map([
            ["/a/gone", { label: "x" }],
            ["/a/kept", { label: "y" }],
          ]),
        ],
      ])
    );
    statusesOf(service).set(
      "acme.two",
      new Map([["proj-a", new Map([["/a/gone", { label: "z" }]])]])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    for (const handler of handlers.get("worktree-removed") ?? []) {
      handler({ worktreeId: "/a/gone", projectPath: "/a" });
    }

    expect(statusesOf(service).get("acme.one")?.get("proj-a")?.has("/a/kept")).toBe(true);
    expect(statusesOf(service).has("acme.two")).toBe(false);
    expect(statusEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.one", projectId: "proj-a", statuses: { "/a/kept": { label: "y" } } },
      { pluginId: "acme.two", projectId: "proj-a", statuses: {} },
    ]);

    service.dispose();
    expect(handlers.get("worktree-removed")?.size ?? 0).toBe(0);
  });
});

describe("worktree review checks (#13806)", () => {
  type Check = { label: string; severity: "warning" | "info" };
  type Checks = Map<string, Map<string, Map<string, Check[]>>>;
  const checksOf = (service: PluginService): Checks =>
    (service as unknown as { pluginWorktreeReviewChecks: Checks }).pluginWorktreeReviewChecks;
  const checkEvents = () =>
    ipcViewMocks.broadcastToProjectRenderers.mock.calls
      .map((call) => ({ to: call[0], ...(call[2] as { name: string; payload: unknown }) }))
      .filter((event) => event.name === "plugin:worktree-review-checks-changed");
  const warn = (label: string): Check => ({ label, severity: "warning" });

  beforeEach(() => {
    devWorkerMock.instances.length = 0;
    devWorkerMock.bridges.length = 0;
  });
  afterEach(() => {
    ipcViewMocks.getProjectRendererTargets.mockImplementation(() => []);
  });

  async function writeDevPlugin(name: string, pluginName: string): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: pluginName, version: "1.0.0", main: "dist/index.js" })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), "export function activate() {}");
    await fs.writeFile(path.join(dir, ".dev-marker"), "");
  }

  it("pushSnapshotTo() replays only the buckets for the view's own project", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    checksOf(service).set(
      "acme.global",
      new Map([
        ["proj-a", new Map([["/a/wt", [warn("a")]]])],
        ["proj-b", new Map([["/b/wt", [warn("b")]]])],
      ])
    );
    ipcViewMocks.getProjectRendererTargets.mockImplementation((projectId) =>
      projectId === "proj-a" ? [{ id: 4260 }] : []
    );
    const send = vi.fn();
    const wc = { id: 4260, send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    const replayed = send.mock.calls
      .map((c) => c[1] as { name?: string; payload?: unknown })
      .filter((event) => event.name === "plugin:worktree-review-checks-changed");
    expect(replayed).toEqual([
      {
        name: "plugin:worktree-review-checks-changed",
        payload: { pluginId: "acme.global", projectId: "proj-a", checks: { "/a/wt": [warn("a")] } },
      },
    ]);
  });

  it("withholds replayed checks from a local view bound to a remote host", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    checksOf(service).set("acme.global", new Map([["proj-a", new Map([["/a/wt", [warn("a")]]])]]));
    ipcViewMocks.getProjectRendererTargets.mockImplementation(() => [{ id: 4261 }]);
    ipcViewMocks.isWithheldFromView.mockImplementation((id) => id === 4261);
    const send = vi.fn();
    const wc = { id: 4261, send, isDestroyed: () => false } as unknown as Electron.WebContents;
    try {
      await service.pushSnapshotTo(wc);
    } finally {
      ipcViewMocks.isWithheldFromView.mockImplementation(() => false);
    }
    const replayed = send.mock.calls
      .map((c) => c[1] as { name?: string })
      .filter((event) => event.name === "plugin:worktree-review-checks-changed");
    expect(replayed).toEqual([]);
  });

  it("clears every project a plugin published to when it unloads", async () => {
    await writeDevPlugin("dev-checks", "acme.checks");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.checks");
    checksOf(service).set(
      "acme.checks",
      new Map([
        ["proj-a", new Map([["/a/wt", [warn("a")]]])],
        ["proj-b", new Map([["/b/wt", [warn("b")]]])],
      ])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    service.unloadPlugin("acme.checks");

    expect(checksOf(service).has("acme.checks")).toBe(false);
    expect(checkEvents().map((event) => [event.to, event.payload])).toEqual([
      ["proj-a", { pluginId: "acme.checks", projectId: "proj-a", checks: {} }],
      ["proj-b", { pluginId: "acme.checks", projectId: "proj-b", checks: {} }],
    ]);
  });

  it("clears a plugin's checks, and advances its generation, when its worker is replaced", async () => {
    await writeDevPlugin("dev-checks-reload", "acme.checks-reload");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.checks-reload");
    checksOf(service).set(
      "acme.checks-reload",
      new Map([["proj-a", new Map([["/a/wt", [warn("a")]]])]])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    (
      devWorkerMock.bridges[0].deps as unknown as { clearPriorRegistrations: () => void }
    ).clearPriorRegistrations();

    expect(checksOf(service).size).toBe(0);
    expect(checkEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.checks-reload", projectId: "proj-a", checks: {} },
    ]);
    const generation = (
      service as unknown as { worktreeReviewChecksGenerations: Map<string, number> }
    ).worktreeReviewChecksGenerations.get("acme.checks-reload");
    expect(generation).toBe(1);
  });

  it("clears every plugin's checks on a closed project and leaves other projects alone", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    checksOf(service).set(
      "acme.global",
      new Map([
        ["proj-a", new Map([["/a/wt", [warn("a")]]])],
        ["proj-b", new Map([["/b/wt", [warn("b")]]])],
      ])
    );
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    await service.onProjectClosed("proj-a");

    expect([...checksOf(service).get("acme.global")!.keys()]).toEqual(["proj-b"]);
    expect(checkEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.global", projectId: "proj-a", checks: {} },
    ]);
  });

  it("prunes a removed worktree from every plugin, and only that worktree", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const handlers = new Map<string, Set<(payload: unknown) => void>>();
    service.setWorkspaceClient({
      on: vi.fn((event: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(handler);
      }),
      off: vi.fn((event: string, handler: (payload: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      }),
    } as never);
    checksOf(service).set(
      "acme.one",
      new Map([
        [
          "proj-a",
          new Map([
            ["/a/gone", [warn("x")]],
            ["/a/kept", [warn("y")]],
          ]),
        ],
      ])
    );
    checksOf(service).set("acme.two", new Map([["proj-a", new Map([["/a/gone", [warn("z")]]])]]));
    ipcViewMocks.broadcastToProjectRenderers.mockClear();

    for (const handler of handlers.get("worktree-removed") ?? []) {
      handler({ worktreeId: "/a/gone", projectPath: "/a" });
    }

    expect(checksOf(service).get("acme.one")?.get("proj-a")?.has("/a/kept")).toBe(true);
    expect(checksOf(service).has("acme.two")).toBe(false);
    expect(checkEvents().map((event) => event.payload)).toEqual([
      { pluginId: "acme.one", projectId: "proj-a", checks: { "/a/kept": [warn("y")] } },
      { pluginId: "acme.two", projectId: "proj-a", checks: {} },
    ]);
    service.dispose();
  });
});

describe("PluginService settings for launch-disabled plugins", () => {
  let svc: PluginService;

  function manifestWith(settings: SettingDefinition[]): PluginManifest {
    return {
      name: "acme.demo",
      version: "1.0.0",
      contributes: { settings },
    } as unknown as PluginManifest;
  }

  /** Register a plugin as launch-disabled (lives only in disabledPlugins). */
  function seedDisabled(manifest: PluginManifest) {
    (svc as unknown as { disabledPlugins: Map<string, unknown> }).disabledPlugins.set(
      manifest.name,
      {
        manifest,
        source: "sideload",
        installedAt: 0,
        originalUrl: null,
        archiveHash: null,
      }
    );
  }

  beforeEach(async () => {
    const pluginsRoot = path.join(tmpDir, "plugins");
    await fs.mkdir(pluginsRoot, { recursive: true });
    svc = new PluginService(pluginsRoot);
  });

  // The manager dialog renders a settings form for every plugin that
  // contributes settings, enabled or not. A plugin disabled at app launch
  // lives only in disabledPlugins (never in plugins), so the settings bridge
  // must resolve its declared fields from there — otherwise stored values
  // hydrate blank in the form.
  it("round-trips a user-scoped value for a launch-disabled plugin", async () => {
    seedDisabled(manifestWith([{ id: "apiKey", type: "string", scope: "user" }]));

    await svc.setSettingValueFromUi("acme.demo", "apiKey", "xyz", "user", null);
    const result = await svc.getSettingValuesForUi("acme.demo", "user", null);

    expect(result.values.apiKey).toBe("xyz");
    // The write is announced app-wide for an installed plugin, id only.
    expect(broadcastToRendererMock).toHaveBeenCalledWith(expect.any(String), {
      name: "plugin:settings-changed",
      payload: { pluginId: "acme.demo" },
    });
  });

  it("answers which required settings are still unset", async () => {
    seedDisabled(
      manifestWith([
        { id: "apiKey", type: "string", scope: "user", required: true },
        { id: "team", type: "string", scope: "user" },
      ])
    );

    expect((await svc.getRequiredSettingsStatusForUi("acme.demo", null)).missing).toEqual([
      "apiKey",
    ]);
    await svc.setSettingValueFromUi("acme.demo", "apiKey", "xyz", "user", null);
    expect((await svc.getRequiredSettingsStatusForUi("acme.demo", null)).missing).toEqual([]);
  });

  describe("setup checklist (#13824)", () => {
    const SETUP_MANIFEST = {
      name: "acme.demo",
      version: "1.0.0",
      contributes: {
        settings: [{ id: "team", type: "string", scope: "user", default: "core" }],
        account: { kind: "token", label: "Acme token" },
        commands: [],
        setup: [
          { id: "team", title: "Pick a team", done: { kind: "setting", key: "team" } },
          { id: "connect", title: "Connect", done: { kind: "account" } },
          {
            id: "sync",
            title: "Run the first sync",
            description: "Pulls your projects",
            done: { kind: "context", when: "acme.demo.synced" },
            action: { kind: "command", actionId: "acme.demo.sync" },
          },
        ],
      },
    } as unknown as PluginManifest;

    it("works each step out from stored state, never from a default", async () => {
      seedDisabled(SETUP_MANIFEST);

      const before = await svc.getSetupStatusForUi("acme.demo", "proj-a");
      expect(before.steps).toEqual([
        {
          id: "team",
          title: "Pick a team",
          description: null,
          check: { kind: "observed", done: false },
          action: { kind: "settings", key: "team" },
          skipped: false,
        },
        {
          id: "connect",
          title: "Connect",
          description: null,
          check: { kind: "observed", done: false },
          action: { kind: "settings", key: null },
          skipped: false,
        },
        {
          id: "sync",
          title: "Run the first sync",
          description: "Pulls your projects",
          check: { kind: "context", when: "acme.demo.synced" },
          action: { kind: "command", actionId: "acme.demo.sync" },
          skipped: false,
        },
      ]);

      await svc.setSettingValueFromUi("acme.demo", "team", "core", "user", null);
      const after = await svc.getSetupStatusForUi("acme.demo", "proj-a");
      expect(after.steps[0]?.check).toEqual({ kind: "observed", done: true });

      // Cleared again, the step is outstanding again: nothing was latched.
      await svc.deleteSettingValueFromUi("acme.demo", "team", "user", null);
      const cleared = await svc.getSetupStatusForUi("acme.demo", "proj-a");
      expect(cleared.steps[0]?.check).toEqual({ kind: "observed", done: false });
    });

    it("keeps the other steps when the account can't be read", async () => {
      seedDisabled(SETUP_MANIFEST);
      const accounts = (svc as unknown as { accounts: { getStateFor: () => Promise<unknown> } })
        .accounts;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const read = vi.spyOn(accounts, "getStateFor").mockRejectedValueOnce(new Error("bad JSON"));

      const status = await svc.getSetupStatusForUi("acme.demo", "proj-a");
      expect(status.steps.map((step) => [step.id, step.check])).toEqual([
        ["team", { kind: "observed", done: false }],
        ["connect", { kind: "observed", done: false }],
        ["sync", { kind: "context", when: "acme.demo.synced" }],
      ]);
      expect(read).toHaveBeenCalledWith("acme.demo", { projectId: "proj-a" });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it("answers no steps for a plugin that declares none or isn't loaded", async () => {
      seedDisabled(manifestWith([{ id: "team", type: "string" } as SettingDefinition]));
      expect(await svc.getSetupStatusForUi("acme.demo", null)).toEqual({ steps: [] });
      expect(await svc.getSetupStatusForUi("acme.unknown", null)).toEqual({ steps: [] });
    });

    it("remembers a skip per project and tells only that project's views", async () => {
      seedDisabled(SETUP_MANIFEST);
      ipcViewMocks.broadcastToProjectRenderers.mockClear();
      broadcastToRendererMock.mockClear();

      svc.setSetupStepSkippedFromUi("proj-a", "acme.demo", "connect", true);

      const skippedIn = async (projectId: string | null) =>
        (await svc.getSetupStatusForUi("acme.demo", projectId)).steps
          .filter((step) => step.skipped)
          .map((step) => step.id);
      expect(await skippedIn("proj-a")).toEqual(["connect"]);
      expect(await skippedIn("proj-b")).toEqual([]);
      expect(await skippedIn(null)).toEqual([]);
      expect(ipcViewMocks.broadcastToProjectRenderers).toHaveBeenCalledWith(
        "proj-a",
        expect.any(String),
        { name: "plugin:settings-changed", payload: { pluginId: "acme.demo" } }
      );
      expect(broadcastToRendererMock).not.toHaveBeenCalled();

      // Asking again changes nothing and announces nothing.
      ipcViewMocks.broadcastToProjectRenderers.mockClear();
      svc.setSetupStepSkippedFromUi("proj-a", "acme.demo", "connect", true);
      expect(ipcViewMocks.broadcastToProjectRenderers).not.toHaveBeenCalled();

      svc.setSetupStepSkippedFromUi("proj-a", "acme.demo", "connect", false);
      expect(await skippedIn("proj-a")).toEqual([]);
    });

    it("refuses to remember a skip for a step the plugin doesn't declare", () => {
      seedDisabled(SETUP_MANIFEST);
      expect(() => svc.setSetupStepSkippedFromUi("proj-a", "acme.demo", "nope", true)).toThrow();
      expect(() => svc.setSetupStepSkippedFromUi("proj-a", "acme.unknown", "sync", true)).toThrow();
    });

    it("runs a project plugin's command in its own instance's namespace", async () => {
      const instanceId = "project__proj-a__acme.demo";
      const manifest = {
        ...SETUP_MANIFEST,
        contributes: { commands: [], setup: [SETUP_MANIFEST.contributes.setup![2]] },
      } as unknown as PluginManifest;
      (svc as unknown as { disabledPlugins: Map<string, unknown> }).disabledPlugins.set(
        instanceId,
        { manifest, source: "sideload", installedAt: 0 }
      );
      const status = await svc.getSetupStatusForUi(instanceId, "proj-a");
      expect(status.steps[0]?.action).toEqual({
        kind: "command",
        actionId: `${instanceId}.sync`,
      });
    });
  });
});
