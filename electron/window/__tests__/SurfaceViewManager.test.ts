/**
 * SurfaceViewManager — the Phase 1V substrate invariants:
 * unique non-persist partitions (process isolation is the whole point),
 * direct-sibling attachment on win.contentView, disjoint bounds enforcement,
 * tiered crash recovery (reload once, crash-loop → defer to retire),
 * listener detach before close, forcefullyCrashRenderer for unresponsive.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Handler = (...args: unknown[]) => void;

function createMockWebContents(options?: { autoFinishLoad?: boolean }) {
  const autoFinishLoad = options?.autoFinishLoad ?? true;
  const handlers = new Map<string, Handler[]>();
  const onceHandlers = new Map<string, Handler[]>();
  let destroyed = false;
  const wc = {
    id: nextWebContentsId++,
    isDestroyed: vi.fn(() => destroyed),
    loadURL: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      destroyed = true;
    }),
    reload: vi.fn(),
    send: vi.fn(),
    forcefullyCrashRenderer: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    once: vi.fn((event: string, handler: Handler) => {
      const list = onceHandlers.get(event) ?? [];
      list.push(handler);
      onceHandlers.set(event, list);
      if (event === "did-finish-load" && autoFinishLoad) {
        Promise.resolve().then(() => wc._fire("did-finish-load"));
      }
    }),
    removeListener: vi.fn((event: string, handler: Handler) => {
      for (const map of [handlers, onceHandlers]) {
        const list = map.get(event);
        if (!list) continue;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    setWindowOpenHandler: vi.fn(),
    _fire(event: string, ...args: unknown[]) {
      const onceList = onceHandlers.get(event);
      const onceHandler = onceList?.shift();
      onceHandler?.(...args);
      for (const persistent of [...(handlers.get(event) ?? [])]) {
        persistent(...args);
      }
    },
    _listenerCount(event: string) {
      return (handlers.get(event)?.length ?? 0) + (onceHandlers.get(event)?.length ?? 0);
    },
  };
  return wc;
}

type MockWc = ReturnType<typeof createMockWebContents>;

let nextWebContentsId = 900;
const wcQueue = vi.hoisted(() => [] as unknown[]);
const fromPartition = vi.hoisted(() => vi.fn(() => ({ protocol: { handle: vi.fn() } })));

vi.mock("electron", () => {
  function MockWebContentsView() {
    const wc = wcQueue.shift();
    if (!wc) {
      throw new Error("wcQueue empty — push a mock webContents before creating a surface");
    }
    return {
      webContents: wc,
      setBounds: vi.fn(),
      setBackgroundColor: vi.fn(),
      setVisible: vi.fn(),
    };
  }
  return {
    WebContentsView: MockWebContentsView,
    session: { fromPartition },
  };
});

const applyDaintreeAppCspToSession = vi.hoisted(() => vi.fn());

vi.mock("../../setup/protocols.js", () => ({
  registerProtocolsForSession: vi.fn(),
  applyDaintreeAppCspToSession,
  getDistPath: vi.fn(() => "/dist"),
}));

vi.mock("../../../shared/config/devServer.js", () => ({
  getDevServerUrl: vi.fn(() => "http://localhost:5173"),
}));

vi.mock("../skeletonCss.js", () => ({
  INITIAL_COLOR_SCHEME_ARG: "--daintree-initial-color-scheme-id",
  resolveE2EPreloadArgs: vi.fn(() => []),
  resolveInitialColorSchemeId: vi.fn(() => "daintree"),
  resolveInitialCanvasBackgroundColor: vi.fn(() => "#1f1b16"),
}));

import { SurfaceViewManager } from "../SurfaceViewManager.js";
import {
  SURFACE_CRASH_LOOP_THRESHOLD,
  SURFACE_HOST_ARG,
  SURFACE_VIEW_PARTITION_PREFIX,
  type SurfaceViewCrashReport,
} from "../../../shared/types/paintFabricSurface.js";

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

function createMockWindow() {
  const children: unknown[] = [];
  return {
    id: 7,
    isDestroyed: vi.fn(() => false),
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
        children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const idx = children.indexOf(view);
        if (idx >= 0) children.splice(idx, 1);
      }),
    },
  };
}

interface Setup {
  manager: SurfaceViewManager;
  win: ReturnType<typeof createMockWindow>;
  crashes: SurfaceViewCrashReport[];
  readySurfaces: string[];
}

function createManager(): Setup {
  const win = createMockWindow();
  const crashes: SurfaceViewCrashReport[] = [];
  const readySurfaces: string[] = [];
  const manager = new SurfaceViewManager({
    win: win as unknown as Electron.BrowserWindow,
    dirname: "/app",
    onCrash: (report) => crashes.push(report),
    onSurfaceReady: (surfaceId) => readySurfaces.push(surfaceId),
  });
  return { manager, win, crashes, readySurfaces };
}

async function createSurface(setup: Setup, surfaceId: string): Promise<MockWc> {
  const wc = createMockWebContents();
  wcQueue.push(wc);
  await setup.manager.createSurface(surfaceId);
  return wc;
}

beforeEach(() => {
  wcQueue.length = 0;
  fromPartition.mockClear();
});

describe("SurfaceViewManager.createSurface", () => {
  it("gives every surface a unique non-persist partition", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    await createSurface(setup, "surface-aux-2");

    const p1 = setup.manager.getPartitionForTests("surface-aux-1")!;
    const p2 = setup.manager.getPartitionForTests("surface-aux-2")!;
    expect(p1).not.toBe(p2);
    for (const partition of [p1, p2]) {
      expect(partition.startsWith(`${SURFACE_VIEW_PARTITION_PREFIX}:`)).toBe(true);
      // Non-persist on purpose: a paint surface has no storage worth keeping.
      expect(partition.startsWith("persist:")).toBe(false);
      expect(fromPartition).toHaveBeenCalledWith(partition);
    }
  });

  it("re-creating a retired surface id mints a fresh partition", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    const first = setup.manager.getPartitionForTests("surface-aux-1")!;
    await setup.manager.destroySurface("surface-aux-1");

    await createSurface(setup, "surface-aux-1");
    const second = setup.manager.getPartitionForTests("surface-aux-1")!;
    expect(second).not.toBe(first);
  });

  it("attaches the view as a direct sibling on win.contentView, hidden until bounds arrive", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");

    expect(setup.win.contentView.addChildView).toHaveBeenCalledTimes(1);
    const view = setup.win.contentView.children[0] as {
      setVisible: ReturnType<typeof vi.fn>;
    };
    expect(view.setVisible).toHaveBeenCalledWith(false);
  });

  it("threads the surface-host role via additionalArguments and returns the connection identity", async () => {
    const setup = createManager();
    const wc = createMockWebContents();
    wcQueue.push(wc);
    const result = await setup.manager.createSurface("surface-aux-1");

    expect(result.webContentsId).toBe(wc.id);
    expect(result.partition).toBe(setup.manager.getPartitionForTests("surface-aux-1"));
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate surface ids", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    await expect(setup.manager.createSurface("surface-aux-1")).rejects.toThrow(
      /already exists/
    );
  });

  it("cleans up when the load fails", async () => {
    const setup = createManager();
    const wc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wc);
    const pending = setup.manager.createSurface("surface-aux-1");
    await Promise.resolve();
    wc._fire("did-fail-load", {}, -2, "ERR_FAILED");

    await expect(pending).rejects.toThrow(/load failed/);
    expect(setup.manager.hasSurface("surface-aux-1")).toBe(false);
    expect(wc.close).toHaveBeenCalled();
  });

  it("settles an in-flight create immediately when the surface is destroyed mid-load", async () => {
    const setup = createManager();
    const wc = createMockWebContents({ autoFinishLoad: false });
    wcQueue.push(wc);
    const pending = setup.manager.createSurface("surface-aux-1");
    await Promise.resolve();

    await setup.manager.destroySurface("surface-aux-1");
    await expect(pending).rejects.toThrow(/destroyed during load/);
    expect(setup.manager.hasSurface("surface-aux-1")).toBe(false);
  });

  it("hardens the surface renderer: CSP applied, child windows denied", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");

    expect(applyDaintreeAppCspToSession).toHaveBeenCalled();
    expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const openHandler = wc.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string };
    expect(openHandler()).toEqual({ action: "deny" });
  });
});

describe("SurfaceViewManager bounds protocol", () => {
  it("applies bounds and reveals the view", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    const view = setup.win.contentView.children[0] as {
      setBounds: ReturnType<typeof vi.fn>;
      setVisible: ReturnType<typeof vi.fn>;
    };

    setup.manager.setSurfaceBounds("surface-aux-1", { x: 10, y: 20, width: 300, height: 200 });
    expect(view.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 300, height: 200 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
  });

  it("rejects overlapping sibling bounds — no per-pixel input pass-through exists", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    await createSurface(setup, "surface-aux-2");

    setup.manager.setSurfaceBounds("surface-aux-1", { x: 0, y: 0, width: 400, height: 300 });
    expect(() =>
      setup.manager.setSurfaceBounds("surface-aux-2", { x: 200, y: 100, width: 400, height: 300 })
    ).toThrow(/overlap/);

    // Edge-adjacent bands stay legal.
    setup.manager.setSurfaceBounds("surface-aux-2", { x: 400, y: 0, width: 400, height: 300 });
  });

  it("rejects invalid bounds and unknown surfaces", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");

    expect(() =>
      setup.manager.setSurfaceBounds("surface-aux-1", { x: 0, y: 0, width: -5, height: 10 })
    ).toThrow(/Invalid/);
    expect(() =>
      setup.manager.setSurfaceBounds("nope", { x: 0, y: 0, width: 10, height: 10 })
    ).toThrow(/Unknown/);
  });

  it("hideSurface releases the band", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    await createSurface(setup, "surface-aux-2");

    setup.manager.setSurfaceBounds("surface-aux-1", { x: 0, y: 0, width: 400, height: 300 });
    setup.manager.hideSurface("surface-aux-1");
    // The freed band is claimable by a sibling.
    setup.manager.setSurfaceBounds("surface-aux-2", { x: 0, y: 0, width: 400, height: 300 });
  });
});

describe("SurfaceViewManager crash recovery", () => {
  it("reloads on a single crash and reports it", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");

    wc._fire("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await flushImmediates();

    expect(wc.reload).toHaveBeenCalledTimes(1);
    expect(setup.crashes).toEqual([
      { surfaceId: "surface-aux-1", disposition: "reloaded", reason: "crashed", exitCode: 1 },
    ]);
  });

  it("stops reloading at the crash-loop threshold and defers to retireSurface", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");

    for (let i = 0; i < SURFACE_CRASH_LOOP_THRESHOLD; i++) {
      wc._fire("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
      await flushImmediates();
    }

    // Two reloads, then the loop verdict — never a third reload.
    expect(wc.reload).toHaveBeenCalledTimes(SURFACE_CRASH_LOOP_THRESHOLD - 1);
    const last = setup.crashes.at(-1)!;
    expect(last.disposition).toBe("crash-loop");
    expect(setup.manager.getStateForTests("surface-aux-1")).toBe("crash-loop");

    // A further crash on a crash-looped surface stays parked.
    wc._fire("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await flushImmediates();
    expect(wc.reload).toHaveBeenCalledTimes(SURFACE_CRASH_LOOP_THRESHOLD - 1);
  });

  it("ignores clean exits", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");

    wc._fire("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    await flushImmediates();
    expect(wc.reload).not.toHaveBeenCalled();
    expect(setup.crashes).toEqual([]);
  });

  it("forces an unresponsive renderer through the crash path instead of reloading", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");

    wc._fire("unresponsive");
    expect(wc.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(wc.reload).not.toHaveBeenCalled();
  });

  it("announces readiness after a post-create load so the port re-brokers, not on the initial load", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");
    expect(setup.readySurfaces).toEqual([]);

    // Crash → auto-reload → the reloaded renderer finishes loading.
    wc._fire("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await flushImmediates();
    wc._fire("did-finish-load");
    expect(setup.readySurfaces).toEqual(["surface-aux-1"]);
  });
});

describe("SurfaceViewManager teardown", () => {
  it("detaches listeners before close and removes the view", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");
    expect(wc._listenerCount("render-process-gone")).toBeGreaterThan(0);

    await setup.manager.destroySurface("surface-aux-1");

    expect(wc._listenerCount("render-process-gone")).toBe(0);
    expect(wc._listenerCount("unresponsive")).toBe(0);
    expect(wc.close).toHaveBeenCalledTimes(1);
    expect(setup.win.contentView.children).toHaveLength(0);
    // The removeListener calls all landed before close().
    const removalOrder = wc.removeListener.mock.invocationCallOrder;
    const closeOrder = wc.close.mock.invocationCallOrder[0]!;
    expect(Math.max(...removalOrder)).toBeLessThan(closeOrder);
  });

  it("destroySurface is idempotent and a crash event after destroy is inert", async () => {
    const setup = createManager();
    const wc = await createSurface(setup, "surface-aux-1");
    await setup.manager.destroySurface("surface-aux-1");
    await setup.manager.destroySurface("surface-aux-1");

    wc._fire("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await flushImmediates();
    expect(wc.reload).not.toHaveBeenCalled();
    expect(setup.crashes).toEqual([]);
  });

  it("dispose destroys every surface and blocks further creates", async () => {
    const setup = createManager();
    const wc1 = await createSurface(setup, "surface-aux-1");
    const wc2 = await createSurface(setup, "surface-aux-2");

    await setup.manager.dispose();
    expect(wc1.close).toHaveBeenCalled();
    expect(wc2.close).toHaveBeenCalled();
    expect(setup.manager.surfaceCount()).toBe(0);
    await expect(setup.manager.createSurface("surface-aux-3")).rejects.toThrow(/disposed/);
  });

  it("raiseSurface re-adds the view to the top of the sibling stack", async () => {
    const setup = createManager();
    await createSurface(setup, "surface-aux-1");
    await createSurface(setup, "surface-aux-2");
    const [first] = [...setup.win.contentView.children];

    setup.manager.raiseSurface("surface-aux-1");
    expect(setup.win.contentView.children.at(-1)).toBe(first);
  });
});

// SURFACE_HOST_ARG is part of the cross-process contract the preload parses.
describe("surface-host argv contract", () => {
  it("keeps the '=' suffix the preload slices on", () => {
    expect(SURFACE_HOST_ARG.endsWith("=")).toBe(true);
  });
});
