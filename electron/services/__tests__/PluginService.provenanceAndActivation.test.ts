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
import { getPluginManifestSchema } from "../../schemas/plugin.js";
import {
  makeProjectPluginInstanceKey,
  type PluginIpcContext,
} from "../../../shared/types/plugin.js";
import { toRuntimePanelKindId } from "../../../shared/config/panelKindRegistry.js";
import { registerPanelKind } from "../../../shared/config/panelKindRegistry.js";
import { stripPluginViewGeneration } from "../../../shared/utils/pluginViewUrl.js";

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
  const schema = getPluginManifestSchema("user");

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

  it("commits the plugin to the map before publishing an addressable panel (#11728)", async () => {
    // The core invariant, asserted in a suite the PR gate actually runs — the
    // real-registry version of this lives in PluginService.integration.test.ts,
    // which the default vitest config excludes.
    //
    // `registerPanelKind` IS the publication point: it carries the `plugin://`
    // componentPath and schedules the broadcast. Resolving that URL's authority
    // from inside the mock therefore samples the exact instant the renderer
    // becomes able to request that module. Checking after `initialize()` would prove
    // nothing — by then everything is in the map regardless of ordering.
    //
    // The fixture contributes a skill because its `await` is what used to sit
    // between publication and the map commit.
    const pluginDir = path.join(tmpDir, "view-order");
    await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-order",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#123" }],
          views: [{ id: "viewer", componentPath: "view.mjs", location: "panel" }],
          skills: [{ id: "s", name: "S", path: "./skills/s.md", triggers: ["s"] }],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "skills", "s.md"),
      "---\ndescription: d\n---\n\nbody\n",
      "utf8"
    );

    const service = new PluginService(tmpDir);
    const observed: Array<{
      id: string;
      resolvedDir: string | undefined;
      aliasDir: string | undefined;
    }> = [];
    vi.mocked(registerPanelKind).mockImplementation((config) => {
      if (!config.componentPath || !config.extensionId) return;
      observed.push({
        id: config.id,
        resolvedDir: service.getPluginRootByAuthority(new URL(config.componentPath).hostname),
        aliasDir: service.getPluginRootByAuthority(config.extensionId),
      });
    });

    try {
      await service.initialize();
    } finally {
      vi.mocked(registerPanelKind).mockReset();
    }

    expect(observed).toHaveLength(1);
    expect(observed[0]!.id).toBe("acme.view-order.viewer");
    // Before the fix this was `undefined`: the panel was published while the
    // plugin was still absent from the map the resolver reads.
    expect(observed[0]!.resolvedDir).toBe(pluginDir);
    expect(observed[0]!.aliasDir).toBe(pluginDir);
  });

  it("addresses views by an opaque authority that unload invalidates", async () => {
    const pluginDir = path.join(tmpDir, "view-authority");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-authority",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#123" }],
          views: [{ id: "viewer", componentPath: "view.mjs", location: "panel" }],
        },
      })
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const published = vi
      .mocked(registerPanelKind)
      .mock.calls.map(([config]) => config)
      .find((config) => config.id === "acme.view-authority.viewer");
    const authority = new URL(published!.componentPath!).hostname;

    // Random per load, never the manifest id — a derived authority would carry
    // the id collision it exists to prevent straight back in.
    expect(authority).not.toBe("acme.view-authority");
    expect(authority).toMatch(/^pi-[0-9a-f]{32}$/);
    expect(service.getPluginRootByAuthority(authority)).toBe(pluginDir);
    // The manifest id is an alias for the same root, because plugin authors
    // write `plugin://{pluginId}/…` by hand.
    expect(service.getPluginRootByAuthority("acme.view-authority")).toBe(pluginDir);

    service.unloadPlugin("acme.view-authority");

    // A URL the renderer captured before the unload now addresses nothing —
    // not the old root, and not whatever next occupies that plugin id.
    expect(service.getPluginRootByAuthority(authority)).toBeUndefined();
    expect(service.getPluginRootByAuthority("acme.view-authority")).toBeUndefined();
  });

  it("activatePluginForView mints one shared recovery view generation per load (#11728)", async () => {
    const pluginDir = path.join(tmpDir, "view-recover");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.view-recover",
        version: "1.0.0",
        contributes: {
          panels: [
            { id: "one", name: "One", iconId: "eye", color: "#111" },
            { id: "two", name: "Two", iconId: "pen", color: "#222" },
            { id: "term", name: "Term", iconId: "terminal", color: "#333", hasPty: true },
          ],
          views: [
            { id: "one", componentPath: "one.mjs", location: "panel" },
            { id: "two", componentPath: "two.mjs", location: "panel" },
          ],
        },
      })
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    // The paths actually handed to the renderer at load, read back off the
    // registry call rather than reconstructed — reconstructing them here would
    // just restate the implementation.
    const published = new Map<string, string>();
    for (const [config] of vi.mocked(registerPanelKind).mock.calls) {
      if (config.componentPath) published.set(config.id, config.componentPath);
    }
    const primaryOne = published.get("acme.view-recover.one");
    const primaryTwo = published.get("acme.view-recover.two");
    expect(primaryOne).toBeDefined();
    expect(primaryTwo).toBeDefined();

    // No recovery requested → nothing minted. A first mount must not burn a
    // second module namespace.
    await expect(service.activatePluginForView("acme.view-recover.one")).resolves.toEqual({
      ok: true,
    });

    const first = await service.activatePluginForView("acme.view-recover.one", true);
    const second = await service.activatePluginForView("acme.view-recover.two", true);
    const third = await service.activatePluginForView("acme.view-recover.one", true);

    // Parse rather than string-match, so the assertions below are about URL
    // structure (host, file, generation) instead of a formatting literal.
    const parse = (url: string): { host: string; file: string; generation: number | null } => {
      const parsed = new URL(url);
      const stripped = stripPluginViewGeneration(parsed.pathname.slice(1));
      return {
        host: parsed.hostname,
        file: stripped?.path ?? "",
        generation: stripped?.generation ?? null,
      };
    };

    const recoveredOne = (first as { recoveryComponentPath?: string }).recoveryComponentPath;
    const recoveredTwo = (second as { recoveryComponentPath?: string }).recoveryComponentPath;
    const recoveredAgain = (third as { recoveryComponentPath?: string }).recoveryComponentPath;
    expect(recoveredOne).toBeDefined();
    expect(recoveredTwo).toBeDefined();

    const one = parse(recoveredOne!);
    const two = parse(recoveredTwo!);
    const primary = parse(primaryOne!);
    const primaryB = parse(primaryTwo!);

    // Both really carry a generation. Without this, a recovery URL that dropped
    // the segment entirely would satisfy the "differs from primary" check below
    // on `null`, and the test would bless a URL that recovers nothing.
    expect(typeof one.generation).toBe("number");
    expect(typeof two.generation).toBe("number");

    // A URL V8 has never seen — the entire point, since the module map keys the
    // failure by specifier and never evicts it.
    expect(one.generation).not.toBe(primary.generation);
    // ...addressing the same plugin and the same file behind it: only the
    // virtual namespace changed. Without the host/file checks, returning another
    // plugin's URL — or panel `one`'s module for panel `two` — would pass.
    expect(one.host).toBe(primary.host);
    expect(one.file).toBe(primary.file);
    expect(two.host).toBe(primaryB.host);
    expect(two.file).toBe(primaryB.file);
    expect(one.file).not.toBe(two.file);

    // One generation for the whole plugin, so a reload still swaps every view
    // together and relative imports keep resolving within one namespace.
    expect(two.generation).toBe(one.generation);
    // Bounded: retrying again reuses it instead of minting a third namespace.
    expect(recoveredAgain).toBe(recoveredOne);

    // A PTY panel is rendered by TerminalPane, so there is no module to recover.
    await expect(service.activatePluginForView("acme.view-recover.term", true)).resolves.toEqual({
      ok: true,
    });
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

      // A timeout is a FAILURE, not a slow success (#12275). Caching the id here
      // made the panel's retry control a no-op forever, because every later
      // `activatePlugin` short-circuited on the fast path.
      const internals = service as unknown as {
        activatedPlugins: Set<string>;
        activationPromises: Map<string, Promise<void>>;
      };
      expect(internals.activatedPlugins.has("acme.hanging-import")).toBe(false);
      expect(internals.activationPromises.has("acme.hanging-import")).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  }, 10_000);

  it("a timed-out activation can be retried and succeed (#12275)", async () => {
    const pluginDir = path.join(tmpDir, "hanging-activate");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "acme.hanging-activate", version: "1.0.0", main: "main.mjs" })
    );
    // Hangs the first time, succeeds the second — so the invocation count proves
    // the retry genuinely re-ran activate() rather than returning a cached
    // "activated" latch the timeout left behind.
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      `export function activate() {
         globalThis.__hangActivateCount = (globalThis.__hangActivateCount ?? 0) + 1;
         if (globalThis.__hangActivateCount === 1) return new Promise(() => {});
         return () => {};
       }`
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      openedServices.push(service);
      await service.initialize();

      await service.activatePlugin("acme.hanging-activate");
      expect((globalThis as Record<string, unknown>).__hangActivateCount).toBe(1);
      expect(service.getPluginLoadError("acme.hanging-activate")?.message).toContain(
        "did not settle"
      );

      await service.activatePlugin("acme.hanging-activate");

      expect((globalThis as Record<string, unknown>).__hangActivateCount).toBe(2);
      expect(
        (service as unknown as { activatedPlugins: Set<string> }).activatedPlugins.has(
          "acme.hanging-activate"
        )
      ).toBe(true);
      // The timeout's record is cleared by the successful retry.
      expect(service.getPluginLoadError("acme.hanging-activate")?.message).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      delete (globalThis as Record<string, unknown>).__hangActivateCount;
    }
  }, 15_000);

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

/**
 * A project plugin loads under an instance key the installed-record store
 * deliberately refuses to persist, so every `loadError` it wrote went nowhere
 * and the host reported a clean load however activation had gone (#12232).
 */
describe("project plugin load errors", () => {
  const PROJECT_ID = "a".repeat(64);
  const PLUGIN_ID = "acme.project-boom";
  const INSTANCE_KEY = makeProjectPluginInstanceKey(PROJECT_ID, PLUGIN_ID);
  const PANEL_KIND_ID = ((): string => {
    const id = toRuntimePanelKindId(
      { origin: "project", pluginId: PLUGIN_ID, kindId: "main" },
      PROJECT_ID
    );
    // Never coerce a null away here: `activatePluginForView` resolves an
    // unknown kind id to `{ ok: true }`, so a bad id would make every
    // assertion below pass without exercising anything.
    if (id === null) throw new Error("could not build the project panel kind id");
    return id;
  })();

  /**
   * A project root holding one lazily-activated plugin — no `activationEvents`,
   * so nothing runs until a view asks for it, which is exactly the path the
   * issue reports.
   */
  async function writeProjectPlugin(body: string): Promise<string> {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-project-"));
    extraTempRoots.push(projectRoot);
    const dir = path.join(projectRoot, ".daintree", "plugins", PLUGIN_ID);
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: PLUGIN_ID,
        version: "1.0.0",
        scope: "project",
        main: "dist/index.js",
        contributes: {
          panels: [
            { id: "main", name: "Boom", iconId: "puzzle", color: "var(--theme-category-orange)" },
          ],
          views: [{ id: "main", componentPath: "dist/panel.js", location: "panel" }],
        },
      })
    );
    await fs.writeFile(path.join(dir, "dist", "index.js"), body);
    await fs.writeFile(path.join(dir, "dist", "panel.js"), "export default function Panel() {}");
    // Trust is already granted and the id already known, so the reconcile loads
    // the plugin rather than staging it behind a prompt.
    storeMock._state.set("projectPluginTrust", {
      [PROJECT_ID]: {
        decision: "enabled",
        decidedAt: 1,
        knownPluginIds: [PLUGIN_ID],
        stagedPluginIds: [],
      },
    });
    return projectRoot;
  }

  async function openWithPlugin(body: string): Promise<PluginService> {
    const projectRoot = await writeProjectPlugin(body);
    const service = new PluginService(tmpDir);
    // Registered before the awaits below: a throw in `initialize` or
    // `onProjectOpened` would otherwise strand a service — and its native
    // project-plugin watcher — with no caller left to dispose it.
    openedServices.push(service);
    await service.initialize();
    await service.onProjectOpened(PROJECT_ID, projectRoot);
    return service;
  }

  /** Rows from the most recent `plugin:project-plugins-changed` push. */
  function lastPushedRows(): Array<{ loadError?: { message: string } }> | undefined {
    const pushed = broadcastToProjectRenderersMock.mock.calls.filter(
      (call) =>
        (call[2] as { name?: string } | undefined)?.name === "plugin:project-plugins-changed"
    );
    return (
      pushed.at(-1)?.[2] as
        { payload: { plugins: Array<{ loadError?: { message: string } }> } } | undefined
    )?.payload.plugins;
  }

  /** The bridge for the most recent activation, for driving stale callbacks. */
  function latestBridge(): { deps: { onActivationResult?: (r: unknown) => void } } {
    const bridge = devWorkerMock.bridges.at(-1);
    if (!bridge) throw new Error("no worker bridge was created");
    return bridge as unknown as { deps: { onActivationResult?: (r: unknown) => void } };
  }

  it("returns the real cause from activatePluginForView instead of a clean result", async () => {
    const service = await openWithPlugin(
      "export function activate() { throw new Error('project-boom'); }"
    );
    // The row is loaded but nothing has run it yet.
    expect(service.getPluginLoadError(INSTANCE_KEY)).toBeUndefined();

    const result = await service.activatePluginForView(PANEL_KIND_ID);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("project-boom");
    const recorded = service.getPluginLoadError(INSTANCE_KEY);
    expect(recorded?.message).toContain("project-boom");
    // The plugin's own stack, not the host's: the activation rejection that
    // follows `onActivationResult` carries a main-process Error built here, and
    // letting it overwrite would throw away the only frame that says where in
    // the plugin the failure was.
    expect(recorded?.stack).toContain("index.js");

    // A lazy failure has no controller mutation behind it, so without its own
    // push the manager would keep describing this plugin as clean.
    expect(lastPushedRows()?.[0]?.loadError?.message).toContain("project-boom");
  });

  it("keeps the instance key out of the persisted provenance record", async () => {
    const service = await openWithPlugin(
      "export function activate() { throw new Error('project-boom'); }"
    );
    await service.activatePluginForView(PANEL_KIND_ID);

    // The whole reason the error lives in memory: the key names one machine's
    // project id and must never reach `plugins.installed`.
    const plugins = storeMock._state.get("plugins") as
      { installed?: Record<string, unknown> } | undefined;
    expect(Object.keys(plugins?.installed ?? {})).not.toContain(INSTANCE_KEY);
    expect(Object.keys(plugins?.installed ?? {})).toHaveLength(0);
  });

  it("marks the row active and attaches the error, and drops both on unload", async () => {
    const service = await openWithPlugin(
      "export function activate() { throw new Error('project-boom'); }"
    );
    await service.activatePluginForView(PANEL_KIND_ID);

    const [row] = service.listProjectPlugins(PROJECT_ID);
    // It loaded and holds its contributions — the failure is about the last
    // run, not a different kind of row.
    expect(row?.state).toBe("active");
    expect(row?.loadError?.message).toContain("project-boom");

    // The unload cascade owns the error's lifetime: nothing outlives the load.
    await service.setProjectPluginTrust(PROJECT_ID, "disabled");
    expect(service.getPluginLoadError(INSTANCE_KEY)).toBeUndefined();
  });

  it("carries the failure into listPlugins, which the manager and bug reports read", async () => {
    // The half of the gap `listProjectPlugins` does not cover. This row was
    // built from the installed provenance record, which a project instance key
    // is never written to — so PluginManagerView, PluginDetailPane and
    // `getDiagnosticsSnapshot` (#12222) all described a plugin that had just
    // thrown as a clean one.
    const service = await openWithPlugin(
      "export function activate() { throw new Error('project-boom'); }"
    );
    await service.activatePluginForView(PANEL_KIND_ID);

    const row = service.listPlugins().find((p) => p.instanceId === INSTANCE_KEY);
    expect(row?.origin).toBe("project");
    expect(row?.loadError?.message).toContain("project-boom");

    // Same field, read straight off that row — and the only thing a bug report
    // filed against this plugin would have to go on.
    const diagnostic = service
      .getDiagnosticsSnapshot()
      .plugins.find((p) => p.pluginId === INSTANCE_KEY);
    expect(diagnostic?.loadError?.message).toContain("project-boom");
  });

  it("reports a clean listPlugins row for a project plugin that ran", async () => {
    const service = await openWithPlugin("export function activate() { return () => {}; }");
    await service.activatePluginForView(PANEL_KIND_ID);

    const row = service.listPlugins().find((p) => p.instanceId === INSTANCE_KEY);
    expect(row?.origin).toBe("project");
    expect(row?.loadError).toBeNull();
  });

  it("reports a clean load for a project plugin whose activate() succeeds", async () => {
    const service = await openWithPlugin("export function activate() { return () => {}; }");

    const result = await service.activatePluginForView(PANEL_KIND_ID);

    expect(result.ok).toBe(true);
    expect(service.getPluginLoadError(INSTANCE_KEY)).toBeUndefined();
    expect(service.listProjectPlugins(PROJECT_ID)[0]?.loadError).toBeUndefined();
  });

  it("clears the error when the same instance later activates cleanly", async () => {
    const service = await openWithPlugin(
      "export function activate() { throw new Error('project-boom'); }"
    );
    await service.activatePluginForView(PANEL_KIND_ID);
    expect(service.getPluginLoadError(INSTANCE_KEY)?.message).toContain("project-boom");

    // What a dev-mode reload does after the author fixes the bug: the same live
    // bridge reports a fresh, successful outcome. Without the clear the plugin
    // would read as broken for the rest of the session.
    latestBridge().deps.onActivationResult?.({ ok: true });

    expect(service.getPluginLoadError(INSTANCE_KEY)).toBeUndefined();
    expect(service.listProjectPlugins(PROJECT_ID)[0]?.loadError).toBeUndefined();
    expect(lastPushedRows()?.[0]?.loadError).toBeUndefined();
  });

  describe("a stale generation under the same instance key", () => {
    /**
     * A project plugin unloads and reloads under an identical key on every
     * disable/enable, dev reload and project reopen, so the two generations are
     * indistinguishable by id — only by object identity. These drive the first
     * generation's callback after the second has replaced it.
     */
    async function reloadUnderSameKey(service: PluginService): Promise<void> {
      await service.setProjectPluginTrust(PROJECT_ID, "disabled");
      await service.setProjectPluginTrust(PROJECT_ID, "enabled");
      expect(service.listProjectPlugins(PROJECT_ID)[0]?.state).toBe("active");
    }

    it("cannot pin its failure on the healthy instance that replaced it", async () => {
      const service = await openWithPlugin("export function activate() { return () => {}; }");
      await service.activatePluginForView(PANEL_KIND_ID);
      const stale = latestBridge();

      await reloadUnderSameKey(service);

      stale.deps.onActivationResult?.({ ok: false, error: "stale-boom", stack: "stale" });

      expect(service.getPluginLoadError(INSTANCE_KEY)).toBeUndefined();
      expect(service.listProjectPlugins(PROJECT_ID)[0]?.loadError).toBeUndefined();
    });

    it("cannot clear the real error of the instance that replaced it", async () => {
      const service = await openWithPlugin(
        "export function activate() { throw new Error('project-boom'); }"
      );
      await service.activatePluginForView(PANEL_KIND_ID);
      const stale = latestBridge();

      await reloadUnderSameKey(service);
      // The replacement re-runs the same throwing bundle, so it has its own
      // real error — one the previous generation's late success must not wipe.
      await service.activatePluginForView(PANEL_KIND_ID);
      expect(service.getPluginLoadError(INSTANCE_KEY)?.message).toContain("project-boom");

      stale.deps.onActivationResult?.({ ok: true });

      expect(service.getPluginLoadError(INSTANCE_KEY)?.message).toContain("project-boom");
    });
  });
});
