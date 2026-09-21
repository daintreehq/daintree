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
import { type PluginIpcContext } from "../../../shared/types/plugin.js";
import {
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem, unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import { unregisterForgeProviders } from "../forgeProviderRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";

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

describe("engines.daintree compatibility gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("loads a plugin when app version satisfies engines.daintree", async () => {
    await writePlugin("compatible", {
      name: "acme.compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects a plugin when app version does not satisfy engines.daintree", async () => {
    await writePlugin("incompatible", {
      name: "acme.incompatible",
      displayName: "Incompatible Plugin",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.incompatible" requires Daintree ^0.7.0')
    );
    expect(broadcastToRendererMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "error",
        title: "Plugin incompatible",
        message: expect.stringContaining("Incompatible Plugin"),
      })
    );
  });

  it("treats app prerelease versions as satisfying their release-series range", async () => {
    await writePlugin("prerelease-compatible", {
      name: "acme.prerelease-compatible",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins that omit engines.daintree with a warning", async () => {
    await writePlugin("no-engines", { name: "acme.no-engines", version: "1.0.0" });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.no-engines" does not declare engines.daintree')
    );
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("loads plugins with empty engines object (daintree absent) with a warning", async () => {
    await writePlugin("empty-engines", {
      name: "acme.empty-engines",
      version: "1.0.0",
      engines: {},
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.empty-engines" does not declare engines.daintree')
    );
  });

  it("rejects manifests with an invalid semver range at schema level", async () => {
    await writePlugin("bad-range", {
      name: "acme.bad-range",
      version: "1.0.0",
      engines: { daintree: "not-a-range" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects plugins requiring a future major version", async () => {
    await writePlugin("future", {
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("does not attempt main import or register contributions for incompatible plugins", async () => {
    await writePlugin("skip-side-effects", {
      name: "acme.skip-side-effects",
      version: "1.0.0",
      main: "dist/main.js",
      engines: { daintree: "^1.0.0" },
      contributes: {
        panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
        toolbarButtons: [
          { id: "b", label: "B", iconId: "i", actionId: "acme.skip-side-effects.act" },
        ],
        menuItems: [{ label: "L", actionId: "acme.skip-side-effects.act", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("loads only the compatible plugins in a mixed batch", async () => {
    await writePlugin("good", {
      name: "acme.good",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });
    await writePlugin("bad", {
      name: "acme.bad",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const names = service.listPlugins().map((p) => p.manifest.name);
    expect(names).toEqual(["acme.good"]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts the wildcard range '*'", async () => {
    await writePlugin("wildcard", {
      name: "acme.wildcard",
      version: "1.0.0",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only range strings at the schema layer", async () => {
    await writePlugin("whitespace-range", {
      name: "acme.whitespace-range",
      version: "1.0.0",
      engines: { daintree: "   " },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an app prerelease that is below a non-prerelease range's lower bound", async () => {
    await writePlugin("prerelease-too-early", {
      name: "acme.prerelease-too-early",
      version: "1.0.0",
      engines: { daintree: ">=0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.0-rc.1");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact-version range when the app matches precisely", async () => {
    await writePlugin("exact-match", {
      name: "acme.exact-match",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an exact-version range when the app does not match", async () => {
    await writePlugin("exact-mismatch", {
      name: "acme.exact-mismatch",
      version: "1.0.0",
      engines: { daintree: "0.7.5" },
    });

    const service = new PluginService(tmpDir, "0.7.4");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });
});

describe("strict schema validation", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("rejects manifests with unknown fields like 'renderer'", async () => {
    await writePlugin("bad-field", {
      name: "acme.bad-field",
      version: "1.0.0",
      renderer: "dist/renderer.js",
      engines: { daintree: "*" },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in bad-field"),
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: ["renderer"],
        }),
      ])
    );
  });
});

describe("Plugin unload lifecycle", () => {
  it("unloadPlugin calls all registry unregister functions for the plugin", async () => {
    await writePlugin("unloadable", {
      name: "acme.unloadable",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        toolbarButtons: [
          { id: "btn", label: "Btn", iconId: "icon", actionId: "acme.unloadable.act" },
        ],
        menuItems: [{ label: "L", actionId: "acme.unloadable.act", location: "terminal" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.hasPlugin("acme.unloadable")).toBe(true);

    service.unloadPlugin("acme.unloadable");

    expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.unloadable");
    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.unloadable");
  });

  it("unloadPlugin removes the plugin from hasPlugin and listPlugins", async () => {
    await writePlugin("goodbye", { name: "acme.goodbye", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.hasPlugin("acme.goodbye")).toBe(true);

    service.unloadPlugin("acme.goodbye");

    expect(service.hasPlugin("acme.goodbye")).toBe(false);
    expect(service.listPlugins()).toEqual([]);
  });

  it("unloadPlugin removes IPC handlers registered for the plugin", async () => {
    await writePlugin("handler-host", { name: "acme.handler-host", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.registerHandler("acme.handler-host", "ping", () => "pong");
    expect(
      await service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).toBe("pong");

    service.unloadPlugin("acme.handler-host");

    // After unload the plugin leaves `this.plugins`, so the ownership guard
    // (#10462) now short-circuits dispatch before the handler lookup.
    await expect(
      service.dispatchHandler("acme.handler-host", "ping", makeCtx("acme.handler-host"), [])
    ).rejects.toThrow('plugin:invoke rejected: plugin "acme.handler-host" is not loaded');
  });

  it("unloadPlugin is a no-op when the plugin is not loaded", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(() => service.unloadPlugin("acme.never-loaded")).not.toThrow();
    expect(unregisterPluginMenuItems).not.toHaveBeenCalled();
    expect(unregisterPluginToolbarButtons).not.toHaveBeenCalled();
    expect(unregisterPluginPanelKinds).not.toHaveBeenCalled();
    expect(unregisterForgeProviders).not.toHaveBeenCalled();
  });

  it("unloadPlugin is idempotent across repeated calls", async () => {
    await writePlugin("twice", { name: "acme.twice", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    service.unloadPlugin("acme.twice");
    expect(service.hasPlugin("acme.twice")).toBe(false);

    // Second call finds nothing to remove and stays silent.
    service.unloadPlugin("acme.twice");
    expect(unregisterPluginMenuItems).toHaveBeenCalledTimes(1);
    expect(unregisterPluginToolbarButtons).toHaveBeenCalledTimes(1);
    expect(unregisterPluginPanelKinds).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviders).toHaveBeenCalledTimes(1);
  });

  it("registers plugin before importing main so sync host-API calls see it as loaded", async () => {
    const pluginDir = path.join(tmpDir, "sync-init");
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: "acme.sync-init",
        version: "1.0.0",
        main: "main.mjs",
      })
    );
    // Plugin main module calls a global hook synchronously during import to
    // observe whether its own pluginId is already registered. Proxies the
    // real-world pattern where a host API call depends on this.plugins.has().
    await fs.writeFile(
      path.join(pluginDir, "main.mjs"),
      "globalThis.__pluginInitObserved = globalThis.__pluginInitCheck('acme.sync-init');"
    );

    const service = new PluginService(tmpDir);
    (globalThis as { __pluginInitCheck?: (name: string) => boolean }).__pluginInitCheck = (name) =>
      service.hasPlugin(name);

    try {
      await service.initialize();
      await service.activatePlugin("acme.sync-init");
      expect((globalThis as { __pluginInitObserved?: boolean }).__pluginInitObserved).toBe(true);
    } finally {
      delete (globalThis as { __pluginInitCheck?: unknown }).__pluginInitCheck;
      delete (globalThis as { __pluginInitObserved?: unknown }).__pluginInitObserved;
    }
  });

  it("supports load → unload → reload lifecycle via fresh service instance", async () => {
    await writePlugin("lifecycle", {
      name: "acme.lifecycle",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const first = new PluginService(tmpDir);
    await first.initialize();
    expect(registerPanelKind).toHaveBeenCalledTimes(1);

    first.unloadPlugin("acme.lifecycle");
    expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.lifecycle");
    expect(first.hasPlugin("acme.lifecycle")).toBe(false);

    // A fresh service instance re-reads the plugin directory and re-registers.
    vi.clearAllMocks();
    const second = new PluginService(tmpDir);
    await second.initialize();

    expect(second.hasPlugin("acme.lifecycle")).toBe(true);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.lifecycle.viewer", extensionId: "acme.lifecycle" })
    );
  });
});
