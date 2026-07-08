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
import { CHANNELS } from "../../ipc/channels.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type SettingsScope = "user" | "project";
type SettingsHostShape = (pluginId: string) => {
  host: {
    settings: {
      get: <T = unknown>(key: string, scope?: SettingsScope) => Promise<T | undefined>;
      set: <T = unknown>(key: string, value: T, scope?: SettingsScope) => Promise<void>;
      onDidChange: <T = unknown>(
        key: string,
        cb: (value: T | undefined) => void,
        scope?: SettingsScope
      ) => () => void;
    };
  };
  revoke: () => void;
};

async function setupSettingsService(
  pluginId: string,
  settings?: Array<{ id: string; type: string; scope?: SettingsScope }>
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

function createSettingsHost(service: PluginService, pluginId: string) {
  return (service as unknown as { createHost: SettingsHostShape }).createHost(pluginId);
}

describe("createHost — settings", () => {
  beforeEach(() => {
    projectStoreMock.getCurrentProject.mockReturnValue(null);
  });

  it("get returns undefined for an unset key", async () => {
    const { service } = await setupSettingsService("acme.settings-get");
    const { host } = createSettingsHost(service, "acme.settings-get");
    expect(await host.settings.get("token")).toBeUndefined();
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

  it("resolves the active project at call time, tracking project switches", async () => {
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

  it("get resolves a user-declared key from the user store with no scope arg", async () => {
    const { service } = await setupSettingsService("acme.settings-declared-user", [
      { id: "token", type: "string", scope: "user" },
    ]);
    const { host } = createSettingsHost(service, "acme.settings-declared-user");
    await host.settings.set("token", "sk-1", "user");
    expect(await host.settings.get<string>("token")).toBe("sk-1");
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

  it("waitForInit() resolves after activateStartupFinishedPlugins() even with zero plugins", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    await expect(service.waitForInit()).resolves.toBeUndefined();
  });

  it("dispose() resolves a pending waitForInit() so callers don't deadlock", async () => {
    const service = new PluginService(tmpDir);
    const waiter = service.waitForInit();
    service.dispose();
    await expect(waiter).resolves.toBeUndefined();
  });

  it("pushSnapshotTo() sends actions, panel kinds, toolbar buttons, context-menu items, and agents to the target webContents", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn();
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).toHaveBeenCalledTimes(6);
    // Every replay goes through the EVENTS_PUSH channel — the same channel the
    // renderer hooks' persistent push listeners consume, so no renderer-side
    // changes are needed for the cold-restore path.
    for (const call of send.mock.calls) {
      expect(call[0]).toBe(CHANNELS.EVENTS_PUSH);
    }
    const names = send.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toContain("plugin:actions-changed");
    expect(names).toContain("plugin:panel-kinds-changed");
    expect(names).toContain("plugin:toolbar-buttons-changed");
    expect(names).toContain("plugin:keybindings-changed");
    expect(names).toContain("plugin:context-menu-items-changed");
    expect(names).toContain("plugin:agents-changed");
    // The renderer menu-items channel was removed (#10465) — guard against the
    // cold-restore replay accidentally re-emitting it.
    expect(names).not.toContain("plugin:menu-items-changed");
    // The keybindings replay is a full authoritative snapshot — the renderer
    // hook full-replaces its plugin bindings on every push, so `complete: true`
    // is consistent with that replace-all semantics.
    const keybindingsCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:keybindings-changed"
    );
    expect((keybindingsCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(
      true
    );
    // Toolbar and context-menu-item replays must use `complete: false`
    // so the renderer does not run a stale-prune sweep — replay is a load-style
    // snapshot, not an unload-driven authoritative sweep.
    const toolbarCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:toolbar-buttons-changed"
    );
    expect((toolbarCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(false);
    const contextMenuItemsCall = send.mock.calls.find(
      (c) => (c[1] as { name?: string })?.name === "plugin:context-menu-items-changed"
    );
    expect((contextMenuItemsCall?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(
      false
    );
  });

  it("pushSnapshotTo() keeps sending remaining channels when one send() throws (TOCTOU)", async () => {
    // Simulates the wc being destroyed between the isDestroyed() guard and an
    // individual send — Electron raises "Object has been destroyed". Without
    // per-send try/catch one bad call would silently drop the remaining
    // channels and the cold-restored renderer would miss state.
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn((_channel: string, payload: { name: string }) => {
      if (payload.name === "plugin:actions-changed") {
        throw new Error("Object has been destroyed");
      }
    });
    const wc = { send, isDestroyed: () => false } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).toHaveBeenCalledTimes(6);
    const names = send.mock.calls.map((c) => (c[1] as { name?: string })?.name);
    expect(names).toContain("plugin:panel-kinds-changed");
    expect(names).toContain("plugin:toolbar-buttons-changed");
    expect(names).toContain("plugin:keybindings-changed");
    expect(names).toContain("plugin:context-menu-items-changed");
    expect(names).toContain("plugin:agents-changed");
  });

  it("pushSnapshotTo() skips a destroyed webContents", async () => {
    const service = new PluginService(tmpDir);
    await service.activateStartupFinishedPlugins();
    const send = vi.fn();
    const wc = { send, isDestroyed: () => true } as unknown as Electron.WebContents;

    await service.pushSnapshotTo(wc);

    expect(send).not.toHaveBeenCalled();
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
    expect(send).toHaveBeenCalledTimes(6);
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
