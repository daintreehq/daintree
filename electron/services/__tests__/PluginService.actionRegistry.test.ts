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
import { getPluginActionAuditService } from "../PluginActionAuditService.js";
import { isAuditedHandlerFailure } from "../../utils/pluginAuditMarker.js";
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

describe("Plugin action registry", () => {
  let service: PluginService;

  const validContribution = () => ({
    id: "acme.my-plugin.doThing",
    title: "Do Thing",
    description: "Does a thing",
    category: "plugin",
    kind: "command" as const,
    danger: "safe" as const,
  });

  beforeEach(async () => {
    await writePlugin("test-plugin", { name: "acme.my-plugin", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("registerPluginAction adds a descriptor and broadcasts the full list", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.my-plugin",
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    });
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions },
    });
  });

  it("registerPluginAction throws when the plugin is not loaded", () => {
    expect(() => service.registerPluginAction("acme.unknown", validContribution())).toThrow(
      /Unknown plugin/
    );
  });

  it("registerPluginAction throws for ids not prefixed with the plugin id", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "other.plugin.doThing",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction throws for malformed ids", () => {
    for (const badId of ["no-dot", "Acme.UpperCase", "", "acme..double"]) {
      expect(() =>
        service.registerPluginAction("acme.my-plugin", {
          ...validContribution(),
          id: badId,
        })
      ).toThrow(/invalid/i);
    }
  });

  it("registerPluginAction throws when id has no suffix after the pluginId", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        id: "acme.my-plugin",
      })
    ).toThrow(/must be prefixed with the plugin's own id/);
  });

  it("registerPluginAction rejects restricted danger", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        danger: "restricted" as unknown as "safe",
      })
    ).toThrow(/invalid danger/i);
  });

  it("registerPluginAction rejects unknown kind", () => {
    expect(() =>
      service.registerPluginAction("acme.my-plugin", {
        ...validContribution(),
        kind: "navigation" as unknown as "command",
      })
    ).toThrow(/invalid kind/i);
  });

  it("registerPluginAction throws on duplicate id", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(() => service.registerPluginAction("acme.my-plugin", validContribution())).toThrow(
      /already registered/
    );
  });

  it("sets effectiveDanger='safe' when the plugin holds no high-risk capability", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    expect(service.listPluginActions()[0].effectiveDanger).toBe("safe");
  });

  it("keeps effectiveDanger='confirm' when the plugin self-declares confirm", () => {
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      danger: "confirm" as const,
    });
    expect(service.listPluginActions()[0].effectiveDanger).toBe("confirm");
  });

  it("raises effectiveDanger to 'confirm' for a self-declared 'safe' action when the manifest grants a high-risk capability", async () => {
    await writePlugin("risky", {
      name: "acme.risky",
      version: "1.0.0",
      capabilities: ["fs:project-read", "shell:exec"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.risky", {
      ...validContribution(),
      id: "acme.risky.doThing",
      danger: "safe" as const,
    });

    const action = svc.listPluginActions().find((a) => a.id === "acme.risky.doThing");
    expect(action?.danger).toBe("safe"); // plugin's advisory declaration preserved
    expect(action?.effectiveDanger).toBe("confirm"); // host raised it
  });

  it.each([
    "shell:exec",
    "git:write",
    "fs:project-write",
    "fs:user-data-write",
    "agent:invoke",
    "agent:register",
    "agent:input",
  ])(
    "raises a self-declared 'safe' action to confirm when the manifest grants %s",
    async (capability) => {
      const name = `acme.perm-${capability.replace(/[^a-z]/g, "-")}`;
      await writePlugin(`perm-${capability.replace(/[^a-z]/g, "-")}`, {
        name,
        version: "1.0.0",
        capabilities: [capability],
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      expect(svc.listPluginActions().find((a) => a.id === `${name}.doThing`)?.effectiveDanger).toBe(
        "confirm"
      );
    }
  );

  it.each([
    ["agent:read", "network:fetch"],
    ["git:read", "network:fetch"],
    ["fs:project-read", "network:fetch"],
    ["fs:user-data-read", "network:fetch"],
  ])(
    "raises effectiveDanger to 'confirm' for compound exfiltration pair %s + %s (no scope)",
    async (source, sink) => {
      const safeName = `${source}-${sink}`.replace(/[^a-z]/g, "-");
      const name = `acme.compound-${safeName}`;
      await writePlugin(`compound-${safeName}`, {
        name,
        version: "1.0.0",
        capabilities: [source, sink],
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      const action = svc.listPluginActions().find((a) => a.id === `${name}.doThing`);
      expect(action?.danger).toBe("safe");
      expect(action?.effectiveDanger).toBe("confirm");
    }
  );

  it.each(["agent:read", "git:read", "fs:project-read", "fs:user-data-read"])(
    "tight network scope attenuates compound elevation for sensitive-read source %s + network:fetch",
    async (source) => {
      const safe = source.replace(/[^a-z]/g, "-");
      const name = `acme.attenuated-${safe}`;
      await writePlugin(`attenuated-${safe}`, {
        name,
        version: "1.0.0",
        capabilities: [source, "network:fetch"],
        scopes: { network: { allowedUrls: ["https://api.example.com/v2"] } },
      });
      const svc = new PluginService(tmpDir);
      await svc.initialize();

      svc.registerPluginAction(name, {
        ...validContribution(),
        id: `${name}.doThing`,
        danger: "safe" as const,
      });

      expect(svc.listPluginActions().find((a) => a.id === `${name}.doThing`)?.effectiveDanger).toBe(
        "safe"
      );
    }
  );

  it("scoped network:fetch does NOT suppress flat elevation from fs:project-write", async () => {
    // The compound attenuation only short-circuits the compound elevation path
    // — flat-elevated capabilities in CONFIRM_TRIGGERING_CAPABILITIES must
    // still raise effectiveDanger regardless of any scope.
    await writePlugin("scoped-with-write", {
      name: "acme.scoped-with-write",
      version: "1.0.0",
      capabilities: ["network:fetch", "fs:project-write"],
      scopes: { network: { allowedUrls: ["https://api.example.com"] } },
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.scoped-with-write", {
      ...validContribution(),
      id: "acme.scoped-with-write.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.scoped-with-write.doThing")
        ?.effectiveDanger
    ).toBe("confirm");
  });

  it("raises effectiveDanger for sensitive-read + shell:exec even with network scope (shell is never attenuated)", async () => {
    await writePlugin("read-shell", {
      name: "acme.read-shell",
      version: "1.0.0",
      capabilities: ["fs:project-read", "shell:exec"],
      scopes: { network: { allowedUrls: ["https://api.example.com"] } },
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.read-shell", {
      ...validContribution(),
      id: "acme.read-shell.doThing",
      danger: "safe" as const,
    });

    // shell:exec is flat-elevated regardless — but the test asserts the compound
    // path also fires because the network scope must not attenuate shell sinks.
    const action = svc.listPluginActions().find((a) => a.id === "acme.read-shell.doThing");
    expect(action?.effectiveDanger).toBe("confirm");
  });

  it("raises effectiveDanger for remote-mutation pair network:fetch + git:write (no scope)", async () => {
    await writePlugin("net-write", {
      name: "acme.net-write",
      version: "1.0.0",
      capabilities: ["network:fetch", "git:write"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.net-write", {
      ...validContribution(),
      id: "acme.net-write.doThing",
      danger: "safe" as const,
    });

    // git:write already elevates flat — compound path is redundant but correct.
    expect(
      svc.listPluginActions().find((a) => a.id === "acme.net-write.doThing")?.effectiveDanger
    ).toBe("confirm");
  });

  it("does not compound-elevate a plugin holding only a sensitive read (no sink)", async () => {
    await writePlugin("read-only", {
      name: "acme.read-only",
      version: "1.0.0",
      capabilities: ["agent:read", "git:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.read-only", {
      ...validContribution(),
      id: "acme.read-only.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.read-only.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("does not compound-elevate a plugin holding only network:fetch (no source/sink pair)", async () => {
    await writePlugin("net-only", {
      name: "acme.net-only",
      version: "1.0.0",
      capabilities: ["network:fetch"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.net-only", {
      ...validContribution(),
      id: "acme.net-only.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.net-only.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("compound elevation is order-independent in the capabilities array", async () => {
    await writePlugin("order", {
      name: "acme.order",
      version: "1.0.0",
      capabilities: ["network:fetch", "agent:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.order", {
      ...validContribution(),
      id: "acme.order.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.order.doThing")?.effectiveDanger
    ).toBe("confirm");
  });

  it("does not raise effectiveDanger for read-only / reversible capabilities (no compound pair)", async () => {
    await writePlugin("readonly", {
      name: "acme.readonly",
      version: "1.0.0",
      capabilities: ["fs:project-read", "clipboard:write", "git:read"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.readonly", {
      ...validContribution(),
      id: "acme.readonly.doThing",
      danger: "safe" as const,
    });

    expect(
      svc.listPluginActions().find((a) => a.id === "acme.readonly.doThing")?.effectiveDanger
    ).toBe("safe");
  });

  it("unregisterPluginAction removes a single action and broadcasts", () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    broadcastToRendererMock.mockClear();

    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.doThing");

    expect(service.listPluginActions()).toEqual([]);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions: [] },
    });
  });

  it("unregisterPluginAction is a silent no-op for unknown ids", () => {
    service.unregisterPluginAction("acme.my-plugin", "acme.my-plugin.missing");
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("unregisterPluginAction does not remove actions owned by a different plugin", async () => {
    await writePlugin("other", { name: "acme.other", version: "1.0.0" });
    const svc = new PluginService(tmpDir);
    await svc.initialize();

    svc.registerPluginAction("acme.my-plugin", validContribution());

    svc.unregisterPluginAction("acme.other", "acme.my-plugin.doThing");
    expect(svc.listPluginActions()).toHaveLength(1);
  });

  it("unloadPlugin bulk-removes plugin actions", async () => {
    service.registerPluginAction("acme.my-plugin", validContribution());
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      id: "acme.my-plugin.other",
    });
    expect(service.listPluginActions()).toHaveLength(2);

    broadcastToRendererMock.mockClear();
    service.unloadPlugin("acme.my-plugin");

    expect(service.listPluginActions()).toEqual([]);
    // Exactly one broadcast for the bulk removal (no per-action spam)
    const broadcasts = broadcastToRendererMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === CHANNELS.EVENTS_PUSH &&
        typeof call[1] === "object" &&
        call[1] !== null &&
        (call[1] as { name?: unknown }).name === "plugin:actions-changed"
    );
    expect(broadcasts).toHaveLength(1);
  });

  it("descriptor keeps a defensive copy of keywords", () => {
    const keywords = ["foo", "bar"];
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      keywords,
    });
    keywords.push("mutated");

    const [descriptor] = service.listPluginActions();
    expect(descriptor.keywords).toEqual(["foo", "bar"]);
  });

  it("descriptor keeps a defensive copy of inputSchema", () => {
    const inputSchema: Record<string, unknown> = { type: "object", properties: { a: 1 } };
    service.registerPluginAction("acme.my-plugin", {
      ...validContribution(),
      inputSchema,
    });
    (inputSchema as Record<string, unknown>).properties = { a: 999 };

    const [descriptor] = service.listPluginActions();
    expect(descriptor.inputSchema).toEqual({ type: "object", properties: { a: 1 } });
  });
});

type ActionDescriptorInput = {
  id: string;
  title: string;
  description: string;
  category: string;
  kind: "command" | "query";
  danger: "safe" | "confirm";
  keywords?: string[];
  inputSchema?: Record<string, unknown>;
};
type ActionHostShape = (pluginId: string) => {
  host: {
    registerAction: (
      descriptor: ActionDescriptorInput,
      handler: (args: unknown) => unknown
    ) => void;
  };
  revoke: () => void;
};

describe("createHost — registerAction", () => {
  let service: PluginService;

  const descriptor = (overrides: Partial<ActionDescriptorInput> = {}): ActionDescriptorInput => ({
    id: "plan-from-issue",
    title: "Plan from issue",
    description: "Turn an issue into a session",
    category: "Planner",
    kind: "command",
    danger: "safe",
    ...overrides,
  });

  const getHost = (pluginId: string) =>
    (service as unknown as { createHost: ActionHostShape }).createHost(pluginId);

  beforeEach(async () => {
    await writePlugin("act-test", { name: "acme.act-test", version: "1.0.0" });
    service = new PluginService(tmpDir);
    await service.initialize();
    broadcastToRendererMock.mockClear();
  });

  it("namespaces the un-prefixed id to {pluginId}.{id} and stores the descriptor", () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => "ok");

    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      pluginId: "acme.act-test",
      id: "acme.act-test.plan-from-issue",
      title: "Plan from issue",
    });
    // Registering a new action broadcasts the refreshed list to renderers.
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.EVENTS_PUSH, {
      name: "plugin:actions-changed",
      payload: { actions },
    });
  });

  it("invokes the handler with the args payload only — no IPC ctx", async () => {
    const handler = vi.fn().mockResolvedValue({ done: true });
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), handler);

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{ issue: 42 }]
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ issue: 42 });
    expect(result).toEqual({ done: true });
  });

  it("invokes the handler with {} when dispatched with no args", async () => {
    const handler = vi.fn().mockReturnValue("ran");
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), handler);

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      []
    );
    // Defaults to {} (matching the input-schema validation default) rather than
    // undefined, so a handler can safely destructure the args object.
    expect(handler).toHaveBeenCalledWith({});
    expect(result).toBe("ran");
  });

  it("audits a throwing action handler as an action-dispatch error record (#10463)", async () => {
    const appendSpy = vi
      .spyOn(getPluginActionAuditService(), "append")
      .mockImplementation(() => {});
    try {
      const boom = new Error("action exploded");
      const { host } = getHost("acme.act-test");
      host.registerAction(descriptor(), () => {
        throw boom;
      });

      await expect(
        service.dispatchHandler(
          "acme.act-test",
          "acme.act-test.plan-from-issue",
          makeCtx("acme.act-test"),
          [{ issue: 7 }]
        )
      ).rejects.toBe(boom);

      expect(appendSpy).toHaveBeenCalledTimes(1);
      const record = appendSpy.mock.calls[0][0];
      expect(record).toMatchObject({
        pluginId: "acme.act-test",
        actionId: "acme.act-test.plan-from-issue",
        recordType: "action-dispatch",
        result: "error",
      });
      expect(record.errorMessage).toContain("action exploded");
      expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
      // Marked so the outer plugin:invoke catch won't record a duplicate.
      expect(isAuditedHandlerFailure(boom)).toBe(true);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("audits a successful action handler as an action-dispatch success record (#10517)", async () => {
    const appendSpy = vi
      .spyOn(getPluginActionAuditService(), "append")
      .mockImplementation(() => {});
    try {
      const { host } = getHost("acme.act-test");
      host.registerAction(descriptor(), () => "done");

      const result = await service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{ issue: 7 }]
      );
      expect(result).toBe("done");

      expect(appendSpy).toHaveBeenCalledTimes(1);
      const record = appendSpy.mock.calls[0][0];
      expect(record).toMatchObject({
        pluginId: "acme.act-test",
        actionId: "acme.act-test.plan-from-issue",
        recordType: "action-dispatch",
        result: "success",
      });
      expect(record.errorMessage).toBe("");
      expect(record.argsHash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof record.durationMs).toBe("number");
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("rejects calls after the host is revoked", () => {
    const { host, revoke } = getHost("acme.act-test");
    revoke();
    expect(() => host.registerAction(descriptor(), () => undefined)).toThrow(
      /host revoked: registerAction/
    );
  });

  it("rejects a non-object descriptor", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(null as unknown as ActionDescriptorInput, () => undefined)
    ).toThrow(/descriptor must be an object/);
  });

  it("rejects a non-function handler", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(descriptor(), "not-a-function" as unknown as () => unknown)
    ).toThrow(/handler must be a function/);
  });

  it("rejects an empty descriptor.id", () => {
    const { host } = getHost("acme.act-test");
    expect(() => host.registerAction(descriptor({ id: "" }), () => undefined)).toThrow(
      /descriptor.id must be a non-empty string/
    );
  });

  it("rejects an id that already includes the plugin prefix (no double-prefix)", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(descriptor({ id: "acme.act-test.plan-from-issue" }), () => undefined)
    ).toThrow(/must not include the plugin prefix/);
    // Nothing was registered under the doubled id.
    expect(service.listPluginActions()).toHaveLength(0);
  });

  it("passes {} to the handler when dispatched with no args (matches schema validation)", async () => {
    const handler = vi.fn().mockReturnValue("ok");
    const { host } = getHost("acme.act-test");
    // Schema with only optional fields accepts an empty object.
    host.registerAction(
      descriptor({ inputSchema: { type: "object", properties: { flag: { type: "boolean" } } } }),
      handler
    );

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      []
    );
    // Handler receives the same {} the validator accepted — not undefined.
    expect(handler).toHaveBeenCalledWith({});
    expect(result).toBe("ok");
  });

  it("rejects restricted danger", () => {
    const { host } = getHost("acme.act-test");
    expect(() =>
      host.registerAction(
        descriptor({ danger: "restricted" as unknown as "safe" }),
        () => undefined
      )
    ).toThrow(/invalid danger/i);
  });

  it("raises effectiveDanger to confirm when the manifest grants a high-risk capability", async () => {
    await writePlugin("act-risky", {
      name: "acme.act-risky",
      version: "1.0.0",
      capabilities: ["shell:exec"],
    });
    const svc = new PluginService(tmpDir);
    await svc.initialize();
    const { host } = (svc as unknown as { createHost: ActionHostShape }).createHost(
      "acme.act-risky"
    );

    host.registerAction(descriptor({ danger: "safe" }), () => undefined);

    const action = svc.listPluginActions().find((a) => a.id === "acme.act-risky.plan-from-issue");
    expect(action?.danger).toBe("safe");
    expect(action?.effectiveDanger).toBe("confirm");
  });

  it("replaces the prior descriptor and handler on re-registration with the same id", async () => {
    const first = vi.fn().mockReturnValue("first");
    const second = vi.fn().mockReturnValue("second");
    const { host } = getHost("acme.act-test");

    host.registerAction(descriptor({ title: "Old title" }), first);
    host.registerAction(descriptor({ title: "New title" }), second);

    // Exactly one descriptor — replace, not append.
    const actions = service.listPluginActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].title).toBe("New title");

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{}]
    );
    expect(result).toBe("second");
    expect(first).not.toHaveBeenCalled();
  });

  it("lets a host re-registration replace a renderer IPC registration", async () => {
    // IPC path registers metadata only (no main-side handler).
    service.registerPluginAction("acme.act-test", {
      id: "acme.act-test.plan-from-issue",
      title: "Via IPC",
      description: "registered through the renderer path",
      category: "Planner",
      kind: "command",
      danger: "safe",
    });

    const handler = vi.fn().mockReturnValue("from-host");
    const { host } = getHost("acme.act-test");
    // Replace semantics: re-registering the same id from the host does not throw.
    expect(() => host.registerAction(descriptor(), handler)).not.toThrow();

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{}]
    );
    expect(result).toBe("from-host");
  });

  it("keeps the renderer IPC path throwing on a duplicate id (asymmetric semantics)", () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => undefined);

    // The IPC path stays loud on duplicates even after a host registration.
    expect(() =>
      service.registerPluginAction("acme.act-test", {
        id: "acme.act-test.plan-from-issue",
        title: "Dup",
        description: "duplicate",
        category: "Planner",
        kind: "command",
        danger: "safe",
      })
    ).toThrow(/already registered/);
  });

  it("validates args against the action's inputSchema", async () => {
    const handler = vi.fn().mockReturnValue("ok");
    const { host } = getHost("acme.act-test");
    host.registerAction(
      descriptor({
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      }),
      handler
    );

    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow(/Invalid arguments/);
    expect(handler).not.toHaveBeenCalled();

    const result = await service.dispatchHandler(
      "acme.act-test",
      "acme.act-test.plan-from-issue",
      makeCtx("acme.act-test"),
      [{ name: "issue" }]
    );
    expect(result).toBe("ok");
  });

  it("propagates an async handler rejection through dispatch", async () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), async () => {
      throw new Error("handler boom");
    });

    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow("handler boom");
  });

  it("removes the handler on unload so dispatch throws afterwards", async () => {
    const { host } = getHost("acme.act-test");
    host.registerAction(descriptor(), () => "ok");
    expect(
      await service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).toBe("ok");

    service.unloadPlugin("acme.act-test");

    expect(service.listPluginActions()).toEqual([]);
    // Once unloaded the plugin is no longer in `this.plugins`, so the ownership
    // guard (#10462) rejects the dispatch before the action lookup runs.
    await expect(
      service.dispatchHandler(
        "acme.act-test",
        "acme.act-test.plan-from-issue",
        makeCtx("acme.act-test"),
        [{}]
      )
    ).rejects.toThrow('plugin:invoke rejected: plugin "acme.act-test" is not loaded');
  });
});
