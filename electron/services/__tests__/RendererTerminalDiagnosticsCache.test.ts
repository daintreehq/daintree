import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  RENDERER_TERMINAL_STALE_MS,
  recordRendererTerminalDiagnostics,
  forgetRendererTerminalDiagnostics,
  getRendererTerminalDiagnosticsSamples,
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
});
