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
import { registerPanelKind } from "../../../shared/config/panelKindRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  PluginBlocklistService,
  type ParsedPluginBlocklist,
} from "../plugin/PluginBlocklistService.js";

let tmpDir: string;

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
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("PluginService blocklist / kill-switch (#10891)", () => {
  function blocklistService(
    entries: ParsedPluginBlocklist["entries"],
    fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ entries }),
    }))
  ) {
    // Route disk cache into the test tmpDir so a real userData path is never touched.
    const svc = new PluginBlocklistService({
      fetchImpl,
      cachePath: path.join(tmpDir, "blocklist-cache.json"),
    });
    return { svc, fetchImpl };
  }

  it("refuses to load a blocklisted plugin and surfaces it in listPlugins", async () => {
    // Declare a panel so the "no registration" assertion is meaningful: a
    // manifest that *has* a contribution yet registers nothing proves the gate
    // runs before contribution registration, not merely that there was nothing
    // to register.
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.2.3",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#ff0000" }],
      },
    });
    const { svc } = blocklistService([
      { name: "acme.bad", ranges: ["<2.0.0"], reason: "malware", message: "Steals tokens" },
    ]);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    const info = plugins[0];
    expect(info.manifest.name).toBe("acme.bad");
    expect(info.blocklisted).toBe(true);
    expect(info.blocklistReason).toBe("Steals tokens");
    // Never ran — no activation, no pending-restart cue, no load error.
    expect(info.loadedAt).toBe(0);
    expect(info.pendingRestart).toBe(false);
    expect(info.loadError).toBeNull();
    // The declared panel must NOT register — the gate precedes contribution wiring.
    expect(registerPanelKind).not.toHaveBeenCalled();
  });

  it("emits a low-priority inbox notification for a blocked plugin", async () => {
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.0.0",
      displayName: "Bad Plugin",
    });
    const { svc } = blocklistService([
      { name: "acme.bad", ranges: ["*"], reason: "malware", message: "Known-bad build" },
    ]);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "warning",
        priority: "low",
        title: "Plugin blocked",
        message: expect.stringContaining("Bad Plugin"),
      })
    );
  });

  it("loads a plugin whose version is outside every blocklisted range", async () => {
    await writePlugin("ok", { name: "acme.ok", version: "3.0.0" });
    const { svc } = blocklistService([{ name: "acme.ok", ranges: ["<2.0.0"], reason: "old-cve" }]);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].blocklisted).toBe(false);
    expect(plugins[0].loadedAt).toBeGreaterThan(0);
  });

  it("reports a disabled-and-blocklisted plugin as blocklisted (block gate wins)", async () => {
    storeMock._state.set("plugins", { disabled: ["acme.bad"] });
    await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
    const { svc } = blocklistService([
      { name: "acme.bad", ranges: ["*"], reason: "revoked", message: "Publisher revoked" },
    ]);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].blocklisted).toBe(true);
    expect(plugins[0].blocklistReason).toBe("Publisher revoked");
  });

  it("fails open — a fetch failure loads plugins normally", async () => {
    await writePlugin("ok", { name: "acme.ok", version: "1.0.0" });
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    const { svc } = blocklistService([], failing);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].blocklisted).toBe(false);
    expect(plugins[0].loadedAt).toBeGreaterThan(0);
  });

  it("resolves the blocklist once at initialize, not once per plugin", async () => {
    await writePlugin("a", { name: "acme.a", version: "1.0.0" });
    await writePlugin("b", { name: "acme.b", version: "1.0.0" });
    await writePlugin("c", { name: "acme.c", version: "1.0.0" });
    const { svc, fetchImpl } = blocklistService([
      { name: "acme.a", ranges: ["<0.0.1"], reason: "n/a" },
    ]);

    const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
    await service.initialize();

    // A single fetch backs the whole multi-plugin scan.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Worker governance (idle dispose + snapshots)", () => {
  const FUTURE = () => Date.now() + 31 * 60_000;

  async function writeWorkerPlugin(
    dirName: string,
    name: string,
    manifestExtras: Record<string, unknown> = {}
  ): Promise<void> {
    const dir = path.join(tmpDir, dirName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name, version: "1.0.0", main: "main.mjs", ...manifestExtras })
    );
    await fs.writeFile(path.join(dir, "main.mjs"), "export function activate() {}\n");
  }

  // The mock worker/bridge capture arrays are module-scoped and accumulate
  // across every describe in this file — index relative to a per-test baseline.
  function baseline() {
    return { hosts: devWorkerMock.instances.length, bridges: devWorkerMock.bridges.length };
  }

  it("disposes an idle prod user plugin worker and re-forks it on next use", async () => {
    const base = baseline();
    await writeWorkerPlugin("sleepy", "acme.sleepy");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.sleepy");
    expect(devWorkerMock.instances).toHaveLength(base.hosts + 1);
    const host = devWorkerMock.instances[base.hosts];
    const bridge = devWorkerMock.bridges[base.bridges];

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result.disposed).toEqual(["acme.sleepy"]);
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(bridge.dispose).toHaveBeenCalledTimes(1);

    // The plugin survives its worker: still loaded, still listed.
    expect(service.hasPlugin("acme.sleepy")).toBe(true);
    const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.sleepy");
    expect(snapshot).toMatchObject({ alive: false, state: "no-worker" });

    // Next use lazily re-forks a fresh worker — the reload cycle, on demand.
    await service.activatePlugin("acme.sleepy");
    expect(devWorkerMock.instances).toHaveLength(base.hosts + 2);
    const revived = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.sleepy");
    expect(revived).toMatchObject({ alive: true, state: "running" });
  });

  it("never disposes a recently-used worker", async () => {
    const base = baseline();
    await writeWorkerPlugin("busy", "acme.busy");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.busy");

    // Default `now`: activation just stamped the activity clock.
    const result = service.disposeIdlePluginWorkers();
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
  });

  it("protects panel-contributing plugins — open panel state is invisible to main", async () => {
    const base = baseline();
    await writeWorkerPlugin("panelly", "acme.panelly", {
      contributes: { panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }] },
    });
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.panelly");

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
    const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.panelly");
    expect(snapshot?.eligibility.dispose).toBe(false);
  });

  it("protects a worker with invokes in flight", async () => {
    const base = baseline();
    await writeWorkerPlugin("invoked", "acme.invoked");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.invoked");

    const bridge = devWorkerMock.bridges[base.bridges];
    bridge.pendingInvokeCount = 2;
    const blocked = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(blocked).toEqual({ disposed: [], skipped: 1 });

    bridge.pendingInvokeCount = 0;
    const released = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(released.disposed).toEqual(["acme.invoked"]);
  });

  it("protects a worker awaiting a host call (e.g. an open prompt)", async () => {
    const base = baseline();
    await writeWorkerPlugin("prompting", "acme.prompting");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.prompting");

    // A plugin blocked on host.showQuickPick can sit "idle" indefinitely —
    // disposing would dismiss the visible prompt out from under the user.
    const bridge = devWorkerMock.bridges[base.bridges];
    bridge.pendingHostCallCount = 1;
    const blocked = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(blocked).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();

    bridge.pendingHostCallCount = 0;
    const released = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(released.disposed).toEqual(["acme.prompting"]);
  });

  it("protects a plugin whose palette entries were registered imperatively", async () => {
    const base = baseline();
    const dir = path.join(tmpDir, "imperative");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: "acme.imperative", version: "1.0.0", main: "main.mjs" })
    );
    // The documented command-plugin shape: no manifest command, actions
    // registered in activate(). They die with the worker and nothing would
    // lazily re-fork for them — governance must leave this worker alone.
    await fs.writeFile(
      path.join(dir, "main.mjs"),
      `export function activate(host) {
        host.registerAction(
          { id: "run", title: "Run", description: "", category: "Test", kind: "command", danger: "safe" },
          () => "ran"
        );
      }
`
    );
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.imperative");

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
    // The imperative palette entry survives.
    expect(service.listPluginActions().map((a) => a.id)).toContain("acme.imperative.run");
  });

  it("protects startup-activated background plugins", async () => {
    const base = baseline();
    await writeWorkerPlugin("bg", "acme.bg", { activationEvents: ["onStartupFinished"] });
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.bg");

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
  });

  it("disabling a plugin clears its worker state and reports it as disabled", async () => {
    const base = baseline();
    await writeWorkerPlugin("toggled", "acme.toggled");
    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.toggled");
    expect(devWorkerMock.instances).toHaveLength(base.hosts + 1);

    await service.setEnabled("acme.toggled", false);
    expect(devWorkerMock.instances[base.hosts].dispose).toHaveBeenCalled();
    const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.toggled");
    expect(snapshot).toMatchObject({ alive: false, state: "disabled", queueDepth: 0 });
  });

  it("reports a blocklisted plugin with no worker and no eligibility", async () => {
    await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
    const blocklist = new PluginBlocklistService({
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          entries: [{ name: "acme.bad", ranges: ["<2.0.0"], reason: "malware" }],
        }),
      })),
      cachePath: path.join(tmpDir, "blocklist-cache.json"),
    });
    const service = new PluginService(tmpDir, undefined, { blocklistService: blocklist });
    await service.initialize();

    const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.bad");
    expect(snapshot).toMatchObject({
      alive: false,
      state: "blocked",
      eligibility: { trim: false, dispose: false, restart: false },
    });
    expect(snapshot?.detail?.reason).toBe("malware");
  });
});
