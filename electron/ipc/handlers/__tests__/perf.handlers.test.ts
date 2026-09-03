import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const appendedPayloads: unknown[] = [];

vi.mock("../../../utils/performance.js", () => ({
  isPerformanceCaptureEnabled: vi.fn(() => true),
  appendPayload: vi.fn((payload: unknown) => appendedPayloads.push(payload)),
  rebaseRendererElapsedMs: vi.fn(
    (rendererTimeOrigin: number, rendererT0: number, elapsedMs: number) =>
      rendererTimeOrigin + rendererT0 + elapsedMs - (1_000_000 + 10)
  ),
  APP_BOOT_T0: 10,
  mainTimeOrigin: 1_000_000,
}));

import { registerPerfHandlers } from "../perf.js";
import type { HandlerDependencies } from "../../types.js";

type FlushHandler = (event: Electron.IpcMainEvent, payload: unknown) => void;

function makeEvent(id = 42, destroyed = false): Electron.IpcMainEvent {
  return {
    sender: {
      id,
      isDestroyed: () => destroyed,
    },
  } as unknown as Electron.IpcMainEvent;
}

function getHandler(): FlushHandler {
  return ipcMainMock.on.mock.calls[0][1] as FlushHandler;
}

describe("registerPerfHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appendedPayloads.length = 0;
  });

  it("registers a listener on PERF_FLUSH_RENDERER_MARKS", () => {
    const cleanup = registerPerfHandlers();
    expect(ipcMainMock.on).toHaveBeenCalledTimes(1);
    expect(ipcMainMock.on).toHaveBeenCalledWith("perf:flush-renderer-marks", expect.any(Function));
    cleanup();
    expect(ipcMainMock.removeListener).toHaveBeenCalledTimes(1);
  });

  it("rebases renderer marks and appends them", () => {
    registerPerfHandlers();
    const handler = getHandler();

    handler(makeEvent(), {
      marks: [
        {
          mark: "hydrate_start",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 100,
          meta: { switchId: null },
        },
        {
          mark: "hydrate_complete",
          timestamp: "2026-01-01T00:00:01.000Z",
          elapsedMs: 500,
        },
      ],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(appendedPayloads).toHaveLength(2);

    const first = appendedPayloads[0] as Record<string, unknown>;
    expect(first.mark).toBe("hydrate_start");
    expect(first.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect((first.meta as Record<string, unknown>).source).toBe("renderer");
    expect((first.meta as Record<string, unknown>).originalElapsedMs).toBe(100);
    expect((first.meta as Record<string, unknown>).switchId).toBe(null);

    const second = appendedPayloads[1] as Record<string, unknown>;
    expect(second.mark).toBe("hydrate_complete");
    expect((second.meta as Record<string, unknown>).source).toBe("renderer");
  });

  it("tags each rebased record with the sender's webContents id", () => {
    registerPerfHandlers();
    const handler = getHandler();

    handler(makeEvent(7), {
      marks: [{ mark: "hydrate_start", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 100 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    const record = appendedPayloads[0] as Record<string, unknown>;
    expect((record.meta as Record<string, unknown>).webContentsId).toBe(7);
  });

  it("stamps each record with the sender view's project id via the per-window manager", () => {
    const deps = {
      projectViewManager: { getProjectIdForWebContents: () => "proj-static" },
      windowRegistry: {
        getByWebContentsId: (id: number) =>
          id === 22
            ? {
                services: {
                  projectViewManager: {
                    getProjectIdForWebContents: (wcId: number) =>
                      wcId === 22 ? "proj-window-b" : null,
                  },
                },
              }
            : undefined,
      },
    } as unknown as HandlerDependencies;

    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(22), {
      marks: [
        {
          mark: "project_switch.pty_port_ready",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 100,
          meta: { switchId: "abc" },
        },
      ],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    const record = appendedPayloads[0] as Record<string, unknown>;
    expect((record.meta as Record<string, unknown>).projectId).toBe("proj-window-b");
    expect((record.meta as Record<string, unknown>).switchId).toBe("abc");
  });

  it("omits projectId when no manager knows the sender", () => {
    const deps = {
      projectViewManager: { getProjectIdForWebContents: () => null },
    } as unknown as HandlerDependencies;
    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(5), {
      marks: [{ mark: "hydrate_start", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 1 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    const record = appendedPayloads[0] as Record<string, unknown>;
    expect(record.meta as Record<string, unknown>).not.toHaveProperty("projectId");
  });

  it("omits webContents id when the sender is destroyed", () => {
    registerPerfHandlers();
    const handler = getHandler();

    handler(makeEvent(7, /* destroyed */ true), {
      marks: [{ mark: "hydrate_start", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 100 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    const record = appendedPayloads[0] as Record<string, unknown>;
    expect((record.meta as Record<string, unknown>).webContentsId).toBeUndefined();
  });

  it("forwards the preload eval duration to ProjectViewManager keyed by webContents id", () => {
    const recordPreloadDuration = vi.fn();
    const deps = {
      projectViewManager: { recordPreloadDuration },
    } as unknown as HandlerDependencies;

    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(99), {
      marks: [
        { mark: "preload.eval:start", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 0 },
        {
          mark: "preload.eval:end",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 12,
          meta: { durationMs: 12 },
        },
      ],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(recordPreloadDuration).toHaveBeenCalledTimes(1);
    expect(recordPreloadDuration).toHaveBeenCalledWith(99, 12);
  });

  it("routes the preload duration to the per-window ProjectViewManager via the registry", () => {
    const recordA = vi.fn();
    const recordB = vi.fn();
    const contexts: Record<
      number,
      { services: { projectViewManager: { recordPreloadDuration: typeof recordA } } }
    > = {
      11: { services: { projectViewManager: { recordPreloadDuration: recordA } } },
      22: { services: { projectViewManager: { recordPreloadDuration: recordB } } },
    };
    const deps = {
      // Static dep points at window A; the registry must override it for B.
      projectViewManager: { recordPreloadDuration: recordA },
      windowRegistry: {
        getByWebContentsId: (id: number) => contexts[id],
      },
    } as unknown as HandlerDependencies;

    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(22), {
      marks: [
        {
          mark: "preload.eval:end",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 9,
          meta: { durationMs: 9 },
        },
      ],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(recordB).toHaveBeenCalledWith(22, 9);
    expect(recordA).not.toHaveBeenCalled();
  });

  it("forwards the preload duration only once when a flush carries duplicate eval:end marks", () => {
    const recordPreloadDuration = vi.fn();
    const deps = {
      projectViewManager: { recordPreloadDuration },
    } as unknown as HandlerDependencies;

    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(99), {
      marks: [
        {
          mark: "preload.eval:end",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 12,
          meta: { durationMs: 12 },
        },
        {
          mark: "preload.eval:end",
          timestamp: "2026-01-01T00:00:00.000Z",
          elapsedMs: 13,
          meta: { durationMs: 13 },
        },
      ],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(recordPreloadDuration).toHaveBeenCalledTimes(1);
    expect(recordPreloadDuration).toHaveBeenCalledWith(99, 12);
  });

  it("does not forward a preload duration when the eval:end mark lacks a numeric durationMs", () => {
    const recordPreloadDuration = vi.fn();
    const deps = {
      projectViewManager: { recordPreloadDuration },
    } as unknown as HandlerDependencies;

    registerPerfHandlers(deps);
    const handler = getHandler();

    handler(makeEvent(99), {
      marks: [{ mark: "preload.eval:end", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 12 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(recordPreloadDuration).not.toHaveBeenCalled();
  });

  it("does not crash when no ProjectViewManager is wired", () => {
    registerPerfHandlers();
    const handler = getHandler();

    expect(() =>
      handler(makeEvent(99), {
        marks: [
          {
            mark: "preload.eval:end",
            timestamp: "2026-01-01T00:00:00.000Z",
            elapsedMs: 12,
            meta: { durationMs: 12 },
          },
        ],
        rendererTimeOrigin: 1_000_100,
        rendererT0: 5,
      })
    ).not.toThrow();
  });

  it("no-ops when capture is disabled", async () => {
    const { isPerformanceCaptureEnabled } = await import("../../../utils/performance.js");
    (isPerformanceCaptureEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    registerPerfHandlers();
    const handler = getHandler();

    handler(makeEvent(), {
      marks: [{ mark: "test", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 50 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(appendedPayloads).toHaveLength(0);
  });

  it("handles invalid payload gracefully", () => {
    registerPerfHandlers();
    const handler = getHandler();

    handler(makeEvent(), null);
    handler(makeEvent(), { marks: "not-an-array" });
    handler(makeEvent(), undefined);

    expect(appendedPayloads).toHaveLength(0);
  });
});
