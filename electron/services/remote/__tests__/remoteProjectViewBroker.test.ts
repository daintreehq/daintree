import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types/project.js";
import type { ProjectViewManager } from "../../../window/ProjectViewManager.js";
import type { WindowContext } from "../../../window/WindowRegistry.js";
import { RemoteProjectViewBroker, RemoteProjectViewError } from "../RemoteProjectViewBroker.js";
import { RemoteRendererPanelRegistry } from "../RemoteRendererPanelRegistry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class Sender extends EventEmitter {
  private destroyed = false;

  constructor(readonly id: number) {
    super();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function project(id = "project-target"): Project {
  return {
    id,
    path: id === "project-target" ? "/private/projects/target" : `/private/projects/${id}`,
    name: "Target",
    emoji: "🌲",
    status: "background",
    lastOpened: 1,
  };
}

function publishAvailable(registry: RemoteRendererPanelRegistry, sender: Sender): void {
  registry.publish({ projectId: "project-target", status: "available", panels: [] }, sender);
}

function managerFixture(
  options: {
    activeProjectId?: string;
    existingWebContentsId?: number;
    canMaterialize?: boolean;
    ensure?: (
      projectId: string,
      projectPath: string,
      signal?: AbortSignal
    ) => Promise<{ view: { webContents: { id: number } }; isNew: boolean }>;
  } = {}
) {
  let activeProjectId = options.activeProjectId ?? "foreground-project";
  let ownerDestroyed = false;
  const invalidationListeners = new Set<(projectId: string, webContentsId: number) => void>();
  const views = new Map<string, { projectId: string; view: { webContents: { id: number } } }>();
  if (options.existingWebContentsId !== undefined) {
    views.set("project-target", {
      projectId: "project-target",
      view: { webContents: { id: options.existingWebContentsId } },
    });
  }
  let holds = 0;
  let releaseInvocations = 0;
  const ensure = vi.fn(
    options.ensure ??
      (async () => {
        const existing = views.get("project-target");
        if (existing) return { view: existing.view, isNew: false };
        const view = { webContents: { id: 42 } };
        views.set("project-target", { projectId: "project-target", view });
        return { view, isNew: true };
      })
  );
  const finalize = vi.fn(() => true);
  const destroy = vi.fn((projectId: string, webContentsId: number) => {
    if (views.get(projectId)?.view.webContents.id !== webContentsId) return false;
    views.delete(projectId);
    return true;
  });
  const manager = {
    disposed: false,
    win: { isDestroyed: vi.fn(() => ownerDestroyed) },
    getActiveProjectId: vi.fn(() => activeProjectId),
    getAllViews: vi.fn(() => [...views.values()]),
    canMaterializeBackgroundView: vi.fn(() => options.canMaterialize ?? true),
    canCreateBackgroundView: vi.fn(() => options.canMaterialize ?? true),
    ensureBackgroundView: ensure,
    acquireBackgroundViewHold: vi.fn(() => {
      holds += 1;
      let released = false;
      return () => {
        releaseInvocations += 1;
        if (released) return;
        released = true;
        holds -= 1;
      };
    }),
    onViewInvalidated: vi.fn((listener) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    }),
    getProjectIdForWebContents: vi.fn(
      (webContentsId: number) =>
        [...views.values()].find((entry) => entry.view.webContents.id === webContentsId)
          ?.projectId ?? null
    ),
    finalizeBackgroundView: finalize,
    destroyBackgroundView: destroy,
  } as unknown as ProjectViewManager;
  return {
    manager,
    ensure,
    finalize,
    destroy,
    views,
    holds: () => holds,
    releaseInvocations: () => releaseInvocations,
    active: () => activeProjectId,
    setActive: (value: string) => {
      activeProjectId = value;
    },
    destroyOwner: () => {
      ownerDestroyed = true;
    },
    invalidate: (projectId: string, webContentsId: number) => {
      for (const listener of invalidationListeners) listener(projectId, webContentsId);
    },
  };
}

function context(manager: ProjectViewManager, id = 1): WindowContext {
  return {
    windowId: id,
    webContentsId: id + 100,
    browserWindow: {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => id === 1),
      focus: vi.fn(),
      show: vi.fn(),
    },
    projectPath: null,
    abortController: new AbortController(),
    services: { projectViewManager: manager },
    cleanup: { dispose: vi.fn() },
  } as unknown as WindowContext;
}

function brokerFixture(
  options: {
    managers?: ReturnType<typeof managerFixture>[];
    timeoutMs?: number;
    maxConcurrent?: number;
  } = {}
) {
  const managers = options.managers ?? [managerFixture()];
  const registry = new RemoteRendererPanelRegistry();
  const windows = managers.map((item, index) => context(item.manager, index + 1));
  const broker = new RemoteProjectViewBroker(
    { getProjectById: (id) => project(id) },
    () => windows,
    registry,
    options.timeoutMs ?? 100,
    options.maxConcurrent ?? 2
  );
  return { broker, registry, managers, windows };
}

describe("RemoteProjectViewBroker", () => {
  it("reuses the active target binding with an independently released lease", async () => {
    const manager = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 21,
    });
    const f = brokerFixture({ managers: [manager] });
    publishAvailable(f.registry, new Sender(21));

    const lease = await f.broker.ensureBackgroundView("project-target");

    expect(lease).toMatchObject({
      projectId: "project-target",
      webContentsId: 21,
      generation: 1,
    });
    expect(manager.ensure).toHaveBeenCalledWith(
      "project-target",
      "/private/projects/target",
      expect.any(AbortSignal)
    );
    expect(manager.finalize).toHaveBeenCalledWith("project-target", 21);
    expect(manager.active()).toBe("project-target");
    expect(manager.holds()).toBe(1);
    lease.release();
    lease.release();
    expect(manager.holds()).toBe(0);
    expect(manager.releaseInvocations()).toBe(1);
  });

  it("materializes a hidden background view without changing foreground window state", async () => {
    const manager = managerFixture({
      ensure: async () => {
        const view = { webContents: { id: 42 } };
        manager.views.set("project-target", { projectId: "project-target", view });
        queueMicrotask(() => publishAvailable(f.registry, new Sender(42)));
        return { view, isNew: true };
      },
    });
    const f = brokerFixture({ managers: [manager] });
    const window = f.windows[0]!.browserWindow;

    const lease = await f.broker.ensureBackgroundView("project-target");

    expect(lease.webContentsId).toBe(42);
    expect(manager.active()).toBe("foreground-project");
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(manager.finalize).toHaveBeenCalledWith("project-target", 42);
    lease.release();
  });

  it("selects the exact registered renderer owner when multiple windows show the project", async () => {
    const first = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 31,
    });
    const bound = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 32,
    });
    const f = brokerFixture({ managers: [first, bound] });
    publishAvailable(f.registry, new Sender(32));

    const lease = await f.broker.ensureBackgroundView("project-target");

    expect(lease.webContentsId).toBe(32);
    expect(first.ensure).not.toHaveBeenCalled();
    expect(bound.ensure).toHaveBeenCalledOnce();
    lease.release();
  });

  it("coalesces concurrent callers while retaining one hold per lease", async () => {
    const ready = deferred<{ view: { webContents: { id: number } }; isNew: boolean }>();
    const manager = managerFixture({ ensure: () => ready.promise });
    const f = brokerFixture({ managers: [manager] });
    const first = f.broker.ensureBackgroundView("project-target");
    const second = f.broker.ensureBackgroundView("project-target");
    const view = { webContents: { id: 42 } };
    manager.views.set("project-target", { projectId: "project-target", view });
    ready.resolve({ view, isNew: true });
    publishAvailable(f.registry, new Sender(42));

    const [firstLease, secondLease] = await Promise.all([first, second]);

    expect(manager.ensure).toHaveBeenCalledOnce();
    expect(manager.holds()).toBe(2);
    firstLease.release();
    expect(manager.holds()).toBe(1);
    secondLease.release();
    expect(manager.holds()).toBe(0);
  });

  it("rejects a third distinct materialization while two project slots are occupied", async () => {
    const manager = managerFixture({ ensure: () => new Promise(() => undefined) });
    const f = brokerFixture({ managers: [manager], maxConcurrent: 2 });
    const first = f.broker.ensureBackgroundView("project-a");
    const second = f.broker.ensureBackgroundView("project-b");
    const pending = Promise.allSettled([first, second]);

    await expect(f.broker.ensureBackgroundView("project-c")).rejects.toMatchObject({
      code: "HOST_RESOURCE_PRESSURE",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.ensure).toHaveBeenCalledTimes(2);

    f.broker.dispose();
    await pending;
    expect(manager.holds()).toBe(0);
  });

  it("fails closed and removes a newly created view on eviction or generation replacement", async () => {
    const manager = managerFixture({
      ensure: async () => {
        const view = { webContents: { id: 42 } };
        manager.views.set("project-target", { projectId: "project-target", view });
        queueMicrotask(() => {
          const sender = new Sender(42);
          publishAvailable(f.registry, sender);
          sender.destroy();
        });
        return { view, isNew: true };
      },
    });
    const f = brokerFixture({ managers: [manager] });

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "VIEW_INVALIDATED",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.destroy).toHaveBeenCalledWith("project-target", 42);
    expect(manager.holds()).toBe(0);
  });

  it("revives a project whose previous renderer binding is already evicted", async () => {
    const manager = managerFixture({
      ensure: async () => {
        const view = { webContents: { id: 44 } };
        manager.views.set("project-target", { projectId: "project-target", view });
        queueMicrotask(() => publishAvailable(f.registry, new Sender(44)));
        return { view, isNew: true };
      },
    });
    const f = brokerFixture({ managers: [manager] });
    const old = new Sender(41);
    publishAvailable(f.registry, old);
    old.destroy();

    const lease = await f.broker.ensureBackgroundView("project-target");

    expect(lease).toMatchObject({ webContentsId: 44, generation: 2 });
    expect(manager.destroy).not.toHaveBeenCalled();
    lease.release();
  });

  it("rechecks owner liveness after the shared materialization await", async () => {
    const manager = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 46,
    });
    const acquire = vi.mocked(manager.manager.acquireBackgroundViewHold).getMockImplementation()!;
    vi.mocked(manager.manager.acquireBackgroundViewHold).mockImplementation((projectId) => {
      const release = acquire(projectId);
      manager.destroyOwner();
      return release;
    });
    const f = brokerFixture({ managers: [manager] });
    publishAvailable(f.registry, new Sender(46));

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "VIEW_INVALIDATED",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.holds()).toBe(0);
  });

  it("rejects a materialization whose exact WindowContext is replaced during preparation", async () => {
    const manager = managerFixture({
      ensure: async () => {
        const view = { webContents: { id: 47 } };
        manager.views.set("project-target", { projectId: "project-target", view });
        f.windows[0] = context(manager.manager, 1);
        return { view, isNew: true };
      },
    });
    const f = brokerFixture({ managers: [manager] });

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "VIEW_INVALIDATED",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.destroy).toHaveBeenCalledWith("project-target", 47);
    expect(manager.holds()).toBe(0);
  });

  it("rechecks the exact renderer generation after the shared materialization await", async () => {
    const manager = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 48,
    });
    const f = brokerFixture({ managers: [manager] });
    publishAvailable(f.registry, new Sender(48));
    vi.mocked(manager.manager.win.isDestroyed).mockImplementation(() => {
      publishAvailable(f.registry, new Sender(49));
      return false;
    });

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "VIEW_INVALIDATED",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.holds()).toBe(0);
  });

  it("bounds timeout, cancellation, memory pressure, missing UI, and shutdown", async () => {
    const stalled = deferred<{ view: { webContents: { id: number } }; isNew: boolean }>();
    const manager = managerFixture({ ensure: () => stalled.promise });
    const timeout = brokerFixture({ managers: [manager], timeoutMs: 5 });
    const view = { webContents: { id: 42 } };
    manager.views.set("project-target", { projectId: "project-target", view });
    stalled.resolve({ view, isNew: true });
    await expect(timeout.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "TIMEOUT",
    } satisfies Partial<RemoteProjectViewError>);

    const cancellable = deferred<{ view: { webContents: { id: number } }; isNew: boolean }>();
    const cancelledManager = managerFixture({
      ensure: (_projectId, _projectPath, signal) =>
        new Promise((resolve, reject) => {
          cancellable.promise.then(resolve, reject);
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    });
    const cancelled = brokerFixture({ managers: [cancelledManager] });
    const controller = new AbortController();
    const request = cancelled.broker.ensureBackgroundView("project-target", {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({
      code: "CANCELLED",
    } satisfies Partial<RemoteProjectViewError>);
    expect(cancelledManager.holds()).toBe(0);

    const pressured = managerFixture({ canMaterialize: false });
    await expect(
      brokerFixture({ managers: [pressured] }).broker.ensureBackgroundView("project-target")
    ).rejects.toMatchObject({
      code: "HOST_RESOURCE_PRESSURE",
    } satisfies Partial<RemoteProjectViewError>);
    await expect(
      new RemoteProjectViewBroker(
        { getProjectById: () => project() },
        () => [],
        new RemoteRendererPanelRegistry()
      ).ensureBackgroundView("project-target")
    ).rejects.toMatchObject({
      code: "HOST_UI_UNAVAILABLE",
    } satisfies Partial<RemoteProjectViewError>);

    const active = managerFixture({
      activeProjectId: "project-target",
      existingWebContentsId: 55,
    });
    const shutdown = brokerFixture({ managers: [active] });
    publishAvailable(shutdown.registry, new Sender(55));
    const lease = await shutdown.broker.ensureBackgroundView("project-target");
    expect(active.holds()).toBe(1);
    shutdown.broker.dispose();
    expect(active.holds()).toBe(0);
    lease.release();
    await expect(shutdown.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "HOST_SHUTDOWN",
    } satisfies Partial<RemoteProjectViewError>);
  });

  it("applies the readiness deadline to manager preparation and releases its hold", async () => {
    const manager = managerFixture({ ensure: () => new Promise(() => undefined) });
    const f = brokerFixture({ managers: [manager], timeoutMs: 5 });

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "TIMEOUT",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.holds()).toBe(0);
  });

  it("rejects late critical memory pressure and removes the newly prepared view", async () => {
    const manager = managerFixture({
      ensure: async () => {
        const view = { webContents: { id: 57 } };
        manager.views.set("project-target", { projectId: "project-target", view });
        vi.mocked(manager.manager.canCreateBackgroundView).mockReturnValue(false);
        return { view, isNew: true };
      },
    });
    const f = brokerFixture({ managers: [manager] });

    await expect(f.broker.ensureBackgroundView("project-target")).rejects.toMatchObject({
      code: "HOST_RESOURCE_PRESSURE",
    } satisfies Partial<RemoteProjectViewError>);
    expect(manager.destroy).toHaveBeenCalledWith("project-target", 57);
    expect(manager.holds()).toBe(0);
  });

  it("rejects pre-aborted requests without acquiring a hold or occupying a slot", async () => {
    const manager = managerFixture();
    const f = brokerFixture({ managers: [manager] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      f.broker.ensureBackgroundView("project-target", { signal: controller.signal })
    ).rejects.toMatchObject({ code: "CANCELLED" } satisfies Partial<RemoteProjectViewError>);
    expect(manager.ensure).not.toHaveBeenCalled();
    expect(manager.manager.acquireBackgroundViewHold).not.toHaveBeenCalled();
    expect(manager.holds()).toBe(0);
  });

  it("allows a replacement request after broker cancellation without stale-slot cleanup", async () => {
    const firstLoad = deferred<{ view: { webContents: { id: number } }; isNew: boolean }>();
    const manager = managerFixture({ ensure: () => firstLoad.promise });
    const f = brokerFixture({ managers: [manager] });
    const controller = new AbortController();
    const first = f.broker.ensureBackgroundView("project-target", { signal: controller.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort();
    await firstRejected;

    vi.mocked(manager.ensure).mockImplementationOnce(async () => {
      const view = { webContents: { id: 58 } };
      manager.views.set("project-target", { projectId: "project-target", view });
      queueMicrotask(() => publishAvailable(f.registry, new Sender(58)));
      return { view, isNew: true };
    });
    const lease = await f.broker.ensureBackgroundView("project-target");

    expect(lease.webContentsId).toBe(58);
    expect(manager.ensure).toHaveBeenCalledTimes(2);
    lease.release();
    expect(manager.holds()).toBe(0);
  });
});
