import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectViewManager } from "../ProjectViewManager.js";

const mocks = vi.hoisted(() => ({
  createView: vi.fn(),
  loadView: vi.fn(),
  updateViewBounds: vi.fn(),
  cleanupEntry: vi.fn(),
  deactivateEntry: vi.fn(),
  setupViewHandlers: vi.fn(),
  registerWebContents: vi.fn(),
  registerProjectView: vi.fn(),
  unregisterCachedViewWebContents: vi.fn(),
  evictStaleViews: vi.fn(),
}));

vi.mock("../ProjectViewFactory.js", () => ({
  createView: mocks.createView,
  loadView: mocks.loadView,
  updateViewBounds: mocks.updateViewBounds,
}));

vi.mock("../ProjectViewLifecycleController.js", () => ({
  cleanupEntry: mocks.cleanupEntry,
  deactivateEntry: mocks.deactivateEntry,
}));

vi.mock("../ProjectViewHandlers.js", () => ({
  setupViewHandlers: mocks.setupViewHandlers,
}));

vi.mock("../webContentsRegistry.js", () => ({
  registerWebContents: mocks.registerWebContents,
  registerProjectView: mocks.registerProjectView,
  unregisterCachedViewWebContents: mocks.unregisterCachedViewWebContents,
}));

vi.mock("../ProjectViewEvictionController.js", () => ({
  evictStaleViews: mocks.evictStaleViews,
}));

import {
  ensureBackgroundView,
  finalizeBackgroundView,
} from "../ProjectViewBackgroundController.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function view(id: number) {
  return {
    webContents: {
      id,
      isDestroyed: vi.fn(() => false),
      close: vi.fn(),
    },
    setVisible: vi.fn(),
    setBounds: vi.fn(),
    webContentsViewFocusCanary: vi.fn(),
  };
}

function hostFixture() {
  const views = new Map();
  const reverse = new Map<number, string>();
  const win = {
    id: 7,
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    show: vi.fn(),
    contentView: {
      children: [] as unknown[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  };
  const windowRegistry = {
    registerAppViewWebContents: vi.fn(),
    unregisterAppViewWebContents: vi.fn(),
  };
  const host = {
    disposed: false,
    win,
    views,
    webContentsToProject: reverse,
    activeProjectId: "foreground-project",
    windowRegistry,
    viewLoadTimeoutMs: 10,
    viewLoadHardTimeoutMs: 20,
  } as unknown as ProjectViewManager;
  mocks.cleanupEntry.mockImplementation((_host: ProjectViewManager, projectId: string) => {
    const entry = views.get(projectId) as { view: ReturnType<typeof view> } | undefined;
    if (entry) reverse.delete(entry.view.webContents.id);
    views.delete(projectId);
  });
  return { host, views, reverse, win, windowRegistry };
}

describe("ProjectViewBackgroundController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadView.mockResolvedValue(undefined);
  });

  it("reuses a live active or cached entry without allocating another renderer", async () => {
    const f = hostFixture();
    const existing = view(10);
    f.views.set("project-target", {
      projectId: "project-target",
      projectPath: "/target",
      view: existing,
      lastUsed: 1,
      state: "active",
    });

    const result = await ensureBackgroundView(
      f.host,
      "project-target",
      "/target",
      new AbortController().signal
    );

    expect(result).toEqual({ view: existing, isNew: false });
    expect(mocks.createView).not.toHaveBeenCalled();
    expect(f.host.activeProjectId).toBe("foreground-project");
  });

  it("loads behind the foreground until readiness without focus or foreground mutation", async () => {
    const f = hostFixture();
    const created = view(11);
    const onBackgroundViewReady = vi.fn().mockResolvedValue(undefined);
    f.host.onBackgroundViewReady = onBackgroundViewReady;
    mocks.createView.mockReturnValue(created);

    const result = await ensureBackgroundView(f.host, "project-target", "/target");

    expect(result).toEqual({ view: created, isNew: true });
    expect(mocks.loadView).toHaveBeenCalledWith(created, "project-target", {
      softMs: 10,
      hardMs: 20,
    });
    expect(mocks.setupViewHandlers).toHaveBeenCalledOnce();
    expect(mocks.registerWebContents).toHaveBeenCalledWith(created.webContents, f.win);
    expect(f.windowRegistry.registerAppViewWebContents).toHaveBeenCalledWith(7, 11);
    expect(f.win.contentView.addChildView).toHaveBeenCalledWith(created, 0);
    expect(mocks.updateViewBounds).toHaveBeenCalledWith(f.host, created);
    expect(onBackgroundViewReady).toHaveBeenCalledWith(
      created.webContents,
      "project-target",
      "/target"
    );
    expect(created.setVisible).not.toHaveBeenCalled();
    expect(f.win.focus).not.toHaveBeenCalled();
    expect(f.win.show).not.toHaveBeenCalled();
    expect(f.host.activeProjectId).toBe("foreground-project");
    expect(f.views.get("project-target")).toMatchObject({ state: "cached" });
    expect(f.reverse.get(11)).toBe("project-target");
  });

  it("cancels an in-flight load and removes every owned registration", async () => {
    const f = hostFixture();
    const created = view(12);
    const load = deferred<void>();
    mocks.createView.mockReturnValue(created);
    mocks.loadView.mockReturnValue(load.promise);
    const controller = new AbortController();

    const materializing = ensureBackgroundView(
      f.host,
      "project-target",
      "/target",
      controller.signal
    );
    controller.abort();
    load.reject(new Error("destroyed"));

    await expect(materializing).rejects.toThrow("destroyed");
    expect(mocks.cleanupEntry).toHaveBeenCalledWith(f.host, "project-target");
    expect(f.views.has("project-target")).toBe(false);
    expect(f.reverse.has(12)).toBe(false);
    expect(f.host.activeProjectId).toBe("foreground-project");
  });

  it("does not tear down a replacement entry when cancellation races ownership transfer", async () => {
    const f = hostFixture();
    const created = view(14);
    const replacement = view(15);
    const load = deferred<void>();
    mocks.createView.mockReturnValue(created);
    mocks.loadView.mockReturnValue(load.promise);
    const controller = new AbortController();
    const materializing = ensureBackgroundView(
      f.host,
      "project-target",
      "/target",
      controller.signal
    );
    await Promise.resolve();
    const replacementEntry = {
      projectId: "project-target",
      projectPath: "/target",
      view: replacement,
      state: "cached",
    };
    f.views.set("project-target", replacementEntry);
    f.reverse.set(15, "project-target");

    controller.abort();
    load.reject(new Error("old load cancelled"));

    await expect(materializing).rejects.toThrow();
    expect(mocks.cleanupEntry).not.toHaveBeenCalled();
    expect(f.views.get("project-target")).toBe(replacementEntry);
    expect(f.reverse.get(15)).toBe("project-target");
  });

  it("finalizes only the exact detached generation and schedules bounded LRU enforcement", async () => {
    const f = hostFixture();
    const created = view(13);
    f.views.set("project-target", {
      projectId: "project-target",
      projectPath: "/target",
      view: created,
      state: "cached",
    });

    expect(finalizeBackgroundView(f.host, "project-target", 99)).toBe(false);
    expect(mocks.deactivateEntry).not.toHaveBeenCalled();
    expect(finalizeBackgroundView(f.host, "project-target", 13)).toBe(true);
    expect(mocks.deactivateEntry).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.evictStaleViews).toHaveBeenCalledWith(f.host, "lru");
    f.host.activeProjectId = "project-target";
    expect(finalizeBackgroundView(f.host, "project-target", 13)).toBe(false);
    expect(mocks.deactivateEntry).toHaveBeenCalledOnce();
  });
});
