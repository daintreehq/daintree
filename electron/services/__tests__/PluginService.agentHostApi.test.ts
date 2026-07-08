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

describe("Plugin agent-state host API (#10521)", () => {
  type AgentHost = {
    pluginId: string;
    getAgentState: () => Promise<unknown>;
    onDidChangeAgentState: (cb: (s: unknown) => void) => Promise<() => void>;
  };

  /**
   * Load a plugin with the given capabilities and build a host for it. The
   * `agent:read`-gated methods read declared capabilities off the loaded
   * manifest, so the capability must be present on disk before initialize().
   */
  async function setupAgentHost(
    capabilities: string[]
  ): Promise<{ service: PluginService; host: AgentHost; revoke: () => void }> {
    await writePlugin("agent-host", {
      name: "acme.agent-host",
      version: "1.0.0",
      capabilities,
    });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host, revoke } = (
      service as unknown as {
        createHost: (id: string) => { host: AgentHost; revoke: () => void };
      }
    ).createHost("acme.agent-host");
    return { service, host, revoke };
  }

  function emitState(
    over: Partial<{
      agentId: string;
      state: string;
      previousState: string;
      waitingReason: string;
      sessionCost: number;
      sessionTokens: number;
      timestamp: number;
    }> = {}
  ): void {
    events.emit("agent:state-changed", {
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 1,
      timestamp: 1000,
      ...over,
    } as never);
  }

  it("getAgentState rejects with PERMISSION_REQUIRED when agent:read is not declared", async () => {
    const { host } = await setupAgentHost([]);
    await expect(host.getAgentState()).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("onDidChangeAgentState throws PERMISSION_REQUIRED when agent:read is not declared", async () => {
    const { host } = await setupAgentHost([]);
    // The capability guard throws synchronously before returning the disposer
    // promise (same shape as onDidChangeWorktrees).
    expect(() => host.onDidChangeAgentState(() => {})).toThrow(/PERMISSION_REQUIRED/);
  });

  it("getAgentState returns null before any agent state change is observed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    expect(await host.getAgentState()).toBeNull();
  });

  it("onDidChangeAgentState delivers a frozen projected snapshot on state-changed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    emitState({
      agentId: "agent-1",
      state: "waiting",
      previousState: "working",
      waitingReason: "question",
      timestamp: 4242,
    });

    expect(received).toHaveLength(1);
    const snap = received[0];
    expect(snap.agentId).toBe("agent-1");
    expect(snap.state).toBe("waiting");
    expect(snap.previousState).toBe("working");
    expect(snap.running).toBe(true);
    expect(snap.waitingReason).toBe("question");
    expect(snap.timestamp).toBe(4242);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("getAgentState returns the last projected snapshot after a state change", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    await host.onDidChangeAgentState(() => {});

    emitState({ agentId: "agent-2", state: "completed", previousState: "working", timestamp: 99 });

    const snap = (await host.getAgentState()) as Record<string, unknown>;
    expect(snap).not.toBeNull();
    expect(snap.agentId).toBe("agent-2");
    expect(snap.state).toBe("completed");
    expect(snap.running).toBe(false);
  });

  it("derives running=true only for working/waiting/directing", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    for (const state of ["idle", "working", "waiting", "directing", "completed", "exited"]) {
      emitState({ state, previousState: "idle" });
    }

    const byState = new Map(received.map((s) => [s.state as string, s.running as boolean]));
    expect(byState.get("idle")).toBe(false);
    expect(byState.get("working")).toBe(true);
    expect(byState.get("waiting")).toBe(true);
    expect(byState.get("directing")).toBe(true);
    expect(byState.get("completed")).toBe(false);
    expect(byState.get("exited")).toBe(false);
  });

  it("the snapshot omits internal routing ids and activity-detector internals", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: Array<Record<string, unknown>> = [];
    await host.onDidChangeAgentState((s) => received.push(s as Record<string, unknown>));

    events.emit("agent:state-changed", {
      agentId: "agent-3",
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 0.9,
      cwd: "/secret/path",
      terminalId: "term-internal",
      worktreeId: "wt-internal",
      temperature: 42,
      heatAdded: 7,
      changedChars: 3,
      timestamp: 1,
    } as never);

    const snap = received[0];
    for (const leaked of [
      "terminalId",
      "worktreeId",
      "cwd",
      "trigger",
      "confidence",
      "temperature",
      "heatAdded",
      "changedChars",
    ]) {
      expect(leaked in snap).toBe(false);
    }
    expect(Object.keys(snap).sort()).toEqual([
      "agentId",
      "previousState",
      "running",
      "state",
      "timestamp",
    ]);
  });

  it("the disposer stops further callbacks and is safe to call twice", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const received: unknown[] = [];
    const dispose = await host.onDidChangeAgentState((s) => received.push(s));

    emitState({ state: "working" });
    expect(received).toHaveLength(1);

    dispose();
    dispose(); // double-dispose must not throw
    emitState({ state: "idle" });
    expect(received).toHaveLength(1);
  });

  it("unloading the plugin disposes the subscription and stops callbacks", async () => {
    const { service, host } = await setupAgentHost(["agent:read"]);
    const received: unknown[] = [];
    await host.onDidChangeAgentState((s) => received.push(s));

    emitState({ state: "working" });
    expect(received).toHaveLength(1);

    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-host");

    emitState({ state: "idle" });
    expect(received).toHaveLength(1);
  });

  it("getAgentState returns null (not an error) after the plugin is unloaded", async () => {
    const { service, host } = await setupAgentHost(["agent:read"]);
    await host.onDidChangeAgentState(() => {});
    emitState({ agentId: "a-pre", state: "working", previousState: "idle" });
    expect(await host.getAgentState()).not.toBeNull();

    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-host");

    // declaredCapabilities() returns [] post-unload, so a capability check first
    // would mis-throw PERMISSION_REQUIRED — the liveness check must win.
    expect(await host.getAgentState()).toBeNull();
  });

  it("getAgentState stays null when events fire but the plugin never subscribed", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    emitState({ state: "working", previousState: "idle" });
    // No subscription means no handler caches the snapshot — the host keeps no
    // pre-subscription history.
    expect(await host.getAgentState()).toBeNull();
  });

  it("getAgentState inside the callback observes the just-delivered snapshot", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    let insidePromise: Promise<unknown> | null = null;
    await host.onDidChangeAgentState(() => {
      insidePromise = host.getAgentState();
    });

    emitState({ agentId: "a9", state: "working", previousState: "idle" });

    const inside = (await insidePromise) as Record<string, unknown> | null;
    expect(inside).not.toBeNull();
    expect(inside?.agentId).toBe("a9");
  });

  it("multiple subscriptions from the same plugin dispose independently", async () => {
    const { host } = await setupAgentHost(["agent:read"]);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const disposeA = await host.onDidChangeAgentState((s) => a.push(s));
    await host.onDidChangeAgentState((s) => b.push(s));

    emitState({ state: "working" });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    disposeA();
    emitState({ state: "idle" });
    expect(a).toHaveLength(1); // disposed — no more deliveries
    expect(b).toHaveLength(2); // still active
  });

  it("onDidChangeAgentState throws once the host is revoked", async () => {
    const { host, revoke } = await setupAgentHost(["agent:read"]);
    revoke();
    expect(() => host.onDidChangeAgentState(() => {})).toThrow(/host revoked/);
  });
});

describe("Plugin agent-input host API (#10558)", () => {
  type FakeTerminal = {
    id: string;
    projectId?: string;
    agentState?: string;
    detectedAgentId?: string;
    launchAgentId?: string;
    lastOutputTime?: number;
    activityTier?: "active" | "background";
    hasPty?: boolean;
  };
  type AgentInputHost = {
    pluginId: string;
    sendToActiveAgent: (text: string, options?: { submit?: boolean }) => Promise<void>;
  };
  type FakePtyClient = {
    submit: ReturnType<typeof vi.fn>;
    stage: ReturnType<typeof vi.fn>;
    getActiveProjectId: () => string | null;
    getAllTerminalsAsync: () => Promise<FakeTerminal[]>;
  };

  function installFakePtyClient(
    terminals: FakeTerminal[],
    activeProjectId: string | null = null
  ): FakePtyClient {
    const fake: FakePtyClient = {
      submit: vi.fn(),
      stage: vi.fn(),
      getActiveProjectId: () => activeProjectId,
      getAllTerminalsAsync: () => Promise.resolve(terminals),
    };
    setPtyClientRef(fake as never);
    return fake;
  }

  async function setupInputHost(
    capabilities: string[]
  ): Promise<{ service: PluginService; host: AgentInputHost }> {
    await writePlugin("agent-input", {
      name: "acme.agent-input",
      version: "1.0.0",
      capabilities,
    });
    const service = new PluginService(tmpDir);
    await service.initialize();
    const { host } = (
      service as unknown as { createHost: (id: string) => { host: AgentInputHost } }
    ).createHost("acme.agent-input");
    return { service, host };
  }

  beforeEach(() => {
    // Auto-approve JIT consent so the write-path assertions run without a
    // renderer; the denial branch is covered explicitly below.
    getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
  });
  afterEach(() => {
    _resetPluginCapabilityServicesForTest();
    setPtyClientRef(null);
  });

  it("rejects with PERMISSION_REQUIRED when agent:input is not declared", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:read"]);
    await expect(host.sendToActiveAgent("hello")).rejects.toThrow(
      /PERMISSION_REQUIRED.*agent:input/
    );
    expect(fake.submit).not.toHaveBeenCalled();
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("rejects empty text before consulting consent", async () => {
    installFakePtyClient([{ id: "t1", detectedAgentId: "claude", hasPty: true }]);
    const consent = getPluginCapabilityConsentService();
    const bridge = vi.fn(async () => "approved-once" as const);
    consent.setConsentBridge(bridge);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("")).rejects.toThrow(/non-empty/);
    expect(bridge).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only text without banking consent or writing (#10558)", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const bridge = vi.fn(async () => "approved-once" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("\n")).rejects.toThrow(/non-empty/);
    await expect(host.sendToActiveAgent("   ", { submit: true })).rejects.toThrow(/non-empty/);
    expect(bridge).not.toHaveBeenCalled();
    expect(fake.stage).not.toHaveBeenCalled();
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("stages (no Enter) by default when submit is omitted", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("draft prompt");
    expect(fake.stage).toHaveBeenCalledWith("t1", "draft prompt");
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("submits (with Enter) when submit:true", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("run it", { submit: true });
    expect(fake.submit).toHaveBeenCalledWith("t1", "run it");
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("prefers a focused/visible agent over a backgrounded waiting agent", async () => {
    const fake = installFakePtyClient([
      {
        id: "bg",
        detectedAgentId: "claude",
        agentState: "waiting",
        activityTier: "background",
        lastOutputTime: 100,
        hasPty: true,
      },
      {
        id: "focused",
        launchAgentId: "claude",
        agentState: "working",
        activityTier: "active",
        lastOutputTime: 50,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("focused", "x");
  });

  it("falls back to most-recently-active agent when none are focused/waiting", async () => {
    const fake = installFakePtyClient([
      {
        id: "old",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 10,
        hasPty: true,
      },
      {
        id: "new",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 99,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("new", "x");
  });

  it("scopes selection to the active project when one is set", async () => {
    const fake = installFakePtyClient(
      [
        {
          id: "other",
          detectedAgentId: "claude",
          projectId: "p2",
          lastOutputTime: 999,
          hasPty: true,
        },
        { id: "mine", detectedAgentId: "claude", projectId: "p1", lastOutputTime: 1, hasPty: true },
      ],
      "p1"
    );
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("mine", "x");
  });

  it("never crosses into another project's terminals (#10558)", async () => {
    const fake = installFakePtyClient(
      [
        {
          id: "other",
          detectedAgentId: "claude",
          projectId: "p2",
          lastOutputTime: 999,
          hasPty: true,
        },
      ],
      "p1"
    );
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/NO_ACTIVE_AGENT/);
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("excludes exited, completed, and non-agent terminals", async () => {
    const fake = installFakePtyClient([
      { id: "noagent", agentState: "idle", hasPty: true },
      { id: "exited", detectedAgentId: "claude", agentState: "exited", hasPty: true },
      { id: "completed", detectedAgentId: "claude", agentState: "completed", hasPty: true },
      { id: "dead", detectedAgentId: "claude", agentState: "idle", hasPty: false },
      {
        id: "live",
        detectedAgentId: "claude",
        agentState: "idle",
        lastOutputTime: 5,
        hasPty: true,
      },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await host.sendToActiveAgent("x");
    expect(fake.stage).toHaveBeenCalledWith("live", "x");
  });

  it("throws NO_ACTIVE_AGENT when no eligible agent terminal exists", async () => {
    const fake = installFakePtyClient([
      { id: "noagent", agentState: "idle", hasPty: true },
      { id: "exited", detectedAgentId: "claude", agentState: "exited", hasPty: true },
    ]);
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/NO_ACTIVE_AGENT/);
    expect(fake.stage).not.toHaveBeenCalled();
  });

  it("blocks the write when consent is denied", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const { host } = await setupInputHost(["agent:input"]);
    await expect(host.sendToActiveAgent("x")).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(fake.stage).not.toHaveBeenCalled();
    expect(fake.submit).not.toHaveBeenCalled();
  });

  it("becomes a no-op after the plugin is unloaded", async () => {
    const fake = installFakePtyClient([
      { id: "t1", detectedAgentId: "claude", agentState: "waiting", hasPty: true },
    ]);
    const { service, host } = await setupInputHost(["agent:input"]);
    (service as unknown as { unloadPlugin: (id: string) => void }).unloadPlugin("acme.agent-input");
    await expect(host.sendToActiveAgent("x")).resolves.toBeUndefined();
    expect(fake.stage).not.toHaveBeenCalled();
  });
});
