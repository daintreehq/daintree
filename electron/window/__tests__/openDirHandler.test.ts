import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import type { WindowRegistry } from "../WindowRegistry.js";
import {
  installOpenDirConsumer,
  drainPendingOpenDirs,
  routeExternalOpen,
  routeProjectOpen,
  _resetOpenDirConsumerForTest,
  type OpenDirHandlerDeps,
  type ProjectOpenRouting,
} from "../openDirHandler.js";
import { openFolderInNewWindow } from "../newWindowOpen.js";
import {
  holdWindowForOpen,
  isWindowBound,
  markWindowReadyForOpens,
  reserveWindowForOpen,
  _resetWindowOpenStateForTest,
} from "../windowOpenState.js";
import { getProjectHistory, resetProjectHistory } from "../../services/ProjectHistoryService.js";

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
  visible: boolean;
  /** Fires the "show" listeners the router left, as createWindow's paint gate would. */
  paint: () => void;
}

/**
 * A registry of fake windows whose view managers report what the fake
 * `openDirectory` last put in them. Focus order is registration order reversed
 * unless a test reorders it, mirroring "newest window has focus".
 */
function makeWorld() {
  const windows: FakeWindow[] = [];
  const closed = new Set<string>();
  let nextId = 1;

  function add(
    opts: { active?: string | null; ready?: boolean; minimized?: boolean; visible?: boolean } = {}
  ) {
    const showListeners: Array<() => void> = [];
    const fake = {
      id: nextId++,
      active: opts.active ?? null,
      views: opts.active ? [opts.active] : [],
      destroyed: false,
      visible: opts.visible ?? true,
    } as FakeWindow;
    fake.paint = () => {
      fake.visible = true;
      for (const listener of showListeners.splice(0)) listener();
    };
    fake.win = {
      id: fake.id,
      isDestroyed: () => fake.destroyed,
      isMinimized: vi.fn(() => opts.minimized ?? false),
      isVisible: () => fake.visible,
      once: (event: string, listener: () => void) => {
        if (event === "show") showListeners.push(listener);
      },
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as FakeWindow["win"];
    windows.unshift(fake);
    // WindowRegistry.register hands every new window a fresh history.
    resetProjectHistory(fake.id);
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
  return { windows, closed, add, registry, byWin };
}

const idFor = (dirPath: string) => `id:${dirPath}`;

function makeDeps(world: ReturnType<typeof makeWorld>) {
  const deps = {
    resolveProject: vi.fn(async (dirPath: string) => ({ id: idFor(dirPath), path: dirPath })),
    // Mirrors handleDirectoryOpen: the switch lands, the row reopens, and the
    // window's history records it.
    openDirectory: vi.fn(async (dirPath: string, win: BrowserWindow) => {
      const fake = world.byWin(win);
      fake.active = idFor(dirPath);
      if (!fake.views.includes(fake.active)) fake.views.push(fake.active);
      world.closed.delete(fake.active);
      getProjectHistory(fake.id).record(fake.active);
    }),
    createWindowForPath: vi.fn(async (dirPath: string) => world.add({ active: idFor(dirPath) }).id),
    getWindowRegistry: () => world.registry,
    getPreference: () => "default" as const,
    isProjectClosed: (projectId: string) => world.closed.has(projectId),
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

    expect(outcome).toEqual({ kind: "created", windowId: 6 });
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

  it("keeps a window left on a git-init prompt for that folder", async () => {
    const world = makeWorld();
    const empty = world.add();
    const deps = makeDeps(world);
    deps.resolveProject.mockRejectedValue(new Error("NOT_A_GIT_REPO"));
    // handleDirectoryOpen shows the prompt and returns without binding anything.
    deps.openDirectory.mockResolvedValueOnce(undefined);

    await routeExternalOpen("/work/plain", deps);
    await routeExternalOpen("/work/other", deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/other");

    // The same folder again goes back to its prompt rather than a new window.
    await routeExternalOpen("/work/plain", deps);
    expect(deps.openDirectory).toHaveBeenLastCalledWith("/work/plain", empty.win);
    expect(deps.createWindowForPath).toHaveBeenCalledTimes(1);
  });

  it("frees an unbound window once it binds a workspace", async () => {
    const world = makeWorld();
    const empty = world.add();
    const deps = makeDeps(world);
    deps.openDirectory.mockResolvedValueOnce(undefined);
    await routeExternalOpen("/work/plain", deps);

    // The user picks a project in that window, then closes it back to the picker.
    empty.active = "picked";
    await routeExternalOpen("/work/picked-check", deps);
    empty.active = null;
    deps.createWindowForPath.mockClear();

    await routeExternalOpen("/work/next", deps);
    expect(deps.openDirectory).toHaveBeenLastCalledWith("/work/next", empty.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("retries a folder whose open threw in the window it failed in", async () => {
    const world = makeWorld();
    world.add();
    const deps = makeDeps(world);
    deps.openDirectory.mockRejectedValueOnce(new Error("boom"));

    await expect(routeExternalOpen("/work/a", deps)).rejects.toThrow("boom");
    await routeExternalOpen("/work/a", deps);
    // Any other folder still gets a window of its own.
    await routeExternalOpen("/work/b", deps);

    expect(deps.openDirectory).toHaveBeenCalledTimes(2);
    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/b");
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

describe("routeExternalOpen — owners and the picker", () => {
  it("reuses a window whose project was closed back to the picker", async () => {
    const world = makeWorld();
    const picker = world.add({ active: "was-open" });
    world.closed.add("was-open");
    world.add({ active: "busy" });
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/new", deps);

    expect(outcome).toEqual({ kind: "activated", windowId: picker.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/new", picker.win);
  });

  it("reopens a closed project in the window still holding its view instead of focusing the picker", async () => {
    const world = makeWorld();
    const picker = world.add({ active: idFor("/work/known") });
    world.closed.add(idFor("/work/known"));
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/known", deps);

    expect(outcome).toEqual({ kind: "activated", windowId: picker.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/known", picker.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("activates a cached view in the window that owns it", async () => {
    const world = makeWorld();
    const owner = world.add({ active: "front" });
    owner.views.push(idFor("/work/known"));
    world.add();
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/known", deps);

    expect(outcome).toEqual({ kind: "activated", windowId: owner.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/known", owner.win);
  });

  it("focuses a window whose open of the same folder is still in flight, without opening it again", async () => {
    const world = makeWorld();
    const deps = makeDeps(world);
    let created: FakeWindow | undefined;
    deps.createWindowForPath.mockImplementationOnce(async (dirPath) => {
      created = world.add();
      void holdWindowForOpen(
        created.id,
        { projectId: null, projectPath: dirPath },
        () => new Promise<void>(() => {}),
        () => false
      );
      return created.id;
    });

    await routeExternalOpen("/work/a", deps);
    const second = await routeExternalOpen("/work/a", deps);

    expect(second).toEqual({ kind: "focused", windowId: created!.id });
    expect(created!.win.focus).toHaveBeenCalled();
    expect(deps.createWindowForPath).toHaveBeenCalledTimes(1);
    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("waits for a window still behind its paint gate to show before focusing it", async () => {
    const world = makeWorld();
    const booting = world.add({ active: idFor("/work/known"), visible: false, ready: false });
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/known", deps);
    await routeExternalOpen("/work/known", deps);

    expect(outcome).toEqual({ kind: "focused", windowId: booting.id });
    expect(booting.win.show).not.toHaveBeenCalled();
    expect(booting.win.focus).not.toHaveBeenCalled();

    booting.paint();
    // Two opens, one focus: the second didn't stack another listener.
    expect(booting.win.focus).toHaveBeenCalledOnce();
    expect(booting.win.show).not.toHaveBeenCalled();
  });

  it("brings back a set-up window that is hidden with the app", async () => {
    const world = makeWorld();
    const hidden = world.add({ active: idFor("/work/known"), visible: false });
    const deps = makeDeps(world);

    await routeExternalOpen("/work/known", deps);

    expect(hidden.win.show).toHaveBeenCalledOnce();
    expect(hidden.win.focus).toHaveBeenCalledOnce();
  });

  it("focuses a restoring window claimed for the project instead of making a second view", async () => {
    const world = makeWorld();
    const restoring = world.add({ ready: false, visible: false });
    reserveWindowForOpen(restoring.id, { projectId: idFor("/work/known"), projectPath: null });
    const deps = makeDeps(world);

    const outcome = await routeExternalOpen("/work/known", deps);

    expect(outcome).toEqual({ kind: "focused", windowId: restoring.id });
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("frees a git-init window the user has since used and closed, with no external open in between", async () => {
    const world = makeWorld();
    const empty = world.add();
    const deps = makeDeps(world);
    deps.openDirectory.mockResolvedValueOnce(undefined);
    await routeExternalOpen("/work/plain", deps);

    // A project picked from that window's picker, then closed again: the view
    // manager is back to nothing, only the history saw it.
    getProjectHistory(empty.id).record("picked");

    await routeExternalOpen("/work/next", deps);
    expect(deps.openDirectory).toHaveBeenLastCalledWith("/work/next", empty.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });
});

describe("routeProjectOpen — an explicit new window (#12594)", () => {
  const newWindowFrom = (initiatingWindowId: number): ProjectOpenRouting => ({
    source: "in-app",
    disposition: "new",
    initiatingWindowId,
  });

  it("never lands in the window that asked, even when that window is empty", async () => {
    const world = makeWorld();
    const asking = world.add();
    const deps = makeDeps(world);

    const outcome = await routeProjectOpen("/work/new", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "created", windowId: asking.id + 1 });
    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/new");
    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(asking.active).toBeNull();
  });

  it("reuses an empty window other than the one that asked, and leaves the asker as it was", async () => {
    const world = makeWorld();
    const empty = world.add();
    const asking = world.add({ active: "running-agents" });
    const deps = makeDeps(world);

    const outcome = await routeProjectOpen("/work/new", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "activated", windowId: empty.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/new", empty.win);
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
    expect(asking.active).toBe("running-agents");
    expect(getProjectHistory(asking.id).current()).toBeNull();
  });

  it("still brings forward the window already showing the project instead", async () => {
    const world = makeWorld();
    const owner = world.add({ active: idFor("/work/known") });
    const asking = world.add({ active: "other" });
    world.add();
    const deps = makeDeps(world);

    const outcome = await routeProjectOpen("/work/known", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "focused", windowId: owner.id });
    expect(owner.win.focus).toHaveBeenCalled();
    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(deps.createWindowForPath).not.toHaveBeenCalled();
  });

  it("hands a live owner to the owner redirect, which focuses its project view", async () => {
    const world = makeWorld();
    const owner = world.add({ active: idFor("/work/known") });
    const asking = world.add({ active: "other" });
    const deps = { ...makeDeps(world), redirectToOwner: vi.fn(() => true) };

    const outcome = await routeProjectOpen("/work/known", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "focused", windowId: owner.id });
    expect(deps.redirectToOwner).toHaveBeenCalledExactlyOnceWith(
      { id: idFor("/work/known"), path: "/work/known" },
      owner.id
    );
    // The redirect did the revealing; the router didn't switch anything itself.
    expect(owner.win.focus).not.toHaveBeenCalled();
    expect(deps.openDirectory).not.toHaveBeenCalled();
  });

  it("lets the owner's own renderer switch to a view it holds cached", async () => {
    const world = makeWorld();
    const owner = world.add({ active: "front" });
    owner.views.push(idFor("/work/known"));
    const asking = world.add({ active: "other" });
    const deps = { ...makeDeps(world), redirectToOwner: vi.fn(() => true) };

    const outcome = await routeProjectOpen("/work/known", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "activated", windowId: owner.id });
    expect(deps.openDirectory).not.toHaveBeenCalled();
    expect(owner.active).toBe("front");
  });

  it("opens the project itself when the owner redirect declines, as for a closed project", async () => {
    const world = makeWorld();
    const picker = world.add({ active: idFor("/work/known") });
    world.closed.add(idFor("/work/known"));
    const asking = world.add({ active: "other" });
    const deps = { ...makeDeps(world), redirectToOwner: vi.fn(() => false) };

    const outcome = await routeProjectOpen("/work/known", newWindowFrom(asking.id), deps);

    expect(outcome).toEqual({ kind: "activated", windowId: picker.id });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/known", picker.win);
  });

  it("leaves external opens on the router's own owner handling", async () => {
    const world = makeWorld();
    const owner = world.add({ active: idFor("/work/known") });
    const deps = { ...makeDeps(world), redirectToOwner: vi.fn(() => true) };

    await routeExternalOpen("/work/known", deps);

    expect(deps.redirectToOwner).not.toHaveBeenCalled();
    expect(owner.win.focus).toHaveBeenCalled();
  });

  it("gives a folder with no repository its own window, where git init is offered", async () => {
    const world = makeWorld();
    const asking = world.add({ active: "busy" });
    const deps = makeDeps(world);
    deps.resolveProject.mockRejectedValueOnce(new Error("NOT_A_GIT_REPO"));

    await routeProjectOpen("/work/plain", newWindowFrom(asking.id), deps);

    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/plain");
    expect(asking.active).toBe("busy");
  });
});

describe("openFolderInNewWindow", () => {
  it("holds a request made before any window has installed the router, then routes it", async () => {
    const world = makeWorld();
    const asking = world.add({ active: "busy" });
    const deps = makeDeps(world);

    const early = openFolderInNewWindow("/work/early", asking.id);
    await Promise.resolve();
    expect(deps.createWindowForPath).not.toHaveBeenCalled();

    installOpenDirConsumer(deps);

    await expect(early).resolves.toEqual({ kind: "created", windowId: asking.id + 1 });
    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/early");
    expect(asking.active).toBe("busy");
  });

  it("fails a held request cleanly if routing is torn down before it arrives", async () => {
    const early = openFolderInNewWindow("/work/early", 1);

    _resetOpenDirConsumerForTest();

    await expect(early).rejects.toThrow("shut down");
  });

  it("routes as an explicit new window once installed", async () => {
    const world = makeWorld();
    const asking = world.add();
    const deps = makeDeps(world);
    installOpenDirConsumer(deps);

    const outcome = await openFolderInNewWindow("/work/a", asking.id);

    expect(outcome.kind).toBe("created");
    expect(deps.createWindowForPath).toHaveBeenCalledExactlyOnceWith("/work/a");
    expect(asking.active).toBeNull();
  });

  it("waits behind an external open already on the chain, so both can't claim one empty window", async () => {
    const world = makeWorld();
    const empty = world.add();
    const asking = world.add({ active: "busy" });
    const deps = makeDeps(world);
    let finishFirst: (() => void) | null = null;
    deps.openDirectory.mockImplementationOnce(async (dirPath, win) => {
      await new Promise<void>((resolve) => (finishFirst = resolve));
      world.byWin(win).active = idFor(dirPath);
    });
    const drop = captureConsumer();
    installOpenDirConsumer(deps);

    drop("/work/dropped");
    const inApp = openFolderInNewWindow("/work/mine", asking.id);
    await vi.waitFor(() => expect(deps.openDirectory).toHaveBeenCalledTimes(1));
    expect(deps.createWindowForPath).not.toHaveBeenCalled();

    finishFirst!();
    await expect(inApp).resolves.toEqual({ kind: "created", windowId: asking.id + 1 });
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/work/dropped", empty.win);
  });

  it("rejects to its caller when the open fails, and the chain keeps going", async () => {
    const world = makeWorld();
    const asking = world.add({ active: "busy" });
    const deps = makeDeps(world);
    deps.createWindowForPath.mockRejectedValueOnce(new Error("boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    installOpenDirConsumer(deps);

    await expect(openFolderInNewWindow("/work/a", asking.id)).rejects.toThrow("boom");
    await expect(openFolderInNewWindow("/work/b", asking.id)).resolves.toMatchObject({
      kind: "created",
    });
    errSpy.mockRestore();
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
    // A created window is ready once its setup returns, but its own open —
    // held the way windowServices holds it — lands later: exactly the window a
    // naive router would mistake for empty.
    const initialOpens: Array<() => void> = [];
    deps.createWindowForPath.mockImplementation(async (dirPath) => {
      const created = world.add();
      void holdWindowForOpen(
        created.id,
        { projectId: null, projectPath: dirPath },
        () =>
          new Promise<void>((resolve) =>
            initialOpens.push(() => {
              created.active = idFor(dirPath);
              created.views.push(created.active);
              resolve();
            })
          ),
        () => isWindowBound(world.registry, created.id)
      );
      return created.id;
    });
    envMock.getPendingOpenDirPaths.mockReturnValue(["/a", "/b", "/c"]);

    drainPendingOpenDirs(launch.win, deps);
    await vi.waitFor(() => expect(deps.createWindowForPath).toHaveBeenCalledTimes(2));

    expect(envMock.clearPendingOpenDirPaths).toHaveBeenCalledBefore(deps.resolveProject);
    expect(deps.openDirectory).toHaveBeenCalledExactlyOnceWith("/a", launch.win);
    expect(deps.createWindowForPath.mock.calls.map(([p]) => p)).toEqual(["/b", "/c"]);
    for (const finish of initialOpens) finish();
    expect(world.windows.map((w) => w.active).sort()).toEqual(["id:/a", "id:/b", "id:/c"]);

    // A fourth folder replaces none of them.
    await routeExternalOpen("/d", deps);
    expect(deps.createWindowForPath).toHaveBeenLastCalledWith("/d");
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
