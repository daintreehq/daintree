import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import os from "os";

/**
 * Per-instance runtime health (#12278).
 *
 * The projection `PluginService` publishes to every mounted plugin panel, and
 * the restart that is a panel's last recovery. Driven through the service's own
 * lifecycle surface with a fake worker host standing in for the utility process
 * — a real `utilityProcess.fork` cannot run under vitest, and the logic under
 * test is the state machine and its identity guards, not the fork.
 *
 * `broadcastToRenderer` is mocked at module scope by the shared preamble, so
 * every published transition is readable off that spy.
 */
const appMock = vi.hoisted(() => ({
  getVersion: vi.fn(() => "0.0.0"),
  getPath: vi.fn(() => "/tmp/daintree-install-test-userdata"),
}));
const storeMock = vi.hoisted(() => {
  const state = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => state.get(key)),
    set: vi.fn((key: string, value: unknown) => state.set(key, value)),
    _state: state,
  };
});
// Plugin-MCP consent + rate-limiter singletons are only reached by the
// installer's uninstall/upgrade purge; stub them so the upgrade-consent-reset
// test can assert the revoke without standing up the real persistence.
const consentMock = vi.hoisted(() => ({ revokeAllForPlugin: vi.fn(() => true) }));
const capConsentMock = vi.hoisted(() => ({ revokeAllForPlugin: vi.fn(() => true) }));
const rateLimiterMock = vi.hoisted(() => ({ dropPlugin: vi.fn() }));

vi.mock("electron", () => ({ app: appMock, ipcMain: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../ipc/utils.js", () => {
  const broadcastToRenderer = vi.fn();
  return {
    broadcastToRenderer,
    broadcastToProjectRenderers: vi.fn(),
  };
});
vi.mock("../../store.js", () => ({ store: storeMock }));
vi.mock("../ProjectStore.js", () => ({ projectStore: { getCurrentProject: vi.fn(() => null) } }));
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
  clearForgeProviderImplRegistry: vi.fn(),
}));
vi.mock("../fileDecorationRegistry.js", () => ({
  registerFileDecorationProviders: vi.fn(),
  registerFileDecorationProviderImpl: vi.fn(),
  unregisterFileDecorationProviders: vi.fn(),
  unregisterFileDecorationProviderImpls: vi.fn(),
  unregisterFileDecorationProviderImpl: vi.fn(),
  scopeMatchesPattern: vi.fn((s: string, p: string) => s === p),
}));
vi.mock("../PluginMcpSupervisor.js", () => ({
  getPluginMcpSupervisor: () => ({
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    shutdownAll: vi.fn(async () => undefined),
    callTool: vi.fn(),
    restart: vi.fn(),
    removeState: vi.fn(),
    list: vi.fn(() => []),
    getStderr: vi.fn(() => ({ pluginId: "", serverId: "", lines: [], totalLines: 0 })),
  }),
}));
vi.mock("../plugin-mcp/instances.js", () => ({
  getPluginMcpConsentService: () => consentMock,
  getPluginMcpRateLimiter: () => rateLimiterMock,
}));
vi.mock("../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: () => capConsentMock,
}));

import { PluginService } from "../PluginService.js";
import { broadcastToRenderer, broadcastToProjectRenderers } from "../../ipc/utils.js";
import type { PluginRuntimeStatus, PluginWorkerState } from "../../../shared/types/plugin.js";

let tmpDir: string;
let pluginsRoot: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-runtime-status-"));
  pluginsRoot = path.join(tmpDir, "plugins");
  await fs.mkdir(pluginsRoot, { recursive: true });
  storeMock._state.clear();
  vi.mocked(broadcastToRenderer).mockClear();
  vi.mocked(broadcastToProjectRenderers).mockClear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * The private surface these tests drive. Reaching in is deliberate: the public
 * entry points fork a real utility process, and the transitions under test are
 * produced by lifecycle edges no unit test can reach through the front door.
 */
interface RuntimeInternals {
  setWorkerStatus(
    pluginId: string,
    state: PluginWorkerState,
    reason: string | null,
    detail: string | null,
    opts?: { newGeneration?: boolean }
  ): void;
  watchWorkerHealth(pluginId: string, entry: { workerHost: EventEmitter }): () => void;
  pluginWorkers: Map<string, unknown>;
  workerStatuses: Map<string, unknown>;
  plugins: Map<string, unknown>;
  commandModulePaths: Map<string, string>;
}

function internals(service: PluginService): RuntimeInternals {
  return service as unknown as RuntimeInternals;
}

function statusOf(service: PluginService, pluginId: string): PluginRuntimeStatus | undefined {
  return service.listPluginRuntimeStatuses().find((s) => s.pluginId === pluginId);
}

/** Every runtime-status payload published since the last clear, in order. */
function publishedStatuses(): Array<{ pluginId: string; status: PluginRuntimeStatus | null }> {
  return vi
    .mocked(broadcastToRenderer)
    .mock.calls.map(([, event]) => event as { name: string; payload: unknown })
    .filter((event) => event.name === "plugin:runtime-status-changed")
    .map((event) => event.payload as { pluginId: string; status: PluginRuntimeStatus | null });
}

describe("plugin runtime status — the projection panels read (#12278)", () => {
  it("reports a production plugin's worker health with no dev session attached", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).setWorkerStatus("acme.prod", "starting", null, null, {
      newGeneration: true,
    });

    const status = statusOf(service, "acme.prod");
    // The whole premise of the issue: before this, a non-dev plugin published
    // nothing at all, because every producer gated on `devSessions`.
    expect(status).toBeDefined();
    expect(status?.dev).toBe(null);
    expect(status?.worker?.state).toBe("starting");

    service.dispose();
  });

  it("publishes each transition on the runtime-status channel", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const api = internals(service);
    api.setWorkerStatus("acme.prod", "starting", null, null, { newGeneration: true });
    api.setWorkerStatus("acme.prod", "activating", null, null);
    api.setWorkerStatus("acme.prod", "ready", null, null);

    expect(publishedStatuses().map((p) => p.status?.worker?.state)).toEqual([
      "starting",
      "activating",
      "ready",
    ]);

    service.dispose();
  });

  it("does not republish an unchanged state", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const api = internals(service);
    api.setWorkerStatus("acme.prod", "ready", null, null, { newGeneration: true });
    vi.mocked(broadcastToRenderer).mockClear();
    api.setWorkerStatus("acme.prod", "ready", null, null);

    // A duplicate snapshot would remount every panel bound to the generation.
    expect(publishedStatuses()).toHaveLength(0);

    service.dispose();
  });

  it("keeps a failure visible when the teardown that follows it lands", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const api = internals(service);
    api.setWorkerStatus("acme.prod", "failed", "crash-loop", "crashed 3 times", {
      newGeneration: true,
    });
    // `onTerminalFailure` tears the worker down right after failing it; the
    // bland "deactivated" must not overwrite the cause the user needs shown.
    api.setWorkerStatus("acme.prod", "stopped", "deactivated", null);

    const worker = statusOf(service, "acme.prod")?.worker;
    expect(worker?.state).toBe("failed");
    expect(worker?.reason).toBe("crash-loop");

    service.dispose();
  });

  it("lets a restart clear a previous failure", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const api = internals(service);
    api.setWorkerStatus("acme.prod", "failed", "crash-loop", null, { newGeneration: true });
    api.setWorkerStatus("acme.prod", "starting", null, null, { newGeneration: true });

    expect(statusOf(service, "acme.prod")?.worker?.state).toBe("starting");

    service.dispose();
  });

  it("mints a new generation per fork and holds it steady within one", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const api = internals(service);
    api.setWorkerStatus("acme.prod", "starting", null, null, { newGeneration: true });
    const first = statusOf(service, "acme.prod")?.worker?.generation;
    api.setWorkerStatus("acme.prod", "ready", null, null);
    expect(statusOf(service, "acme.prod")?.worker?.generation).toBe(first);

    api.setWorkerStatus("acme.prod", "starting", null, null, { newGeneration: true });
    const second = statusOf(service, "acme.prod")?.worker?.generation;
    // A panel tells "my backend was replaced" from "my backend is the one I
    // mounted against" by this number alone — `viewGeneration` does not move
    // when only the worker is swapped.
    expect(second).toBeGreaterThan(first as number);

    service.dispose();
  });
});

describe("runtime-status broadcast scope (#12278)", () => {
  const PROJECT = "a".repeat(64);
  const INSTANCE = `project__${PROJECT}__acme.dashboard`;

  it("keeps a project instance's health inside its own project's views", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).setWorkerStatus(INSTANCE, "failed", "activation-failed", "/Users/x/secret", {
      newGeneration: true,
    });

    // Scoped, not global: the payload carries plugin-authored `detail` — error
    // text and paths out of that project's checkout — and no other project's
    // view has a panel on the instance to render it. Same rule the pull handler
    // applies, and the one every other project-local plugin event follows.
    const scoped = vi
      .mocked(broadcastToProjectRenderers)
      .mock.calls.filter(
        ([, , event]) =>
          (event as { name: string } | undefined)?.name === "plugin:runtime-status-changed"
      );
    expect(scoped).toHaveLength(1);
    expect(scoped[0][0]).toBe(PROJECT);
    expect(publishedStatuses()).toHaveLength(0);

    service.dispose();
  });

  it("broadcasts an app-global instance's health to every view", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).setWorkerStatus("acme.prod", "starting", null, null, {
      newGeneration: true,
    });

    expect(publishedStatuses().map((p) => p.pluginId)).toEqual(["acme.prod"]);
    expect(vi.mocked(broadcastToProjectRenderers)).not.toHaveBeenCalled();

    service.dispose();
  });
});

describe("worker health subscription — identity guards (#12278)", () => {
  function attach(service: PluginService, pluginId: string) {
    const workerHost = new EventEmitter();
    const entry = { workerHost };
    internals(service).pluginWorkers.set(pluginId, entry);
    const detach = internals(service).watchWorkerHealth(pluginId, entry);
    return { workerHost, entry, detach };
  }

  it("maps the host's own lifecycle events onto renderer-facing states", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { workerHost } = attach(service, "acme.prod");

    workerHost.emit("ready");
    expect(statusOf(service, "acme.prod")?.worker?.state).toBe("activating");

    workerHost.emit("crash-loop", 139);
    const worker = statusOf(service, "acme.prod")?.worker;
    expect(worker?.state).toBe("failed");
    expect(worker?.reason).toBe("crash-loop");

    service.dispose();
  });

  it("treats an unexpected exit as a respawn in progress, not a failure", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { workerHost } = attach(service, "acme.prod");
    workerHost.emit("ready");
    const before = statusOf(service, "acme.prod")?.worker?.generation;

    workerHost.emit("exit", 1, /* expected */ false);

    const worker = statusOf(service, "acme.prod")?.worker;
    // The supervisor decides a tick later whether to respawn or trip the cap.
    // Optimistic by design: this is what the shell renders as "Reloading".
    expect(worker?.state).toBe("starting");
    expect(worker?.reason).toBe("crashed");
    expect(worker?.generation).toBeGreaterThan(before as number);

    service.dispose();
  });

  it("ignores an expected exit, which is a dispose the owner already accounted for", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { workerHost } = attach(service, "acme.prod");
    workerHost.emit("ready");
    vi.mocked(broadcastToRenderer).mockClear();

    workerHost.emit("exit", 0, /* expected */ true);

    expect(publishedStatuses()).toHaveLength(0);

    service.dispose();
  });

  it("lets a retired worker's late event say nothing about its replacement", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const outgoing = attach(service, "acme.prod");
    outgoing.workerHost.emit("ready");

    // A replacement takes the slot under the same plugin id — the exact shape
    // that makes a presence check (`Map.has`) wrong (#10899).
    const incoming = attach(service, "acme.prod");
    incoming.workerHost.emit("ready");
    internals(service).setWorkerStatus("acme.prod", "ready", null, null);
    const generation = statusOf(service, "acme.prod")?.worker?.generation;

    outgoing.workerHost.emit("crash-loop", 139);

    const worker = statusOf(service, "acme.prod")?.worker;
    expect(worker?.state).toBe("ready");
    expect(worker?.generation).toBe(generation);

    service.dispose();
  });

  it("stops reporting once detached", () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    const { workerHost, detach } = attach(service, "acme.prod");
    workerHost.emit("ready");
    detach();
    vi.mocked(broadcastToRenderer).mockClear();

    workerHost.emit("crash-loop", 139);

    expect(publishedStatuses()).toHaveLength(0);
    expect(workerHost.listenerCount("crash-loop")).toBe(0);

    service.dispose();
  });
});

describe("restartPluginWorker — the panel's last recovery (#12278)", () => {
  async function writePlugin(id: string): Promise<void> {
    const dir = path.join(pluginsRoot, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ name: id, version: "1.0.0" })
    );
  }

  /** A loaded plugin that actually has a utility-process backend to restart. */
  function workerBackedPlugin(id: string) {
    return {
      manifest: { name: id },
      isBuiltin: false,
      resolvedMain: path.join(pluginsRoot, id, "dist", "index.js"),
    };
  }

  it("refuses a builtin, which activates in-process and has no worker", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).plugins.set("daintree.github", {
      manifest: { name: "daintree.github" },
      isBuiltin: true,
      resolvedMain: "/builtin/index.js",
    });

    // Refused BEFORE anything is published: a `starting` no worker event can
    // ever settle would strand every panel on it in "Reloading".
    await expect(service.restartPluginWorker("daintree.github")).rejects.toThrow(
      /no backend to restart/
    );
    expect(statusOf(service, "daintree.github")).toBeUndefined();

    service.dispose();
  });

  /**
   * A plugin with no `main` at all, whose manifest commands are backed by real
   * handler modules. Since #12274 that plugin forks a worker like any other, so
   * the restart gate must not read "no `main`" as "no backend".
   */
  function commandsOnlyPlugin(id: string) {
    return {
      manifest: { name: id, contributes: { commands: [{ id: "refresh" }] } },
      isBuiltin: false,
      resolvedMain: null,
    };
  }

  it("restarts a commands-only plugin, which has a worker despite having no main", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).plugins.set("acme.commands", commandsOnlyPlugin("acme.commands"));
    // The probe's own output: a resolved handler module is what makes the
    // plugin worker-backed (#12274).
    internals(service).commandModulePaths.set(
      "acme.commands.refresh",
      path.join(pluginsRoot, "acme.commands", "src", "refresh.js")
    );
    const activate = vi.spyOn(service, "activatePlugin").mockImplementation(async () => undefined);

    await service.restartPluginWorker("acme.commands");

    expect(activate).toHaveBeenCalledWith("acme.commands");

    service.dispose();
  });

  it("refuses a plugin with neither a main nor a resolvable command module", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    // A command DESCRIPTOR with nothing behind it — the file is missing, or its
    // only sibling is `.ts` — forks no worker, so there is nothing to retire.
    internals(service).plugins.set("acme.hollow", commandsOnlyPlugin("acme.hollow"));

    await expect(service.restartPluginWorker("acme.hollow")).rejects.toThrow(
      /no backend to restart/
    );
    expect(statusOf(service, "acme.hollow")).toBeUndefined();

    service.dispose();
  });

  it("refuses a plugin that isn't loaded", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await expect(service.restartPluginWorker("acme.missing")).rejects.toThrow(/isn't loaded/);
    service.dispose();
  });

  it("refuses a disabled plugin rather than reviving what the user turned off", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    await writePlugin("acme.off");
    internals(service).plugins.set("acme.off", workerBackedPlugin("acme.off"));
    (
      service as unknown as { records: { setEnabled(id: string, enabled: boolean): void } }
    ).records.setEnabled("acme.off", false);

    await expect(service.restartPluginWorker("acme.off")).rejects.toThrow(/disabled/);

    service.dispose();
  });

  it("coalesces concurrent restarts so sibling panels share one", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).plugins.set("acme.prod", workerBackedPlugin("acme.prod"));
    const activate = vi.spyOn(service, "activatePlugin").mockImplementation(async () => undefined);

    // Three panels of one instance, each clicking Restart plugin.
    await Promise.all([
      service.restartPluginWorker("acme.prod"),
      service.restartPluginWorker("acme.prod"),
      service.restartPluginWorker("acme.prod"),
    ]);

    expect(activate).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("clears a previous failure once the fresh generation starts", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).plugins.set("acme.prod", workerBackedPlugin("acme.prod"));
    internals(service).setWorkerStatus("acme.prod", "failed", "crash-loop", null, {
      newGeneration: true,
    });
    const failedGeneration = statusOf(service, "acme.prod")?.worker?.generation;
    // Stands in for `activateViaWorker`, which publishes `starting` on a new
    // generation as it forks. The restart deliberately does NOT publish one
    // itself — doing both bumped the generation twice per restart.
    vi.spyOn(service, "activatePlugin").mockImplementation(async () => {
      internals(service).setWorkerStatus("acme.prod", "starting", null, null, {
        newGeneration: true,
      });
    });

    await service.restartPluginWorker("acme.prod");

    const worker = statusOf(service, "acme.prod")?.worker;
    expect(worker?.state).toBe("starting");
    // The panels bound to the failed backend see a generation they are not on.
    expect(worker?.generation).toBeGreaterThan(failedGeneration as number);

    service.dispose();
  });

  it("returns the resulting status rather than throwing when the backend fails again", async () => {
    const service = new PluginService(pluginsRoot, "0.0.0");
    internals(service).plugins.set("acme.prod", workerBackedPlugin("acme.prod"));
    // `activatePlugin` never rejects by contract (#9428) — the outcome is read
    // back off the published status, which is what the banner renders.
    vi.spyOn(service, "activatePlugin").mockImplementation(async () => {
      internals(service).setWorkerStatus("acme.prod", "failed", "activation-failed", "boom");
    });

    const result = await service.restartPluginWorker("acme.prod");

    expect(result?.worker?.state).toBe("failed");
    expect(result?.worker?.reason).toBe("activation-failed");

    service.dispose();
  });
});
