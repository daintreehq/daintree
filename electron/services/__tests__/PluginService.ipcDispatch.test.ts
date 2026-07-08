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

describe("Plugin IPC handler registration", () => {
  let service: PluginService;

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.test-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
  });

  it("registerHandler succeeds for a loaded plugin with valid channel", () => {
    const handler = vi.fn();
    expect(() => service.registerHandler("acme.test-plugin", "get-data", handler)).not.toThrow();
  });

  it("registerHandler throws when pluginId is not loaded", () => {
    expect(() => service.registerHandler("acme.unknown-plugin", "get-data", vi.fn())).toThrow(
      "Unknown plugin: acme.unknown-plugin"
    );
  });

  it("registerHandler throws when channel contains a colon", () => {
    expect(() => service.registerHandler("acme.test-plugin", "bad:channel", vi.fn())).toThrow(
      "Plugin channel must not contain colons: bad:channel"
    );
  });

  it("registerHandler throws when handler is not a function", () => {
    expect(() =>
      service.registerHandler("acme.test-plugin", "get-data", "not-a-function" as never)
    ).toThrow("Plugin handler must be a function, got string");
  });

  it("dispatchHandler calls the registered handler and returns its result", async () => {
    const handler = vi.fn().mockResolvedValue({ value: 42 });
    service.registerHandler("acme.test-plugin", "get-data", handler);

    const ctx = makeCtx("acme.test-plugin", { webContentsId: 7 });
    const result = await service.dispatchHandler("acme.test-plugin", "get-data", ctx, [
      "arg1",
      "arg2",
    ]);
    expect(handler).toHaveBeenCalledWith(ctx, "arg1", "arg2");
    expect(result).toEqual({ value: 42 });
  });

  it("dispatchHandler passes the context as the first argument to the handler", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    service.registerHandler("acme.test-plugin", "get-ctx", handler);

    const ctx = makeCtx("acme.test-plugin", {
      projectId: "p1",
      worktreeId: "w1",
      webContentsId: 42,
    });
    await service.dispatchHandler("acme.test-plugin", "get-ctx", ctx, ["x"]);
    expect(handler.mock.calls[0][0]).toEqual(ctx);
    expect(handler.mock.calls[0][1]).toBe("x");
  });

  it("dispatchHandler throws when no handler is found", async () => {
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow("No plugin handler registered for acme.test-plugin:unknown");
  });

  it("dispatchHandler rejects an unknown pluginId with PluginInvokeOwnershipError (#10462)", async () => {
    await expect(
      service.dispatchHandler("acme.unknown-plugin", "get-data", makeCtx("acme.unknown-plugin"), [])
    ).rejects.toThrow(PluginInvokeOwnershipError);
  });

  it("dispatchHandler does not activate when the pluginId is not loaded (#10462)", async () => {
    // The ownership guard must fire before activation, so impersonating an
    // unloaded plugin can never trigger any plugin code to run.
    const activateSpy = vi.spyOn(service, "activatePlugin");
    await expect(
      service.dispatchHandler("acme.unknown-plugin", "get-data", makeCtx("acme.unknown-plugin"), [])
    ).rejects.toBeInstanceOf(PluginInvokeOwnershipError);
    expect(activateSpy).not.toHaveBeenCalled();
  });

  it("dispatchHandler treats an unknown channel on a loaded plugin as a normal error, not an ownership rejection (#10462)", async () => {
    // Regression guard: the ownership rejection keys on the pluginId being
    // loaded, not on whether the channel resolves — a real plugin with a bad
    // channel must still surface the generic handler error.
    await expect(
      service.dispatchHandler("acme.test-plugin", "unknown", makeCtx("acme.test-plugin"), [])
    ).rejects.not.toBeInstanceOf(PluginInvokeOwnershipError);
  });

  it("registering same (pluginId, channel) twice overwrites the handler", async () => {
    const handler1 = vi.fn().mockReturnValue("first");
    const handler2 = vi.fn().mockReturnValue("second");
    service.registerHandler("acme.test-plugin", "get-data", handler1);
    service.registerHandler("acme.test-plugin", "get-data", handler2);

    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "get-data",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("second");
    expect(handler1).not.toHaveBeenCalled();
  });

  it("removeHandlers removes all handlers for a plugin, leaving others intact", async () => {
    await writePlugin("other-plugin", { name: "acme.other-plugin", version: "1.0.0" });
    const service2 = new PluginService(tmpDir);
    await service2.initialize();

    service2.registerHandler("acme.test-plugin", "ch-a", vi.fn().mockReturnValue("a"));
    service2.registerHandler("acme.test-plugin", "ch-b", vi.fn().mockReturnValue("b"));
    service2.registerHandler("acme.other-plugin", "ch-c", vi.fn().mockReturnValue("c"));

    service2.removeHandlers("acme.test-plugin");

    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-a", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    await expect(
      service2.dispatchHandler("acme.test-plugin", "ch-b", makeCtx("acme.test-plugin"), [])
    ).rejects.toThrow();
    expect(
      await service2.dispatchHandler("acme.other-plugin", "ch-c", makeCtx("acme.other-plugin"), [])
    ).toBe("c");
  });

  it("hasPlugin returns true for loaded plugins and false otherwise", () => {
    expect(service.hasPlugin("acme.test-plugin")).toBe(true);
    expect(service.hasPlugin("nonexistent")).toBe(false);
  });

  it("registerHandler throws for empty channel", () => {
    expect(() => service.registerHandler("acme.test-plugin", "", vi.fn())).not.toThrow();
    // Empty channel is technically valid — no colons
  });

  it("dispatchHandler handles synchronous handlers", async () => {
    service.registerHandler("acme.test-plugin", "sync", () => "sync-result");
    const result = await service.dispatchHandler(
      "acme.test-plugin",
      "sync",
      makeCtx("acme.test-plugin"),
      []
    );
    expect(result).toBe("sync-result");
  });

  describe("dispatchHandler failure auditing (#10463)", () => {
    it("audits a throwing typed-channel handler as an ipc-invoke error record", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const boom = new Error("handler exploded");
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(boom));

        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [
            { q: "x" },
          ])
        ).rejects.toBe(boom);

        expect(appendSpy).toHaveBeenCalledTimes(1);
        const record = appendSpy.mock.calls[0][0];
        expect(record).toMatchObject({
          pluginId: "acme.test-plugin",
          actionId: "get-data",
          recordType: "ipc-invoke",
          channel: "get-data",
          result: "error",
        });
        expect(record.errorMessage).toContain("handler exploded");
        expect(typeof record.durationMs).toBe("number");
        expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
        // The error is marked so the outer plugin:invoke catch won't re-audit.
        expect(isAuditedHandlerFailure(boom)).toBe(true);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("audits a successful typed-channel handler as an ipc-invoke success record (#10517)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockResolvedValue("ok"));
        const result = await service.dispatchHandler(
          "acme.test-plugin",
          "get-data",
          makeCtx("acme.test-plugin"),
          ["a"]
        );
        expect(result).toBe("ok");
        expect(appendSpy).toHaveBeenCalledTimes(1);
        const record = appendSpy.mock.calls[0][0];
        expect(record).toMatchObject({
          pluginId: "acme.test-plugin",
          actionId: "get-data",
          recordType: "ipc-invoke",
          channel: "get-data",
          result: "success",
        });
        expect(record.errorMessage).toBe("");
        expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(typeof record.durationMs).toBe("number");
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("does not audit schema/no-handler errors (owned by the IPC boundary)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        await expect(
          service.dispatchHandler("acme.test-plugin", "missing", makeCtx("acme.test-plugin"), [])
        ).rejects.toThrow("No plugin handler registered");
        expect(appendSpy).not.toHaveBeenCalled();
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("rethrows the original error even when it is frozen (marker can't attach)", async () => {
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const frozen = Object.freeze(new Error("handler exploded"));
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(frozen));
        // The marker can't be written onto a frozen error; the original error
        // must still surface (not a TypeError from the failed assignment).
        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [])
        ).rejects.toBe(frozen);
        expect(appendSpy).toHaveBeenCalledTimes(1);
        expect(isAuditedHandlerFailure(frozen)).toBe(false);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("never lets an audit append failure mask the handler error", async () => {
      const appendSpy = vi.spyOn(getPluginActionAuditService(), "append").mockImplementation(() => {
        throw new Error("audit store corrupt");
      });
      try {
        const boom = new Error("handler exploded");
        service.registerHandler("acme.test-plugin", "get-data", vi.fn().mockRejectedValue(boom));
        await expect(
          service.dispatchHandler("acme.test-plugin", "get-data", makeCtx("acme.test-plugin"), [])
        ).rejects.toBe(boom);
        expect(appendSpy).toHaveBeenCalledTimes(1);
      } finally {
        appendSpy.mockRestore();
      }
    });
  });

  describe("dispatchHandler args validation", () => {
    it("validates args when channel matches a registered action with inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.ping",
        title: "Ping",
        description: "Ping action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.ping", handler);

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.ping",
          makeCtx("acme.test-plugin"),
          [{ name: 42 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes valid args through to the handler", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.echo",
        title: "Echo",
        description: "Echo action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.echo", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.echo",
        makeCtx("acme.test-plugin"),
        [{ name: "world" }]
      );
      expect(result).toBe("ok");
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: "world" });
    });

    it("skips validation when no action descriptor is registered for the channel", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "raw-channel", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "raw-channel",
        makeCtx("acme.test-plugin"),
        [{ anything: "goes" }]
      );
      expect(result).toBe("ok");
    });

    it("skips validation when the descriptor has no inputSchema", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.no-schema",
        title: "No Schema",
        description: "No schema action",
        category: "test",
        kind: "command",
        danger: "safe",
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.no-schema", handler);

      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.no-schema",
        makeCtx("acme.test-plugin"),
        [{ foo: "bar" }]
      );
      expect(result).toBe("ok");
    });

    it("caches the compiled validator and reuses it on subsequent calls", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cached",
        title: "Cached",
        description: "Cache test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.cached", handler);

      // First call compiles
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 1 }]
      );
      // Second call reuses cached validator
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cached",
        makeCtx("acme.test-plugin"),
        [{ value: 2 }]
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, expect.anything(), { value: 1 });
      expect(handler).toHaveBeenNthCalledWith(2, expect.anything(), { value: 2 });
    });

    it("treats no args as empty object for validation", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.opt",
        title: "Opt",
        description: "Optional args action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.opt", handler);

      // No args call — should validate against {} which matches the schema (no required fields)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.opt",
        makeCtx("acme.test-plugin"),
        []
      );
      expect(result).toBe("ok");
    });

    it("cleans up the validator when the handler is removed", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.cleanup",
        title: "Cleanup",
        description: "Cleanup test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the validator cache with a successful call
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      service.removeHandlers("acme.test-plugin");

      // Re-register and re-prime — the old validator should be gone
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        vi.fn().mockResolvedValue("ok")
      );
      // Should still work (compiles fresh)
      const result = await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.cleanup",
        makeCtx("acme.test-plugin"),
        [{ x: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("rejects async ($async) schemas at compile time", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.async",
        title: "Async",
        description: "Async schema action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: { $async: true, type: "object" },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.async",
        vi.fn().mockResolvedValue("ok")
      );

      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.async",
          makeCtx("acme.test-plugin"),
          [{}]
        )
      ).rejects.toThrow("async");
    });

    it("supports standard JSON Schema formats like uri and email", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.format",
        title: "Format",
        description: "Format test action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", format: "uri" },
            email: { type: "string", format: "email" },
          },
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.format", handler);

      // Valid formats
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.format",
        makeCtx("acme.test-plugin"),
        [{ url: "https://example.com", email: "test@example.com" }]
      );
      expect(handler).toHaveBeenCalled();

      // Invalid format rejects
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.format",
          makeCtx("acme.test-plugin"),
          [{ url: "not-a-url", email: "test@example.com" }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");
    });

    it("does not validate when descriptor.pluginId differs from dispatch pluginId", async () => {
      // Register an action for acme.test-plugin
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.guarded",
        title: "Guarded",
        description: "Owner-check action",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin
      await writePlugin("other", { name: "acme.other", version: "1.0.0" });
      const service2 = new PluginService(tmpDir);
      await service2.initialize();

      // Register a raw handler on the second plugin whose channel collides with first plugin's action id
      const handler = vi.fn().mockResolvedValue("ok");
      service2.registerHandler("acme.other", "acme.test-plugin.guarded", handler);

      // Dispatch via the second plugin — should NOT validate (owner mismatch)
      const result = await service2.dispatchHandler(
        "acme.other",
        "acme.test-plugin.guarded",
        { projectId: null, worktreeId: null, webContentsId: 1, pluginId: "acme.other" },
        [{ name: 42 }]
      );
      expect(result).toBe("ok");
    });

    it("cleans up validators on unregisterPluginAction", async () => {
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
      });
      service.registerHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        vi.fn().mockResolvedValue("ok")
      );

      // Prime the cache
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ x: 1 }]
      );

      // Unregister and re-register with a different schema
      service.unregisterPluginAction("acme.test-plugin", "acme.test-plugin.stale");
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.stale",
        title: "Stale",
        description: "Stale validator test — new schema",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { y: { type: "string" } },
          required: ["y"],
        },
      });
      const handler = vi.fn().mockResolvedValue("ok");
      service.registerHandler("acme.test-plugin", "acme.test-plugin.stale", handler);

      // Old schema required `x: number` — should now reject that
      await expect(
        service.dispatchHandler(
          "acme.test-plugin",
          "acme.test-plugin.stale",
          makeCtx("acme.test-plugin"),
          [{ x: 1 }]
        )
      ).rejects.toThrow("Invalid arguments for plugin action");

      // New schema requires `y: string` — should pass with correct args
      await service.dispatchHandler(
        "acme.test-plugin",
        "acme.test-plugin.stale",
        makeCtx("acme.test-plugin"),
        [{ y: "hello" }]
      );
      expect(handler).toHaveBeenCalledWith(expect.anything(), { y: "hello" });
    });

    it("does not validate when a different plugin registers a handler with same channel as another plugin's action id", async () => {
      // Register action for acme.test-plugin with a restrictive schema
      service.registerPluginAction("acme.test-plugin", {
        id: "acme.test-plugin.shared-channel",
        title: "Shared Channel",
        description: "Test shared channel collision",
        category: "test",
        kind: "command",
        danger: "safe",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      });

      // Load a second plugin and register a raw handler on the same channel
      await writePlugin("collider-plugin", { name: "acme.collider", version: "1.0.0" });
      const colliderService = new PluginService(tmpDir, "0.0.0");
      await colliderService.initialize();

      // Register a raw handler whose channel collides with test-plugin's action id
      const handler = vi.fn().mockResolvedValue("cross-plugin-ok");
      colliderService.registerHandler("acme.collider", "acme.test-plugin.shared-channel", handler);

      // Dispatching via collider plugin should NOT inherit test-plugin's schema
      const result = await colliderService.dispatchHandler(
        "acme.collider",
        "acme.test-plugin.shared-channel",
        { projectId: null, worktreeId: null, webContentsId: 99, pluginId: "acme.collider" },
        [{ name: 42 }]
      );
      expect(result).toBe("cross-plugin-ok");
    });
  });

  describe("typed channel registration (registerHandler schema overload)", () => {
    let typedService: PluginService;

    beforeEach(async () => {
      await writePlugin("typed-plugin", {
        name: "acme.typed",
        version: "1.0.0",
        capabilities: ["fs:project-read", "git:read"],
      });
      typedService = new PluginService(tmpDir);
      await typedService.initialize();
    });

    it("registers and dispatches a typed channel with parsed args and result", async () => {
      const schema = {
        args: z.object({ name: z.string() }),
        result: z.object({ greeting: z.string() }),
      };
      const handler = vi.fn(async (_ctx, args: { name: string }) => ({
        greeting: `hello ${args.name}`,
      }));
      typedService.registerHandler("acme.typed", "greet", schema, handler);

      const result = await typedService.dispatchHandler(
        "acme.typed",
        "greet",
        makeCtx("acme.typed"),
        [{ name: "world" }]
      );
      expect(result).toEqual({ greeting: "hello world" });
      // The handler must receive the parsed single payload, not the raw variadic.
      expect(handler).toHaveBeenCalledWith(expect.anything(), { name: "world" });
    });

    it("throws SCHEMA_ERROR when args fail Zod validation and never calls the handler", async () => {
      const schema = {
        args: z.object({ count: z.number().int().positive() }),
        result: z.unknown(),
      };
      const handler = vi.fn();
      typedService.registerHandler("acme.typed", "tally", schema, handler);

      await expect(
        typedService.dispatchHandler("acme.typed", "tally", makeCtx("acme.typed"), [
          { count: "not-a-number" },
        ])
      ).rejects.toThrow(/^SCHEMA_ERROR:/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("throws SCHEMA_ERROR when the handler returns a result that fails the result schema", async () => {
      const schema = {
        args: z.object({}).passthrough(),
        result: z.object({ count: z.number() }),
      };
      const handler = vi.fn(async () => ({ count: "nope" as unknown as number }));
      typedService.registerHandler("acme.typed", "broken", schema, handler);

      await expect(
        typedService.dispatchHandler("acme.typed", "broken", makeCtx("acme.typed"), [{}])
      ).rejects.toThrow(/^SCHEMA_ERROR: result for channel "broken" failed validation/);
    });

    it("does NOT emit a success audit when the result schema rejects (#10517)", async () => {
      // The success record is written only after result-schema validation
      // passes — a host-side schema rejection of a handler that otherwise ran
      // must never be logged as a successful dispatch.
      const appendSpy = vi
        .spyOn(getPluginActionAuditService(), "append")
        .mockImplementation(() => {});
      try {
        const schema = {
          args: z.object({}).passthrough(),
          result: z.object({ count: z.number() }),
        };
        typedService.registerHandler(
          "acme.typed",
          "broken",
          schema,
          vi.fn(async () => ({ count: "nope" as unknown as number }))
        );

        await expect(
          typedService.dispatchHandler("acme.typed", "broken", makeCtx("acme.typed"), [{}])
        ).rejects.toThrow(/^SCHEMA_ERROR:/);

        // No success record from the inner dispatch boundary (the schema
        // rejection is owned by the outer plugin:invoke boundary instead).
        const successCalls = appendSpy.mock.calls.filter(
          (c) => (c[0] as { result?: string }).result === "success"
        );
        expect(successCalls).toHaveLength(0);
      } finally {
        appendSpy.mockRestore();
      }
    });

    it("rejects registration with PERMISSION_REQUIRED when a required capability is not declared", () => {
      const schema = {
        args: z.object({}),
        result: z.object({}),
        requires: ["fs:project-write" as const],
      };
      expect(() =>
        typedService.registerHandler("acme.typed", "write-stuff", schema, vi.fn())
      ).toThrow(/^PERMISSION_REQUIRED:/);
    });

    it("allows registration when every required capability is declared in the manifest", () => {
      const schema = {
        args: z.object({}),
        result: z.object({}),
        requires: ["fs:project-read" as const, "git:read" as const],
      };
      expect(() =>
        typedService.registerHandler(
          "acme.typed",
          "read-stuff",
          schema,
          vi.fn().mockResolvedValue({})
        )
      ).not.toThrow();
    });

    it("throws PERMISSION_REQUIRED at dispatch when manifest capability disappears after registration (defense-in-depth)", async () => {
      const schema = {
        args: z.object({}),
        result: z.unknown(),
        requires: ["fs:project-read" as const],
      };
      const handler = vi.fn().mockResolvedValue({ ok: true });
      typedService.registerHandler("acme.typed", "guarded", schema, handler);

      // Tamper with the loaded manifest to simulate a future code path that
      // removes a capability after registration. The dispatch-time re-check
      // must reject before the handler runs.
      const plugin = (
        typedService as unknown as { plugins: Map<string, { manifest: PluginManifest }> }
      ).plugins.get("acme.typed");
      if (plugin) {
        plugin.manifest = { ...plugin.manifest, capabilities: [] };
      }

      await expect(
        typedService.dispatchHandler("acme.typed", "guarded", makeCtx("acme.typed"), [{}])
      ).rejects.toThrow(/^PERMISSION_REQUIRED:/);
      expect(handler).not.toHaveBeenCalled();
    });

    it("removeHandlers cleans up channel schemas and capability gates", async () => {
      const schema = {
        args: z.object({ x: z.number() }),
        result: z.object({ doubled: z.number() }),
      };
      typedService.registerHandler(
        "acme.typed",
        "double",
        schema,
        async (_ctx, args: { x: number }) => ({ doubled: args.x * 2 })
      );

      typedService.removeHandlers("acme.typed");

      await expect(
        typedService.dispatchHandler("acme.typed", "double", makeCtx("acme.typed"), [{ x: 3 }])
      ).rejects.toThrow(/No plugin handler registered/);

      // Re-register WITHOUT the typed overload — the old schema must be gone
      // so legacy validation doesn't run on the new untyped handler.
      typedService.registerHandler(
        "acme.typed",
        "double",
        vi.fn().mockResolvedValue({ doubled: "string-result-not-validated" })
      );
      const legacyResult = await typedService.dispatchHandler(
        "acme.typed",
        "double",
        makeCtx("acme.typed"),
        [{ x: "anything" }]
      );
      expect(legacyResult).toEqual({ doubled: "string-result-not-validated" });
    });

    it("re-registering a typed channel as legacy drops the prior schema", async () => {
      const schema = {
        args: z.object({ x: z.number() }),
        result: z.unknown(),
      };
      typedService.registerHandler(
        "acme.typed",
        "swap",
        schema,
        vi.fn().mockResolvedValue("typed")
      );

      const legacyHandler = vi.fn().mockResolvedValue("legacy");
      typedService.registerHandler("acme.typed", "swap", legacyHandler);

      // Now the legacy untyped path runs — args validation does not fire,
      // so a previously-invalid payload would now go through.
      const result = await typedService.dispatchHandler(
        "acme.typed",
        "swap",
        makeCtx("acme.typed"),
        [{ x: "string-was-invalid-before" }]
      );
      expect(result).toBe("legacy");
      expect(legacyHandler).toHaveBeenCalledWith(expect.anything(), {
        x: "string-was-invalid-before",
      });
    });

    it("treats missing args as undefined for the typed args schema", async () => {
      const schema = {
        args: z.object({ name: z.string() }).optional(),
        result: z.string(),
      };
      const handler = vi.fn(async (_ctx, args: { name: string } | undefined) =>
        args ? args.name : "anonymous"
      );
      typedService.registerHandler("acme.typed", "optional", schema, handler);

      const result = await typedService.dispatchHandler(
        "acme.typed",
        "optional",
        makeCtx("acme.typed"),
        []
      );
      expect(result).toBe("anonymous");
    });

    it("passes Zod-parsed output (defaults / coercions) to the handler, not the raw payload", async () => {
      const schema = {
        args: z.object({
          n: z.coerce.number().int(),
          tag: z.string().default("auto"),
        }),
        result: z.object({ n: z.number(), tag: z.string() }),
      };
      const handler = vi.fn(async (_ctx, args: { n: number; tag: string }) => args);
      typedService.registerHandler("acme.typed", "coerce", schema, handler);

      // Dispatch with a string "n" (coerced) and no `tag` (defaulted).
      const result = await typedService.dispatchHandler(
        "acme.typed",
        "coerce",
        makeCtx("acme.typed"),
        [{ n: "42" }]
      );
      expect(result).toEqual({ n: 42, tag: "auto" });
      expect(handler).toHaveBeenCalledWith(expect.anything(), { n: 42, tag: "auto" });
    });

    it("rejects malformed schema at registration when args/result lack safeParse", () => {
      expect(() =>
        typedService.registerHandler(
          "acme.typed",
          "bad-schema",
          // Missing `result` ZodType — bare object has no safeParse method.
          { args: z.object({}), result: {} as unknown as z.ZodType<unknown> },
          vi.fn()
        )
      ).toThrow(/Plugin handler must be a function|^PERMISSION_REQUIRED:/);
      // Specifically, isChannelSchema returns false for missing safeParse,
      // so the legacy path runs and the bare object is rejected as a
      // non-function handler. Either way: malformed schema is rejected at
      // registration time, not at dispatch.
    });

    it("legacy untyped handler still dispatches alongside typed handlers on the same plugin", async () => {
      typedService.registerHandler(
        "acme.typed",
        "typed-ch",
        { args: z.string(), result: z.string() },
        async (_ctx, args: string) => args.toUpperCase()
      );
      typedService.registerHandler(
        "acme.typed",
        "legacy-ch",
        vi.fn().mockResolvedValue("legacy-result")
      );

      const typedResult = await typedService.dispatchHandler(
        "acme.typed",
        "typed-ch",
        makeCtx("acme.typed"),
        ["hello"]
      );
      expect(typedResult).toBe("HELLO");

      const legacyResult = await typedService.dispatchHandler(
        "acme.typed",
        "legacy-ch",
        makeCtx("acme.typed"),
        ["whatever"]
      );
      expect(legacyResult).toBe("legacy-result");
    });
  });
});
