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
const broadcastToProjectRenderersMock = vi.hoisted(() => vi.fn());
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
  broadcastToProjectRenderers: broadcastToProjectRenderersMock,
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
  toRuntimePanelKindId: vi.fn(
    (ref: { origin: string; pluginId: string; kindId: string }, projectId?: string | null) =>
      ref.origin === "project"
        ? projectId
          ? `project:${projectId}/${ref.pluginId}/${ref.kindId}`
          : null
        : `${ref.pluginId}.${ref.kindId}`
  ),
  getPanelKindConfig: vi.fn(() => undefined),
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
  getPanelKindConfig,
  registerPanelKind,
  unregisterPluginPanelKinds,
} from "../../../shared/config/panelKindRegistry.js";
import {
  clearAllProjectSurfaces,
  getProjectSurfaceRefusals,
  getProjectSurfaceSlots,
} from "../plugin/PluginSurfaceRegistry.js";
import {
  registerToolbarButton,
  unregisterPluginToolbarButtons,
} from "../../../shared/config/toolbarButtonRegistry.js";
import { unregisterPluginMenuItems } from "../pluginMenuRegistry.js";
import { unregisterForgeProviders } from "../forgeProviderRegistry.js";
import { CHANNELS } from "../../ipc/channels.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { DATABASE_ENDPOINT_ID } from "../pluginAgentMcp/types.js";

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

  it("loads a plugin the app version is newer than, with a warning toast", async () => {
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

    expect(service.listPlugins().map((p) => p.manifest.name)).toEqual(["acme.incompatible"]);
    expect(registerPanelKind).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plugin "acme.incompatible" targets Daintree ^0.7.0')
    );
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    const [channel, payload] = broadcastToRendererMock.mock.calls[0];
    expect(channel).toBe(CHANNELS.NOTIFICATION_SHOW_TOAST);
    expect(payload).toMatchObject({
      type: "warning",
      message: expect.stringContaining('"Incompatible Plugin" targets Daintree ^0.7.0'),
      rateLimitKey: "plugin-engine:acme.incompatible",
      rateLimitLabel: "Incompatible Plugin",
    });
    expect(payload.message).toContain("newer version of the plugin");
    expect(payload).not.toHaveProperty("action");
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

  it("loads a plugin requiring a future version and points at updating Daintree", async () => {
    await writePlugin("future", {
      name: "acme.future",
      version: "1.0.0",
      engines: { daintree: "^1.0.0" },
    });

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    const payload = broadcastToRendererMock.mock.calls[0][1];
    expect(payload.message).toContain("Update Daintree");
    expect(payload.action).toMatchObject({
      ipcChannel: CHANNELS.SYSTEM_OPEN_EXTERNAL,
      data: expect.stringMatching(/^https:\/\/daintree\.org\//),
    });
  });

  it("omits the download link on Windows Store builds, where the Store owns updates", async () => {
    await writePlugin("future-store", {
      name: "acme.future-store",
      version: "1.0.0",
      engines: { daintree: ">=0.8.0" },
    });
    const previous = Object.getOwnPropertyDescriptor(process, "windowsStore");
    Object.defineProperty(process, "windowsStore", { value: true, configurable: true });

    try {
      const service = new PluginService(tmpDir, "0.7.1");
      await service.initialize();
    } finally {
      if (previous) Object.defineProperty(process, "windowsStore", previous);
      else Reflect.deleteProperty(process, "windowsStore");
    }

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    const payload = broadcastToRendererMock.mock.calls[0][1];
    expect(payload.message).toContain("Update Daintree");
    expect(payload).not.toHaveProperty("action");
  });

  it("warns once per plugin version across reloads", async () => {
    const manifest = {
      name: "acme.reloaded",
      version: "1.0.0",
      engines: { daintree: ">=0.8.0" },
    };
    await writePlugin("acme.reloaded", manifest);

    const toasts = () =>
      broadcastToRendererMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.NOTIFICATION_SHOW_TOAST
      );

    const service = new PluginService(tmpDir, "0.7.1");
    await service.initialize();
    await service.loadDevPlugin("acme.reloaded");

    expect(service.hasPlugin("acme.reloaded")).toBe(true);
    expect(toasts()).toHaveLength(1);

    await writePlugin("acme.reloaded", { ...manifest, version: "1.1.0" });
    await service.loadDevPlugin("acme.reloaded");

    expect(toasts()).toHaveLength(2);
  });

  it("sends a project plugin's warning to that project's views only", async () => {
    const projectRoot = path.join(tmpDir, "project-a");
    const pluginsParent = path.join(projectRoot, ".daintree", "plugins");
    await fs.mkdir(path.join(pluginsParent, "acme.project-future"), { recursive: true });
    await fs.writeFile(
      path.join(pluginsParent, "acme.project-future", "plugin.json"),
      JSON.stringify({
        name: "acme.project-future",
        version: "1.0.0",
        scope: "project",
        engines: { daintree: ">=0.8.0" },
      })
    );

    const service = new PluginService(path.join(tmpDir, "installed"), "0.7.1");
    const seam = service as unknown as {
      loadPlugin(
        root: string,
        dirName: string,
        opts: {
          isBuiltin: boolean;
          disabled: Set<string>;
          origin: "project";
          instanceKey: string;
          binding: { projectId: string; projectRoot: string };
        }
      ): Promise<unknown>;
    };
    let loaded: unknown;
    try {
      loaded = await seam.loadPlugin(pluginsParent, "acme.project-future", {
        isBuiltin: false,
        disabled: new Set(),
        origin: "project",
        instanceKey: "project__proj-a__acme.project-future",
        binding: { projectId: "proj-a", projectRoot },
      });
    } finally {
      service.dispose();
    }

    expect(loaded).not.toBeNull();
    expect(broadcastToProjectRenderersMock).toHaveBeenCalledWith(
      "proj-a",
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({ type: "warning" })
    );
    expect(
      broadcastToRendererMock.mock.calls.filter(
        ([channel]) => channel === CHANNELS.NOTIFICATION_SHOW_TOAST
      )
    ).toHaveLength(0);
  });

  it("loads every plugin in a mixed batch and warns only for the mismatched one", async () => {
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

    const names = service
      .listPlugins()
      .map((p) => p.manifest.name)
      .sort();
    expect(names).toEqual(["acme.bad", "acme.good"]);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock.mock.calls[0][1].message).toContain('"acme.bad"');
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

  it("treats a dev build as the release it precedes (#12589)", async () => {
    await writePlugin("dev-build", {
      name: "acme.dev-build",
      version: "1.0.0",
      engines: { daintree: ">=0.37.0" },
    });

    const service = new PluginService(tmpDir, "0.37.0-dev.20260922");
    await service.initialize();

    expect(service.listPlugins()).toHaveLength(1);
    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });

  it("warns without a directional remedy when the app sits in a gap of the range", async () => {
    await writePlugin("gap", {
      name: "acme.gap",
      version: "1.0.0",
      engines: { daintree: "0.7.0 || 0.9.0" },
    });

    const service = new PluginService(tmpDir, "0.8.0");
    await service.initialize();

    expect(service.hasPlugin("acme.gap")).toBe(true);
    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    const payload = broadcastToRendererMock.mock.calls[0][1];
    expect(payload.message).toContain('"acme.gap" targets Daintree 0.7.0 || 0.9.0');
    expect(payload.message).not.toContain("Update Daintree");
    expect(payload.message).not.toContain("newer version of the plugin");
    expect(payload).not.toHaveProperty("action");
  });
});

describe("Project surface claims", () => {
  const PROJECT = "proj-a";
  const INSTANCE = "project__proj-a__acme.canvas";

  async function loadCanvasPlugin(service: PluginService): Promise<unknown> {
    const projectRoot = path.join(tmpDir, "project-a");
    const pluginsParent = path.join(projectRoot, ".daintree", "plugins");
    const dir = path.join(pluginsParent, "acme.canvas");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "panel.js"), "export default () => null;\n");
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.canvas",
        version: "1.0.0",
        scope: "project",
        engines: { daintree: ">=0.1.0" },
        contributes: {
          panels: [{ id: "overview", name: "Overview", iconId: "gauge", color: "#000" }],
          views: [{ id: "overview", componentPath: "dist/panel.js", location: "panel" }],
          surfaces: { emptyCanvas: { viewId: "overview" } },
        },
      })
    );
    const seam = service as unknown as {
      loadPlugin(
        root: string,
        dirName: string,
        opts: {
          isBuiltin: boolean;
          disabled: Set<string>;
          origin: "project";
          instanceKey: string;
          binding: { projectId: string; projectRoot: string };
        }
      ): Promise<unknown>;
    };
    return seam.loadPlugin(pluginsParent, "acme.canvas", {
      isBuiltin: false,
      disabled: new Set(),
      origin: "project",
      instanceKey: INSTANCE,
      binding: { projectId: PROJECT, projectRoot },
    });
  }

  /** Every slot-state push, in order, as `[projectId, revision]`. */
  const surfacePushes = () =>
    broadcastToProjectRenderersMock.mock.calls.flatMap(([projectId, channel, envelope]) => {
      const { name, payload } = envelope as { name?: string; payload?: { revision?: number } };
      return channel === CHANNELS.EVENTS_PUSH && name === "plugin:project-surfaces-changed"
        ? [[projectId, payload?.revision]]
        : [];
    });

  beforeEach(() => {
    clearAllProjectSurfaces();
    // `clearAllMocks` keeps implementations, so a mountable kind installed by
    // one test would otherwise leak into the next.
    vi.mocked(getPanelKindConfig).mockReset().mockReturnValue(undefined);
  });

  afterEach(() => {
    clearAllProjectSurfaces();
  });

  it("tells the project's views when a plugin claims a slot, and again when it unloads", async () => {
    vi.mocked(getPanelKindConfig).mockImplementation((id: string) => ({
      id,
      name: "Overview",
      iconId: "gauge",
      color: "#000",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: INSTANCE,
      componentPath: "plugin://acme.canvas/1/dist/panel.js",
    }));
    const service = new PluginService(path.join(tmpDir, "installed"), "1.0.0");
    try {
      expect(await loadCanvasPlugin(service)).not.toBeNull();
      expect(getProjectSurfaceSlots(PROJECT).emptyCanvas?.defaultOptionId).toBe(INSTANCE);
      const [claimed] = surfacePushes();
      expect(claimed?.[0]).toBe(PROJECT);

      // The release result used to be dropped here, so a slot change that was
      // not also a panel-kind change never reached the canvas.
      service.unloadPlugin(INSTANCE);

      expect(getProjectSurfaceSlots(PROJECT)).toEqual({});
      const pushes = surfacePushes();
      expect(pushes).toHaveLength(2);
      expect(pushes[1]?.[0]).toBe(PROJECT);
      expect(pushes[1]?.[1]).toBeGreaterThan(claimed?.[1] as number);
    } finally {
      service.dispose();
    }
  });

  it("claims a slot per default pattern of a file editor, and releases them on unload (#13811)", async () => {
    const instance = "project__proj-a__acme.cms";
    const projectRoot = path.join(tmpDir, "project-a");
    const pluginsParent = path.join(projectRoot, ".daintree", "plugins");
    const dir = path.join(pluginsParent, "acme.cms");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "editor.js"), "export default () => null;\n");
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.cms",
        version: "1.0.0",
        scope: "project",
        engines: { daintree: ">=0.1.0" },
        contributes: {
          views: [
            { id: "records-editor", componentPath: "dist/editor.js", location: "fileEditor" },
          ],
          fileEditors: [
            {
              id: "records",
              view: "records-editor",
              mode: "edit",
              extensions: ["json"],
              paths: ["content/*.json", "data/**/*.json"],
              default: true,
            },
            // Not a default: it only adds a choice, and claims nothing.
            { id: "pages", view: "records-editor", mode: "edit", paths: ["pages/*.json"] },
          ],
        },
      })
    );
    const service = new PluginService(path.join(tmpDir, "installed"), "1.0.0");
    const seam = service as unknown as {
      loadPlugin(
        root: string,
        dirName: string,
        opts: {
          isBuiltin: boolean;
          disabled: Set<string>;
          origin: "project";
          instanceKey: string;
          binding: { projectId: string; projectRoot: string };
        }
      ): Promise<unknown>;
    };
    try {
      expect(
        await seam.loadPlugin(pluginsParent, "acme.cms", {
          isBuiltin: false,
          disabled: new Set(),
          origin: "project",
          instanceKey: instance,
          binding: { projectId: PROJECT, projectRoot },
        })
      ).not.toBeNull();

      const slots = getProjectSurfaceSlots(PROJECT);
      expect(Object.keys(slots).sort()).toEqual([
        "fileEditor:content/*.json",
        "fileEditor:data/**/*.json",
      ]);
      expect(slots["fileEditor:content/*.json"]?.options).toEqual([
        {
          pluginId: instance,
          scope: "project",
          value: { kind: "data", data: { editorId: "records" } },
        },
      ]);
      expect(surfacePushes().map(([projectId]) => projectId)).toEqual([PROJECT]);

      service.unloadPlugin(instance);
      expect(getProjectSurfaceSlots(PROJECT)).toEqual({});
    } finally {
      service.dispose();
    }
  });

  it("records a claim whose view registered nothing mountable as a refusal", async () => {
    const service = new PluginService(path.join(tmpDir, "installed"), "1.0.0");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await loadCanvasPlugin(service);

      // Visible to the user and the author, not only to the log.
      expect(getProjectSurfaceRefusals(PROJECT)).toEqual([
        { slot: "emptyCanvas", pluginId: INSTANCE, reason: "unresolved-view" },
      ]);
      expect(getProjectSurfaceSlots(PROJECT).emptyCanvas?.defaultOptionId).toBeNull();
      expect(surfacePushes()).toHaveLength(1);
    } finally {
      service.dispose();
      warn.mockRestore();
    }
  });
});

describe("Project toolbar popover buttons", () => {
  const PROJECT = "proj-a";
  const INSTANCE = "project__proj-a__acme.inbox";

  async function loadInboxPlugin(service: PluginService): Promise<unknown> {
    const projectRoot = path.join(tmpDir, "project-a");
    const pluginsParent = path.join(projectRoot, ".daintree", "plugins");
    const dir = path.join(pluginsParent, "acme.inbox");
    await fs.mkdir(path.join(dir, "dist"), { recursive: true });
    await fs.writeFile(path.join(dir, "dist", "inbox.js"), "export default () => null;\n");
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        name: "acme.inbox",
        version: "1.0.0",
        scope: "project",
        engines: { daintree: ">=0.1.0" },
        contributes: {
          panels: [{ id: "inbox", name: "Inbox", iconId: "list", color: "#000" }],
          views: [{ id: "inbox", componentPath: "dist/inbox.js", location: "panel" }],
          toolbarButtons: [
            { id: "open", label: "Inbox", iconId: "list", popover: { viewId: "inbox" } },
          ],
        },
      })
    );
    const seam = service as unknown as {
      loadPlugin(
        root: string,
        dirName: string,
        opts: {
          isBuiltin: boolean;
          disabled: Set<string>;
          origin: "project";
          instanceKey: string;
          binding: { projectId: string; projectRoot: string };
        }
      ): Promise<unknown>;
    };
    return seam.loadPlugin(pluginsParent, "acme.inbox", {
      isBuiltin: false,
      disabled: new Set(),
      origin: "project",
      instanceKey: INSTANCE,
      binding: { projectId: PROJECT, projectRoot },
    });
  }

  it("registers the popover against the project-qualified panel kind its view loads under", async () => {
    vi.mocked(registerToolbarButton).mockClear();
    vi.mocked(registerPanelKind).mockClear();
    const service = new PluginService(path.join(tmpDir, "installed"), "1.0.0");
    expect(await loadInboxPlugin(service)).not.toBeNull();

    const config = vi
      .mocked(registerToolbarButton)
      .mock.calls.map(([registered]) => registered)
      .find((registered) => registered.id === `${INSTANCE}.open`);
    const kindIds = vi.mocked(registerPanelKind).mock.calls.map(([kind]) => kind.id);
    // The id the panels loop registered this project's view under, so the
    // popover never mounts a same-named installed plugin's kind.
    expect(config?.popover?.viewId).toBe("inbox");
    expect(config?.popover?.panelKindId).toBe(`project:${PROJECT}/acme.inbox/inbox`);
    expect(kindIds).toContain(config?.popover?.panelKindId);
    expect(config?.pluginId).toBe(INSTANCE);
    expect(config).not.toHaveProperty("actionId");
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

  it("serves a plugin's databases to agents from load until unload, without activating it", async () => {
    await writePlugin("ledger", {
      name: "acme.ledger",
      version: "1.0.0",
      main: "main.mjs",
      contributes: { databases: [{ id: "ledger", location: "local" }] },
    });
    await fs.writeFile(
      path.join(tmpDir, "ledger", "main.mjs"),
      "globalThis.__ledgerActivated = true; export function activate() {}"
    );

    const service = new PluginService(tmpDir);
    try {
      await service.initialize();

      const registration = agentMcpEndpointRegistry.get("acme.ledger", DATABASE_ENDPOINT_ID);
      expect(registration?.tools.map((t) => t.name)).toEqual(["database_schema", "database_query"]);
      expect((globalThis as { __ledgerActivated?: boolean }).__ledgerActivated).toBeUndefined();

      service.unloadPlugin("acme.ledger");
      expect(agentMcpEndpointRegistry.get("acme.ledger", DATABASE_ENDPOINT_ID)).toBeUndefined();
    } finally {
      delete (globalThis as { __ledgerActivated?: unknown }).__ledgerActivated;
      agentMcpEndpointRegistry.unregisterPlugin("acme.ledger");
    }
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
});
