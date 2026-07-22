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
import { getPluginManifestSchema } from "../../schemas/plugin.js";
import { type PluginIpcContext } from "../../../shared/types/plugin.js";

function makeCtx(pluginId: string, overrides: Partial<PluginIpcContext> = {}): PluginIpcContext {
  return {
    projectId: null,
    worktreeId: null,
    webContentsId: 0,
    pluginId,
    ...overrides,
  };
}

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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Plugin provenance persistence", () => {
  it("creates a sideload record for non-builtin plugin on first load", async () => {
    await writePlugin("fresh", { name: "acme.fresh", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].source).toBe("sideload");
    expect(plugins[0].installedAt).toBeGreaterThan(0);
    expect(plugins[0].archiveHash).toBeNull();
    expect(plugins[0].originalUrl).toBeNull();
    expect(plugins[0].disabled).toBe(false);
    expect(plugins[0].updateAvailable).toBeNull();
    expect(plugins[0].devMode).toBe(false);
    expect(plugins[0].loadError).toBeNull();
  });

  it("built-in plugins return synthetic provenance fields without a store record", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-prov-"));
    try {
      const dir = path.join(builtinDir, "helper");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.helper", version: "1.0.0" })
      );

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
      expect(builtin).toBeDefined();
      expect(builtin!.source).toBe("builtin");
      expect(builtin!.installedAt).toBe(0);
      expect(builtin!.archiveHash).toBeNull();
      expect(builtin!.originalUrl).toBeNull();
      expect(builtin!.loadError).toBeNull();
      expect(builtin!.disabled).toBe(false);
      expect(builtin!.updateAvailable).toBeNull();
      expect(builtin!.devMode).toBe(false);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("preserves installedAt across repeated loads (idempotent record creation)", async () => {
    await writePlugin("persist", { name: "acme.persist", version: "1.0.0" });

    const first = new PluginService(tmpDir);
    await first.initialize();
    const firstInstalledAt = first.listPlugins()[0].installedAt;

    // Second service instance simulates a restart — the store mock persists
    // the record (store is a singleton mock in tests).
    const second = new PluginService(tmpDir);
    await second.initialize();

    const plugins = second.listPlugins();
    expect(plugins[0].installedAt).toBe(firstInstalledAt);
  });

  it("non-builtin plugin with disabled=true is listed but not activated", async () => {
    const pluginDir = path.join(tmpDir, "disabled-nonbuiltin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.disabled-nb",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // main.mjs calls a global to prove activation was skipped
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__disabledActivated = true; export function activate() {}"
    );

    // Pre-seed the store with the unified disabled list (#9284); the
    // provenance record's `disabled` field is set independently by
    // setEnabled() — listing alone surfaces the unified state.
    storeMock._state.set("plugins", {
      disabled: ["acme.disabled-nb"],
      installed: {
        "acme.disabled-nb": {
          source: "sideload",
          installedAt: Date.now(),
          archiveHash: null,
          originalUrl: null,
          disabled: true,
          updateAvailable: null,
          devMode: false,
          loadError: null,
        },
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Run the startup activation pass and an explicit trigger: the disabled
    // plugin is rejected at scan time (never inserted into the plugins map), so
    // neither path can pick it up — that's exactly what we assert below.
    await service.activateStartupFinishedPlugins();
    await service.activatePlugin("acme.disabled-nb");

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.disabled-nb");
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);

    // Activation was skipped — the main.mjs was never imported
    expect((globalThis as Record<string, unknown>).__disabledActivated).toBeUndefined();
  });

  it("writes activation error to the persisted record", async () => {
    const pluginDir = path.join(tmpDir, "err-persist");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.err-persist", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('persisted-boom'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.activatePlugin("acme.err-persist");

    const record = service.getPluginLoadError("acme.err-persist");
    expect(record?.message).toBe("persisted-boom");

    // Also visible via listPlugins
    const plugins = service.listPlugins();
    expect(plugins[0].loadError?.message).toBe("persisted-boom");
  });

  it("clears loadError on a subsequent successful activation", async () => {
    // Use two different plugin directories with distinct names to avoid
    // Node ESM module caching (import() caches by URL, so the same file
    // path would return the cached throwing module).
    const failDir = path.join(tmpDir, "heal-fail");
    await fs.mkdir(failDir);
    await fs.writeFile(
      path.join(failDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-fail", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(failDir, "main.mjs"),
      "globalThis.__healFailCalled = true; export function activate() { throw new Error('first-fail'); }"
    );

    const first = new PluginService(tmpDir);
    await first.initialize();
    await first.activatePlugin("acme.heal-fail");
    expect(first.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");

    // Second plugin: same concept but different dir + name, so ESM cache
    // doesn't interfere. The store still holds the first plugin's error
    // record, confirming persistence works.
    const healDir = path.join(tmpDir, "heal-ok");
    await fs.mkdir(healDir);
    await fs.writeFile(
      path.join(healDir, "plugin.json"),
      JSON.stringify({ name: "acme.heal-ok", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(healDir, "main.mjs"),
      "export function activate() { return () => {}; }"
    );

    const second = new PluginService(tmpDir);
    await second.initialize();
    await second.activatePlugin("acme.heal-ok");

    // New plugin loaded successfully — no error
    expect(second.getPluginLoadError("acme.heal-ok")).toBeUndefined();
    const plugins = second.listPlugins();
    const healed = plugins.find((p) => p.manifest.name === "acme.heal-ok");
    expect(healed?.loadError).toBeNull();

    // Original failed plugin's error still in the store
    expect(second.getPluginLoadError("acme.heal-fail")?.message).toBe("first-fail");
  });

  it("getPluginLoadError returns undefined for an unknown plugin", () => {
    const service = new PluginService(tmpDir);
    expect(service.getPluginLoadError("acme.never-existed")).toBeUndefined();
  });

  it("listPlugins includes all provenance fields in output", async () => {
    await writePlugin("full-prov", { name: "acme.full-prov", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const [plugin] = service.listPlugins();
    expect(Object.keys(plugin)).toContain("source");
    expect(Object.keys(plugin)).toContain("installedAt");
    expect(Object.keys(plugin)).toContain("archiveHash");
    expect(Object.keys(plugin)).toContain("originalUrl");
    expect(Object.keys(plugin)).toContain("loadError");
    expect(Object.keys(plugin)).toContain("disabled");
    expect(Object.keys(plugin)).toContain("updateAvailable");
    expect(Object.keys(plugin)).toContain("devMode");
    // Runtime fields still present
    expect(Object.keys(plugin)).toContain("manifest");
    expect(Object.keys(plugin)).toContain("dir");
    expect(Object.keys(plugin)).toContain("loadedAt");
    expect(Object.keys(plugin)).toContain("isBuiltin");
    // Internal field still excluded
    expect(Object.keys(plugin)).not.toContain("resolvedMain");
  });

  it("disabled builtin returns disabled=true in listPlugins output", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-dis-"));
    try {
      const dir = path.join(builtinDir, "muted");
      await fs.mkdir(dir);
      await fs.writeFile(
        path.join(dir, "plugin.json"),
        JSON.stringify({ name: "daintree.muted", version: "1.0.0" })
      );

      storeMock._state.set("plugins", { disabled: ["daintree.muted"], installed: {} });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      // Disabled builtins are tracked in `disabledPlugins` so listPlugins()
      // can surface them for the Preferences toggle (#9284); they are not
      // activated. The entry reports disabled=true.
      const plugins = service.listPlugins();
      const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
      expect(muted).toBeDefined();
      expect(muted!.disabled).toBe(true);
      expect(muted!.loadedAt).toBe(0);
    } finally {
      await fs.rm(builtinDir, { recursive: true, force: true });
    }
  });

  it("plugin with dot in name stores record without nesting", async () => {
    // Plugin names are scoped as "publisher.name" — a single dot is valid.
    // electron-store's dotNotation would split "acme.foo" into nested keys
    // if written per-field, so we write the whole `plugins.installed` object.
    const pluginDir = path.join(tmpDir, "dot-plugin");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.foo", version: "1.0.0" })
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.foo");

    // Record stored under the dotted name without nesting
    const stored = storeMock._state.get("plugins") as
      { installed?: Record<string, unknown> } | undefined;
    expect(stored?.installed).toHaveProperty("acme.foo");
    expect(stored?.installed?.["acme.foo"]).toBeDefined();
  });
});

describe("PluginManifestSchema activationEvents field", () => {
  const schema = getPluginManifestSchema(false);

  it("defaults to an empty array when omitted", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.activationEvents).toEqual([]);
    }
  });

  it("accepts an explicit ['onStartupFinished']", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onStartupFinished"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown activation event strings (no onCommand/onView in v1)", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: ["onCommand:foo"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array activationEvents value", () => {
    const result = schema.safeParse({
      name: "acme.foo",
      version: "1.0.0",
      activationEvents: "onStartupFinished",
    });
    expect(result.success).toBe(false);
  });
});

describe("Deferred activation — activatePlugin", () => {
  it("lazy by default: no activationEvents stays deferred through activateStartupFinishedPlugins, activates on first use (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "deferred-import");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.deferred-import", version: "1.0.0", main: "main.mjs" })
    );
    // The module sets a global as a side effect at import time. If the
    // module were imported during initialize()/startup the global would be set
    // before we explicitly activate.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__deferredImportRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // Scan must register the plugin (contributions populated) but must NOT
      // have imported its main module yet.
      expect(service.hasPlugin("acme.deferred-import")).toBe(true);
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBeUndefined();

      // With no activationEvents the plugin is lazy: startup activation must
      // leave it deferred (the inverse of the pre-#10523 behavior).
      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBeUndefined();

      // An explicit first-use trigger imports main and runs activate().
      await service.activatePlugin("acme.deferred-import");
      expect((globalThis as Record<string, unknown>).__deferredImportRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__deferredImportRan;
    }
  });

  it("activatePlugin is idempotent — _doActivate runs once across concurrent callers", async () => {
    const pluginDir = path.join(tmpDir, "dedup-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.dedup-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__dedupCount = (globalThis.__dedupCount ?? 0) + 1; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Fan out activation from three concurrent callers; the in-flight
      // promise dedup means _doActivate runs exactly once.
      await Promise.all([
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
        service.activatePlugin("acme.dedup-activate"),
      ]);

      // A fourth call after the first settled should hit the synchronous
      // `activatedPlugins` fast path and not re-import either.
      await service.activatePlugin("acme.dedup-activate");

      expect((globalThis as unknown as Record<string, number>).__dedupCount).toBe(1);
    } finally {
      delete (globalThis as unknown as Record<string, number>).__dedupCount;
    }
  });

  it("activatePlugin does not reject when activate() throws", async () => {
    const pluginDir = path.join(tmpDir, "throwy-but-stable");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.throwy-but-stable", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { throw new Error('nope'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Implicit-trigger contract: the promise resolves so callers don't
      // need a try/catch around every dispatch.
      await expect(service.activatePlugin("acme.throwy-but-stable")).resolves.toBeUndefined();
      // Error is persisted to the provenance record instead of propagating.
      expect(service.getPluginLoadError("acme.throwy-but-stable")?.message).toBe("nope");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("activatePlugin can re-run after a failure (Settings → Retry)", async () => {
    const pluginDir = path.join(tmpDir, "retry-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.retry-activate", version: "1.0.0", main: "main.mjs" })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__retryCount = (globalThis.__retryCount ?? 0) + 1; export function activate() { throw new Error('retry-boom'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.retry-activate");

      // After a failure the in-flight entry is dropped so a retry calls
      // through to _doActivate again. ESM import() is URL-cached, so the
      // module is only evaluated once — but `activate()` still runs again
      // on the cached exports. Assert via the persisted error record.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");

      await service.activatePlugin("acme.retry-activate");
      // The fact that this resolves and re-records the error proves the
      // promise was not cached as a settled success.
      expect(service.getPluginLoadError("acme.retry-activate")?.message).toBe("retry-boom");
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as unknown as Record<string, number>).__retryCount;
    }
  });

  it("activateStartupFinishedPlugins activates plugins with activationEvents=['onStartupFinished']", async () => {
    const pluginDir = path.join(tmpDir, "explicit-onstartup");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.explicit-onstartup",
        version: "1.0.0",
        main: "main.mjs",
        activationEvents: ["onStartupFinished"],
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__explicitOnstartupRan = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBeUndefined();

      await service.activateStartupFinishedPlugins();
      expect((globalThis as Record<string, unknown>).__explicitOnstartupRan).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__explicitOnstartupRan;
    }
  });

  it("activatePluginForView resolves the owning plugin from contributes.panels and activates it (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-owner");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-owner",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__viewOwnerActivated = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // Lazy: registered but not yet activated.
      expect(service.hasPlugin("acme.view-owner")).toBe(true);
      expect((globalThis as Record<string, unknown>).__viewOwnerActivated).toBeUndefined();

      // Opening the contributed panel view (kind id `${pluginId}.${panel.id}`)
      // triggers first-use activation and reports success (#10618).
      await expect(service.activatePluginForView("acme.view-owner.viewer")).resolves.toEqual({
        ok: true,
      });
      expect((globalThis as Record<string, unknown>).__viewOwnerActivated).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__viewOwnerActivated;
    }
  });

  it("activatePluginForView is a no-op for an unknown or empty panel kind id (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-noop");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-noop",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__viewNoopActivated = true; export function activate() {}"
    );

    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // Unknown kind id — and a non-matching bare id — must not activate
      // anything, and report ok (nothing to activate; #10618).
      await expect(service.activatePluginForView("acme.view-noop.nope")).resolves.toEqual({
        ok: true,
      });
      await expect(service.activatePluginForView("viewer")).resolves.toEqual({ ok: true });
      await expect(service.activatePluginForView("")).resolves.toEqual({ ok: true });
      expect((globalThis as Record<string, unknown>).__viewNoopActivated).toBeUndefined();
    } finally {
      delete (globalThis as Record<string, unknown>).__viewNoopActivated;
    }
  });

  it("activatePluginForView records loadError on activation failure and retries on a second open (#10523)", async () => {
    const pluginDir = path.join(tmpDir, "view-fail");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-fail",
        version: "1.0.0",
        main: "main.mjs",
        contributes: {
          panels: [
            {
              id: "viewer",
              name: "Viewer",
              iconId: "eye",
              color: "#000",
              hasPty: false,
              canRestart: false,
              canConvert: false,
              showInPalette: true,
            },
          ],
          views: [{ id: "viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { globalThis.__viewFailActivateCount = (globalThis.__viewFailActivateCount ?? 0) + 1; throw new Error('view-activate-boom'); }"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      // First open: activation fails but never rejects; contributions survive.
      // The failure is surfaced as a plain { ok: false } result (#10618) carrying
      // the real activate() error so PluginViewHost can throw it before import.
      // (toMatchObject because the result also carries the diagnostic `stack`.)
      await expect(service.activatePluginForView("acme.view-fail.viewer")).resolves.toMatchObject({
        ok: false,
        error: "view-activate-boom",
      });
      expect(service.getPluginLoadError("acme.view-fail")?.message).toBe("view-activate-boom");
      expect(service.hasPlugin("acme.view-fail")).toBe(true);
      expect((globalThis as Record<string, unknown>).__viewFailActivateCount).toBe(1);

      // Second open: the failed in-flight entry was cleared, so activation runs
      // again (Settings → Retry / re-open semantics) rather than returning a
      // cached settled promise — proven by the activate() invocation count.
      await expect(service.activatePluginForView("acme.view-fail.viewer")).resolves.toMatchObject({
        ok: false,
        error: "view-activate-boom",
      });
      expect(service.getPluginLoadError("acme.view-fail")?.message).toBe("view-activate-boom");
      expect((globalThis as Record<string, unknown>).__viewFailActivateCount).toBe(2);
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).__viewFailActivateCount;
    }
  });

  it("a hanging activation times out instead of stalling forever", async () => {
    const pluginDir = path.join(tmpDir, "hanging-import");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.hanging-import", version: "1.0.0", main: "main.mjs" })
    );
    // Top-level `await new Promise(() => {})` hangs the worker's import forever.
    // The worker is isolated (it can't stall main), but the activation gate must
    // still time out so `Promise.allSettled` startup fan-outs aren't pinned.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "await new Promise(() => {}); export function activate() {}"
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      // The promise resolves (it doesn't reject — `activatePlugin` swallows) and
      // the activation-timeout error is persisted as the loadError so diagnostics
      // surface why the plugin never came up.
      await service.activatePlugin("acme.hanging-import");
      const record = service.getPluginLoadError("acme.hanging-import");
      expect(record?.message).toContain("did not settle");
    } finally {
      errorSpy.mockRestore();
    }
  }, 10_000);

  it("unloadPlugin during a racing activation does not leak activatedPlugins state", async () => {
    const pluginDir = path.join(tmpDir, "race-unload");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.race-unload", version: "1.0.0", main: "main.mjs" })
    );
    // Activate resolves successfully but the test will unload mid-flight so
    // the .then handler sees a tombstoned plugins map.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate() { return () => {}; }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    const activation = service.activatePlugin("acme.race-unload");
    // Synchronously unload before the activation promise resolves. The
    // plugin is still in `this.plugins` at this point (activation is
    // mid-flight), so unload runs fully.
    service.unloadPlugin("acme.race-unload");
    await activation;

    // The .then(success) handler now runs after unload; the guard must
    // prevent re-adding the id to `activatedPlugins`.
    expect(service.hasPlugin("acme.race-unload")).toBe(false);
    expect(
      (service as unknown as { activatedPlugins: Set<string> }).activatedPlugins.has(
        "acme.race-unload"
      )
    ).toBe(false);
    expect(
      (service as unknown as { cleanupMap: Map<string, () => void> }).cleanupMap.has(
        "acme.race-unload"
      )
    ).toBe(false);
  });

  it("dispatchHandler implicitly activates the owning plugin before lookup", async () => {
    const pluginDir = path.join(tmpDir, "implicit-dispatch");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.implicit-dispatch",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // The plugin's activate() registers a handler. If dispatchHandler did
    // not force activation first, the handler would not be registered yet
    // and the dispatch would throw "No plugin handler registered".
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "export function activate(host) { host.registerHandler('probe', () => 'pong'); }"
    );

    const service = new PluginService(tmpDir);
    await service.initialize();
    // Crucially, do NOT call activateStartupFinishedPlugins(). The dispatch
    // path itself must trigger activation.
    const result = await service.dispatchHandler(
      "acme.implicit-dispatch",
      "probe",
      makeCtx("acme.implicit-dispatch"),
      []
    );
    expect(result).toBe("pong");
  });
});
