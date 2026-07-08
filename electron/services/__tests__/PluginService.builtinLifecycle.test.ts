import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";
import type { PanelKindConfig } from "../../../shared/config/panelKindRegistry.js";

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

import { z } from "zod";
import { PluginService } from "../PluginService.js";
import { events } from "../events.js";
import { PluginProcessManager, type ManagedChildProcess } from "../plugin/PluginProcessManager.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../plugin-capability/instances.js";
import { getPluginActionAuditService } from "../PluginActionAuditService.js";
import { setPtyClientRef } from "../../window/serviceRefs.js";
import { isAuditedHandlerFailure } from "../../utils/pluginAuditMarker.js";
import { PluginInvokeOwnershipError } from "../plugin/PluginInvokeErrors.js";
import { getPluginManifestSchema, isPrivateOrLoopbackHostname } from "../../schemas/plugin.js";
import {
  BUILT_IN_PLUGIN_CAPABILITIES,
  type PluginIpcContext,
  type PluginManifest,
} from "../../../shared/types/plugin.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import {
  getRegisteredForgeProviders,
  registerForgeProviderImpl,
  registerForgeProviders,
  unregisterForgeProviderImpl,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";
import {
  unregisterFileDecorationProviders,
  unregisterFileDecorationProviderImpls,
} from "../fileDecorationRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  PluginBlocklistService,
  type ParsedPluginBlocklist,
} from "../plugin/PluginBlocklistService.js";

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

describe("PluginService built-in plugin loading", () => {
  let builtinDir: string;

  async function writeBuiltinPlugin(
    name: string,
    manifest: Record<string, unknown>
  ): Promise<void> {
    const dir = path.join(builtinDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
  }

  beforeEach(async () => {
    builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-builtin-plugin-test-"));
  });

  afterEach(async () => {
    await fs.rm(builtinDir, { recursive: true, force: true });
  });

  it("tags plugins loaded from the built-in directory with isBuiltin=true", async () => {
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const builtin = plugins.find((p) => p.manifest.name === "daintree.helper");
    const user = plugins.find((p) => p.manifest.name === "acme.user-plugin");
    expect(builtin?.isBuiltin).toBe(true);
    expect(user?.isBuiltin).toBe(false);
  });

  it("user plugins receive isBuiltin=false even when no built-in dir is configured", async () => {
    await writePlugin("acme.user-only", {
      name: "acme.user-only",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0");
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("skips built-in scan cleanly when the directory is absent", async () => {
    const missingDir = path.join(builtinDir, "does-not-exist");
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: missingDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.user-plugin");
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("built-ins win when a user plugin declares the same manifest name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writeBuiltinPlugin("collision", {
        name: "daintree.dupe",
        version: "1.0.0",
        description: "builtin",
      });
      await writePlugin("collision-user", {
        name: "daintree.dupe",
        version: "2.0.0",
        description: "user",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].manifest.description).toBe("builtin");
      expect(plugins[0].isBuiltin).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid manifest in collision-user`),
        expect.anything()
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("skips built-ins listed in plugins.disabled but still lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.muted"] });
    await writeBuiltinPlugin("muted", {
      name: "daintree.muted",
      version: "1.0.0",
    });
    await writeBuiltinPlugin("kept", {
      name: "daintree.kept",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    const kept = plugins.find((p) => p.manifest.name === "daintree.kept");
    const muted = plugins.find((p) => p.manifest.name === "daintree.muted");
    expect(kept?.disabled).toBe(false);
    expect(muted?.disabled).toBe(true);
    expect(muted?.isBuiltin).toBe(true);
  });

  it("skips user plugins listed in plugins.disabled and lists them as disabled", async () => {
    storeMock._state.set("plugins", { disabled: ["acme.user-plugin"] });
    await writePlugin("acme.user-plugin", {
      name: "acme.user-plugin",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(false);
  });

  it("marks active plugins with disabled=false", async () => {
    await writePlugin("acme.active", { name: "acme.active", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(false);
  });

  it("treats missing plugins.disabled as empty (no exception)", async () => {
    // store has no "plugins" key at all (in-memory fallback shape)
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("ignores malformed disabled values defensively", async () => {
    storeMock._state.set("plugins", { disabled: "not-an-array" });
    await writeBuiltinPlugin("daintree.helper", {
      name: "daintree.helper",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(service.listPlugins()[0].disabled).toBe(false);
  });

  it("a disabled name collision keeps the built-in entry (loaded first) for the toggle", async () => {
    storeMock._state.set("plugins", { disabled: ["daintree.github"] });
    await writeBuiltinPlugin("github", {
      name: "daintree.github",
      version: "1.0.0",
      description: "first-party",
    });
    await writePlugin("hijacker", {
      name: "daintree.github",
      version: "9.9.9",
      description: "third-party impostor",
    });

    const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].disabled).toBe(true);
    expect(plugins[0].isBuiltin).toBe(true);
    expect(plugins[0].manifest.description).toBe("first-party");
  });

  describe("setEnabled", () => {
    it("adds a plugin id to plugins.disabled when disabling", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("removes a plugin id from plugins.disabled when enabling", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo", "acme.bar"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", true);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.bar"] });
    });

    it("is idempotent — disabling an already-disabled plugin does not duplicate it", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.foo"] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"] });
    });

    it("preserves other keys in the plugins object", async () => {
      storeMock._state.set("plugins", { disabled: [], other: "keep" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.setEnabled("acme.foo", false);

      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["acme.foo"], other: "keep" });
    });

    it("throws on an empty or whitespace-only plugin id", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.setEnabled("", false)).rejects.toThrow(/non-empty string/);
      await expect(service.setEnabled("   ", false)).rejects.toThrow(/non-empty string/);
    });

    it("user plugin disable unloads live — disabled, not pending, no longer running (#10887)", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writePlugin("acme.runtime", { name: "acme.runtime", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({
        disabled: false,
        pendingRestart: false,
        isBuiltin: false,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("acme.runtime", false);

      // Applied immediately: the user plugin is unloaded live (its worker torn
      // down via the unload cascade) and surfaced from the skipped map, so
      // loadedAt resets to 0 and no restart is required — isBuiltin stays false.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: true, pendingRestart: false, isBuiltin: false });
      expect(row.loadedAt).toBe(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("user plugin re-enable of a launch-disabled plugin loads live — enabled, not pending (#10887)", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.off"] });
      await writePlugin("acme.off", { name: "acme.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()[0]).toMatchObject({
        disabled: true,
        pendingRestart: false,
        isBuiltin: false,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("acme.off", true);

      // Applied immediately: re-registered with the real isBuiltin (false) and
      // re-activated via a freshly forked worker, so it's running (loadedAt set)
      // with no restart cue.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: false, pendingRestart: false, isBuiltin: false });
      expect(row.loadedAt).toBeGreaterThan(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("built-in disable unloads live — disabled, not pending, no longer running", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.live", { name: "daintree.live", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()[0]).toMatchObject({
        disabled: false,
        pendingRestart: false,
        isBuiltin: true,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("daintree.live", false);

      // Applied immediately: the plugin is unloaded (loadedAt resets to 0 since
      // it's now surfaced from the skipped map) and no restart is required.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: true, pendingRestart: false, isBuiltin: true });
      expect(row.loadedAt).toBe(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("built-in re-enable loads live — enabled, not pending, running again", async () => {
      storeMock._state.set("plugins", { disabled: ["daintree.off"] });
      await writeBuiltinPlugin("daintree.off", { name: "daintree.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()[0]).toMatchObject({
        disabled: true,
        pendingRestart: false,
        isBuiltin: true,
      });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("daintree.off", true);

      // Applied immediately: now running (loadedAt is set) and no restart cue.
      const row = service.listPlugins()[0];
      expect(row).toMatchObject({ disabled: false, pendingRestart: false, isBuiltin: true });
      expect(row.loadedAt).toBeGreaterThan(0);
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("built-in disable notifies workspace hosts that the forge registry changed", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.forgey", {
        name: "daintree.forgey",
        version: "1.0.0",
        contributes: {
          forgeProviders: [{ id: "forgey", name: "Forgey", matches: ["forgey.example.com"] }],
        },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      const notifyForgeProviderRegistryUpdated = vi.fn();
      service.setWorkspaceClient({
        notifyForgeProviderRegistryUpdated,
        // The real WorkspaceClient is an EventEmitter; the service-level
        // worktree-scope cache eviction listener (#10621) wires through on/off.
        on: vi.fn(),
        off: vi.fn(),
      } as never);

      await service.setEnabled("daintree.forgey", false);

      // The unload removed the forge descriptor from the registry, so PR
      // polling in every workspace host must re-resolve — without this notify,
      // a live disable left hosts polling against a provider that no longer
      // exists (the load path has always notified; see loadPlugin).
      expect(notifyForgeProviderRegistryUpdated).toHaveBeenCalled();
    });

    it("built-in survives a rapid disable→enable→disable without a stuck state", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      await writeBuiltinPlugin("daintree.flap", { name: "daintree.flap", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      // Fire all three without awaiting between them — the per-id chain must
      // serialise them so the final state is a clean, applied disable.
      await Promise.all([
        service.setEnabled("daintree.flap", false),
        service.setEnabled("daintree.flap", true),
        service.setEnabled("daintree.flap", false),
      ]);

      const rows = service.listPlugins();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ disabled: true, pendingRestart: false, isBuiltin: true });
    });

    it("a failed built-in re-enable restores the skipped state (no lost row)", async () => {
      // Launch-disabled built-in whose engine range can never be satisfied by
      // the running app version, so the re-enable's loadPlugin() returns null at
      // the engine gate and must fall through to the restore path.
      storeMock._state.set("plugins", { disabled: ["daintree.future"] });
      await writeBuiltinPlugin("daintree.future", {
        name: "daintree.future",
        version: "1.0.0",
        engines: { daintree: ">=99.0.0" },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);

      await service.setEnabled("daintree.future", true);

      // Intent persisted as enabled, but the load failed: the row stays visible,
      // not running, flagged pendingRestart — never silently dropped.
      const rows = service.listPlugins();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        disabled: false,
        pendingRestart: true,
        isBuiltin: true,
      });
      expect(rows[0].loadedAt).toBe(0);
    });

    it("an unknown plugin id is treated as a user plugin (persist-only, no transition)", async () => {
      storeMock._state.set("plugins", { disabled: [] });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      broadcastToRendererMock.mockClear();

      await service.setEnabled("unknown.plugin", false);

      // Persisted, but no live transition runs and no provenance broadcast fires.
      expect(storeMock._state.get("plugins")).toEqual({ disabled: ["unknown.plugin"] });
      expect(broadcastToRendererMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });
  });

  describe("uninstallPlugin", () => {
    it("removes a running plugin from listPlugins, deletes its dir, and broadcasts provenance-changed", async () => {
      await writePlugin("acme.live", { name: "acme.live", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);

      await service.uninstallPlugin("acme.live");

      expect(service.listPlugins()).toEqual([]);
      await expect(fs.access(path.join(tmpDir, "acme.live"))).rejects.toThrow();
      expect(broadcastToRendererMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: "plugin:provenance-changed" })
      );
    });

    it("removes a launch-disabled plugin and clears it from plugins.disabled (no zombie row)", async () => {
      // Regression: a disabled plugin lives in `disabledPlugins`, not `plugins`,
      // so unloadPlugin alone leaves the row in listPlugins and resurrects it on
      // the next launch.
      storeMock._state.set("plugins", { disabled: ["acme.off"] });
      await writePlugin("acme.off", { name: "acme.off", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      expect(service.listPlugins()).toHaveLength(1);
      expect(service.listPlugins()[0]).toMatchObject({ disabled: true });

      await service.uninstallPlugin("acme.off");

      expect(service.listPlugins()).toEqual([]);
      await expect(fs.access(path.join(tmpDir, "acme.off"))).rejects.toThrow();
      const stored = storeMock._state.get("plugins") as { disabled?: string[] };
      expect(stored.disabled ?? []).not.toContain("acme.off");
    });

    it("deletes the installed provenance record", async () => {
      storeMock._state.set("plugins", {
        disabled: [],
        installed: { "acme.gone": { source: "sideload", installedAt: 1 } },
      });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });

      await service.uninstallPlugin("acme.gone");

      const stored = storeMock._state.get("plugins") as { installed?: Record<string, unknown> };
      expect(stored.installed ?? {}).not.toHaveProperty("acme.gone");
    });

    it("preserves the user-scope settings file by default", async () => {
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.keep"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.keep", "plugin.json"),
        JSON.stringify({ name: "acme.keep", version: "1.0.0" })
      );
      const settingsFile = path.join(tmpDir, "plugin-settings", "acme.keep.json");
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify({ token: "secret" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.keep");

      await expect(fs.access(path.join(pluginsRoot, "acme.keep"))).rejects.toThrow();
      // Secrets survive a plain uninstall.
      await expect(fs.access(settingsFile)).resolves.toBeUndefined();
    });

    it("deletes the user-scope settings file when deleteSettings is true", async () => {
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.wipe"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.wipe", "plugin.json"),
        JSON.stringify({ name: "acme.wipe", version: "1.0.0" })
      );
      const settingsFile = path.join(tmpDir, "plugin-settings", "acme.wipe.json");
      await fs.mkdir(path.dirname(settingsFile), { recursive: true });
      await fs.writeFile(settingsFile, JSON.stringify({ token: "secret" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.wipe", true);

      await expect(fs.access(path.join(pluginsRoot, "acme.wipe"))).rejects.toThrow();
      await expect(fs.access(settingsFile)).rejects.toThrow();
    });

    it("never deletes a project-scope settings file, even with deleteSettings", async () => {
      // Uninstall only ever targets the user-scope settings root; per-repo
      // `.daintree/plugin-settings/` files are tracked git artifacts and are not
      // the uninstall's to remove. Drift guard for docs/plugins/distribution.md.
      const pluginsRoot = path.join(tmpDir, "plugins");
      await fs.mkdir(path.join(pluginsRoot, "acme.proj"), { recursive: true });
      await fs.writeFile(
        path.join(pluginsRoot, "acme.proj", "plugin.json"),
        JSON.stringify({ name: "acme.proj", version: "1.0.0" })
      );
      const projectSettingsFile = path.join(
        tmpDir,
        "some-project",
        ".daintree",
        "plugin-settings",
        "acme.proj.json"
      );
      await fs.mkdir(path.dirname(projectSettingsFile), { recursive: true });
      await fs.writeFile(projectSettingsFile, JSON.stringify({ team: "platform" }));
      const service = new PluginService(pluginsRoot, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      await service.uninstallPlugin("acme.proj", true);

      await expect(fs.access(path.join(pluginsRoot, "acme.proj"))).rejects.toThrow();
      await expect(fs.access(projectSettingsFile)).resolves.toBeUndefined();
    });

    it("clears the launch-time name reservation so a same-session reinstall isn't blocked", async () => {
      // Regression: a disabled-at-launch plugin reserves its name; uninstall
      // must release it or loadPlugin rejects the reinstall as a duplicate.
      storeMock._state.set("plugins", { disabled: ["acme.reserve"] });
      await writePlugin("acme.reserve", { name: "acme.reserve", version: "1.0.0" });
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();
      const reserved = () =>
        (service as unknown as { reservedNames: Set<string> }).reservedNames.has("acme.reserve");
      expect(reserved()).toBe(true);

      await service.uninstallPlugin("acme.reserve");

      expect(reserved()).toBe(false);
    });

    it("rejects a path-traversal or non-scoped plugin id before touching the filesystem", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.uninstallPlugin("../../../etc")).rejects.toThrow(/scoped plugin name/);
      await expect(service.uninstallPlugin("no-dot")).rejects.toThrow(/scoped plugin name/);
    });

    it("rejects on an empty or whitespace-only plugin id", async () => {
      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await expect(service.uninstallPlugin("")).rejects.toThrow(/non-empty string/);
      await expect(service.uninstallPlugin("   ")).rejects.toThrow(/non-empty string/);
    });
  });

  it("emits toast when a user plugin uses the daintree.* namespace", async () => {
    const { broadcastToRenderer } = await import("../../ipc/utils.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("daintree.pirate", {
        name: "daintree.pirate",
        version: "1.0.0",
      });

      const service = new PluginService(tmpDir, "0.0.0", { builtinPluginsRoot: builtinDir });
      await service.initialize();

      expect(service.listPlugins()).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Invalid manifest in daintree.pirate"),
        expect.anything()
      );
      expect(broadcastToRenderer).toHaveBeenCalledWith(
        CHANNELS.NOTIFICATION_SHOW_TOAST,
        expect.objectContaining({
          type: "error",
          title: "Plugin uses a reserved namespace",
          message: expect.stringContaining("daintree.pirate"),
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
