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
import { PluginProcessManager, type ManagedChildProcess } from "../plugin/PluginProcessManager.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../plugin-capability/instances.js";
import { type PluginIpcContext } from "../../../shared/types/plugin.js";
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

type CreateHostShape = (pluginId: string) => {
  host: {
    pluginId: string;
    registerHandler: (
      channel: string,
      schemaOrHandler: unknown,
      typedHandler?: (...args: unknown[]) => unknown
    ) => void;
    broadcastToRenderer: (channel: string, payload: unknown) => void;
    postToPanel: (channel: string, payload: unknown, panelId?: string | null) => Promise<void>;
    setPanelBadge: (panelId: string, badge: unknown) => Promise<void>;
    invalidateFileDecorations: (scope: string, paths?: string[]) => Promise<void>;
    registerForgeProvider: (descriptor: { id: string }, impl: unknown) => () => void;
  };
  revoke: () => void;
};

describe("createHost (plugin activation API)", () => {
  it("host.registerHandler delegates with the plugin's own namespace", async () => {
    await writePlugin("host-test", { name: "acme.host-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.host-test"
    );

    expect(host.pluginId).toBe("acme.host-test");

    const handler = vi.fn().mockReturnValue("ok");
    host.registerHandler("probe", handler);

    const ctx = makeCtx("acme.host-test");
    const result = await service.dispatchHandler("acme.host-test", "probe", ctx, ["a"]);
    expect(handler).toHaveBeenCalledWith(ctx, "a");
    expect(result).toBe("ok");
  });

  it("host.broadcastToRenderer namespaces channels as plugin:{pluginId}:{channel}", async () => {
    await writePlugin("bcast-test", { name: "acme.bcast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-test"
    );

    broadcastToRendererMock.mockClear();
    host.broadcastToRenderer("status", { ok: true });
    // Wrapped in the per-instance envelope (panelId: null = broadcast) so the
    // preload dispatcher sees the same shape for every push over this transport.
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.bcast-test:status", {
      panelId: null,
      payload: { ok: true },
    });
  });

  it("host.broadcastToRenderer rejects channels containing colons", async () => {
    await writePlugin("bcast-reject", { name: "acme.bcast-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.bcast-reject"
    );

    expect(() => host.broadcastToRenderer("bad:channel", null)).toThrow(
      "Plugin broadcast channel must be a string without colons"
    );
  });

  it("host.registerHandler rejects a 3-arg call where the second arg isn't a channel schema", async () => {
    await writePlugin("mismatch-test", { name: "acme.mismatch", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.mismatch"
    );

    expect(() =>
      // A typed handler was provided but the second arg is a function, not
      // a schema — silently dropping the typed handler would phantom-no-op
      // at dispatch, so this must throw.
      host.registerHandler(
        "ch",
        () => "legacy",
        () => "typed"
      )
    ).toThrow(/second argument must be a channel schema/);
  });

  it("revoked host rejects registerHandler and broadcastToRenderer calls", async () => {
    await writePlugin("revoke-test", { name: "acme.revoke-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.revoke-test"
    );

    revoke();

    expect(() => host.registerHandler("x", () => undefined)).toThrow(
      /host revoked: registerHandler/
    );
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked: broadcastToRenderer/);
    expect(() => host.registerForgeProvider({ id: "github" }, {})).toThrow(
      /host revoked: registerForgeProvider/
    );
  });

  it("host.postToPanel fans out to the plugin:{pluginId}:{channel} subscriber channel", async () => {
    await writePlugin("post-test", { name: "acme.post-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-test"
    );

    broadcastToRendererMock.mockClear();
    host.postToPanel("tick", { count: 3 });
    // Same transport as the renderer-side window.electron.plugin.on subscription
    // (`plugin:${pluginId}:${channel}`), so a subscribed panel receives the push.
    // No panelId → broadcast envelope (panelId: null).
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-test:tick", {
      panelId: null,
      payload: { count: 3 },
    });
  });

  it("host.postToPanel targets a single instance when given a panelId", async () => {
    await writePlugin("post-target", { name: "acme.post-target", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-target"
    );

    broadcastToRendererMock.mockClear();
    host.postToPanel("tick", { count: 7 }, "panel-a");
    // The panelId rides in the envelope so the preload dispatcher fans out only
    // to the onPanel("panel-a") subscriber, not to sibling instances (#10618).
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-target:tick", {
      panelId: "panel-a",
      payload: { count: 7 },
    });
  });

  it("host.postToPanel rejects an empty-string panelId", async () => {
    await writePlugin("post-bad-panel", { name: "acme.post-bad-panel", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-bad-panel"
    );

    broadcastToRendererMock.mockClear();
    // An empty string would silently match no subscriber — surface it loudly
    // rather than coercing to a broadcast.
    expect(() => host.postToPanel("tick", { n: 1 }, "")).toThrow(/postToPanel: panelId/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
    // null is an explicit broadcast and must NOT throw.
    expect(() => host.postToPanel("tick", { n: 2 }, null)).not.toThrow();
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-bad-panel:tick", {
      panelId: null,
      payload: { n: 2 },
    });
  });

  it("host.postToPanel remains callable AFTER the activation host is revoked", async () => {
    await writePlugin("post-postact", { name: "acme.post-postact", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-postact"
    );

    // Revoke the activation window — broadcastToRenderer is now closed, but
    // postToPanel (its post-activation-safe sibling) must keep delivering so a
    // plugin can stream from timers/polls long after activate() resolves.
    revoke();
    expect(() => host.broadcastToRenderer("x", null)).toThrow(/host revoked/);

    broadcastToRendererMock.mockClear();
    expect(() => host.postToPanel("tick", { n: 1 })).not.toThrow();
    expect(broadcastToRendererMock).toHaveBeenCalledWith("plugin:acme.post-postact:tick", {
      panelId: null,
      payload: { n: 1 },
    });
  });

  it("host.postToPanel rejects empty or colon-bearing channels", async () => {
    await writePlugin("post-reject", { name: "acme.post-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-reject"
    );

    broadcastToRendererMock.mockClear();
    // Validation errors must REJECT (not throw synchronously) so a plugin can
    // `.catch()` a non-awaited call — the promise-based error contract (#10617).
    // A sync throw would escape the Promise and force a try/catch wrapper.
    await expect(host.postToPanel("bad:channel", null)).rejects.toThrow(/postToPanel: channel/);
    await expect(host.postToPanel("", null)).rejects.toThrow(/postToPanel: channel/);
    // Calling without awaiting must not throw synchronously — the rejection is
    // delivered through the returned promise, catchable via `.catch()`.
    let caught: unknown;
    const pending = host.postToPanel("also:bad", null).catch((err) => {
      caught = err;
    });
    await pending;
    expect(caught).toBeInstanceOf(Error);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.postToPanel silently no-ops once the plugin is unloaded", async () => {
    await writePlugin("post-unloaded", { name: "acme.post-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.post-unloaded"
    );

    service.unloadPlugin("acme.post-unloaded");

    broadcastToRendererMock.mockClear();
    expect(() => host.postToPanel("tick", { n: 1 })).not.toThrow();
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.setPanelBadge rejects an invalid panelId or badge shape (#10617)", async () => {
    await writePlugin("badge-reject", { name: "acme.badge-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.badge-reject"
    );

    broadcastToRendererMock.mockClear();
    // Empty panelId and a malformed badge must reject through the Promise, not
    // throw synchronously — the runtime-surface error contract (#10617).
    await expect(host.setPanelBadge("", { kind: "dot" })).rejects.toThrow(/setPanelBadge: panelId/);
    await expect(host.setPanelBadge("panel-1", { kind: "bogus" })).rejects.toThrow(
      /setPanelBadge: invalid badge/
    );
    // Non-awaited call is catchable, never a sync throw.
    let caught: unknown;
    await host.setPanelBadge("", null).catch((err) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(Error);
    // A rejected setPanelBadge has no side effect: no badge-changed broadcast.
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("host.setPanelBadge silently no-ops once the plugin is unloaded (#10617)", async () => {
    await writePlugin("badge-unloaded", { name: "acme.badge-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.badge-unloaded"
    );
    service.unloadPlugin("acme.badge-unloaded");

    // Liveness no-op stays a silent resolve even with an otherwise-invalid badge.
    await expect(host.setPanelBadge("", { kind: "bogus" })).resolves.toBeUndefined();
  });

  it("host.invalidateFileDecorations rejects an empty scope (#10617)", async () => {
    await writePlugin("deco-reject", { name: "acme.deco-reject", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.deco-reject"
    );

    // Empty scope rejects at the first guard, before the declared-scope check —
    // through the Promise, not a sync throw (#10617).
    await expect(host.invalidateFileDecorations("")).rejects.toThrow(
      /invalidateFileDecorations: scope/
    );
    // A non-empty but undeclared scope rejects at the second guard, also through
    // the Promise (this plugin declares no fileDecorationProviders).
    await expect(host.invalidateFileDecorations("acme.deco-reject:*")).rejects.toThrow(
      /is not covered by any declared/
    );
  });

  it("host.invalidateFileDecorations silently no-ops once the plugin is unloaded (#10617)", async () => {
    await writePlugin("deco-unloaded", { name: "acme.deco-unloaded", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.deco-unloaded"
    );
    service.unloadPlugin("acme.deco-unloaded");

    await expect(host.invalidateFileDecorations("")).resolves.toBeUndefined();
  });
});

type ProcessHostShape = (pluginId: string) => {
  host: {
    process: {
      spawn: (
        command: string,
        options?: { args?: string[]; cwd?: string; env?: Record<string, string> }
      ) => Promise<{
        id: string;
        kill: () => void;
        restart: () => Promise<void>;
        onExit: (
          cb: (info: { exitCode: number | null; signal: string | null }) => void
        ) => () => void;
        onCrash: (
          cb: (info: { exitCode: number | null; signal: string | null }) => void
        ) => () => void;
      }>;
    };
  };
  revoke: () => void;
};

function makeFakeChild() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  const child: ManagedChildProcess = {
    pid: 9999,
    stdout: null,
    stderr: null,
    kill(signal) {
      killSignals.push(signal);
      return true;
    },
    on: ((event: string, listener: (...args: never[]) => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener as (...args: unknown[]) => void);
      listeners.set(event, arr);
      return child;
    }) as ManagedChildProcess["on"],
  };
  return { child, killSignals };
}

describe("createHost — host.process (managed processes, #9234)", () => {
  // JIT capability consent (#10524) gates the first shell:exec spawn. Auto-approve
  // without pinning so the spawn-path assertions run without a renderer; the
  // dedicated consent tests cover the prompt/denial branch. The no-capability
  // test below rejects before consent is even consulted, so it is unaffected.
  beforeEach(() => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
  });
  afterEach(() => {
    _resetPluginCapabilityServicesForTest();
  });

  it("rejects spawn from a plugin without the shell:exec capability", async () => {
    await writePlugin("proc-nocap", { name: "acme.proc-nocap", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-nocap"
    );

    await expect(host.process.spawn("node", { args: ["x.js"] })).rejects.toThrow(
      /PERMISSION_REQUIRED.*shell:exec/
    );
  });

  it("spawns through the manager when shell:exec is declared", async () => {
    await writePlugin("proc-cap", {
      name: "acme.proc-cap",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: () => {
        const fake = makeFakeChild();
        fakes.push(fake);
        return fake.child;
      },
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-cap"
    );

    const handle = await host.process.spawn("node", { args: ["server.js"], cwd: "/repo" });
    expect(typeof handle.id).toBe("string");
    expect(fakes).toHaveLength(1);
    expect(manager.runningCount("acme.proc-cap")).toBe(1);
  });

  it("blocks the spawn and never reaches the manager when consent is denied (#10524)", async () => {
    await writePlugin("proc-deny", {
      name: "acme.proc-deny",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const spawner = vi.fn(() => makeFakeChild().child);
    const manager = new PluginProcessManager({ streamSink: () => {}, spawner, killGraceMs: 10 });
    service._setProcessManagerForTests(manager);
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-deny"
    );

    await expect(host.process.spawn("node", { args: ["server.js"] })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(spawner).not.toHaveBeenCalled();
    expect(manager.runningCount("acme.proc-deny")).toBe(0);
  });

  it("does not spend a consent prompt on an invalid spawn that fails validation (#10524)", async () => {
    await writePlugin("proc-invalid", {
      name: "acme.proc-invalid",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const bridge = vi.fn(async () => "approved-and-pin" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-invalid"
    );

    // An empty command fails validation; the prompt must NOT fire (else a plugin
    // could bank a silent grant via a deliberately-doomed call).
    await expect(host.process.spawn("")).rejects.toThrow(/non-empty string/);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("rejects invalid mode/panelId/geometry before spending a consent prompt (#11300)", async () => {
    await writePlugin("proc-args", {
      name: "acme.proc-args",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const bridge = vi.fn(async () => "approved-and-pin" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const spawner = vi.fn(() => makeFakeChild().child);
    const manager = new PluginProcessManager({ streamSink: () => {}, spawner, killGraceMs: 10 });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-args"
    );
    const spawn = host.process.spawn as (command: string, options?: unknown) => Promise<unknown>;

    await expect(spawn("node", { mode: "interactive" })).rejects.toThrow(/mode must be/);
    // An empty panelId would silently match no subscriber — reject, don't coerce.
    await expect(spawn("node", { panelId: "" })).rejects.toThrow(/panelId must be/);
    await expect(spawn("node", { mode: "pty", cols: 0 })).rejects.toThrow(/cols must be/);
    await expect(spawn("node", { mode: "pty", rows: 10.5 })).rejects.toThrow(/rows must be/);

    // None of these reached consent or the manager.
    expect(bridge).not.toHaveBeenCalled();
    expect(spawner).not.toHaveBeenCalled();
  });

  it("accepts null/undefined panelId and defaults to pipe mode (#11300)", async () => {
    await writePlugin("proc-defaults", {
      name: "acme.proc-defaults",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const configs: Array<{ mode: string; panelId: string | null }> = [];
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: (config) => {
        configs.push({ mode: config.mode, panelId: config.panelId });
        return makeFakeChild().child;
      },
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-defaults"
    );
    const spawn = host.process.spawn as (command: string, options?: unknown) => Promise<unknown>;

    await spawn("node");
    await spawn("node", { panelId: null });
    await spawn("node", { panelId: "panel-3" });

    expect(configs).toEqual([
      { mode: "pipe", panelId: null },
      { mode: "pipe", panelId: null },
      { mode: "pipe", panelId: "panel-3" },
    ]);
  });

  it("rejects interactive mode when the host has no PTY backend (#11300)", async () => {
    await writePlugin("proc-nopty", {
      name: "acme.proc-nopty",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    // No ptySpawner injected — the manager must refuse rather than silently
    // downgrading an interactive request to a pipe child with no stdin.
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: () => makeFakeChild().child,
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-nopty"
    );
    const spawn = host.process.spawn as (command: string, options?: unknown) => Promise<unknown>;
    await expect(spawn("flutter", { mode: "pty" })).rejects.toThrow(/unavailable/);
  });

  it("kills outstanding processes when the plugin is unloaded", async () => {
    await writePlugin("proc-unload", {
      name: "acme.proc-unload",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const fakes: ReturnType<typeof makeFakeChild>[] = [];
    const manager = new PluginProcessManager({
      streamSink: () => {},
      spawner: () => {
        const fake = makeFakeChild();
        fakes.push(fake);
        return fake.child;
      },
      killGraceMs: 10,
    });
    service._setProcessManagerForTests(manager);

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-unload"
    );
    await host.process.spawn("sleep", { args: ["100"] });
    expect(manager.runningCount("acme.proc-unload")).toBe(1);

    service.unloadPlugin("acme.proc-unload");

    // The unload teardown SIGTERMs the outstanding process.
    expect(fakes[0]!.killSignals).toContain("SIGTERM");
  });

  it("denies a spawn from a plugin that has already been unloaded", async () => {
    await writePlugin("proc-gone", {
      name: "acme.proc-gone",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ProcessHostShape }).createHost(
      "acme.proc-gone"
    );
    service.unloadPlugin("acme.proc-gone");

    await expect(host.process.spawn("node")).rejects.toThrow(/no longer loaded/);
  });
});

type ShowToastOptions = {
  message: string;
  type?: "info" | "success" | "warning" | "error";
  durationMs?: number;
};
type ToastHostShape = (pluginId: string) => {
  host: { showToast: (options: ShowToastOptions) => Promise<void> };
  revoke: () => void;
};

describe("createHost — showToast", () => {
  it("broadcasts NOTIFICATION_SHOW_TOAST with the pluginId-namespaced message", async () => {
    await writePlugin("toast-test", { name: "acme.toast-test", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-test"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Synced 12 issues", type: "success" });

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-test: Synced 12 issues",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-test:success",
    });
  });

  it("defaults type to info when omitted", async () => {
    await writePlugin("toast-default", { name: "acme.toast-default", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-default"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Done" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-default: Done",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-default:info",
    });
  });

  it("forwards durationMs as duration", async () => {
    await writePlugin("toast-duration", { name: "acme.toast-duration", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-duration"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Saved", type: "success", durationMs: 3000 });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "success",
      message: "acme.toast-duration: Saved",
      duration: 3000,
      rateLimitKey: "plugin:acme.toast-duration:success",
    });
  });

  it("rejects an out-of-range or non-integer durationMs and does not broadcast", async () => {
    await writePlugin("toast-dur-range", { name: "acme.toast-dur-range", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-dur-range"
    );

    broadcastToRendererMock.mockClear();
    for (const durationMs of [0, -1, 1.5, 60_001]) {
      await expect(host.showToast({ message: "x", durationMs })).rejects.toThrow(
        /showToast: invalid options/
      );
    }
    // Boundaries that should pass.
    await host.showToast({ message: "min", durationMs: 1 });
    await host.showToast({ message: "max", durationMs: 60_000 });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a message over the max length and does not broadcast", async () => {
    await writePlugin("toast-maxlen", { name: "acme.toast-maxlen", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-maxlen"
    );

    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "x".repeat(2000) });
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);

    await expect(host.showToast({ message: "x".repeat(2001) })).rejects.toThrow(
      /showToast: invalid options/
    );
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty/whitespace message and does not broadcast", async () => {
    await writePlugin("toast-empty", { name: "acme.toast-empty", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-empty"
    );

    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "   " })).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown type and does not broadcast", async () => {
    await writePlugin("toast-badtype", { name: "acme.toast-badtype", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-badtype"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Oops", type: "fatal" as ShowToastOptions["type"] })
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("rejects unknown fields (strict schema)", async () => {
    await writePlugin("toast-strict", { name: "acme.toast-strict", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-strict"
    );

    broadcastToRendererMock.mockClear();
    await expect(
      host.showToast({ message: "Hi", priority: "low" } as unknown as ShowToastOptions)
    ).rejects.toThrow(/showToast: invalid options/);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("is NOT revoke-guarded — still delivers after revoke() while the plugin is loaded", async () => {
    await writePlugin("toast-revoke", { name: "acme.toast-revoke", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host, revoke } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-revoke"
    );

    revoke();
    broadcastToRendererMock.mockClear();
    await host.showToast({ message: "Still alive" });

    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.NOTIFICATION_SHOW_TOAST, {
      type: "info",
      message: "acme.toast-revoke: Still alive",
      duration: undefined,
      rateLimitKey: "plugin:acme.toast-revoke:info",
    });
  });

  it("is a silent no-op once the plugin is unloaded (liveness guard)", async () => {
    await writePlugin("toast-unload", { name: "acme.toast-unload", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ToastHostShape }).createHost(
      "acme.toast-unload"
    );

    service.unloadPlugin("acme.toast-unload");
    broadcastToRendererMock.mockClear();
    await expect(host.showToast({ message: "Gone" })).resolves.toBeUndefined();

    // unloadPlugin emits its own registry-change broadcasts; assert specifically
    // that no toast was delivered rather than "no broadcast at all".
    const toastBroadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) => call[0] === CHANNELS.NOTIFICATION_SHOW_TOAST
    );
    expect(toastBroadcasts).toHaveLength(0);
  });
});
