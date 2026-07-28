import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";

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
import { getPluginManifestSchema } from "../../schemas/plugin.js";
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
import {
  registerForgeProviders,
  unregisterForgeProviderImpls,
  unregisterForgeProviders,
} from "../forgeProviderRegistry.js";
import {
  unregisterFileDecorationProviders,
  unregisterFileDecorationProviderImpls,
} from "../fileDecorationRegistry.js";

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

describe("reserved contribution point warnings", () => {
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

  it("attaches componentPath to the matching panel kind when a view targets location 'panel' (#9229)", async () => {
    await writePlugin("views", {
      name: "acme.views",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.views.main",
        extensionId: "acme.views",
        // The URL carries a per-load generation namespace (#11301), so assert
        // the parts that are contractual — host and resolved asset — rather
        // than a literal that would have to be edited alongside the counter.
        componentPath: expect.stringMatching(/^plugin:\/\/acme\.views\/__dtv-\d+\/dist\/view\.js$/),
      })
    );
    const viewWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes(": views ")
    );
    expect(viewWarnings).toHaveLength(0);
  });

  it("rejects the whole manifest when a views entry has no matching panel id (#10620)", async () => {
    await writePlugin("orphan", {
      name: "acme.orphan",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "ghost",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // An orphan view (id matches no panel) is now a hard manifest error
    // (view_panel_ref_unknown superRefine), so the plugin never loads — no
    // panel kind is registered and the failure surfaces as an invalid manifest.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in orphan"),
      expect.anything()
    );
  });

  it("rejects the whole manifest when a view targets the unimplemented sidebar location (#10464)", async () => {
    await writePlugin("sidebar", {
      name: "acme.sidebar",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            componentPath: "./dist/view.js",
            location: "sidebar",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // `location: "sidebar"` fails ViewContributionSchema at parse time, so the
    // manifest is invalid and the plugin never loads — no panel kind, no
    // sibling registration, surfaced as a manifest error rather than a warning.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in sidebar"),
      expect.anything()
    );
  });

  it("warns when an views entry targets a PTY-backed panel", async () => {
    await writePlugin("pty-view", {
      name: "acme.pty-view",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc", hasPty: true }],
        views: [
          {
            id: "main",
            componentPath: "./dist/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    const panelCall = (registerPanelKind as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      componentPath?: string;
      hasPty?: boolean;
    };
    expect(panelCall.hasPty).toBe(true);
    expect(panelCall.componentPath).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('views entry "main" matches a panel with hasPty=true')
    );
  });

  it("rejects the whole manifest when a view declares a traversal componentPath (#10464)", async () => {
    await writePlugin("unsafe", {
      name: "acme.unsafe",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            componentPath: "../escape.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // An unsafe componentPath fails ViewContributionSchema's refine at parse
    // time, so the manifest is invalid and the plugin never loads.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in unsafe"),
      expect.anything()
    );
  });

  it("rejects the whole manifest when a view declares an https componentPath (#10464)", async () => {
    await writePlugin("https", {
      name: "acme.https",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          {
            id: "main",
            componentPath: "https://evil.example/view.js",
            location: "panel",
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in https"),
      expect.anything()
    );
  });

  it("rejects the whole manifest on duplicate views ids (#10620)", async () => {
    await writePlugin("dup", {
      name: "acme.dup",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "main", name: "Main", iconId: "eye", color: "#abc" }],
        views: [
          { id: "main", componentPath: "./first.js", location: "panel" },
          { id: "main", componentPath: "./second.js", location: "panel" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // A duplicate view id is now a hard manifest error
    // (duplicate_contribution_id superRefine), so the plugin never loads —
    // no first-wins, no panel kind registered.
    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in dup"),
      expect.anything()
    );
  });

  it("registers a contributes.mcpServers entry without eagerly spawning it (#9235)", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("mcp", {
      name: "acme.mcp",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        mcpServers: [
          {
            id: "linear",
            name: "Linear MCP",
            command: "node",
            args: ["./server.js"],
            env: { LINEAR_API_KEY: "secret" },
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    // Lazy discovery (#9235): activation must NOT spawn the MCP subprocess —
    // it starts on the first `plugin-mcp:list-tools` enumeration instead.
    expect(mockPluginMcpSupervisor.start).not.toHaveBeenCalled();
    // The contribution is still registered so the IPC boundary can resolve and
    // lazily start it on demand.
    const lookup = service.findMcpServerContribution("acme.mcp", "linear");
    expect(lookup?.contribution).toEqual({
      id: "linear",
      name: "Linear MCP",
      command: "node",
      args: ["./server.js"],
      env: { LINEAR_API_KEY: "secret" },
    });
  });

  it("registers a contributes.forgeProviders entry with the forge provider registry", async () => {
    await writePlugin("forge", {
      name: "acme.forge",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        // `settingsScopeRef` / `viewRefs` are cross-validated against the
        // manifest's own settings/views (#10620), so the referenced ids must
        // exist; the referenced view in turn needs a matching panel id.
        panels: [{ id: "github-issues", name: "Issues", iconId: "eye", color: "#abc" }],
        settings: [{ id: "github", type: "string", label: "GitHub" }],
        views: [
          {
            id: "github-issues",
            componentPath: "./issues.js",
            location: "panel",
          },
        ],
        forgeProviders: [
          {
            id: "github",
            name: "GitHub",
            matches: ["github.com"],
            capabilities: ["issues", "pulls", "reviews"],
            settingsScopeRef: "github",
            viewRefs: ["github-issues"],
          },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).toHaveBeenCalledWith("acme.forge", [
      {
        id: "github",
        name: "GitHub",
        matches: ["github.com"],
        capabilities: ["issues", "pulls", "reviews"],
        settingsScopeRef: "github",
        viewRefs: ["github-issues"],
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("contributes.forgeProviders"));
    expect(registerToolbarButton).not.toHaveBeenCalled();
    expect(registerPluginMenuItem).not.toHaveBeenCalled();
  });

  it("does not call registerForgeProviders when the manifest declares no forgeProviders", async () => {
    await writePlugin("forge-none", {
      name: "acme.forge-none",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerForgeProviders).not.toHaveBeenCalled();
  });

  it("does not warn about reserved points when the manifest omits them", async () => {
    await writePlugin("plain", {
      name: "acme.plain",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("does not warn when reserved arrays are explicitly present but empty", async () => {
    await writePlugin("explicit-empty", {
      name: "acme.explicit-empty",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: { views: [], mcpServers: [], forgeProviders: [] },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(warnMessages.some((m: string) => m.includes("contributes.experimental_views"))).toBe(
      false
    );
    expect(
      warnMessages.some((m: string) => m.includes("contributes.experimental_mcpServers"))
    ).toBe(false);
    expect(warnMessages.some((m: string) => m.includes("contributes.forgeProviders"))).toBe(false);
  });

  it("migrates deprecated experimental_* contribution aliases to their stable names and warns (#10466)", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("legacy", {
      name: "acme.legacy",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        experimental_views: [{ id: "viewer", componentPath: "./v.js", location: "panel" }],
        experimental_mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    // The deprecated aliases are honored: the view binds to its panel and the
    // MCP contribution resolves through the canonical lookup.
    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acme.legacy.viewer",
        componentPath: expect.stringMatching(/^plugin:\/\/acme\.legacy\/__dtv-\d+\/v\.js$/),
      })
    );
    expect(service.findMcpServerContribution("acme.legacy", "svc")).toBeDefined();

    // Each deprecated alias logs exactly one deprecation warning naming the
    // stable replacement — not zero (silently migrated) or more than one
    // (double-emission from a future refactor).
    const warnMessages = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      warnMessages.filter(
        (m: string) =>
          m.includes("contributes.experimental_views is deprecated") &&
          m.includes("contributes.views")
      )
    ).toHaveLength(1);
    expect(
      warnMessages.filter(
        (m: string) =>
          m.includes("contributes.experimental_mcpServers is deprecated") &&
          m.includes("contributes.mcpServers")
      )
    ).toHaveLength(1);
  });

  it("still processes other contributions when reserved points are present", async () => {
    mockPluginMcpSupervisor.start.mockClear();
    await writePlugin("mixed", {
      name: "acme.mixed",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        views: [{ id: "viewer", componentPath: "./v.js", location: "panel" }],
        mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(registerPanelKind).toHaveBeenCalledTimes(1);
    // mcpServers is registered (no warning) but, under lazy
    // discovery (#9235), is NOT spawned at activation.
    expect(mockPluginMcpSupervisor.start).not.toHaveBeenCalled();
    expect(service.findMcpServerContribution("acme.mixed", "svc")).toBeDefined();
  });

  it("rejects the whole manifest when any view entry is an orphan (#10620)", async () => {
    await writePlugin("many", {
      name: "acme.many",
      version: "1.0.0",
      engines: { daintree: "^0.7.0" },
      contributes: {
        // `a` matches a panel and would bind; `c` is an orphan with no matching
        // panel id. A single orphan view now fails the whole manifest
        // (view_panel_ref_unknown superRefine) rather than logging a warning.
        panels: [{ id: "a", name: "A", iconId: "eye", color: "#000" }],
        views: [
          { id: "a", componentPath: "./a.js", location: "panel" },
          { id: "c", componentPath: "./c.js", location: "panel" },
        ],
      },
    });

    const service = new PluginService(tmpDir, "0.7.5");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(0);
    expect(registerPanelKind).not.toHaveBeenCalled();
    const orphanWarnings = warnSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('"c" has no matching contributes.panels')
    );
    expect(orphanWarnings).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Invalid manifest in many"),
      expect.anything()
    );
  });

  it("rejects a views entry with an invalid location at schema level", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-location",
      version: "1.0.0",
      contributes: {
        views: [{ id: "main", componentPath: "./v.js", location: "floating" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a views entry missing componentPath", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-path",
      version: "1.0.0",
      contributes: {
        views: [{ id: "main", location: "panel" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry missing command", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.no-cmd",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc" }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an mcpServers entry with non-string env values", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.bad-env",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc", command: "node", env: { PORT: 8080 } }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an mcpServers entry without optional args/env fields", () => {
    const result = getPluginManifestSchema(false).safeParse({
      name: "acme.minimal-mcp",
      version: "1.0.0",
      contributes: {
        mcpServers: [{ id: "svc", name: "Svc", command: "node" }],
      },
    });
    expect(result.success).toBe(true);
  });
});

// Boundary containment regression tests for issue #9276 — verify that a
// plugin's exceptions can't escape the host. Each block covers one boundary:
// activation, action dispatch, and the unload cascade.

describe("Plugin exception containment (#9276)", () => {
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

  describe("Boundary 1 — activation failure", () => {
    it("records the activation error on getPluginLoadError without rethrowing", async () => {
      const pluginDir = path.join(tmpDir, "throws-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom on activate'); }"
      );

      const service = new PluginService(tmpDir);
      // The host MUST NOT crash — initialize() should resolve.
      await expect(service.initialize()).resolves.toBeUndefined();
      // Lazy by default (#10523): trigger activation explicitly rather than via
      // the startup path, which no longer activates plugins without
      // activationEvents.
      await service.activatePlugin("acme.throws-activate");

      const record = service.getPluginLoadError("acme.throws-activate");
      expect(record).toBeDefined();
      expect(record?.message).toBe("boom on activate");
      expect(record?.stack).toContain("boom on activate");
      expect(typeof record?.at).toBe("number");
      // The plugin is still registered (manifest-declared contributions survive
      // even if the JS main entry blows up).
      expect(service.hasPlugin("acme.throws-activate")).toBe(true);
    });

    it("returns undefined when the plugin's activate succeeds", async () => {
      const pluginDir = path.join(tmpDir, "clean-activate");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.clean-activate", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { return () => {}; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.clean-activate");

      expect(service.getPluginLoadError("acme.clean-activate")).toBeUndefined();
    });

    it("returns undefined when the plugin declares no main entry", async () => {
      await writePlugin("no-main", { name: "acme.no-main", version: "1.0.0" });
      const service = new PluginService(tmpDir);
      await service.initialize();

      expect(service.getPluginLoadError("acme.no-main")).toBeUndefined();
    });

    it("load error persists in the provenance record across unload", async () => {
      const pluginDir = path.join(tmpDir, "throws-then-unload");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-then-unload", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw new Error('boom'); }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-then-unload");
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();

      // Unload removes the plugin from the registry, but the persisted
      // provenance record (including loadError) survives so diagnostics
      // export and re-install flows can still read it.
      service.unloadPlugin("acme.throws-then-unload");
      expect(service.getPluginLoadError("acme.throws-then-unload")).toBeDefined();
      expect(service.getPluginLoadError("acme.throws-then-unload")?.message).toBe("boom");
    });

    it("normalises non-Error throws into a load error record", async () => {
      const pluginDir = path.join(tmpDir, "throws-string");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-string", version: "1.0.0", main: "main.mjs" })
      );
      // Throw a plain string — many plugin authors do this.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw 'plain-string-failure'; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-string");

      const record = service.getPluginLoadError("acme.throws-string");
      expect(record?.message).toBe("plain-string-failure");
      expect(record?.stack).toBeUndefined();
    });
  });

  describe("Boundary 2 — action handler throw", () => {
    it("dispatchHandler rejects with the original error and logs to console.error", async () => {
      await writePlugin("acme.throwy-handler", {
        name: "acme.throwy-handler",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("handler boom");
      service.registerHandler("acme.throwy-handler", "blow-up", () => {
        throw original;
      });

      await expect(
        service.dispatchHandler(
          "acme.throwy-handler",
          "blow-up",
          makeCtx("acme.throwy-handler"),
          []
        )
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.throwy-handler:blow-up" threw:`),
        original
      );
    });

    it("dispatchHandler rejects with an async handler's rejection and logs", async () => {
      await writePlugin("acme.async-throwy", {
        name: "acme.async-throwy",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const original = new Error("async boom");
      service.registerHandler("acme.async-throwy", "blow-up", async () => {
        throw original;
      });

      await expect(
        service.dispatchHandler("acme.async-throwy", "blow-up", makeCtx("acme.async-throwy"), [])
      ).rejects.toBe(original);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Handler "acme.async-throwy:blow-up" threw:`),
        original
      );
    });
  });

  describe("Boundary 3 — unload cascade containment", () => {
    it("continues past a throwing menu-items unregister and still clears the plugin", async () => {
      await writePlugin("cascade-test", {
        name: "acme.cascade-test",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
          toolbarButtons: [
            { id: "btn", label: "Btn", iconId: "icon", actionId: "acme.cascade-test.act" },
          ],
          menuItems: [{ label: "L", actionId: "acme.cascade-test.act", location: "terminal" }],
        },
      });

      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginMenuItems).mockImplementationOnce(() => {
        throw new Error("menu unregister boom");
      });

      service.unloadPlugin("acme.cascade-test");

      // Each step after the throwing one still ran:
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.cascade-test");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.cascade-test");

      // Containment guarantees: plugin gone from registry, no rethrown error.
      expect(service.hasPlugin("acme.cascade-test")).toBe(false);

      // Disposer throws are warnings, not errors (per issue constraint).
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginMenuItems" for "acme.cascade-test" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing toolbar unregister", async () => {
      await writePlugin("toolbar-throws", {
        name: "acme.toolbar-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "viewer", name: "Viewer", iconId: "eye", color: "#000" }],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterPluginToolbarButtons).mockImplementationOnce(() => {
        throw new Error("toolbar boom");
      });

      service.unloadPlugin("acme.toolbar-throws");

      // Subsequent steps in cascade still run.
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.toolbar-throws");
      expect(service.hasPlugin("acme.toolbar-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterPluginToolbarButtons" for "acme.toolbar-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing forge-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("forge-throws", {
        name: "acme.forge-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterForgeProviders).mockImplementationOnce(() => {
        throw new Error("forge boom");
      });

      service.unloadPlugin("acme.forge-throws");

      // Critical: the impl unregister must run even if the provider unregister
      // threw, otherwise impl entries leak across reload. Coupled steps under
      // a single try/catch wrapper would have skipped this call.
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.forge-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith("acme.forge-throws");
      expect(service.hasPlugin("acme.forge-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterForgeProviders" for "acme.forge-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing fileDecoration-provider unregister AND still runs the impl unregister", async () => {
      await writePlugin("file-decoration-throws", {
        name: "acme.file-decoration-throws",
        version: "1.0.0",
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      vi.mocked(unregisterFileDecorationProviders).mockImplementationOnce(() => {
        throw new Error("file-decoration boom");
      });

      service.unloadPlugin("acme.file-decoration-throws");

      // Same correctness check as the forge case: the impl unregister must
      // not be stranded by a throw in the provider unregister.
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.file-decoration-throws"
      );
      expect(service.hasPlugin("acme.file-decoration-throws")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Unload step "unregisterFileDecorationProviders" for "acme.file-decoration-throws" threw:`
        ),
        expect.any(Error)
      );
    });

    it("continues past a throwing removeHandlers, running every later registry step", async () => {
      await writePlugin("remove-handlers-throws", {
        name: "acme.remove-handlers-throws",
        version: "1.0.0",
        contributes: {
          panels: [{ id: "p", name: "P", iconId: "i", color: "#000" }],
          toolbarButtons: [
            { id: "b", label: "B", iconId: "i", actionId: "acme.remove-handlers-throws.act" },
          ],
          menuItems: [
            { label: "L", actionId: "acme.remove-handlers-throws.act", location: "terminal" },
          ],
        },
      });
      const service = new PluginService(tmpDir);
      await service.initialize();

      const removeHandlersSpy = vi
        .spyOn(service as unknown as { removeHandlers: (id: string) => void }, "removeHandlers")
        .mockImplementationOnce(() => {
          throw new Error("removeHandlers boom");
        });

      service.unloadPlugin("acme.remove-handlers-throws");

      // Even though the very first step threw, every later step ran.
      expect(unregisterPluginMenuItems).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginToolbarButtons).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterPluginPanelKinds).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterForgeProviderImpls).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviders).toHaveBeenCalledWith("acme.remove-handlers-throws");
      expect(unregisterFileDecorationProviderImpls).toHaveBeenCalledWith(
        "acme.remove-handlers-throws"
      );
      expect(service.hasPlugin("acme.remove-handlers-throws")).toBe(false);

      removeHandlersSpy.mockRestore();
    });
  });

  describe("Boundary 1 — non-Error throws", () => {
    it("normalises a bare `throw undefined` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-undefined");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-undefined", version: "1.0.0", main: "main.mjs" })
      );
      // `throw undefined` is a real footgun in plugin code — make sure the
      // load-error record never sneaks an `undefined` into its `message`
      // field, which would violate the type contract for the F19 / #9271
      // consumer.
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw undefined; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-undefined");

      const record = service.getPluginLoadError("acme.throws-undefined");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });

    it("normalises a bare `throw null` into a string message", async () => {
      const pluginDir = path.join(tmpDir, "throws-null");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "acme.throws-null", version: "1.0.0", main: "main.mjs" })
      );
      await fs.writeFile(
        path.join(pluginDir, "main.mjs"),
        "export function activate() { throw null; }"
      );

      const service = new PluginService(tmpDir);
      await service.initialize();
      await service.activatePlugin("acme.throws-null");

      const record = service.getPluginLoadError("acme.throws-null");
      expect(record).toBeDefined();
      expect(typeof record?.message).toBe("string");
      expect(record?.message.length).toBeGreaterThan(0);
    });
  });
});

describe("hello-daintree sample fixture", () => {
  const fixturePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../plugins/sample/hello-daintree/plugin.json"
  );
  const readManifest = async (): Promise<unknown> =>
    JSON.parse(await fs.readFile(fixturePath, "utf8"));

  it("validates against the manifest schema", async () => {
    const result = getPluginManifestSchema(true).safeParse(await readManifest());
    expect(result.success).toBe(true);
  });

  it("declares the first-party name and the wired contribution points", async () => {
    const manifest = getPluginManifestSchema(true).parse(await readManifest());
    expect(manifest.name).toBe("daintree.hello");
    expect(manifest.engines?.daintree).toBe(">=0.11.0");
    expect(manifest.contributes.toolbarButtons).toHaveLength(1);
    expect(manifest.contributes.toolbarButtons[0].id).toBe("ping");
    expect(manifest.contributes.menuItems).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders).toHaveLength(1);
    expect(manifest.contributes.fileDecorationProviders[0].scopes).toEqual(["hello:*"]);
  });
});
