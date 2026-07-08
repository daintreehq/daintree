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

type DispatchHostShape = (pluginId: string) => {
  host: {
    dispatch: (
      actionId: string,
      args?: unknown
    ) => Promise<import("../../../shared/types/actions.js").ActionDispatchResult>;
  };
  revoke: () => void;
};

interface FakeWebContents {
  id: number;
  isDestroyed: () => boolean;
  once: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  _triggerDestroyed: () => void;
}

function makeFakeWebContents(id: number): FakeWebContents {
  const destroyedHandlers = new Set<() => void>();
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn((event: string, cb: () => void) => {
      if (event === "destroyed") destroyedHandlers.add(cb);
    }),
    removeListener: vi.fn((event: string, cb: () => void) => {
      if (event === "destroyed") destroyedHandlers.delete(cb);
    }),
    send: vi.fn(),
    _triggerDestroyed: () => {
      for (const cb of [...destroyedHandlers]) cb();
    },
  };
}

/** Set the active renderer the plugin dispatch bridge will target, or `null`. */
function setActiveWebContents(wc: FakeWebContents | null): void {
  windowRefMock.getWindowRegistry.mockReturnValue(null);
  windowRefMock.getProjectViewManager.mockReturnValue(
    wc ? ({ getActiveView: () => ({ webContents: wc }) } as never) : null
  );
}

/** Read the request payload from the most recent dispatch `webContents.send`. */
function lastDispatchRequest(wc: FakeWebContents): {
  requestId: string;
  actionId: string;
  args?: unknown;
} {
  const call = [...wc.send.mock.calls]
    .reverse()
    .find((c) => c[0] === CHANNELS.PLUGIN_DISPATCH_ACTION_REQUEST);
  if (!call) throw new Error("no PLUGIN_DISPATCH_ACTION_REQUEST send recorded");
  return call[1] as { requestId: string; actionId: string; args?: unknown };
}

describe("createHost — dispatch", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    setActiveWebContents(null);
  });

  it("returns PLUGIN_UNLOADED without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(7);
    setActiveWebContents(wc);
    await writePlugin("dispatch-unload", { name: "acme.dispatch-unload", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-unload"
    );

    service.unloadPlugin("acme.dispatch-unload");
    const result = await host.dispatch("terminal.new", { x: 1 });

    expect(result).toEqual({
      ok: false,
      error: { code: "PLUGIN_UNLOADED", message: expect.stringContaining("no longer loaded") },
    });
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("returns EXECUTION_ERROR when no renderer is available", async () => {
    setActiveWebContents(null);
    await writePlugin("dispatch-norender", { name: "acme.dispatch-norender", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-norender"
    );

    const result = await host.dispatch("app.openSettings");
    expect(result).toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("No active renderer") },
    });
  });

  it("sends the request and resolves with the renderer's matching response", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-ok", { name: "acme.dispatch-ok", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-ok"
    );

    const pending = host.dispatch("acme.dispatch-ok.doThing", { count: 3 });

    const req = lastDispatchRequest(wc);
    expect(req.actionId).toBe("acme.dispatch-ok.doThing");
    expect(req.args).toEqual({ count: 3 });
    expect(typeof req.requestId).toBe("string");

    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 11 } },
      { requestId: req.requestId, result: { ok: true, result: 42 } }
    );

    await expect(pending).resolves.toEqual({ ok: true, result: 42 });
  });

  it("ignores a response from an unexpected sender id (cross-window guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-guard", { name: "acme.dispatch-guard", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-guard"
    );

    const pending = host.dispatch("acme.dispatch-guard.go");
    const req = lastDispatchRequest(wc);

    // Ignore any warnings emitted during plugin load/init; only count the guard.
    warnSpy.mockClear();

    // Wrong sender — must be ignored and warned about.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 999 } },
      { requestId: req.requestId, result: { ok: true, result: "spoofed" } }
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected sender"));

    // Correct sender — resolves with the real result.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      { sender: { id: 11 } },
      { requestId: req.requestId, result: { ok: true, result: "real" } }
    );

    await expect(pending).resolves.toEqual({ ok: true, result: "real" });
    warnSpy.mockRestore();
  });

  it("dispose() drains pending dispatches and removes the response listener", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-dispose", { name: "acme.dispatch-dispose", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-dispose"
    );

    const pending = host.dispatch("acme.dispatch-dispose.go");
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE)).toBe(1);

    service.dispose();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("disposed") },
    });
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
      expect.any(Function)
    );
  });

  it("resolves with EXECUTION_ERROR when the target renderer is destroyed mid-dispatch", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-destroyed", { name: "acme.dispatch-destroyed", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-destroyed"
    );

    const pending = host.dispatch("acme.dispatch-destroyed.go");
    wc._triggerDestroyed();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: expect.stringContaining("destroyed") },
    });
  });

  it("after dispose() returns PLUGIN_UNLOADED without re-registering a listener", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-after-dispose", {
      name: "acme.dispatch-after-dispose",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-after-dispose"
    );

    // dispose() runs the full disposer cascade, which unloads every plugin
    // (removes it from the map). A post-dispose dispatch therefore fails the
    // host's PLUGIN_UNLOADED membership guard before any renderer round-trip —
    // no listener is registered and the renderer is never touched.
    service.dispose();
    const result = await host.dispatch("acme.dispatch-after-dispose.go");

    expect(result).toEqual({
      ok: false,
      error: {
        code: "PLUGIN_UNLOADED",
        message: expect.stringContaining("no longer loaded"),
      },
    });
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE)).toBe(0);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("times out a dispatch that never receives a response and ignores a late reply", async () => {
    const wc = makeFakeWebContents(11);
    setActiveWebContents(wc);
    await writePlugin("dispatch-timeout", { name: "acme.dispatch-timeout", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: DispatchHostShape }).createHost(
      "acme.dispatch-timeout"
    );

    // Switch to fake timers only after plugin load/init (which uses real I/O).
    vi.useFakeTimers();
    try {
      const pending = host.dispatch("acme.dispatch-timeout.go");
      const req = lastDispatchRequest(wc);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toEqual({
        ok: false,
        error: { code: "EXECUTION_ERROR", message: expect.stringContaining("timed out") },
      });

      // A late response for a timed-out request is silently dropped (no throw,
      // no double-resolve) because the pending entry was already deleted.
      expect(() =>
        ipcMainMock._emit(
          CHANNELS.PLUGIN_DISPATCH_ACTION_RESPONSE,
          { sender: { id: 11 } },
          { requestId: req.requestId, result: { ok: true, result: "late" } }
        )
      ).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

type ActionsHostShape = (pluginId: string) => {
  host: {
    actions: {
      list: () => Promise<import("../../../shared/types/actions.js").PluginActionManifestEntry[]>;
      get: (
        actionId: string
      ) => Promise<import("../../../shared/types/actions.js").PluginActionManifestEntry | null>;
      canDispatch: (
        actionId: string
      ) => Promise<import("../../../shared/types/actions.js").PluginCanDispatchResult>;
    };
  };
  revoke: () => void;
};

/** Read the request payload from the most recent `webContents.send` for `channel`. */
function lastRequestFor(
  wc: FakeWebContents,
  channel: string
): { requestId: string } & Record<string, unknown> {
  const call = [...wc.send.mock.calls].reverse().find((c) => c[0] === channel);
  if (!call) throw new Error(`no ${channel} send recorded`);
  return call[1] as { requestId: string } & Record<string, unknown>;
}

describe("createHost — actions catalog (#10561)", () => {
  beforeEach(() => {
    ipcMainMock._reset();
    setActiveWebContents(null);
  });

  it("list() round-trips through the renderer and resolves with the projected entries", async () => {
    const wc = makeFakeWebContents(21);
    setActiveWebContents(wc);
    await writePlugin("actions-list", { name: "acme.actions-list", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list"
    );

    const pending = host.actions.list();
    const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
    expect(typeof req.requestId).toBe("string");

    const entries = [
      { id: "terminal.new", title: "New terminal", danger: "safe", requiresArgs: false },
    ];
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      { sender: { id: 21 } },
      { requestId: req.requestId, entries }
    );

    await expect(pending).resolves.toEqual(entries);
  });

  it("list() returns [] without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(21);
    setActiveWebContents(wc);
    await writePlugin("actions-list-unload", {
      name: "acme.actions-list-unload",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list-unload"
    );

    service.unloadPlugin("acme.actions-list-unload");
    await expect(host.actions.list()).resolves.toEqual([]);
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("list() resolves [] when no renderer is available", async () => {
    setActiveWebContents(null);
    await writePlugin("actions-list-norender", {
      name: "acme.actions-list-norender",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-list-norender"
    );

    await expect(host.actions.list()).resolves.toEqual([]);
  });

  it("get() resolves the matching entry, and a missing/absent reply resolves null", async () => {
    const wc = makeFakeWebContents(22);
    setActiveWebContents(wc);
    await writePlugin("actions-get", { name: "acme.actions-get", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-get"
    );

    // Known id → entry.
    const knownPending = host.actions.get("terminal.new");
    const knownReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    expect(knownReq.actionId).toBe("terminal.new");
    const entry = {
      id: "terminal.new",
      title: "New terminal",
      danger: "safe",
      requiresArgs: false,
    };
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 22 } },
      { requestId: knownReq.requestId, entry }
    );
    await expect(knownPending).resolves.toEqual(entry);

    // Unknown id → renderer replies with a null entry.
    const missingPending = host.actions.get("does.not.exist");
    const missingReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 22 } },
      { requestId: missingReq.requestId, entry: null }
    );
    await expect(missingPending).resolves.toBeNull();
  });

  it("canDispatch() derives ok/confirm/restricted from the projected danger", async () => {
    const wc = makeFakeWebContents(23);
    setActiveWebContents(wc);
    await writePlugin("actions-can", { name: "acme.actions-can", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-can"
    );

    const replyGet = (entry: unknown): void => {
      const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
      ipcMainMock._emit(
        CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
        { sender: { id: 23 } },
        { requestId: req.requestId, entry }
      );
    };

    // safe → "ok"
    const okPending = host.actions.canDispatch("worktree.createWithRecipe");
    replyGet({ id: "worktree.createWithRecipe", danger: "safe", requiresArgs: false });
    await expect(okPending).resolves.toBe("ok");

    // confirm → "confirm" (the recipe.run vs createWithRecipe asymmetry is now observable)
    const confirmPending = host.actions.canDispatch("recipe.run");
    replyGet({ id: "recipe.run", danger: "confirm", requiresArgs: false });
    await expect(confirmPending).resolves.toBe("confirm");

    // absent entry (unknown or restricted-and-projected-away) → "restricted"
    const restrictedPending = host.actions.canDispatch("some.restricted.action");
    replyGet(null);
    await expect(restrictedPending).resolves.toBe("restricted");

    // fail closed: an unexpected danger value is NOT treated as dispatchable
    const bogusPending = host.actions.canDispatch("some.bogus.action");
    replyGet({ id: "some.bogus.action", danger: "bogus", requiresArgs: false });
    await expect(bogusPending).resolves.toBe("restricted");
  });

  it("ignores a catalog response from an unexpected sender id (cross-window guard)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wc = makeFakeWebContents(25);
    setActiveWebContents(wc);
    await writePlugin("actions-guard", { name: "acme.actions-guard", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-guard"
    );

    const pending = host.actions.get("terminal.new");
    const req = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);
    warnSpy.mockClear();

    // Wrong sender — must be ignored and warned about, leaving the request pending.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 999 } },
      { requestId: req.requestId, entry: { id: "terminal.new", danger: "safe" } }
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected sender"));

    // Correct sender — resolves with the real entry.
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 25 } },
      { requestId: req.requestId, entry: { id: "terminal.new", danger: "safe" } }
    );
    await expect(pending).resolves.toMatchObject({ id: "terminal.new" });
    warnSpy.mockRestore();
  });

  it("resolves concurrent list + get independently regardless of response order", async () => {
    const wc = makeFakeWebContents(26);
    setActiveWebContents(wc);
    await writePlugin("actions-concurrent", {
      name: "acme.actions-concurrent",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-concurrent"
    );

    const listPending = host.actions.list();
    const getPending = host.actions.get("terminal.new");
    const listReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_LIST_REQUEST);
    const getReq = lastRequestFor(wc, CHANNELS.PLUGIN_ACTIONS_GET_REQUEST);

    // Deliver the get response BEFORE the list response — the shared pending map
    // keyed by requestId must not let one resolve the other.
    const entry = { id: "terminal.new", danger: "safe", requiresArgs: false };
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_GET_RESPONSE,
      { sender: { id: 26 } },
      { requestId: getReq.requestId, entry }
    );
    const entries = [{ id: "app.openSettings", danger: "safe", requiresArgs: false }];
    ipcMainMock._emit(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      { sender: { id: 26 } },
      { requestId: listReq.requestId, entries }
    );

    await expect(getPending).resolves.toEqual(entry);
    await expect(listPending).resolves.toEqual(entries);
  });

  it("canDispatch() returns 'restricted' without a round-trip once the plugin is unloaded", async () => {
    const wc = makeFakeWebContents(23);
    setActiveWebContents(wc);
    await writePlugin("actions-can-unload", {
      name: "acme.actions-can-unload",
      version: "1.0.0",
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-can-unload"
    );

    service.unloadPlugin("acme.actions-can-unload");
    await expect(host.actions.canDispatch("terminal.new")).resolves.toBe("restricted");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("dispose() drains a pending catalog request with its fallback and removes the listener", async () => {
    const wc = makeFakeWebContents(24);
    setActiveWebContents(wc);
    await writePlugin("actions-dispose", { name: "acme.actions-dispose", version: "1.0.0" });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: ActionsHostShape }).createHost(
      "acme.actions-dispose"
    );

    const pendingList = host.actions.list();
    expect(ipcMainMock._listenerCount(CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE)).toBe(1);

    service.dispose();

    await expect(pendingList).resolves.toEqual([]);
    expect(ipcMainMock.removeListener).toHaveBeenCalledWith(
      CHANNELS.PLUGIN_ACTIONS_LIST_RESPONSE,
      expect.any(Function)
    );
  });
});

describe("createHost — registerForgeProvider", () => {
  function forgeManifest(
    name: string,
    providerIds: string[] = ["github"]
  ): Record<string, unknown> {
    return {
      name,
      version: "1.0.0",
      contributes: {
        forgeProviders: providerIds.map((id) => ({
          id,
          name: id,
          matches: [`${id}.example`],
        })),
      },
    };
  }

  it("binds the impl via registerForgeProviderImpl with the descriptor id", async () => {
    await writePlugin("forge-host", forgeManifest("acme.forge-host"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-host"
    );

    vi.mocked(registerForgeProviderImpl).mockClear();
    const impl = { tag: "impl-a" };
    await host.registerForgeProvider({ id: "github" }, impl);
    expect(registerForgeProviderImpl).toHaveBeenCalledWith("acme.forge-host", "github", impl);
  });

  it("returns a disposer that calls unregisterForgeProviderImpl exactly once", async () => {
    await writePlugin("forge-dispose", forgeManifest("acme.forge-dispose"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-dispose"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    const impl = { tag: "impl" };
    const dispose = await host.registerForgeProvider({ id: "github" }, impl);
    dispose();
    dispose(); // idempotent — only the first call should propagate
    expect(unregisterForgeProviderImpl).toHaveBeenCalledTimes(1);
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-dispose", "github", impl);
  });

  it("rejects a descriptor missing an id", async () => {
    await writePlugin("forge-baddesc", forgeManifest("acme.forge-baddesc"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-baddesc"
    );

    expect(() =>
      host.registerForgeProvider({} as unknown as { id: string }, { tag: "impl" })
    ).toThrow(/descriptor.id must be a non-empty string/);
  });

  it("rejects a non-object impl", async () => {
    await writePlugin("forge-badimpl", forgeManifest("acme.forge-badimpl"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-badimpl"
    );

    expect(() => host.registerForgeProvider({ id: "github" }, null)).toThrow(
      /impl must be an object/
    );
  });

  it("rejects a descriptor.id not declared in contributes.forgeProviders", async () => {
    // Manifest declares only "github"; "bogus" must be rejected.
    await writePlugin("forge-undeclared", forgeManifest("acme.forge-undeclared", ["github"]));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-undeclared"
    );

    expect(() => host.registerForgeProvider({ id: "bogus" }, { tag: "impl" })).toThrow(
      /not declared in contributes.forgeProviders/
    );
  });

  it("re-binding the same descriptor.id makes the older disposer inert", async () => {
    await writePlugin("forge-rebind", forgeManifest("acme.forge-rebind"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-rebind"
    );

    vi.mocked(unregisterForgeProviderImpl).mockClear();

    const impl1 = { tag: "first" };
    const impl2 = { tag: "second" };
    const dispose1 = await host.registerForgeProvider({ id: "github" }, impl1);
    await host.registerForgeProvider({ id: "github" }, impl2);

    // Calling the older disposer must pass the older impl so the registry
    // can decline to clear an already-overwritten entry. The registry side
    // of this guard is covered in forgeProviderRegistry.test.ts; here we
    // only assert the disposer carries the right identity into the call.
    dispose1();
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-rebind", "github", impl1);
  });

  it("unloadPlugin fires unregisterForgeProviderImpls alongside unregisterForgeProviders", async () => {
    await writePlugin("forge-unload", forgeManifest("acme.forge-unload"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    vi.mocked(unregisterForgeProviderImpls).mockClear();
    vi.mocked(unregisterForgeProviders).mockClear();

    service.unloadPlugin("acme.forge-unload");

    expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.forge-unload");
    expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-unload");
  });

  it("unloadPlugin flushes per-provider disposers from pluginEventCleanups", async () => {
    await writePlugin("forge-flush", forgeManifest("acme.forge-flush"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-flush"
    );
    const impl = { tag: "impl" };
    await host.registerForgeProvider({ id: "github" }, impl);

    vi.mocked(unregisterForgeProviderImpl).mockClear();
    service.unloadPlugin("acme.forge-flush");
    // The per-provider disposer fires through the pluginEventCleanups flush
    // path during unloadPlugin — independent from the bulk unregisterForgeProviderImpls
    // belt-and-suspenders call.
    expect(unregisterForgeProviderImpl).toHaveBeenCalledWith("acme.forge-flush", "github", impl);
  });

  it("replays a persisted credential into the freshly bound impl (#9983)", async () => {
    await writePlugin("forge-replay", forgeManifest("acme.forge-replay"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replay.github": JSON.stringify({ token: "stored-secret" }),
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replay"
    );

    const setCredentials = vi.fn();
    await host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "stored-secret" });
  });

  it("replays the password-typed field (not the first field) on bind (#9983)", async () => {
    await writePlugin("forge-replayfield", forgeManifest("acme.forge-replayfield"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replayfield.github": JSON.stringify({
        baseUrl: "https://github.example",
        token: "stored-secret",
      }),
    });
    // Provider declares the password field second, so a `fields[0]`-always bug
    // would replay the base URL instead of the token.
    vi.mocked(getRegisteredForgeProviders).mockReturnValueOnce([
      {
        pluginId: "acme.forge-replayfield",
        contribution: {
          id: "github",
          name: "github",
          matches: ["github.example"],
          credentialFields: [
            { id: "baseUrl", label: "Base URL", type: "text" },
            { id: "token", label: "API token", type: "password" },
          ],
        },
      },
    ]);
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replayfield"
    );

    const setCredentials = vi.fn();
    await host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).toHaveBeenCalledWith({ kind: "bearer", value: "stored-secret" });
  });

  it("does not call setCredentials on bind when no credential is stored (#9983)", async () => {
    await writePlugin("forge-noreplay", forgeManifest("acme.forge-noreplay"));
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-noreplay"
    );

    const setCredentials = vi.fn();
    host.registerForgeProvider({ id: "github" }, { setCredentials });

    expect(setCredentials).not.toHaveBeenCalled();
  });

  it("survives a setCredentials throw during replay without aborting registration (#9983)", async () => {
    await writePlugin("forge-replaythrow", forgeManifest("acme.forge-replaythrow"));
    storeMock._state.set("forgeCredentials", {
      "acme.forge-replaythrow.github": JSON.stringify({ token: "stored-secret" }),
    });
    const service = new PluginService(tmpDir);
    await service.initialize();

    const { host } = (service as unknown as { createHost: CreateHostShape }).createHost(
      "acme.forge-replaythrow"
    );

    const setCredentials = vi.fn(() => {
      throw new Error("boom");
    });
    // A plugin's setCredentials throwing must not propagate out of binding.
    const dispose = await host.registerForgeProvider({ id: "github" }, { setCredentials });
    expect(setCredentials).toHaveBeenCalled();
    expect(typeof dispose).toBe("function");
  });
});
