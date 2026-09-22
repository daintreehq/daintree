import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { WindowRegistry } from "../WindowRegistry.js";
import {
  installOpenDirConsumer,
  drainPendingOpenDirs,
  routeExternalOpen,
  _resetOpenDirConsumerForTest,
  type OpenDirHandlerDeps,
} from "../openDirHandler.js";
import {
  markWindowReadyForOpens,
  reserveWindowForOpen,
  _resetWindowOpenStateForTest,
} from "../windowOpenState.js";

// Spy on the environment.ts queue primitives openDirHandler drives. Mocking the
// module keeps this test free of environment.ts's heavy main-process init while
// exercising the REAL routing — openDirHandler, the policy and the world
// snapshot — against a fake set of windows.
const envMock = vi.hoisted(() => ({
  getPendingOpenDirPaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenDirPaths: vi.fn(),
  setOpenDirConsumer: vi.fn(),
  queuePendingOpenDirPath: vi.fn(),
}));

vi.mock("../../setup/environment.js", () => envMock);
vi.mock("../../utils/logger.js", () => ({ logError: vi.fn() }));

interface FakeWindow {
  id: number;
  win: BrowserWindow & {
    isMinimized: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  active: string | null;
  views: string[];
  destroyed: boolean;
}

/**
 * A registry of fake windows whose view managers report what the fake
 * `openDirectory` last put in them. Focus order is registration order reversed
 * unless a test reorders it, mirroring "newest window has focus".
 */
function makeWorld() {
  const windows: FakeWindow[] = [];
  let nextId = 1;

  function add(opts: { active?: string | null; ready?: boolean; minimized?: boolean } = {}) {
    const fake = {
      id: nextId++,
      active: opts.active ?? null,
      views: opts.active ? [opts.active] : [],
      destroyed: false,
    } as FakeWindow;
    fake.win = {
      id: fake.id,
      isDestroyed: () => fake.destroyed,
      isMinimized: vi.fn(() => opts.minimized ?? false),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as FakeWindow["win"];
    windows.unshift(fake);
    if (opts.ready ?? true) markWindowReadyForOpens(fake.win);
    return fake;
  }

  function ctxOf(fake: FakeWindow) {
    return {
      windowId: fake.id,
      browserWindow: fake.win,
      services: {
        projectViewManager: {
          getActiveProjectId: () => fake.active,
          getOutgoingBridgeProjectId: () => null,
          getAllViews: () =>
            fake.views.map((projectId) => ({
              projectId,
              view: { webContents: { isDestroyed: () => false } },
            })),
        },
      },
    };
  }

  const registry = {
    focusOrder: () => windows.filter((w) => !w.destroyed).map(ctxOf),
    getByWindowId: (id: number) => {
      const fake = windows.find((w) => w.id === id && !w.destroyed);
      return fake ? ctxOf(fake) : undefined;
    },
  } as unknown as WindowRegistry;

  const byWin = (win: BrowserWindow) => windows.find((w) => w.win === win)!;
  return { windows, add, registry, byWin };
}

const idFor = (dirPath: string) => `id:${dirPath}`;

function makeDeps(world: ReturnType<typeof makeWorld>) {
  const deps = {
    resolveProject: vi.fn(async (dirPath: string) => ({ id: idFor(dirPath), path: dirPath })),
    openDirectory: vi.fn(async (dirPath: string, win: BrowserWindow) => {
      const fake = world.byWin(win);
      fake.active = idFor(dirPath);
      if (!fake.views.includes(fake.active)) fake.views.push(fake.active);
    }),
    createWindowForPath: vi.fn(async (dirPath: string) => {
      world.add({ active: idFor(dirPath) });
    }),
    getWindowRegistry: () => world.registry,
    getPreference: () => "default" as const,
  };
  return deps satisfies OpenDirHandlerDeps;
}

function captureConsumer(): (d: string) => void {
  let captured: ((d: string) => void) | null = null;
  envMock.setOpenDirConsumer.mockImplementation((c: (d: string) => void) => {
    captured = c;
  });
  return (d: string) => captured!(d);
}

beforeEach(() => {
  vi.clearAllMocks();
  envMock.getPendingOpenDirPaths.mockReturnValue([]);
  _resetOpenDirConsumerForTest();
  _resetWindowOpenStateForTest();
});

describe("routeExternalOpen (#12593 acceptance)", () => {
  it("opens a sixth window and leaves five occupied windows untouched", async () => {
    const world = makeWorld();
    const five = [1, 2, 3, 4, 5].map((n) => world.add({ active: `p${n}` }));
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/new", deps);

    expect(outcome).toEqual({ kind: "created" });
    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/new");
    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(five.map((w) => w.active)).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("fills the one empty window and brings it forward", async () => {
    const world = makeWorld();
    const empty = world.add({ minimized: true });
    world.add({ active: "busy" });
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/new", deps);

    expect(outcome).toEqual({ kind: "activated", windowId: empty.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/new", empty.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
    expect(empty.win.restore).toHaveBeenCalled();
    expect(empty.win.focus).toHaveBeenCalled();
  });

  it("creates one window when none are open", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);

    await routeExternalOpen("/work/new", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/new");
  });

  it("focuses the window already showing the project instead of opening it again", async () => {
    const world = makeWorld();
    const owner = world.add({ active: idFor("/work/known") });
    world.add({ active: "other" });
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/known", deps);

    expect(outcome).toEqual({ kind: "focused", windowId: owner.id });
    expect(owner.win.focus).toHaveBeenCalled();
    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("opens with the canonical project path the folder resolved to", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    deps.resolveProject.mockResolvedValueOnce({ id: "repo", path: "/work/repo" });

    await routeExternalOpen("/work/repo/child", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledWith("/work/repo");
  });

  it("still routes a folder that resolves to no project, so the target window can offer git init", async () => {
    const world = makeWorld();
    world.add({ active: "busy" });
    const deps = makeDeps(world);
    deps.resolveProject.mockRejectedValueOnce(new Error("NOT_A_GIT_REPO"));

    await routeExternalOpen("/work/plain", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/plain");
  });

  it("releases its claim on the target window when the open fails", async () => {
    const world = makeWorld();
    const empty = world.add();
    const deps = makeDeps(world);
    deps.openDirectory.mockRejectedValueOnce(new Error("boom"));

    await expect(routeExternalOpen("/work/a", deps)).rejects.toThrow("boom");
    // Unclaimed and still on the picker, so the next folder may take it.
    await routeExternalOpen("/work/b", deps);

    expect(deps.openDirectory).toHaveBeenLastCalledWith("/work/b", empty.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("does not take a window whose own initial open is still in flight", async () => {
    const world = makeWorld();
    const booting = world.add();
    reserveWindowForOpen(booting.id, { projectId: null, projectPath: "/work/initial" });
    const deps = makeDeps(world);

    await routeExternalOpen("/work/other", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/other");
    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("does not take a window that has not finished setting up", async () => {
    const world = makeWorld();
    world.add({ ready: false });
    const deps = makeDeps(world);

    await routeExternalOpen("/work/other", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/other");
  });
});

describe("installOpenDirConsumer", () => {
  it("registers a consumer exactly once (idempotent)", () => {
    const deps = makeDeps(makeWorld());
    installOpenDirConsumer(deps);
    installOpenDirConsumer(deps);
    expect(envMock.setOpenDirConsumer).toHaveBeenCalledTimes(1);
  });

  it("never lands a warm drop in the most recently focused occupied window", async () => {
    const world = makeWorld();
    world.add({ active: "older" });
    const focused = world.add({ active: "focused" });
    const deps = makeDeps(world);
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/work/dropped");
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledWith("/work/dropped"));

    expect(focused.active).toBe("focused");
    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("two quick drops into one empty window: the second gets its own window", async () => {
    const world = makeWorld();
    const empty = world.add();
    const deps = makeDeps(world);
    let finishFirst: (() => void) | null = null;
    deps.openDirectory.mockImplementationOnce(async (dirPath, win) => {
      await new Promise<void>((resolve) => (finishFirst = resolve));
      world.byWin(win).active = idFor(dirPath);
    });
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/work/a");
    drop("/work/b");
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(1));
    // The chain holds /b until /a has landed, so /b never sees the window as empty.
    expect(deps.createWindowForPath).not.toHaveBeenCalled();

    finishFirst!();
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledWith("/work/b"));
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/a", empty.win);
  });

  it("the same folder dropped twice opens once and focuses the second time", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    const drop = captureConsumer();

    installOpenDirConsumer(deps);
    drop("/work/a");
    drop("/work/a");
    await vi.waitFor(() => expect(world.windows).toHaveLength(1));
    await vi.waitFor(() => expect(world.windows[0].win.focus).toHaveBeenCalled());

    expect(deps.createWindowForPath).toHaveBeenCalledTimes(1);
  });

  it("a failed open is caught and logged, and the chain keeps going", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    deps.createWindowForPath.mockRejectedValueOnce(new Error("boom"));
    const drop = captureConsumer();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    installOpenDirConsumer(deps);
    drop("/work/a");
    drop("/work/b");
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledTimes(2));

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("drainPendingOpenDirs", () => {
  it("marks the window ready even when nothing is queued", async () => {
    const world = makeWorld();
    const launch = world.add({ ready: false });
    const deps = makeDeps(world);

    drainPendingOpenDirs(launch.win, deps);
    expect(envMock.clearPendingOpenDirPaths).not.toHaveBeenCalled();

    await routeExternalOpen("/work/a", deps);
    expect(deps.openDirectory).toHaveBeenCalledWith("/work/a", launch.win);
  });

  it("cold launch with three queued folders ends with three windows, not one", async () => {
    const world = makeWorld();
    const launch = world.add({ ready: false });
    const deps = makeDeps(world);
    // A created window reports ready at once but its own open lands later —
    // exactly the window a naive router would mistake for empty.
    const initialOpens: Array<() => void> = [];
    deps.createWindowForPath.mockImplementation(async (dirPath) => {
      const created = world.add();
      const release = reserveWindowForOpen(created.id, { projectId: null, projectPath: dirPath });
      initialOpens.push(() => {
        created.active = idFor(dirPath);
        created.views.push(created.active);
        release();
      });
    });
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b", "/c"]);

    drainPendingOpenDirs(launch.win, deps);
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledTimes(2));

    expect(envMock.clearPendingOpenDirPaths).toHaveBeenCalledBefore(deps.resolveProject);
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/a", launch.win);
    expect(deps.createWindowForPath.mock.calls.map(([p]) => p)).toEqual(["/b", "/c"]);
    for (const finish of initialOpens) finish();
    expect(world.windows.map((w) => w.active).sort()).toEqual(["id:/a", "id:/b", "id:/c"]);
  });

  it("warm drop mid-drain is serialized after the queued folders", async () => {
    const world = makeWorld();
    const launch = world.add({ ready: false });
    const deps = makeDeps(world);
    let finishA: (() => void) | null = null;
    deps.openDirectory.mockImplementationOnce(async (dirPath, win) => {
      await new Promise<void>((resolve) => (finishA = resolve));
      world.byWin(win).active = idFor(dirPath);
    });
    const drop = captureConsumer();
    installOpenDirConsumer(deps);
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b"]);

    drainPendingOpenDirs(launch.win, deps);
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(1));
    drop("/c");
    await Promise.resolve();
    expect(deps.resolveProject).toHaveBeenCalledTimes(1);

    finishA!();
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledTimes(2));
    expect(deps.resolveProject.mock.calls.map(([p]) => p)).toEqual(["/a", "/b", "/c"]);
    expect(deps.createWindowForPath.mock.calls.map(([p]) => p)).toEqual(["/b", "/c"]);
  });
});
