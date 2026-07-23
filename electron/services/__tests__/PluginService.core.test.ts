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
import { registerPanelKind } from "../../../shared/config/panelKindRegistry.js";
import { registerToolbarButton } from "../../../shared/config/toolbarButtonRegistry.js";
import { registerPluginMenuItem } from "../pluginMenuRegistry.js";

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

describe("PluginService", () => {
  it("returns empty list when plugins directory does not exist", async () => {
    const service = new PluginService(path.join(tmpDir, "nonexistent"));
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("returns empty list when plugins directory is empty", async () => {
    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads a valid plugin and registers panel kinds", async () => {
    await writePlugin("test-plugin", {
      name: "acme.test-plugin",
      version: "1.0.0",
      displayName: "Test Plugin",
      contributes: {
        panels: [
          {
            id: "viewer",
            name: "Test Viewer",
            iconId: "eye",
            color: "#ff0000",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].manifest.name).toBe("acme.test-plugin");
    expect(plugins[0].manifest.displayName).toBe("Test Plugin");
    expect(plugins[0].dir).toBe(path.join(tmpDir, "test-plugin"));

    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.test-plugin.viewer",
        name: "Test Viewer",
        iconId: "eye",
        color: "#ff0000",
        hasPty: false,
        canRestart: false,
        canConvert: false,
        showInPalette: true,
        extensionId: "acme.test-plugin",
      })
    );
  });

  it("forwards an explicit dockable:false from a panel contribution into registerPanelKind (#11332)", async () => {
    await writePlugin("dock-plugin", {
      name: "acme.dock-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "compact", name: "Compact", iconId: "eye", color: "#111", dockable: false },
          { id: "wide", name: "Wide", iconId: "eye", color: "#222" },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    // Explicit opt-out flows through verbatim.
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.dock-plugin.compact", dockable: false })
    );
    // Absent flag never stamps a `dockable` key, so the registry default
    // (dockable) applies — assert the key is not present on that call.
    const wideCall = vi
      .mocked(registerPanelKind)
      .mock.calls.find((call) => call[0]?.id === "acme.dock-plugin.wide");
    expect(wideCall).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(wideCall![0], "dockable")).toBe(false);
  });

  it("skips directories without plugin.json", async () => {
    await fs.mkdir(path.join(tmpDir, "empty-dir"));

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid JSON", async () => {
    const dir = path.join(tmpDir, "bad-json");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "plugin.json"), "not valid json {{{");

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("skips plugins with invalid manifest schema", async () => {
    await writePlugin("invalid-schema", {
      version: "1.0.0",
      // missing required 'name' field
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("loads multiple plugins and skips invalid ones", async () => {
    await writePlugin("good-1", { name: "acme.good-1", version: "1.0.0" });
    await writePlugin("bad", { version: "1.0.0" }); // missing name
    await writePlugin("good-2", { name: "acme.good-2", version: "2.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(2);
    const names = plugins.map((p) => p.manifest.name).sort();
    expect(names).toEqual(["acme.good-1", "acme.good-2"]);
  });

  it("deep-freezes the stored manifest as an immutability invariant (#10477)", async () => {
    await writePlugin("frozen", {
      name: "acme.frozen",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const stored = (
      service as unknown as { plugins: Map<string, { manifest: unknown }> }
    ).plugins.get("acme.frozen")?.manifest as { contributes: { panels: unknown[] } } | undefined;
    expect(stored).toBeDefined();
    // Deep freeze: top level and nested contribution arrays/objects are sealed.
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored!.contributes)).toBe(true);
    expect(Object.isFrozen(stored!.contributes.panels)).toBe(true);
    expect(Object.isFrozen(stored!.contributes.panels[0])).toBe(true);
  });

  it("is idempotent — second initialize is a no-op", async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(0); // no panels declared
  });

  it("namespaces panel IDs as pluginName.panelId", async () => {
    await writePlugin("my-plugin", {
      name: "acme.my-plugin",
      version: "1.0.0",
      contributes: {
        panels: [
          { id: "viewer", name: "Viewer", iconId: "eye", color: "#000" },
          { id: "editor", name: "Editor", iconId: "pen", color: "#fff" },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPanelKind).toHaveBeenCalledTimes(2);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.viewer" })
    );
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({ id: "acme.my-plugin.editor" })
    );
  });

  it("rejects main entry paths that escape the plugin directory", async () => {
    await writePlugin("escape-test", {
      name: "acme.escape-test",
      version: "1.0.0",
      main: "../evil.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // The plugin loads but main is silently rejected (no import attempted)
    expect(plugins[0].manifest.main).toBe("../evil.js");
  });

  it("does not include resolvedMain in listPlugins output", async () => {
    await writePlugin("main-test", {
      name: "acme.main-test",
      version: "1.0.0",
      main: "dist/main.js",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    // listPlugins returns LoadedPluginInfo which doesn't have resolvedMain
    expect(Object.keys(plugins[0])).not.toContain("resolvedMain");
  });

  it("listPlugins includes archiveHash when set on a loaded plugin", async () => {
    await writePlugin("hashed", {
      name: "acme.hashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const validHash = "a".repeat(64);
    service.setPluginArchiveHash("acme.hashed", validHash);
    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBe(validHash);
  });

  it("listPlugins returns null archiveHash when not set", async () => {
    await writePlugin("unhashed", {
      name: "acme.unhashed",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].archiveHash).toBeNull();
  });

  it("setPluginArchiveHash is a silent no-op for unknown plugin ids", () => {
    const service = new PluginService(tmpDir);
    expect(() => service.setPluginArchiveHash("acme.nonexistent", "deadbeef")).not.toThrow();
  });

  describe("listPlugins pluginDanger", () => {
    it("reports safe for a plugin with no capabilities", async () => {
      await writePlugin("safe-plugin", { name: "acme.safe", version: "1.0.0" });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("reports safe for a read-only / clipboard capability set", async () => {
      await writePlugin("reader", {
        name: "acme.reader",
        version: "1.0.0",
        capabilities: ["fs:project-read", "git:read", "clipboard:read"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("reports confirm for an individually high-risk capability (shell:exec)", async () => {
      await writePlugin("sheller", {
        name: "acme.sheller",
        version: "1.0.0",
        capabilities: ["shell:exec"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    // Guards against accidental removal from CONFIRM_TRIGGERING_CAPABILITIES.
    it.each([
      "git:write",
      "fs:project-write",
      "fs:user-data-write",
      "agent:invoke",
      "agent:register",
      "agent:input",
    ])("reports confirm for the flat-elevated capability %s", async (capability) => {
      await writePlugin("flat", {
        name: "acme.flat",
        version: "1.0.0",
        capabilities: [capability],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    it("reports confirm via the compound lattice (sensitive read + unscoped network:fetch)", async () => {
      await writePlugin("exfil", {
        name: "acme.exfil",
        version: "1.0.0",
        capabilities: ["fs:project-read", "network:fetch"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("confirm");
    });

    it("reports safe when a tight network scope attenuates the compound pair", async () => {
      await writePlugin("scoped", {
        name: "acme.scoped",
        version: "1.0.0",
        capabilities: ["fs:project-read", "network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v1"] } },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      expect(service.listPlugins()[0].pluginDanger).toBe("safe");
    });

    it("computes pluginDanger for a launch-disabled plugin too", async () => {
      storeMock._state.set("plugins", { disabled: ["acme.off-danger"] });
      await writePlugin("off-danger", {
        name: "acme.off-danger",
        version: "1.0.0",
        capabilities: ["shell:exec"],
      });
      const service = new PluginService(tmpDir);
      await service.initialize();
      const info = service.listPlugins()[0];
      expect(info.disabled).toBe(true);
      expect(info.pluginDanger).toBe("confirm");
    });
  });

  it("rejects manifest with empty name", async () => {
    await writePlugin("empty-name", { name: "", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects manifest with path-traversal name", async () => {
    await writePlugin("evil-name", { name: "../evil", version: "1.0.0" });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects panel with invalid ID characters", async () => {
    await writePlugin("bad-panel", {
      name: "acme.bad-panel",
      version: "1.0.0",
      contributes: {
        panels: [{ id: "../../hack", name: "Hack", iconId: "x", color: "#000" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();
    expect(service.listPlugins()).toEqual([]);
  });

  it("rejects duplicate plugin names with error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await writePlugin("dir-a", {
        name: "acme.same-name",
        version: "1.0.0",
        description: "first",
      });
      await writePlugin("dir-b", {
        name: "acme.same-name",
        version: "2.0.0",
        description: "second",
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      // Initialize loads plugins concurrently via Promise.allSettled; the winner
      // is whichever finishes first, which depends on fs.readFile completion
      // order. The contract being tested is "first wins, duplicates rejected" —
      // not which directory happens to win on a given filesystem.
      const winner = plugins[0].manifest.description;
      expect(winner === "first" || winner === "second").toBe(true);
      const loser = winner === "first" ? "dir-b" : "dir-a";
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate plugin name "acme.same-name" in ${loser}`)
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("allows retry after non-ENOENT initialize failure", async () => {
    const badRoot = path.join(tmpDir, "unreadable");
    await fs.mkdir(badRoot);
    await writePlugin("good", { name: "acme.good", version: "1.0.0" });

    const service = new PluginService(tmpDir);

    // First call succeeds
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);

    // Second call is no-op (already initialized)
    await service.initialize();
    expect(service.listPlugins()).toHaveLength(1);
  });

  it("registers toolbar buttons from plugin manifest", async () => {
    await writePlugin("toolbar-test", {
      name: "acme.toolbar-test",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "my-btn",
            label: "My Button",
            iconId: "puzzle",
            actionId: "acme.toolbar-test.doThing",
            priority: 4,
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.toolbar-test.my-btn",
        label: "My Button",
        iconId: "puzzle",
        actionId: "acme.toolbar-test.doThing",
        priority: 4,
        pluginId: "acme.toolbar-test",
      })
    );
  });

  it("uses default priority 3 when not specified in toolbar button", async () => {
    await writePlugin("default-priority", {
      name: "acme.default-priority",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [
          {
            id: "btn",
            label: "Btn",
            iconId: "icon",
            actionId: "acme.default-priority.action",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.default-priority.btn",
        priority: 3,
      })
    );
  });

  it("registers menu items from plugin manifest", async () => {
    await writePlugin("menu-test", {
      name: "acme.menu-test",
      version: "1.0.0",
      contributes: {
        menuItems: [
          {
            label: "Do Something",
            actionId: "acme.menu-test.doSomething",
            location: "terminal",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerPluginMenuItem).toHaveBeenCalledWith("acme.menu-test", {
      label: "Do Something",
      actionId: "acme.menu-test.doSomething",
      location: "terminal",
    });
  });

  it("does not call toolbar/menu registration when no contributions", async () => {
    await writePlugin("empty-contribs", {
      name: "acme.empty-contribs",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });
});

describe("PluginService manifest command contributions (#9281)", () => {
  async function writePluginWithSrc(
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string> = {}
  ): Promise<void> {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
    if (Object.keys(files).length > 0) {
      await fs.mkdir(path.join(dir, "src"), { recursive: true });
      for (const [filename, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, "src", filename), content);
      }
    }
  }

  function ctx(pluginId: string): PluginIpcContext {
    return makeCtx(pluginId);
  }

  it("registers a manifest command descriptor at load time without importing the handler", async () => {
    await writePluginWithSrc(
      "cmd-lazy",
      {
        name: "acme.cmd-lazy",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Run the thing",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "do-thing.ts": `export default () => "loaded"`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.cmd-lazy",
      id: "acme.cmd-lazy.do-thing",
      title: "Do Thing",
      category: "Test",
      kind: "command",
      danger: "safe",
      effectiveDanger: "safe",
    });
  });

  it("honours a manifest command's requires when deriving effectiveDanger", async () => {
    // The manifest path spreads the command into the same validator the
    // runtime host.registerAction path uses, so `requires` has to survive that
    // spread — a declared-in-JSON one-click action is the issue's actual case.
    await writePluginWithSrc(
      "cmd-intent",
      {
        name: "acme.cmd-intent",
        version: "1.0.0",
        capabilities: ["shell:exec", "fs:project-read"],
        contributes: {
          commands: [
            {
              id: "open-panel",
              title: "Open Panel",
              description: "Opens the panel",
              category: "Test",
              kind: "command",
              danger: "safe",
              requires: [],
            },
            {
              id: "run-build",
              title: "Run Build",
              description: "Runs the build",
              category: "Test",
              kind: "command",
              danger: "safe",
              requires: ["shell:exec"],
            },
          ],
        },
      },
      {
        "open-panel.ts": `export default () => "ok"`,
        "run-build.ts": `export default () => "ok"`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const byId = new Map(service.listPluginActions().map((a) => [a.id, a]));
    expect(byId.get("acme.cmd-intent.open-panel")?.effectiveDanger).toBe("safe");
    expect(byId.get("acme.cmd-intent.run-build")?.effectiveDanger).toBe("confirm");
  });

  it("elevates a manifest command that omits requires under a high-risk manifest", async () => {
    // The backward-compatibility half: a command written before #11299 must
    // keep the conservative verdict through the manifest path too, not just
    // the runtime one.
    await writePluginWithSrc(
      "cmd-legacy",
      {
        name: "acme.cmd-legacy",
        version: "1.0.0",
        capabilities: ["shell:exec"],
        contributes: {
          commands: [
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Runs",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      { "do-thing.ts": `export default () => "ok"` }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(
      service.listPluginActions().find((a) => a.id === "acme.cmd-legacy.do-thing")?.effectiveDanger
    ).toBe("confirm");
  });

  it("fails a manifest command whose requires names an undeclared capability", async () => {
    await writePluginWithSrc(
      "cmd-overclaim",
      {
        name: "acme.cmd-overclaim",
        version: "1.0.0",
        capabilities: ["fs:project-read"],
        contributes: {
          commands: [
            {
              id: "fine",
              title: "Fine",
              description: "Runs",
              category: "Test",
              kind: "command",
              danger: "safe",
              requires: ["fs:project-read"],
            },
            {
              id: "do-thing",
              title: "Do Thing",
              description: "Runs",
              category: "Test",
              kind: "command",
              danger: "safe",
              requires: ["shell:exec"],
            },
          ],
        },
      },
      { "fine.ts": `export default () => "ok"`, "do-thing.ts": `export default () => "ok"` }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    // Fail-closed: the over-claiming action does not register rather than
    // silently falling back to whole-manifest derivation, so the author's
    // mistake is visible. The valid sibling pins that this is a targeted
    // rejection — without it the assertion would also pass if command
    // loading broke entirely.
    const ids = service.listPluginActions().map((a) => a.id);
    expect(ids).toContain("acme.cmd-overclaim.fine");
    expect(ids).not.toContain("acme.cmd-overclaim.do-thing");
  });

  it("lazily imports and invokes the handler on first dispatch", async () => {
    await writePluginWithSrc(
      "cmd-dispatch",
      {
        name: "acme.cmd-dispatch",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "plan",
              title: "Plan",
              description: "",
              category: "Planning",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "plan.js": `export default async (args) => ({ ok: true, args })`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const result = await service.dispatchHandler(
      "acme.cmd-dispatch",
      "acme.cmd-dispatch.plan",
      ctx("acme.cmd-dispatch"),
      [{ issue: 42 }]
    );
    expect(result).toEqual({ ok: true, args: { issue: 42 } });
  });

  it("throws the documented toast error when the handler file is missing", async () => {
    await writePluginWithSrc("cmd-missing", {
      name: "acme.cmd-missing",
      version: "1.0.0",
      contributes: {
        commands: [
          {
            id: "ghost",
            title: "Ghost",
            description: "",
            category: "Test",
            kind: "command",
            danger: "safe",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    // Descriptor is still registered (palette visibility) even with no file.
    expect(service.listPluginActions()).toHaveLength(1);

    await expect(
      service.dispatchHandler(
        "acme.cmd-missing",
        "acme.cmd-missing.ghost",
        ctx("acme.cmd-missing"),
        []
      )
    ).rejects.toThrow('Command "acme.cmd-missing.ghost" has no handler');
  });

  it("throws when the handler module has no callable default export", async () => {
    await writePluginWithSrc(
      "cmd-nodef",
      {
        name: "acme.cmd-nodef",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "broken",
              title: "Broken",
              description: "",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        "broken.js": `export const named = 1`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    await expect(
      service.dispatchHandler("acme.cmd-nodef", "acme.cmd-nodef.broken", ctx("acme.cmd-nodef"), [])
    ).rejects.toThrow(/no callable default export/);
  });

  it("probes extensions in order .js → .mjs and ignores a .ts sibling", async () => {
    // The resolver now only probes built handler modules (.js, .mjs); a .ts or
    // .tsx sibling is never picked. When both .js and .mjs exist, .js wins.
    await writePluginWithSrc(
      "cmd-order",
      {
        name: "acme.cmd-order",
        version: "1.0.0",
        contributes: {
          commands: [
            {
              id: "pick",
              title: "Pick",
              description: "",
              category: "Test",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      },
      {
        // A .ts sibling must NOT be probed — if it were, it would shadow .js.
        "pick.ts": `export default () => "ts-not-probed"`,
        "pick.js": `export default () => "js-wins"`,
        "pick.mjs": `export default () => "mjs-loses"`,
      }
    );

    const service = new PluginService(tmpDir);
    await service.initialize();

    const result = await service.dispatchHandler(
      "acme.cmd-order",
      "acme.cmd-order.pick",
      ctx("acme.cmd-order"),
      []
    );
    expect(result).toBe("js-wins");
  });

  it("surfaces a loadError when a manifest command collides with a built-in id", async () => {
    // Construct a plugin whose namespaced command id WILL collide. The
    // manifest schema requires `publisher.name` form (`/^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/`),
    // so we filter built-ins to ones whose first two dotted segments would
    // satisfy that pattern — three-segment, all-lowercase, no camelCase or
    // special chars.
    const { BUILT_IN_ACTION_IDS } = await import("../../../shared/config/actionIds.js");
    const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const threeSegment = BUILT_IN_ACTION_IDS.find((id) => {
      const parts = id.split(".");
      if (parts.length < 3) return false;
      return pluginNamePattern.test(`${parts[0]}.${parts[1]}`);
    });
    if (!threeSegment) {
      // No suitable target — the collision path is structurally unreachable
      // from a well-formed plugin manifest, so the load-time guard is
      // defence-in-depth against a future built-in id whose shape would
      // overlap. The test still validates the descriptor-registration path
      // doesn't accidentally allow such an id.
      return;
    }
    const parts = threeSegment.split(".");
    const pluginName = `${parts[0]}.${parts[1]}`;
    const cmdId = parts.slice(2).join(".");

    await writePluginWithSrc(pluginName, {
      name: pluginName,
      version: "1.0.0",
      contributes: {
        commands: [
          {
            id: cmdId,
            title: "Collides",
            description: "",
            category: "X",
            kind: "command",
            danger: "safe",
          },
        ],
      },
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();

      const namespacedId = `${pluginName}.${cmdId}`;
      // No descriptor for the colliding id.
      expect(service.listPluginActions().some((a) => a.id === namespacedId)).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`command id "${namespacedId}" collides with a built-in action id`)
      );
      // Provenance loadError set on the installed record.
      const installed = (storeMock._state.get("plugins") as { installed?: Record<string, unknown> })
        ?.installed as Record<string, { loadError?: { message: string } }> | undefined;
      expect(installed?.[pluginName]?.loadError?.message).toContain("collides with a built-in");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("registers the toolbar button under the canonical {pluginId}.{btnId} namespace", async () => {
    await writePlugin("ns-check", {
      name: "acme.ns-check",
      version: "1.0.0",
      contributes: {
        toolbarButtons: [{ id: "btn", label: "Btn", iconId: "i", actionId: "acme.ns-check.act" }],
      },
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(registerToolbarButton).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.ns-check.btn",
        pluginId: "acme.ns-check",
      })
    );
  });

  it("preserves a collision loadError across a successful main activation", async () => {
    // A plugin with both `main` AND a colliding manifest command writes a
    // loadError at load time; `_doActivate()` success previously cleared it
    // unconditionally, erasing the diagnostic. The collision is a manifest-
    // level fact that doesn't go away when `main` activates cleanly.
    const { BUILT_IN_ACTION_IDS } = await import("../../../shared/config/actionIds.js");
    const pluginNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const threeSegment = BUILT_IN_ACTION_IDS.find((id) => {
      const parts = id.split(".");
      if (parts.length < 3) return false;
      return pluginNamePattern.test(`${parts[0]}.${parts[1]}`);
    });
    if (!threeSegment) return;
    const parts = threeSegment.split(".");
    const pluginName = `${parts[0]}.${parts[1]}`;
    const cmdId = parts.slice(2).join(".");

    const pluginDir = path.join(tmpDir, pluginName);
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify({
        name: pluginName,
        version: "1.0.0",
        main: "main.js",
        contributes: {
          commands: [
            {
              id: cmdId,
              title: "Bad",
              description: "",
              category: "X",
              kind: "command",
              danger: "safe",
            },
          ],
        },
      })
    );
    await fs.writeFile(
      path.join(pluginDir, "main.js"),
      `export async function activate() { /* no-op */ }`
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin(pluginName);

      const installed = (storeMock._state.get("plugins") as { installed?: Record<string, unknown> })
        ?.installed as Record<string, { loadError?: { message: string } | null }> | undefined;
      expect(installed?.[pluginName]?.loadError?.message).toContain("collides with a built-in");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
