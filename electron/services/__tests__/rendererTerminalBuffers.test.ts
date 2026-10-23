import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../ipc/channels.js", () => ({ CHANNELS: { EVENTS_PUSH: "events:push" } }));

import {
  collectRendererTerminalBuffers,
  composeRendererTerminalBufferSlice,
  RENDERER_BUFFER_SAMPLE_REUSE_MS,
  RENDERER_BUFFER_SAMPLE_TIMEOUT_MS,
  _resetRendererTerminalBuffersForTesting,
} from "../rendererTerminalBuffers.js";
import {
  recordRendererTerminalDiagnostics,
  _clearRendererTerminalDiagnosticsForTesting,
} from "../RendererTerminalDiagnosticsCache.js";

const RENDERING = {
  webglMode: "webgl" as const,
  wantsWebgl: 0,
  terminalCount: 1,
  countsByTier: {},
};

function report(id: number, sampledAt: number, normalLines = 10_000, cols = 182) {
  recordRendererTerminalDiagnostics(id, {
    ...RENDERING,
    bufferMemory: {
      sampledAt,
      terminals: [{ terminalId: `term-${id}`, normalLines, alternateLines: 0, cols }],
    },
  });
}

type FakeWc = { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };

function fakeView(
  id: number,
  projectId: string,
  state: "loading" | "active" | "cached",
  onSend?: (wc: FakeWc) => void
) {
  const wc: FakeWc = {
    id,
    isDestroyed: () => false,
    send: vi.fn(() => onSend?.(wc)),
  };
  return { projectId, state, view: { webContents: wc } };
}

function depsFor(views: ReturnType<typeof fakeView>[]) {
  return {
    projectViewManager: { getAllViews: () => views },
  } as never;
}

describe("rendererTerminalBuffers", () => {
  beforeEach(() => {
    _clearRendererTerminalDiagnosticsForTesting();
    _resetRendererTerminalBuffersForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("composeRendererTerminalBufferSlice", () => {
    it("estimates (normal + alternate) × cols × 12 per terminal and sums per view", () => {
      recordRendererTerminalDiagnostics(1, {
        ...RENDERING,
        bufferMemory: {
          sampledAt: 1_000_000,
          terminals: [
            { terminalId: "a", normalLines: 10_000, alternateLines: 0, cols: 182 },
            { terminalId: "b", normalLines: 30, alternateLines: 30, cols: 100 },
          ],
        },
      });

      const slice = composeRendererTerminalBufferSlice(
        [{ webContentsId: 1, windowId: 1, projectId: "p", state: "active" }],
        new Set([1]),
        1_000_000
      );

      expect(slice.views[0].terminals?.map((t) => t.estimatedBytes)).toEqual([
        10_000 * 182 * 12,
        60 * 100 * 12,
      ]);
      expect(slice.views[0].estimatedBytes).toBe(10_000 * 182 * 12 + 60 * 100 * 12);
      expect(slice.views[0].status).toBe("fresh");
      expect(slice.estimatedBytes).toBe(slice.views[0].estimatedBytes);
      expect(slice.complete).toBe(true);
    });

    it("reports a view that never reported as unavailable, never as zero", () => {
      report(1, 1_000_000);

      const slice = composeRendererTerminalBufferSlice(
        [
          { webContentsId: 1, windowId: 1, projectId: "p", state: "active" },
          { webContentsId: 2, windowId: 1, projectId: "q", state: "cached" },
        ],
        new Set([1]),
        1_000_000
      );

      expect(slice.views[1]).toMatchObject({
        status: "unavailable",
        estimatedBytes: null,
        terminals: null,
        sampledAt: null,
      });
      expect(slice.complete).toBe(false);
      expect(slice.estimatedBytes).toBe(10_000 * 182 * 12);
    });

    it("has no total at all when no view has reported", () => {
      const slice = composeRendererTerminalBufferSlice(
        [{ webContentsId: 2, windowId: 1, projectId: "q", state: "cached" }],
        new Set(),
        1_000_000
      );
      expect(slice.estimatedBytes).toBeNull();
    });

    it("counts an empty view as a real zero", () => {
      recordRendererTerminalDiagnostics(1, {
        ...RENDERING,
        bufferMemory: { sampledAt: 1_000_000, terminals: [] },
      });
      const slice = composeRendererTerminalBufferSlice(
        [{ webContentsId: 1, windowId: 1, projectId: "p", state: "active" }],
        new Set([1]),
        1_000_000
      );
      expect(slice.views[0]).toMatchObject({ status: "fresh", estimatedBytes: 0 });
      expect(slice.estimatedBytes).toBe(0);
    });

    it("marks a cached view's counts as last-known with their age", () => {
      report(2, 940_000);
      const slice = composeRendererTerminalBufferSlice(
        [{ webContentsId: 2, windowId: 1, projectId: "q", state: "cached" }],
        new Set(),
        1_000_000
      );
      expect(slice.views[0]).toMatchObject({ status: "last-known", ageMs: 60_000 });
    });
  });

  describe("collectRendererTerminalBuffers", () => {
    it("asks active views only and never sends to a cached view", async () => {
      const active = fakeView(1, "p", "active", () => report(1, Date.now()));
      const cached = fakeView(2, "q", "cached");
      report(2, 900_000);

      const slice = await collectRendererTerminalBuffers(depsFor([active, cached]));

      expect(active.view.webContents.send).toHaveBeenCalledWith("events:push", {
        name: "window:sample-terminal-buffers",
        payload: expect.objectContaining({ requestId: expect.any(String) }),
      });
      expect(cached.view.webContents.send).not.toHaveBeenCalled();
      expect(slice.views.map((v) => v.status)).toEqual(["fresh", "last-known"]);
    });

    it("falls back to last-known counts when an active view doesn't answer in time", async () => {
      report(1, 900_000);
      const silent = fakeView(1, "p", "active");

      const pending = collectRendererTerminalBuffers(depsFor([silent]));
      await vi.advanceTimersByTimeAsync(RENDERER_BUFFER_SAMPLE_TIMEOUT_MS);
      const slice = await pending;

      expect(slice.views[0]).toMatchObject({ status: "last-known", sampledAt: 900_000 });
    });

    it("reports an unanswering active view with no history as unavailable", async () => {
      const silent = fakeView(1, "p", "active");

      const pending = collectRendererTerminalBuffers(depsFor([silent]));
      await vi.advanceTimersByTimeAsync(RENDERER_BUFFER_SAMPLE_TIMEOUT_MS);
      const slice = await pending;

      expect(slice.views[0].status).toBe("unavailable");
      expect(slice.complete).toBe(false);
    });

    it("reuses a recent sample instead of asking again", async () => {
      const active = fakeView(1, "p", "active", () => report(1, Date.now()));

      await collectRendererTerminalBuffers(depsFor([active]));
      vi.advanceTimersByTime(RENDERER_BUFFER_SAMPLE_REUSE_MS - 1);
      await collectRendererTerminalBuffers(depsFor([active]));
      expect(active.view.webContents.send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await collectRendererTerminalBuffers(depsFor([active]));
      expect(active.view.webContents.send).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent collections into one request per view", async () => {
      const silent = fakeView(1, "p", "active");

      const first = collectRendererTerminalBuffers(depsFor([silent]));
      const second = collectRendererTerminalBuffers(depsFor([silent]));
      await vi.advanceTimersByTimeAsync(RENDERER_BUFFER_SAMPLE_TIMEOUT_MS);
      await Promise.all([first, second]);

      expect(silent.view.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("doesn't re-ask a view that stayed silent until the reuse window passes", async () => {
      const silent = fakeView(1, "p", "active");

      const first = collectRendererTerminalBuffers(depsFor([silent]));
      await vi.advanceTimersByTimeAsync(RENDERER_BUFFER_SAMPLE_TIMEOUT_MS);
      await first;
      await collectRendererTerminalBuffers(depsFor([silent]));

      expect(silent.view.webContents.send).toHaveBeenCalledTimes(1);
    });

    it("returns an empty, complete slice when no views are resident", async () => {
      const slice = await collectRendererTerminalBuffers(depsFor([]));
      expect(slice).toEqual({ views: [], estimatedBytes: 0, complete: true });
    });
  });
});
