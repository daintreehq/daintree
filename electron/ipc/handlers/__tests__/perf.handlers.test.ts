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
    const handler = ipcMainMock.on.mock.calls[0][1];

    handler({} as Electron.IpcMainEvent, {
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

  it("no-ops when capture is disabled", async () => {
    const { isPerformanceCaptureEnabled } = await import("../../../utils/performance.js");
    (isPerformanceCaptureEnabled as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);

    registerPerfHandlers();
    const handler = ipcMainMock.on.mock.calls[0][1];

    handler({} as Electron.IpcMainEvent, {
      marks: [{ mark: "test", timestamp: "2026-01-01T00:00:00.000Z", elapsedMs: 50 }],
      rendererTimeOrigin: 1_000_100,
      rendererT0: 5,
    });

    expect(appendedPayloads).toHaveLength(0);
  });

  it("handles invalid payload gracefully", () => {
    registerPerfHandlers();
    const handler = ipcMainMock.on.mock.calls[0][1];

    handler({} as Electron.IpcMainEvent, null);
    handler({} as Electron.IpcMainEvent, { marks: "not-an-array" });
    handler({} as Electron.IpcMainEvent, undefined);

    expect(appendedPayloads).toHaveLength(0);
  });
});
