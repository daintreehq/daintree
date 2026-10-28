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
import { getWorktreeDeleteNotesBinding } from "../plugin/worktreeDeleteNotesRegistry.js";

const PROJECT_ID = "p".repeat(64);
const WORKTREE = {
  id: "/repo/wt",
  worktreeId: "/repo/wt",
  path: "/repo/wt",
  name: "wt",
  branch: "feature/x",
  isCurrent: false,
  isMainWorktree: false,
  aheadCount: 0,
  behindCount: 0,
  mood: "stable",
  createdAt: 1,
};

let tmpDir: string;

async function writeNotesPlugin(name: string, activateBody: string): Promise<void> {
  const dir = path.join(tmpDir, name);
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "plugin.json"),
    JSON.stringify({
      name,
      displayName: "Acme Sync",
      version: "1.0.0",
      main: "dist/index.js",
      contributes: { worktreeDeleteNotes: [{ id: "notes" }] },
    })
  );
  await fs.writeFile(
    path.join(dir, "dist", "index.js"),
    `export async function activate(host) {\n${activateBody}\n}`
  );
}

async function setup(activateBody: string) {
  await writeNotesPlugin("acme.sync", activateBody);
  const service = new PluginService(tmpDir);
  await service.initialize();
  projectStoreMock.getProjectById.mockReturnValue({ path: "/repo" });
  service.setWorkspaceClient({
    on: vi.fn(),
    off: vi.fn(),
    getAllStatesForProjectResultAsync: vi.fn(async () => ({
      status: "ok",
      projectId: PROJECT_ID,
      states: [WORKTREE],
    })),
  } as never);
  return service;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-test-"));
  vi.clearAllMocks();
  storeMock._state.clear();
  devWorkerMock.instances.length = 0;
  devWorkerMock.bridges.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("PluginService worktree delete notes (#13805)", () => {
  it("lists a declaring plugin without starting it, then activates it to ask", async () => {
    const service = await setup(`
      await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, {
        provideNotes: async (worktree) => [{ severity: "warning", text: "2 edits on " + worktree.branch }],
      });
    `);
    expect(service.listWorktreeDeleteNoteSources(PROJECT_ID)).toEqual([
      { pluginId: "acme.sync", pluginName: "Acme Sync" },
    ]);
    expect(devWorkerMock.instances).toHaveLength(0);

    await expect(
      service.getWorktreeDeleteNotes(PROJECT_ID, "acme.sync", "/repo/wt")
    ).resolves.toEqual({
      status: "answered",
      notes: [{ severity: "warning", text: "2 edits on feature/x" }],
    });
    expect(devWorkerMock.instances).toHaveLength(1);
    service.dispose();
  });

  it("neither lists nor starts a plugin whose notes the user turned off", async () => {
    const service = await setup(`
      await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, { provideNotes: async () => [] });
    `);
    storeMock._state.set("pluginWorktreeDeleteNoteMutes", ["acme.sync"]);
    expect(service.listWorktreeDeleteNoteSources(PROJECT_ID)).toEqual([]);
    await expect(
      service.getWorktreeDeleteNotes(PROJECT_ID, "acme.sync", "/repo/wt")
    ).resolves.toBeNull();
    expect(devWorkerMock.instances).toHaveLength(0);
    service.dispose();
  });

  it("drops the check a plugin bound before its activation threw, and reads it as no answer", async () => {
    const service = await setup(`
      await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, {
        provideNotes: async () => [{ severity: "info", text: "from a broken start" }],
      });
      throw new Error("boom");
    `);
    await expect(
      service.getWorktreeDeleteNotes(PROJECT_ID, "acme.sync", "/repo/wt")
    ).resolves.toEqual({ status: "no-answer" });
    expect(getWorktreeDeleteNotesBinding("acme.sync")).toBeUndefined();
    service.dispose();
  });

  it("asks nothing about a worktree that isn't the project's", async () => {
    const service = await setup(`
      await host.registerWorktreeDeleteNotesProvider({ id: "notes" }, { provideNotes: async () => [] });
    `);
    await expect(
      service.getWorktreeDeleteNotes(PROJECT_ID, "acme.sync", "/elsewhere")
    ).resolves.toBeNull();
    service.dispose();
  });

  it("stops waiting on the startup scan once its budget is spent", async () => {
    vi.useFakeTimers();
    try {
      const service = new PluginService(tmpDir);
      let settled = false;
      void service.waitForCatalogWithin(500).then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      service.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
