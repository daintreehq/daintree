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
  getPanelKindConfig: vi.fn(() => undefined),
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
    // A manifest command relayed into the worker; resolves as a handler would.
    invokeCommand = vi.fn(async (_id: string, _path: string, _args: unknown) => undefined);
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
import {
  ProjectPresenceTracker,
  _setProjectPresenceTrackerForTests,
} from "../ProjectPresenceTracker.js";
import { getPanelKindConfig, registerPanelKind } from "../../../shared/config/panelKindRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import { PLUGIN_BLOCKLIST_TTL_MS } from "../../../shared/config/pluginBlocklist.js";
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
    // No seed, so startup takes the fetched list as its first enforced one.
    const svc = new PluginBlocklistService({
      fetchImpl,
      cachePath: path.join(tmpDir, "blocklist-cache.json"),
      seed: null,
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

  describe("fresh profile with the release-shipped seed (#14127)", () => {
    function pendingFetch(entries: ParsedPluginBlocklist["entries"], seed?: unknown) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const fetchEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fetchImpl = vi.fn(async () => {
        entered();
        await gate;
        return { ok: true, status: 200, json: async () => ({ entries }) };
      });
      const svc = new PluginBlocklistService({
        fetchImpl,
        cachePath: path.join(tmpDir, "blocklist-cache.json"),
        ...(seed === undefined ? {} : { seed }),
      });
      return { svc, release, fetchEntered };
    }

    const isBlocked = (service: PluginService, name: string) =>
      service.listPlugins().some((p) => p.manifest.name === name && p.blocklisted);

    // The fetched list persists fire-and-forget; let it land before the fixture
    // dir is removed so a late write can't recreate it.
    const persisted = () => vi.waitFor(() => fs.access(path.join(tmpDir, "blocklist-cache.json")));

    it("publishes the built-in catalog while the remote fetch is still pending", async () => {
      const builtinRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-test-"));
      try {
        const dir = path.join(builtinRoot, "viewer");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, "plugin.json"),
          JSON.stringify({
            name: "daintree.viewer",
            version: "1.0.0",
            contributes: {
              panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#ff0000" }],
            },
          })
        );
        const { svc, release, fetchEntered } = pendingFetch([]);
        const service = new PluginService(tmpDir, undefined, {
          blocklistService: svc,
          builtinPluginsRoot: builtinRoot,
        });

        await service.initialize();
        await service.waitForCatalog();
        await fetchEntered;
        expect(service.hasPlugin("daintree.viewer")).toBe(true);
        expect(registerPanelKind).toHaveBeenCalledTimes(1);
        release();
        await persisted();
        service.dispose();
      } finally {
        await fs.rm(builtinRoot, { recursive: true, force: true });
      }
    });

    it("enforces the seed's denials before the fetch answers", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      await writePlugin("ok", { name: "acme.ok", version: "1.0.0" });
      const { svc, release, fetchEntered } = pendingFetch([], {
        entries: [{ name: "acme.bad", ranges: ["*"], reason: "malware" }],
      });

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      await fetchEntered;
      expect(isBlocked(service, "acme.bad")).toBe(true);
      expect(service.hasPlugin("acme.ok")).toBe(true);
      release();
      await persisted();
      service.dispose();
    });

    it("unloads a plugin loaded against the seed once the fetched list denies it", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      await writePlugin("ok", { name: "acme.ok", version: "1.0.0" });
      const { svc, release } = pendingFetch([
        { name: "acme.bad", ranges: ["*"], reason: "malware" },
      ]);

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      expect(service.hasPlugin("acme.bad")).toBe(true);

      release();
      await vi.waitFor(() => expect(isBlocked(service, "acme.bad")).toBe(true));
      expect(service.hasPlugin("acme.bad")).toBe(false);
      expect(service.hasPlugin("acme.ok")).toBe(true);
      await persisted();
      service.dispose();
    });

    it("refuses a plugin discovered after the fetched list denied it", async () => {
      const { svc, release } = pendingFetch([
        { name: "acme.late", ranges: ["*"], reason: "malware" },
      ]);
      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      release();
      await vi.waitFor(() =>
        expect(
          (service as unknown as { startupBlocklist: ParsedPluginBlocklist | null })
            .startupBlocklist?.entries
        ).toHaveLength(1)
      );

      await writePlugin("late", { name: "acme.late", version: "1.0.0" });
      await (
        service as unknown as {
          loadFromDir: (root: string, opts: { isBuiltin: boolean }) => Promise<number>;
        }
      ).loadFromDir(tmpDir, { isBuiltin: false });
      expect(service.hasPlugin("acme.late")).toBe(false);
      expect(isBlocked(service, "acme.late")).toBe(true);
      await persisted();
      service.dispose();
    });

    it("waits for the fetch when the shipped seed is malformed", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      const { svc, release, fetchEntered } = pendingFetch(
        [{ name: "acme.bad", ranges: ["*"], reason: "malware" }],
        { entries: "not-a-list" }
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
        let initialized = false;
        const init = service.initialize().then(() => (initialized = true));
        await fetchEntered;
        await Promise.resolve();
        expect(initialized).toBe(false);

        release();
        await init;
        expect(isBlocked(service, "acme.bad")).toBe(true);
        await persisted();
        service.dispose();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("stale cached list at startup", () => {
    const cachePath = () => path.join(tmpDir, "blocklist-cache.json");

    async function writeStaleCache(entries: ParsedPluginBlocklist["entries"]): Promise<void> {
      await fs.writeFile(
        cachePath(),
        JSON.stringify({
          fetchedAt: Date.now() - PLUGIN_BLOCKLIST_TTL_MS - 60_000,
          raw: { entries },
        })
      );
    }

    function gatedBlocklist(entries: ParsedPluginBlocklist["entries"]) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchImpl = vi.fn(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({ entries }) };
      });
      const svc = new PluginBlocklistService({ fetchImpl, cachePath: cachePath() });
      return { svc, release, fetchImpl };
    }

    const isBlocked = (service: PluginService, name: string) =>
      service.listPlugins().some((p) => p.manifest.name === name && p.blocklisted);

    it("enforces the stale list without waiting for the fetch", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      await writePlugin("ok", { name: "acme.ok", version: "1.0.0" });
      await writeStaleCache([{ name: "acme.bad", ranges: ["*"], reason: "malware" }]);
      const { svc, release, fetchImpl } = gatedBlocklist([]);

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      // Resolves while the fetch is still held open.
      await service.initialize();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      expect(service.hasPlugin("acme.bad")).toBe(false);
      expect(isBlocked(service, "acme.bad")).toBe(true);
      expect(service.hasPlugin("acme.ok")).toBe(true);
      release();
      // Let the background refresh settle before the fixture dir is removed. An
      // entry the fresh list drops stays blocked until the next launch.
      await new Promise((r) => setTimeout(r, 20));
      expect(isBlocked(service, "acme.bad")).toBe(true);
    });

    it("adopts a refresh that lands while the scan is still running", async () => {
      for (let i = 0; i < 12; i++) {
        await writePlugin(`p${i}`, { name: `acme.p${i}`, version: "1.0.0" });
      }
      await writeStaleCache([]);
      const fetchImpl = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ entries: [{ name: "acme.p0", ranges: ["*"], reason: "malware" }] }),
      }));
      const svc = new PluginBlocklistService({ fetchImpl, cachePath: cachePath() });

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      await vi.waitFor(() => expect(isBlocked(service, "acme.p0")).toBe(true));
      expect(service.hasPlugin("acme.p0")).toBe(false);
      expect(service.hasPlugin("acme.p1")).toBe(true);
    });

    it("unloads a plugin the revalidated list newly blocks", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0", displayName: "Bad" });
      await writePlugin("ok", { name: "acme.ok", version: "1.0.0" });
      await writeStaleCache([]);
      const { svc, release } = gatedBlocklist([
        { name: "acme.bad", ranges: ["*"], reason: "malware", message: "Revoked" },
      ]);

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      expect(service.hasPlugin("acme.bad")).toBe(true);

      release();
      await vi.waitFor(() => expect(isBlocked(service, "acme.bad")).toBe(true));
      expect(service.hasPlugin("acme.bad")).toBe(false);
      expect(service.hasPlugin("acme.ok")).toBe(true);
      expect(
        service.listPlugins().find((p) => p.manifest.name === "acme.bad")?.blocklistReason
      ).toBe("Revoked");
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          title: "Plugin blocked",
          message: expect.stringContaining("Bad"),
        })
      );
    });

    it("moves a disabled plugin the revalidated list blocks into the blocked set", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.bad"] });
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      await writeStaleCache([]);
      const { svc, release } = gatedBlocklist([
        { name: "acme.bad", ranges: ["*"], reason: "malware" },
      ]);

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      expect(isBlocked(service, "acme.bad")).toBe(false);

      release();
      await vi.waitFor(() => expect(isBlocked(service, "acme.bad")).toBe(true));
      expect(service.listPlugins()).toHaveLength(1);
    });

    it("keeps the stale list when the revalidation fails", async () => {
      await writePlugin("bad", { name: "acme.bad", version: "1.0.0" });
      await writeStaleCache([{ name: "acme.bad", ranges: ["*"], reason: "malware" }]);
      const fetchImpl = vi.fn(async () => {
        throw new Error("offline");
      });
      const svc = new PluginBlocklistService({ fetchImpl, cachePath: cachePath() });

      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(isBlocked(service, "acme.bad")).toBe(true);
      expect(service.hasPlugin("acme.bad")).toBe(false);
    });

    it("refuses to activate a registered plugin the current list blocks", async () => {
      // A load that passed the gate against the older list can commit after the
      // revalidated list swept; activation must still refuse it.
      await writePlugin("late", { name: "acme.late", version: "1.0.0" });
      const { svc } = blocklistService([]);
      const service = new PluginService(tmpDir, undefined, { blocklistService: svc });
      await service.initialize();
      expect(service.hasPlugin("acme.late")).toBe(true);

      (service as unknown as { startupBlocklist: ParsedPluginBlocklist }).startupBlocklist = {
        entries: [{ name: "acme.late", ranges: ["*"], reason: "malware" }],
      };
      await service.activatePlugin("acme.late");
      expect(service.hasPlugin("acme.late")).toBe(false);
      expect(isBlocked(service, "acme.late")).toBe(true);
    });
  });
});

describe("Worker governance (idle dispose + snapshots)", () => {
  const FUTURE = () => Date.now() + 31 * 60_000;
  // Disposed after every test, so no service's idle sweep outlives it.
  const services: PluginService[] = [];
  const startService = (opts?: ConstructorParameters<typeof PluginService>[2]): PluginService => {
    const service = new PluginService(tmpDir, undefined, opts);
    services.push(service);
    return service;
  };

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    vi.mocked(getPanelKindConfig).mockReset();
  });

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
    const service = startService();
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
    const service = startService();
    await service.initialize();
    await service.activatePlugin("acme.busy");

    // Default `now`: activation just stamped the activity clock.
    const result = service.disposeIdlePluginWorkers();
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
  });

  /** Resolve `acme.panelly`'s panel kind the way the live registry would. */
  function ownPanelKind(): void {
    vi.mocked(getPanelKindConfig).mockImplementation((kindId: string) =>
      kindId === "acme.panelly.viewer"
        ? ({ id: kindId, extensionId: "acme.panelly" } as ReturnType<typeof getPanelKindConfig>)
        : undefined
    );
  }

  async function startPanelPlugin(): Promise<{ service: PluginService; hostIndex: number }> {
    const base = baseline();
    await writeWorkerPlugin("panelly", "acme.panelly", {
      contributes: { panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }] },
    });
    ownPanelKind();
    const service = startService();
    await service.initialize();
    await service.activatePlugin("acme.panelly");
    return { service, hostIndex: base.hosts };
  }

  const panelEvent = (phase: string, panelId = "p1") => ({
    panelId,
    panelKindId: "acme.panelly.viewer",
    pluginId: "acme.panelly",
    phase,
  });
  /** Long past the idle window, on the service's own clock. */
  const HOURS = 2 * 60 * 60_000;
  const IDLE = 30 * 60_000;

  it("retires a panel plugin none of whose panels is open, and reopens it (#17068)", async () => {
    const { service, hostIndex } = await startPanelPlugin();
    // Not vacuous: the plugin really contributes the panel kind.
    expect(vi.mocked(registerPanelKind)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.panelly.viewer" })
    );

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result.disposed).toEqual(["acme.panelly"]);
    expect(devWorkerMock.instances[hostIndex].dispose).toHaveBeenCalledTimes(1);

    // Opening a panel activates through the view path, which forks a fresh worker.
    await expect(service.activatePluginForView("acme.panelly.viewer")).resolves.toEqual({
      ok: true,
    });
    expect(devWorkerMock.instances).toHaveLength(hostIndex + 2);
  });

  it("keeps the worker while any of its panels is open, in any live phase", async () => {
    const { service, hostIndex } = await startPanelPlugin();

    for (const phase of ["mounted", "hidden", "backgrounded", "trashed", "render-failed"]) {
      const panelId = `p-${phase}`;
      service.ingestPanelLifecycleEvents(1, [panelEvent(phase, panelId)]);
      expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed, phase).toEqual([]);
      service.ingestPanelLifecycleEvents(1, [panelEvent("removed", panelId)]);
    }

    service.ingestPanelLifecycleEvents(1, [panelEvent("mounted", "a"), panelEvent("hidden", "b")]);
    const open = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.panelly");
    expect(open?.eligibility.dispose).toBe(false);
    expect(open?.detail?.openViews).toBe(2);
    service.ingestPanelLifecycleEvents(1, [panelEvent("removed", "a")]);
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual([]);

    service.ingestPanelLifecycleEvents(1, [panelEvent("removed", "b")]);
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual(["acme.panelly"]);
    expect(devWorkerMock.instances[hostIndex].dispose).toHaveBeenCalledTimes(1);
  });

  it("runs the idle window from the last panel closing, not from activation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service } = await startPanelPlugin();
      service.ingestPanelLifecycleEvents(1, [panelEvent("mounted")]);
      vi.setSystemTime(Date.now() + HOURS);
      service.ingestPanelLifecycleEvents(1, [panelEvent("removed")]);

      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE - 1 }).disposed).toEqual([]);
      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE }).disposed).toEqual([
        "acme.panelly",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a destroyed renderer's panels, running the idle window from then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service } = await startPanelPlugin();
      let destroyed: (() => void) | undefined;
      const sender = {
        id: 41,
        once: (_event: "destroyed", listener: () => void) => {
          destroyed = listener;
        },
        removeListener: () => {},
      };
      service.ingestPanelLifecycleEvents(41, [panelEvent("hidden")], sender);
      vi.setSystemTime(Date.now() + HOURS);
      expect(service.disposeIdlePluginWorkers().disposed).toEqual([]);

      destroyed?.();
      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE - 1 }).disposed).toEqual([]);
      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE }).disposed).toEqual([
        "acme.panelly",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the worker while one of its views is mounted outside the grid", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = baseline();
      await writeWorkerPlugin("sided", "acme.sided", {
        contributes: {
          views: [
            { id: "board", componentPath: "dist/board.js", location: "sidebar", name: "Board" },
          ],
        },
      });
      const service = startService();
      await service.initialize();
      await service.activatePlugin("acme.sided");
      let documentGone: (() => void) | undefined;
      const watch = (forget: () => void) => {
        documentGone = forget;
        return () => {};
      };

      // A renderer's claim names a view; main decides whose it is.
      service.ingestHostedViewConsumers(7, watch, ["plugin-view:acme.sided/board"]);
      vi.setSystemTime(Date.now() + HOURS);
      expect(service.disposeIdlePluginWorkers().disposed).toEqual([]);

      documentGone?.();
      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE - 1 }).disposed).toEqual([]);
      expect(service.disposeIdlePluginWorkers({ now: Date.now() + IDLE }).disposed).toEqual([
        "acme.sided",
      ]);
      expect(devWorkerMock.instances[base.hosts].dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a fresh session's panel replay without redelivering it to the plugin", async () => {
    const { service } = await startPanelPlugin();
    const heard = vi.fn();
    (
      service as unknown as {
        panelLifecycleBroker: { subscribe(id: string, cb: (e: unknown) => void): () => void };
      }
    ).panelLifecycleBroker.subscribe("acme.panelly", heard);

    service.ingestPanelLifecycleEvents(9, [panelEvent("mounted")], undefined, { replay: true });
    expect(heard).not.toHaveBeenCalled();
    // Recorded all the same: the panel still holds the worker.
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual([]);

    service.ingestPanelLifecycleEvents(9, [panelEvent("hidden")]);
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ phase: "hidden" }));
  });

  it("counts a panel kind drawn outside the grid, as a project surface does, as its plugin's view", async () => {
    const { service } = await startPanelPlugin();
    const watch = () => () => {};

    service.ingestHostedViewConsumers(7, watch, ["acme.panelly.viewer"]);
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual([]);

    service.ingestHostedViewConsumers(7, watch, []);
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual(["acme.panelly"]);
  });

  it("still protects a plugin subscribed to host events once its views close", async () => {
    const { service, hostIndex } = await startPanelPlugin();
    // A live subscription made during activate() can't be re-hydrated from the
    // manifest, so closing the plugin's last view must not strand it.
    (
      service as unknown as { pluginEventCleanups: Map<string, Array<() => void>> }
    ).pluginEventCleanups.set("acme.panelly", [() => {}]);

    service.ingestPanelLifecycleEvents(1, [panelEvent("mounted")]);
    service.ingestPanelLifecycleEvents(1, [panelEvent("removed")]);
    expect(service.disposeIdlePluginWorkers({ now: FUTURE() }).disposed).toEqual([]);
    expect(devWorkerMock.instances[hostIndex].dispose).not.toHaveBeenCalled();
  });

  it("protects a worker with invokes in flight", async () => {
    const base = baseline();
    await writeWorkerPlugin("invoked", "acme.invoked");
    const service = startService();
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
    const service = startService();
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
    const service = startService();
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
    const service = startService();
    await service.initialize();
    await service.activatePlugin("acme.bg");

    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result).toEqual({ disposed: [], skipped: 1 });
    expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
  });

  it("disabling a plugin clears its worker state and reports it as disabled", async () => {
    const base = baseline();
    await writeWorkerPlugin("toggled", "acme.toggled");
    const service = startService();
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
    const service = startService({ blocklistService: blocklist });
    await service.initialize();

    const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.bad");
    expect(snapshot).toMatchObject({
      alive: false,
      state: "blocked",
      eligibility: { trim: false, dispose: false, restart: false },
    });
    expect(snapshot?.detail?.reason).toBe("malware");
  });
  it("sweeps on its own every minute while a third-party worker is alive (#17068)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const base = baseline();
      await writeWorkerPlugin("swept", "acme.swept");
      const service = startService();
      await service.initialize();
      const idleTimers = vi.getTimerCount();

      await service.activatePlugin("acme.swept");
      expect(vi.getTimerCount()).toBe(idleTimers + 1);
      const host = devWorkerMock.instances[base.hosts];

      // A young worker survives its first ticks, and the sweep stays armed for it.
      vi.advanceTimersByTime(60_000);
      expect(host.dispose).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(idleTimers + 1);

      // Neither a fork nor a profile change: time passing is enough.
      vi.advanceTimersByTime(30 * 60_000);
      expect(host.dispose).toHaveBeenCalledTimes(1);
      // The last worker took the sweep with it.
      expect(vi.getTimerCount()).toBe(idleTimers);

      await service.activatePlugin("acme.swept");
      expect(vi.getTimerCount()).toBe(idleTimers + 1);
      service.dispose();
      expect(vi.getTimerCount()).toBe(idleTimers);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a worker the supervisor gave up on (#17211)", () => {
    /**
     * Registers an imperative action, one of the registrations that otherwise
     * keep a worker ineligible for idle disposal forever, and a panel handler
     * that answers with the activation it was registered by. The module is
     * imported once, so the counter survives across workers.
     */
    async function writeLoopingPlugin(dirName: string, name: string): Promise<void> {
      const dir = path.join(tmpDir, dirName);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name, version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(dir, "main.mjs"),
        `let activations = 0;
        export function activate(host) {
          const generation = ++activations;
          host.registerHandler("probe", () => generation);
          host.registerAction(
            { id: "run", title: "Run", description: "", category: "Test", kind: "command", danger: "safe" },
            () => "ran"
          );
        }
`
      );
    }

    /** The supervisor's verdict, delivered through the service's own health listener. */
    function tripCrashLoop(hostIndex: number): void {
      const calls = devWorkerMock.instances[hostIndex].on.mock.calls as unknown[][];
      const onCrashLoop = calls.find(([event]) => event === "crash-loop")?.[1] as
        ((code: number) => void) | undefined;
      expect(onCrashLoop).toBeTypeOf("function");
      onCrashLoop?.(139);
    }

    function workerStatus(service: PluginService, pluginId: string) {
      return service.listPluginRuntimeStatuses().find((s) => s.pluginId === pluginId)?.worker;
    }

    it("releases the dead worker and its registrations, keeping the failure on screen", async () => {
      const base = baseline();
      await writeLoopingPlugin("looper", "acme.looper");
      const service = startService();
      await service.initialize();
      await service.activatePlugin("acme.looper");
      const flushed = vi.fn();
      const eventCleanups = (
        service as unknown as { pluginEventCleanups: Map<string, Array<() => void>> }
      ).pluginEventCleanups;
      eventCleanups.set("acme.looper", [flushed]);
      expect(service.listPluginActions().map((a) => a.id)).toContain("acme.looper.run");

      tripCrashLoop(base.hosts);

      expect(devWorkerMock.instances[base.hosts].dispose).toHaveBeenCalledTimes(1);
      expect(devWorkerMock.bridges[base.bridges].dispose).toHaveBeenCalledTimes(1);
      expect(flushed).toHaveBeenCalledTimes(1);
      expect(eventCleanups.has("acme.looper")).toBe(false);
      expect(service.listPluginActions().map((a) => a.id)).not.toContain("acme.looper.run");
      const snapshot = service.getWorkerGovernanceSnapshots().find((s) => s.id === "acme.looper");
      expect(snapshot).toMatchObject({ alive: false });
      // The teardown's own "stopped" must not replace the cause the banner shows.
      expect(workerStatus(service, "acme.looper")).toMatchObject({
        state: "failed",
        reason: "crash-loop",
      });
    });

    it("forks a fresh worker for the next lazy invocation instead of short-circuiting", async () => {
      const base = baseline();
      await writeLoopingPlugin("revived", "acme.revived");
      const service = startService();
      await service.initialize();
      const ctx = { projectId: null, worktreeId: null, webContentsId: 0, pluginId: "acme.revived" };
      // A panel's invoke, which activates the plugin on its own like a palette
      // command or an MCP call does.
      expect(await service.dispatchHandler("acme.revived", "probe", ctx, [])).toBe(1);
      tripCrashLoop(base.hosts);
      const failedGeneration = workerStatus(service, "acme.revived")?.generation;

      expect(await service.dispatchHandler("acme.revived", "probe", ctx, [])).toBe(2);

      expect(devWorkerMock.instances).toHaveLength(base.hosts + 2);
      expect(service.listPluginActions().map((a) => a.id)).toContain("acme.revived.run");
      const worker = workerStatus(service, "acme.revived");
      expect(worker?.state).toBe("ready");
      // Panels bound to the failed backend see a generation they are not on.
      expect(worker?.generation).toBeGreaterThan(failedGeneration as number);
    });

    it("stops the idle sweep with the last worker it took down", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
      try {
        const base = baseline();
        await writeLoopingPlugin("swept-loop", "acme.swept-loop");
        const service = startService();
        await service.initialize();
        const idleTimers = vi.getTimerCount();
        await service.activatePlugin("acme.swept-loop");
        expect(vi.getTimerCount()).toBe(idleTimers + 1);

        tripCrashLoop(base.hosts);

        expect(vi.getTimerCount()).toBe(idleTimers);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a dev worker standing for the artifact watcher's edit-and-save recovery", async () => {
      const base = baseline();
      await writeLoopingPlugin("dev-loop", "acme.dev-loop");
      const service = startService();
      await service.initialize();
      (service as unknown as { plugins: Map<string, { devMode?: boolean }> }).plugins.get(
        "acme.dev-loop"
      )!.devMode = true;
      await service.activatePlugin("acme.dev-loop");

      tripCrashLoop(base.hosts);

      expect(devWorkerMock.instances[base.hosts].dispose).not.toHaveBeenCalled();
      expect(workerStatus(service, "acme.dev-loop")).toMatchObject({
        state: "failed",
        reason: "crash-loop",
      });
      await service.activatePlugin("acme.dev-loop");
      expect(devWorkerMock.instances).toHaveLength(base.hosts + 1);
    });
  });
});

describe("Manifest event routes (#13816)", () => {
  const FUTURE = () => Date.now() + 31 * 60_000;
  const ALPHA = "a".repeat(64);
  const BETA = "b".repeat(64);
  let shown: string[];
  let tracker: ProjectPresenceTracker;
  // Disposed after every test, pass or fail, so no service keeps its routes on
  // the shared buses into the next test.
  const services: PluginService[] = [];
  const startService = (): PluginService => {
    const service = new PluginService(tmpDir);
    services.push(service);
    return service;
  };

  beforeEach(() => {
    shown = [];
    tracker = new ProjectPresenceTracker(() => shown);
    _setProjectPresenceTrackerForTests(tracker);
    tracker.markOpened(ALPHA);
    tracker.markOpened(BETA);
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    _setProjectPresenceTrackerForTests(null);
  });

  function show(projectId: string): void {
    shown = [projectId];
    tracker.refresh();
  }

  async function writeRoutedPlugin(dirName: string, name: string): Promise<void> {
    const dir = path.join(tmpDir, dirName);
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        main: "main.mjs",
        eventRoutes: [{ event: "projectForeground", command: "onShown" }],
        contributes: {
          commands: [
            {
              id: "onShown",
              title: "On shown",
              description: "Runs when a project comes to the front",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      })
    );
    await fs.writeFile(path.join(dir, "main.mjs"), "export function activate() {}\n");
    await fs.writeFile(path.join(dir, "src", "onShown.mjs"), "export default () => {};\n");
  }

  function baseline() {
    return { hosts: devWorkerMock.instances.length, bridges: devWorkerMock.bridges.length };
  }

  it("activates a cold plugin on its event, runs the command, and leaves it disposable", async () => {
    const base = baseline();
    await writeRoutedPlugin("routed", "acme.routed");
    const service = startService();
    await service.initialize();
    // Nothing runs at load: the route is held by the host, not the plugin.
    expect(devWorkerMock.instances).toHaveLength(base.hosts);

    show(BETA);
    await vi.waitFor(() => {
      expect(devWorkerMock.bridges[base.bridges]?.invokeCommand).toHaveBeenCalledTimes(1);
    });
    expect(devWorkerMock.bridges[base.bridges].invokeCommand).toHaveBeenCalledWith(
      "acme.routed.onShown",
      expect.stringContaining("onShown.mjs"),
      { event: "projectForeground", presence: { projectId: BETA, state: "foreground" } },
      // An event route wakes the command with nobody behind it (#16751).
      { dispatchSource: "plugin" }
    );

    // The route is not a live subscription: the worker is still idle-disposable.
    const result = service.disposeIdlePluginWorkers({ now: FUTURE() });
    expect(result.disposed).toEqual(["acme.routed"]);

    // And the route outlives the worker, waking a fresh one on the next event.
    show(ALPHA);
    await vi.waitFor(
      () => {
        expect(devWorkerMock.bridges[base.bridges + 1]?.invokeCommand).toHaveBeenCalledTimes(1);
      },
      { timeout: 3_000 }
    );
    expect(devWorkerMock.instances).toHaveLength(base.hosts + 2);
  });

  it("wakes nothing while the worker is in its crash loop", async () => {
    const base = baseline();
    await writeRoutedPlugin("looping", "acme.looping");
    const service = startService();
    await service.initialize();
    await service.activatePlugin("acme.looping");
    const host = devWorkerMock.instances[base.hosts];
    const onCrashLoop = host.on.mock.calls.find(([event]) => event === "crash-loop")?.[1] as
      ((code: number) => void) | undefined;
    expect(onCrashLoop).toBeTypeOf("function");
    onCrashLoop?.(1);

    show(BETA);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(devWorkerMock.bridges[base.bridges].invokeCommand).not.toHaveBeenCalled();
    expect(devWorkerMock.instances).toHaveLength(base.hosts + 1);
  });

  it("stops listening once the plugin is disabled", async () => {
    let listening = 0;
    const subscribe = tracker.subscribe.bind(tracker);
    vi.spyOn(tracker, "subscribe").mockImplementation((listener) => {
      listening++;
      const off = subscribe(listener);
      return () => {
        listening--;
        off();
      };
    });
    await writeRoutedPlugin("off", "acme.off");
    const service = startService();
    await service.initialize();
    const whileEnabled = listening;
    expect(whileEnabled).toBeGreaterThan(0);

    await service.setEnabled("acme.off", false);
    expect(listening).toBe(whileEnabled - 1);
  });
});
