import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "fs/promises";
import path from "path";
import os from "os";
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
const webContentsRegistryMock = vi.hoisted(() => ({
  getWindowForWebContents: vi.fn((_wc: unknown): { id: number } | null => null),
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
vi.mock("../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: webContentsRegistryMock.getWindowForWebContents,
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

describe("Plugin panel kind registry broadcast", () => {
  it("dispose() drops a microtask scheduled before disposal", async () => {
    // Capture the listener PluginService passes into onPanelKindRegistered so
    // we can fire it directly — this simulates a register event arriving from
    // the shared registry during the test.
    const registryMock = await import("../../../shared/config/panelKindRegistry.js");
    const onRegisteredMock = vi.mocked(registryMock.onPanelKindRegistered);
    let capturedRegisterListener: ((config: PanelKindConfig) => void) | null = null;
    onRegisteredMock.mockImplementation((listener: (config: PanelKindConfig) => void) => {
      capturedRegisterListener = listener;
      return () => {};
    });

    const service = new PluginService();
    expect(capturedRegisterListener).toBeTypeOf("function");

    // Simulate a register event — schedules a microtask broadcast
    const mockConfig: PanelKindConfig = {
      id: "test-panel",
      name: "Test Panel",
      iconId: "test",
      color: "#000000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "test-ext",
    };
    capturedRegisterListener!(mockConfig);
    // Dispose before the microtask drains
    service.dispose();

    // Allow microtasks to drain
    await Promise.resolve();
    await Promise.resolve();

    // Disposal must have cancelled the pending broadcast
    const panelKindBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:panel-kinds-changed"
    );
    expect(panelKindBroadcasts).toHaveLength(0);
  });
});

describe("Plugin context-menu items broadcast", () => {
  it("coalesces load + unload in the same tick into a single broadcast with complete=true", async () => {
    const service = new PluginService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(true);

    await Promise.resolve();
    await Promise.resolve();

    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:context-menu-items-changed"
    );
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0]?.[1] as { payload: { complete: boolean } }).payload.complete).toBe(true);

    service.dispose();
  });

  it("dispose() drops a context-menu items broadcast scheduled before disposal", async () => {
    const service = new PluginService();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).broadcaster.scheduleContextMenuItemsBroadcast(true);
    service.dispose();

    await Promise.resolve();
    await Promise.resolve();

    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call) => (call[1] as { name?: unknown })?.name === "plugin:context-menu-items-changed"
    );
    expect(broadcasts).toHaveLength(0);
  });
});

describe("capabilities declaration logging", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs declared capabilities when plugin has capabilities", async () => {
    await writePlugin("perm-plugin", {
      name: "acme.perm-plugin",
      version: "1.0.0",
      capabilities: ["fs:project-read", "network:fetch"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plugin "acme.perm-plugin" declares capabilities: fs:project-read, network:fetch'
      )
    );
  });

  it("does not log when plugin has no capabilities", async () => {
    await writePlugin("no-perms", {
      name: "acme.no-perms",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("does not log capabilities for incompatible plugins", async () => {
    await writePlugin("incompatible-perms", {
      name: "acme.incompatible-perms",
      version: "1.0.0",
      capabilities: ["fs:project-read"],
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });

  it("includes capabilities in loaded plugin manifest", async () => {
    await writePlugin("with-perms", {
      name: "acme.with-perms",
      version: "1.0.0",
      capabilities: ["git:read", "agent:invoke"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual(["git:read", "agent:invoke"]);
  });

  it("defaults capabilities to empty array for plugins without the field", async () => {
    await writePlugin("no-field", {
      name: "acme.no-field",
      version: "1.0.0",
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    const plugins = service.listPlugins();
    expect(plugins[0].manifest.capabilities).toEqual([]);
  });

  it("rejects plugins that declare unknown capabilities and does not log them", async () => {
    await writePlugin("unknown-perm", {
      name: "acme.unknown-perm",
      version: "1.0.0",
      capabilities: ["shell:exec", "invalid:perm"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins with newline characters in capability strings", async () => {
    await writePlugin("padded-perm", {
      name: "acme.padded-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read\n", "agent:invoke\r"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest"),
      expect.any(Array)
    );
  });

  it("rejects plugins where any one capability in a mixed array is invalid", async () => {
    await writePlugin("mixed-perm", {
      name: "acme.mixed-perm",
      version: "1.0.0",
      capabilities: ["fs:project-read", "invalid:perm", "git:read"],
    });

    const service = new PluginService(tmpDir);
    await service.initialize();

    expect(service.listPlugins()).toEqual([]);
    const permLogs = logSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("declares capabilities")
    );
    expect(permLogs).toHaveLength(0);
  });
});

describe("Plugin worktree host API", () => {
  // The host worktree APIs window-scope their snapshot fetch (#11297): they
  // resolve the renderer the plugin is acting for, map it to a BrowserWindow,
  // and pass that id to `getAllStatesAsync`. With no resolvable window they
  // return empty rather than a cross-project aggregate, so these tests must
  // stand up a resolvable one. `getAllStatesAsync` itself ignores the id, so
  // the assertions below still exercise the projection, not the routing.
  const fakeActiveWebContents = { id: 99, isDestroyed: () => false };

  beforeEach(() => {
    windowRefMock.getProjectViewManager.mockReturnValue({
      getActiveView: () => ({ webContents: fakeActiveWebContents }),
    } as never);
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue({ id: 1 });
  });

  afterEach(() => {
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue(null);
  });

  type WorktreeSnapshotLike = {
    id: string;
    worktreeId: string;
    path: string;
    name: string;
    isCurrent: boolean;
    branch?: string;
    aheadCount?: number;
    issueNumber?: number;
    lastActivityTimestamp?: number | null;
    worktreeChanges?: {
      worktreeId: string;
      rootPath: string;
      changes: Array<{ path: string; status: string; insertions: null; deletions: null }>;
      changedFileCount: number;
    };
    _secret?: string;
  };

  function mkSnap(over: Partial<WorktreeSnapshotLike> & { id: string }): WorktreeSnapshotLike {
    return {
      worktreeId: over.id,
      path: `/tmp/${over.id}`,
      name: over.id,
      isCurrent: false,
      ...over,
    };
  }

  function createMockClient(initial: WorktreeSnapshotLike[] = []) {
    const emitter = new EventEmitter();
    let states = initial;
    const getAllStatesAsync = vi.fn(() => Promise.resolve(states));
    const client = Object.assign(emitter, {
      getAllStatesAsync,
      setStates: (next: WorktreeSnapshotLike[]) => {
        states = next;
      },
    });
    return client;
  }

  type HostWithWorktree = {
    pluginId: string;
    registerHandler: (c: string, h: (...args: unknown[]) => unknown) => void;
    broadcastToRenderer: (c: string, p: unknown) => void;
    getActiveWorktree: () => Promise<unknown>;
    getWorktrees: () => Promise<unknown[]>;
    getWorktreeStatus: (path: string) => Promise<unknown>;
    onDidChangeActiveWorktree: (cb: (s: unknown) => void) => () => void;
    onDidChangeWorktrees: (cb: (list: unknown[]) => void) => () => void;
  };

  async function setup(snapshots: WorktreeSnapshotLike[] = []) {
    await writePlugin("wt-host", { name: "acme.wt-host", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const client = createMockClient(snapshots);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => {
          host: HostWithWorktree;
          revoke: () => void;
        };
      }
    ).createHost("acme.wt-host");
    return { service, client, host, revoke };
  }

  it("getActiveWorktree returns a frozen projection of the isCurrent snapshot", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true, branch: "feature/x", _secret: "leak" }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown> | null;
    expect(active).not.toBeNull();
    expect(active!.id).toBe("b");
    expect(active!.branch).toBe("feature/x");
    // Internal fields must not leak through the projection
    expect("_secret" in active!).toBe(false);
    expect(Object.isFrozen(active)).toBe(true);
  });

  it("getActiveWorktree returns null when no worktree is current", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: false })]);
    expect(await host.getActiveWorktree()).toBeNull();
  });

  // ── #11297: window scoping ──

  it("scopes the snapshot fetch to the resolved window's id", async () => {
    const { host, client } = await setup([mkSnap({ id: "b", isCurrent: true })]);
    await host.getActiveWorktree();
    // Not called bare: an unscoped fetch aggregates every open project and
    // hands back whichever `isCurrent` snapshot happens to sort first.
    expect(client.getAllStatesAsync).toHaveBeenCalledWith(1);
  });

  it("returns empty rather than a cross-project aggregate when no window resolves", async () => {
    const { host, client } = await setup([mkSnap({ id: "b", isCurrent: true })]);
    windowRefMock.getProjectViewManager.mockReturnValue(null);

    expect(await host.getWorktrees()).toEqual([]);
    expect(await host.getActiveWorktree()).toBeNull();
    // The unscoped call is the bug — it must never be reached.
    expect(client.getAllStatesAsync).not.toHaveBeenCalled();
  });

  it("returns empty when the resolved webContents maps to no window", async () => {
    const { host, client } = await setup([mkSnap({ id: "b", isCurrent: true })]);
    webContentsRegistryMock.getWindowForWebContents.mockReturnValue(null);

    expect(await host.getWorktrees()).toEqual([]);
    expect(client.getAllStatesAsync).not.toHaveBeenCalled();
  });

  // ── #11297: sender-precise lookup backing plugin:invoke's IPC context ──

  type ServiceWithWindowLookup = {
    getActiveWorktreeIdForWindow: (windowId: number | undefined) => Promise<string | null>;
  };

  it("getActiveWorktreeIdForWindow resolves the given window's current worktree", async () => {
    const { service, client } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true }),
    ]);

    const id = await (service as unknown as ServiceWithWindowLookup).getActiveWorktreeIdForWindow(
      7
    );
    expect(id).toBe("b");
    // Uses the id it was handed — the caller's real sender — not the
    // focused-window heuristic the host APIs fall back to.
    expect(client.getAllStatesAsync).toHaveBeenCalledWith(7);
  });

  it("getActiveWorktreeIdForWindow returns null for an unresolved window without querying", async () => {
    const { service, client } = await setup([mkSnap({ id: "b", isCurrent: true })]);

    expect(
      await (service as unknown as ServiceWithWindowLookup).getActiveWorktreeIdForWindow(undefined)
    ).toBeNull();
    expect(client.getAllStatesAsync).not.toHaveBeenCalled();
  });

  it("getActiveWorktreeIdForWindow degrades to null when the workspace host fails", async () => {
    // This sits on the critical path of every plugin:invoke — a wedged
    // workspace host must cost the context, not the invocation.
    const { service, client } = await setup([mkSnap({ id: "b", isCurrent: true })]);
    client.getAllStatesAsync.mockRejectedValueOnce(new Error("workspace host down"));

    await expect(
      (service as unknown as ServiceWithWindowLookup).getActiveWorktreeIdForWindow(7)
    ).resolves.toBeNull();
  });

  it("getWorktrees returns frozen snapshots for every worktree", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({ id: "b", isCurrent: true }),
    ]);
    const list = (await host.getWorktrees()) as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(list.every((s) => Object.isFrozen(s))).toBe(true);
  });

  it("getWorktreeStatus returns the changed-file projection for the matching path", async () => {
    const { host } = await setup([
      mkSnap({ id: "a", isCurrent: false }),
      mkSnap({
        id: "b",
        isCurrent: true,
        worktreeChanges: {
          worktreeId: "b",
          rootPath: "/tmp/b",
          changes: [
            { path: "src/x.ts", status: "modified", insertions: null, deletions: null },
            { path: "src/y.ts", status: "untracked", insertions: null, deletions: null },
          ],
          changedFileCount: 2,
        },
      }),
    ]);

    const status = (await host.getWorktreeStatus("/tmp/b")) as {
      changedFileCount: number;
      files: Array<{ path: string; state: string }>;
    } | null;
    expect(status).not.toBeNull();
    expect(status!.changedFileCount).toBe(2);
    expect(status!.files).toEqual([
      { path: "src/x.ts", state: "modified" },
      { path: "src/y.ts", state: "untracked" },
    ]);
    expect(Object.isFrozen(status)).toBe(true);
  });

  it("getWorktreeStatus returns null when no worktree matches the path", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: true })]);
    expect(await host.getWorktreeStatus("/tmp/does-not-exist")).toBeNull();
  });

  it("getWorktreeStatus returns null when the matched worktree has no polled changes", async () => {
    const { host } = await setup([mkSnap({ id: "a", isCurrent: true })]);
    // /tmp/a exists but carries no worktreeChanges → null, not an empty status.
    expect(await host.getWorktreeStatus("/tmp/a")).toBeNull();
  });

  it("getActiveWorktree returns null when WorkspaceClient is not wired", async () => {
    await writePlugin("wt-nowsc", { name: "acme.wt-nowsc", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally skip setWorkspaceClient
    const { host } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-nowsc");
    expect(await host.getActiveWorktree()).toBeNull();
    expect(await host.getWorktrees()).toEqual([]);
  });

  it("onDidChangeActiveWorktree fires with the new active snapshot", async () => {
    const snaps = [mkSnap({ id: "a", isCurrent: true })];
    const { host, client, revoke } = await setup(snaps);

    // Subscribe during "activate" window (before revoke), as a real plugin would.
    const cb = vi.fn();
    const dispose = await host.onDidChangeActiveWorktree(cb);
    revoke();

    client.setStates([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
    expect(arg.branch).toBe("dev");

    dispose();
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    // Ensure no additional calls after dispose
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("onDidChangeWorktrees fires with the full list on worktree-update", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    await host.onDidChangeWorktrees(cb);
    revoke();

    client.emit("worktree-update", {
      worktree: mkSnap({ id: "a", isCurrent: true }),
      projectPath: "/p",
    });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("disposers are idempotent and only remove the matching listener", async () => {
    const { host, client, revoke } = await setup();

    const cbA = vi.fn();
    const cbB = vi.fn();
    const disposeA = await host.onDidChangeActiveWorktree(cbA);
    await host.onDidChangeActiveWorktree(cbB);
    revoke();

    disposeA();
    disposeA(); // no-op

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await vi.waitFor(() => expect(cbB).toHaveBeenCalledTimes(1));
    expect(cbA).not.toHaveBeenCalled();
  });

  it("unloadPlugin flushes every worktree event listener for the plugin", async () => {
    const { service, host, client, revoke } = await setup();

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    await host.onDidChangeActiveWorktree(cb1);
    await host.onDidChangeWorktrees(cb2);
    revoke();

    // worktree-activated carries an extra service-level listener: the #10621
    // cache-eviction subscription wired in setWorkspaceClient (independent of any
    // plugin). worktree-update has only the plugin's listener.
    expect(client.listenerCount("worktree-activated")).toBe(2);
    expect(client.listenerCount("worktree-update")).toBe(1);

    service.unloadPlugin("acme.wt-host");

    // The plugin's listeners are flushed; the service-level eviction listener on
    // worktree-activated survives the unload (it's torn down only on dispose).
    expect(client.listenerCount("worktree-activated")).toBe(1);
    expect(client.listenerCount("worktree-update")).toBe(0);

    client.emit("worktree-activated", { worktreeId: "x", projectPath: "/p" });
    client.emit("worktree-update", { worktree: mkSnap({ id: "x" }), projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("registering an event subscription after revoke throws", async () => {
    const { host, revoke } = await setup();

    // Pre-revoke registration is allowed (this is the activate() window).
    expect(() => host.onDidChangeActiveWorktree(() => {})).not.toThrow();

    revoke();

    // Post-revoke registration is rejected — simulates a plugin holding the
    // host reference and trying to subscribe after activate() returned.
    expect(() => host.onDidChangeActiveWorktree(() => {})).toThrow(/host revoked/);
    expect(() => host.onDidChangeWorktrees(() => {})).toThrow(/host revoked/);
  });

  it("callbacks do not fire after unloadPlugin even if the client emits again", async () => {
    const { service, host, client, revoke } = await setup();
    const cb = vi.fn();
    await host.onDidChangeActiveWorktree(cb);
    revoke();

    service.unloadPlugin("acme.wt-host");

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("subscriptions registered before setWorkspaceClient replay against the new client", async () => {
    await writePlugin("wt-boot", { name: "acme.wt-boot", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    // Intentionally do NOT set the workspace client yet — this simulates a
    // plugin calling host.onDidChange* during its activate() on cold boot,
    // before windowServices wires up WorkspaceClient.
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot");

    const cb = vi.fn();
    await host.onDidChangeActiveWorktree(cb);
    revoke();

    // Now the client becomes available — subscriptions must be replayed.
    const client = createMockClient([mkSnap({ id: "b", isCurrent: true, branch: "dev" })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    // One replayed plugin subscription plus the service-level cache-eviction
    // listener that setWorkspaceClient always attaches (#10621).
    expect(client.listenerCount("worktree-activated")).toBe(2);

    client.emit("worktree-activated", { worktreeId: "b", projectPath: "/p" });
    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const arg = cb.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.id).toBe("b");
  });

  it("disposing a pending subscription before setWorkspaceClient stops replay", async () => {
    await writePlugin("wt-boot2", { name: "acme.wt-boot2", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: HostWithWorktree; revoke: () => void };
      }
    ).createHost("acme.wt-boot2");

    const cb = vi.fn();
    const dispose = await host.onDidChangeActiveWorktree(cb);
    revoke();
    dispose();

    const client = createMockClient([mkSnap({ id: "a", isCurrent: true })]);
    (service as unknown as { setWorkspaceClient: (c: unknown) => void }).setWorkspaceClient(client);

    // The disposed plugin subscription does not replay; only the service-level
    // cache-eviction listener that setWorkspaceClient attaches remains (#10621).
    expect(client.listenerCount("worktree-activated")).toBe(1);
    client.emit("worktree-activated", { worktreeId: "a", projectPath: "/p" });
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("onDidChangeWorktrees fires on worktree-removed with the post-removal list", async () => {
    const { host, client, revoke } = await setup([
      mkSnap({ id: "a", isCurrent: true }),
      mkSnap({ id: "b", isCurrent: false }),
    ]);

    const cb = vi.fn();
    await host.onDidChangeWorktrees(cb);
    revoke();

    client.setStates([mkSnap({ id: "a", isCurrent: true })]);
    client.emit("worktree-removed", { worktreeId: "b", projectPath: "/p" });

    await vi.waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    const list = cb.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(list.map((s) => s.id)).toEqual(["a"]);
  });

  it("onDidChangeWorktrees disposer stops both update and remove subscriptions", async () => {
    const { host, client, revoke } = await setup([mkSnap({ id: "a", isCurrent: true })]);

    const cb = vi.fn();
    const dispose = await host.onDidChangeWorktrees(cb);
    revoke();
    expect(client.listenerCount("worktree-update")).toBe(1);
    expect(client.listenerCount("worktree-removed")).toBe(1);

    dispose();
    expect(client.listenerCount("worktree-update")).toBe(0);
    expect(client.listenerCount("worktree-removed")).toBe(0);
  });

  it("plugin snapshot exposes exactly the documented allowlist fields", async () => {
    const { host } = await setup([
      mkSnap({
        id: "a",
        isCurrent: true,
        branch: "main",
        aheadCount: 1,
        // A field that must NOT leak to plugins — the real WorktreeSnapshot
        // has dozens of these; we sample one as a guard.
        _secret: "leak-me",
      }),
    ]);

    const active = (await host.getActiveWorktree()) as Record<string, unknown>;
    expect(active).not.toBeNull();
    const expected = [
      "aheadCount",
      "behindCount",
      "branch",
      "createdAt",
      "id",
      "isCurrent",
      "isMainWorktree",
      "lastActivityTimestamp",
      "linked",
      "mood",
      "name",
      "path",
      "status",
      "worktreeId",
    ];
    expect(Object.keys(active).sort()).toEqual(expected);
    expect("_secret" in active).toBe(false);
    // None of the removed GitHub-shaped fields should leak through.
    for (const removed of [
      "issueNumber",
      "issueTitle",
      "prNumber",
      "prState",
      "prTitle",
      "prUrl",
    ]) {
      expect(removed in active).toBe(false);
    }
  });
});
