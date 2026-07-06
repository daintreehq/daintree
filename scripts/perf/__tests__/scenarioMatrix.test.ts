import { describe, expect, it } from "vitest";
import { allScenarios, assertMatrixCoverage, getScenariosForMode } from "../scenarios";

describe("perf scenario matrix", () => {
  it("covers full PERF matrix", () => {
    expect(() => assertMatrixCoverage()).not.toThrow();
    expect(allScenarios).toHaveLength(35);
  });

  it("returns mode-specific scenario sets", () => {
    const smoke = getScenariosForMode("smoke");
    const ci = getScenariosForMode("ci");
    const nightly = getScenariosForMode("nightly");
    const soak = getScenariosForMode("soak");

    expect(smoke.length).toBeGreaterThan(0);
    expect(ci.length).toBeGreaterThan(smoke.length - 1);
    expect(nightly.length).toBeGreaterThanOrEqual(ci.length);
    expect(soak.length).toBeGreaterThan(0);
  });

  it("has unique scenario IDs", () => {
    const ids = allScenarios.map((scenario) => scenario.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("PERF-080 returns valid metrics and fixture meets size threshold", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-080");
    expect(scenario).toBeDefined();

    const context = { mode: "ci" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    expect(sample.metrics!.terminalCount).toBeGreaterThan(0);
    expect(sample.metrics!.bytes).toBeGreaterThan(0);
  });

  it("PERF-033 write-to-parse scenario drives a real headless terminal", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-033");
    expect(scenario).toBeDefined();

    const context = { mode: "ci" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // 33 KiB crossing + 4 KiB steady + 100 small lines (~26 bytes each) = ~39600
    expect(sample.metrics!.bytesWritten).toBeGreaterThan(39_000);
    // Each sequential write fires onWriteParsed once it drains. 3 writes
    // => at least 3 invocations (would catch coalescing/buffering regressions).
    expect(sample.metrics!.parseInvocations).toBeGreaterThanOrEqual(3);
    // Length of "log entry 99 from agent terminal" = 32. The last write
    // is the log stream, so the last line must be the final log entry.
    expect(sample.metrics!.lastLineLength).toBeGreaterThanOrEqual(32);
  });

  it("PERF-034 parse-isolation scenario produces solo and flood echo brackets", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-034");
    expect(scenario).toBeDefined();

    const context = { mode: "smoke" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // Both brackets must have measured real write-to-parse latencies.
    expect(sample.metrics!.soloEchoP99Ms).toBeGreaterThan(0);
    expect(sample.metrics!.floodEchoP99Ms).toBeGreaterThan(0);
    expect(sample.metrics!.echoDegradationX).toBeGreaterThan(0);
    expect(Number.isFinite(sample.metrics!.echoDegradationX)).toBe(true);
    // 12 background terminals × 30 rounds × ~1.8 KB chunks — if this shrinks,
    // the flood stopped flooding and the degradation signal is meaningless.
    expect(sample.metrics!.floodBytes).toBeGreaterThan(500_000);
  });
});
