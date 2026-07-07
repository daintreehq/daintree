/**
 * paintSurface IPC namespace — env gating (fabric off → every op refuses),
 * lazy per-window manager/broker construction on WindowContext.services,
 * zod boundary validation, port-release-before-view-destroy ordering, and
 * the webgl-threshold push into the surface view's webContents.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { z } from "zod";

type RegisteredOp = {
  schema: z.ZodTypeAny | null;
  handler: (...args: unknown[]) => unknown;
  withContext: boolean;
};

const registered = vi.hoisted(() => new Map<string, RegisteredOp>());

// Substitute the typedHandle* layer with a capture harness that still runs
// the real zod parse, so ops are invokable directly with a hand-built ctx.
vi.mock("../utils.js", () => ({
  typedHandle: vi.fn((channel: string, handler: RegisteredOp["handler"]) => {
    registered.set(channel, { schema: null, handler, withContext: false });
    return () => registered.delete(channel);
  }),
  typedHandleValidated: vi.fn(
    (channel: string, schema: z.ZodTypeAny, handler: RegisteredOp["handler"]) => {
      registered.set(channel, { schema, handler, withContext: false });
      return () => registered.delete(channel);
    }
  ),
  typedHandleWithContext: vi.fn((channel: string, handler: RegisteredOp["handler"]) => {
    registered.set(channel, { schema: null, handler, withContext: true });
    return () => registered.delete(channel);
  }),
  typedHandleWithContextValidated: vi.fn(
    (channel: string, schema: z.ZodTypeAny, handler: RegisteredOp["handler"]) => {
      registered.set(channel, { schema, handler, withContext: true });
      return () => registered.delete(channel);
    }
  ),
}));

const managerInstances = vi.hoisted(() => [] as unknown[]);
const brokerInstances = vi.hoisted(() => [] as unknown[]);

// Function expressions (not arrows) so `new SurfaceViewManager(...)` works;
// a constructor returning an object substitutes it as the instance.
vi.mock("../../window/SurfaceViewManager.js", () => ({
  SurfaceViewManager: function SurfaceViewManager(deps: unknown) {
    const instance = {
      deps,
      createSurface: vi.fn(async (surfaceId: string) => ({
        surfaceId,
        webContentsId: 42,
        partition: `paint-surface:7:${surfaceId}:abcd`,
      })),
      destroySurface: vi.fn(async () => {}),
      setSurfaceBounds: vi.fn(),
      getWebContents: vi.fn(),
      dispose: vi.fn(async () => {}),
    };
    managerInstances.push(instance);
    return instance;
  },
}));

vi.mock("../../window/SurfacePortBroker.js", () => ({
  SurfacePortBroker: function SurfacePortBroker() {
    const instance = {
      brokerSurfacePort: vi.fn(() => 1073741825),
      rebrokerFromLast: vi.fn(),
      releaseSurfacePort: vi.fn(),
      dispose: vi.fn(),
    };
    brokerInstances.push(instance);
    return instance;
  },
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => ({ path: "/proj-live" })) },
}));

import { registerPaintFabricSurfaceHandlers } from "../handlers/paintFabricSurface.js";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { WindowContext } from "../../window/WindowRegistry.js";

type FakeManager = {
  deps: { win: unknown; dirname: string; onCrash?: (report: unknown) => void };
  createSurface: ReturnType<typeof vi.fn>;
  destroySurface: ReturnType<typeof vi.fn>;
  setSurfaceBounds: ReturnType<typeof vi.fn>;
  getWebContents: ReturnType<typeof vi.fn>;
};

type FakeBroker = {
  brokerSurfacePort: ReturnType<typeof vi.fn>;
  releaseSurfacePort: ReturnType<typeof vi.fn>;
};

function makeHarness() {
  const wctx = {
    windowId: 7,
    browserWindow: { id: 7 },
    projectPath: "/proj",
    services: { preloadDirname: "/app" },
  } as unknown as WindowContext;
  const deps = {
    windowRegistry: { getByWindowId: vi.fn(() => wctx) },
    ptyClient: {},
  } as unknown as HandlerDependencies;
  const cleanup = registerPaintFabricSurfaceHandlers(deps);
  const ctx = {
    event: {},
    webContentsId: 11,
    senderWindow: { id: 7 },
    projectId: "p1",
  } as unknown as IpcContext;

  async function invoke(channel: string, payload: unknown): Promise<unknown> {
    const op = registered.get(channel);
    if (!op) throw new Error(`channel not registered: ${channel}`);
    const parsed = op.schema ? op.schema.parse(payload) : payload;
    return op.handler(ctx, parsed);
  }

  return { wctx, deps, ctx, invoke, cleanup };
}

beforeEach(() => {
  registered.clear();
  managerInstances.length = 0;
  brokerInstances.length = 0;
  process.env.DAINTREE_PAINT_FABRIC = "1";
  process.env.DAINTREE_PAINT_FABRIC_VIEWS = "1";
});

afterEach(() => {
  delete process.env.DAINTREE_PAINT_FABRIC;
  delete process.env.DAINTREE_PAINT_FABRIC_VIEWS;
});

describe("registerPaintFabricSurfaceHandlers", () => {
  it("registers all four ops and the cleanup unregisters them", () => {
    const { cleanup } = makeHarness();
    expect([...registered.keys()].sort()).toEqual([
      CHANNELS.PAINT_SURFACE_APPLY_WEBGL_THRESHOLDS,
      CHANNELS.PAINT_SURFACE_CREATE,
      CHANNELS.PAINT_SURFACE_DESTROY,
      CHANNELS.PAINT_SURFACE_SET_BOUNDS,
    ]);
    cleanup();
    expect(registered.size).toBe(0);
  });

  it("refuses every op while the fabric flags are off", async () => {
    delete process.env.DAINTREE_PAINT_FABRIC_VIEWS;
    const { invoke } = makeHarness();
    await expect(invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" })).rejects.toThrow(
      /disabled/
    );
    expect(managerInstances).toHaveLength(0);
  });

  it("creates the per-window manager lazily and brokers a pty port for the new surface", async () => {
    const { invoke, wctx } = makeHarness();
    const result = await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" });
    expect(result).toMatchObject({ surfaceId: "s1", webContentsId: 42 });

    const manager = managerInstances[0] as FakeManager;
    expect(manager.deps.dirname).toBe("/app");
    expect(wctx.services.surfaceViewManager).toBe(manager);

    // getWebContents returned nothing in this run — no port brokered.
    expect(brokerInstances).toHaveLength(0);

    manager.getWebContents.mockReturnValue({ id: 42 });
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s2" });
    const broker = brokerInstances[0] as FakeBroker;
    // projectPath resolves from the sender's CURRENT project at call time,
    // not the registration-time WindowContext.projectPath.
    expect(broker.brokerSurfacePort).toHaveBeenCalledWith({
      surfaceId: "s2",
      wc: { id: 42 },
      projectId: "p1",
      projectPath: "/proj-live",
    });
    // The manager is per-window: the second create reused it.
    expect(managerInstances).toHaveLength(1);
  });

  it("destroys the just-created surface when port brokering fails", async () => {
    const { invoke, wctx } = makeHarness();
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" });
    const manager = wctx.services.surfaceViewManager as unknown as FakeManager;
    manager.getWebContents.mockReturnValue({ id: 42 });
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s2" });
    const broker = brokerInstances[0] as FakeBroker;
    broker.brokerSurfacePort.mockImplementation(() => {
      throw new Error("delivery failed");
    });

    await expect(invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s3" })).rejects.toThrow(
      /delivery failed/
    );
    expect(manager.destroySurface).toHaveBeenCalledWith("s3");
  });

  it("throws when the sender has no window or the window is unregistered", async () => {
    const { invoke, ctx, deps } = makeHarness();
    (ctx as { senderWindow: unknown }).senderWindow = null;
    await expect(invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" })).rejects.toThrow(
      /no owning window/
    );

    (ctx as { senderWindow: unknown }).senderWindow = { id: 9 };
    vi.mocked(deps.windowRegistry!.getByWindowId).mockReturnValue(undefined);
    await expect(invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" })).rejects.toThrow(
      /not registered/
    );
  });

  it("rejects malformed payloads at the zod boundary", async () => {
    const { invoke } = makeHarness();
    await expect(invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "" })).rejects.toThrow();
    await expect(
      invoke(CHANNELS.PAINT_SURFACE_SET_BOUNDS, {
        surfaceId: "s1",
        bounds: { x: 0, y: 0, width: -1, height: 10 },
      })
    ).rejects.toThrow();
    await expect(
      invoke(CHANNELS.PAINT_SURFACE_APPLY_WEBGL_THRESHOLDS, {
        surfaceId: "s1",
        upperThreshold: 99,
        lowerThreshold: 0,
      })
    ).rejects.toThrow();
  });

  it("delegates setSurfaceBounds and fails on a window with no surfaces yet", async () => {
    const { invoke, wctx } = makeHarness();
    await expect(
      invoke(CHANNELS.PAINT_SURFACE_SET_BOUNDS, {
        surfaceId: "s1",
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      })
    ).rejects.toThrow(/Unknown surface/);

    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" });
    await invoke(CHANNELS.PAINT_SURFACE_SET_BOUNDS, {
      surfaceId: "s1",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    });
    const manager = wctx.services.surfaceViewManager as unknown as FakeManager;
    expect(manager.setSurfaceBounds).toHaveBeenCalledWith("s1", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
  });

  it("destroy releases the pty port before destroying the view", async () => {
    const { invoke, wctx } = makeHarness();
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" });
    const manager = wctx.services.surfaceViewManager as unknown as FakeManager;
    manager.getWebContents.mockReturnValue({ id: 42 });
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s2" });
    const broker = brokerInstances[0] as FakeBroker;

    await invoke(CHANNELS.PAINT_SURFACE_DESTROY, { surfaceId: "s2" });
    expect(broker.releaseSurfacePort).toHaveBeenCalledWith("s2", { forgetContext: true });
    expect(manager.destroySurface).toHaveBeenCalledWith("s2");
    const releaseOrder = broker.releaseSurfacePort.mock.invocationCallOrder[0]!;
    const destroyOrder = manager.destroySurface.mock.invocationCallOrder[0]!;
    expect(releaseOrder).toBeLessThan(destroyOrder);
  });

  it("pushes webgl thresholds into the surface view's webContents", async () => {
    const { invoke, wctx } = makeHarness();
    await invoke(CHANNELS.PAINT_SURFACE_CREATE, { surfaceId: "s1" });
    const manager = wctx.services.surfaceViewManager as unknown as FakeManager;
    const wc = { id: 42, send: vi.fn() };
    manager.getWebContents.mockReturnValue(wc);

    const payload = { surfaceId: "s1", upperThreshold: 8, lowerThreshold: 6 };
    await invoke(CHANNELS.PAINT_SURFACE_APPLY_WEBGL_THRESHOLDS, payload);
    expect(wc.send).toHaveBeenCalledWith(CHANNELS.PAINT_SURFACE_WEBGL_THRESHOLDS, payload);

    manager.getWebContents.mockReturnValue(null);
    await expect(
      invoke(CHANNELS.PAINT_SURFACE_APPLY_WEBGL_THRESHOLDS, payload)
    ).rejects.toThrow(/Unknown surface/);
  });
});
