import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  RENDERER_TERMINAL_STALE_MS,
  recordRendererTerminalDiagnostics,
  forgetRendererTerminalDiagnostics,
  getRendererTerminalDiagnosticsSamples,
  getRendererTerminalBufferSample,
  waitForRendererTerminalBufferSample,
  _clearRendererTerminalDiagnosticsForTesting,
} from "../RendererTerminalDiagnosticsCache.js";

const REPORT = {
  webglMode: "webgl" as const,
  wantsWebgl: 3,
  terminalCount: 5,
  countsByTier: { FOCUSED: 1, BACKGROUND: 4 },
};

describe("RendererTerminalDiagnosticsCache", () => {
  beforeEach(() => {
    _clearRendererTerminalDiagnosticsForTesting();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a sample keyed by webContents id", () => {
    recordRendererTerminalDiagnostics(42, REPORT);

    const samples = getRendererTerminalDiagnosticsSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      webContentsId: 42,
      webglMode: "webgl",
      wantsWebgl: 3,
      terminalCount: 5,
      countsByTier: { FOCUSED: 1, BACKGROUND: 4 },
    });
  });

  it("keeps one sample per webContents id (latest wins)", () => {
    recordRendererTerminalDiagnostics(42, REPORT);
    recordRendererTerminalDiagnostics(42, { ...REPORT, webglMode: "dom", terminalCount: 9 });

    const samples = getRendererTerminalDiagnosticsSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].webglMode).toBe("dom");
    expect(samples[0].terminalCount).toBe(9);
  });

  it("forgets a sample on view eviction", () => {
    recordRendererTerminalDiagnostics(1, REPORT);
    recordRendererTerminalDiagnostics(2, REPORT);

    forgetRendererTerminalDiagnostics(1);

    const samples = getRendererTerminalDiagnosticsSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0].webContentsId).toBe(2);
  });

  it("computes ageMs and flags stale samples past the threshold", () => {
    recordRendererTerminalDiagnostics(7, REPORT);

    const fresh = getRendererTerminalDiagnosticsSamples(1_000_000);
    expect(fresh[0].ageMs).toBe(0);
    expect(fresh[0].stale).toBe(false);

    const aged = getRendererTerminalDiagnosticsSamples(1_000_000 + RENDERER_TERMINAL_STALE_MS + 1);
    expect(aged[0].ageMs).toBe(RENDERER_TERMINAL_STALE_MS + 1);
    expect(aged[0].stale).toBe(true);
  });

  it("returns a copied snapshot array, not the live store", () => {
    recordRendererTerminalDiagnostics(1, REPORT);
    const first = getRendererTerminalDiagnosticsSamples();
    forgetRendererTerminalDiagnostics(1);
    // The earlier result must not be mutated by the later forget.
    expect(first).toHaveLength(1);
    expect(getRendererTerminalDiagnosticsSamples()).toHaveLength(0);
  });

  it("does not let a caller mutate the cached countsByTier map", () => {
    recordRendererTerminalDiagnostics(1, REPORT);

    const projection = getRendererTerminalDiagnosticsSamples();
    projection[0].countsByTier.FOCUSED = 999;

    // A fresh read must reflect the original recorded value, not the mutation.
    expect(getRendererTerminalDiagnosticsSamples()[0].countsByTier.FOCUSED).toBe(1);
  });

  describe("buffer counts (#14213)", () => {
    const BUFFERS = {
      sampledAt: 999_000,
      terminals: [{ terminalId: "t1", normalLines: 10_000, alternateLines: 0, cols: 182 }],
    };

    it("stores buffer counts apart from the rendering state, with the renderer's timestamp", () => {
      recordRendererTerminalDiagnostics(7, { ...REPORT, bufferMemory: BUFFERS });

      expect(getRendererTerminalBufferSample(7)).toEqual(BUFFERS);
      expect(getRendererTerminalDiagnosticsSamples()[0]).not.toHaveProperty("bufferMemory");
    });

    it("keeps the last buffer counts when a routine report carries none", () => {
      recordRendererTerminalDiagnostics(7, { ...REPORT, bufferMemory: BUFFERS });
      vi.advanceTimersByTime(60_000);
      recordRendererTerminalDiagnostics(7, REPORT);

      expect(getRendererTerminalBufferSample(7)?.sampledAt).toBe(999_000);
    });

    it("replaces the terminal list whole, so closed terminals drop out", () => {
      recordRendererTerminalDiagnostics(7, { ...REPORT, bufferMemory: BUFFERS });
      recordRendererTerminalDiagnostics(7, {
        ...REPORT,
        bufferMemory: { sampledAt: 1_000_000, terminals: [] },
      });

      expect(getRendererTerminalBufferSample(7)?.terminals).toEqual([]);
    });

    it("forgets buffer counts on eviction", () => {
      recordRendererTerminalDiagnostics(7, { ...REPORT, bufferMemory: BUFFERS });
      forgetRendererTerminalDiagnostics(7);

      expect(getRendererTerminalBufferSample(7)).toBeUndefined();
    });

    it("settles a waiter when the view reports buffer counts", async () => {
      const settled = vi.fn();
      void waitForRendererTerminalBufferSample(7, 1_000).then(settled);

      recordRendererTerminalDiagnostics(7, REPORT);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();

      recordRendererTerminalDiagnostics(7, { ...REPORT, bufferMemory: BUFFERS });
      await Promise.resolve();
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("settles a waiter on its deadline when the view never answers", async () => {
      const settled = vi.fn();
      void waitForRendererTerminalBufferSample(7, 1_000).then(settled);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledTimes(1);
    });

    it("settles a waiter when the view is forgotten", async () => {
      const settled = vi.fn();
      void waitForRendererTerminalBufferSample(7, 1_000).then(settled);

      forgetRendererTerminalDiagnostics(7);
      await Promise.resolve();
      expect(settled).toHaveBeenCalledTimes(1);
    });
  });
});
