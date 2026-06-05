import { describe, expect, it } from "vitest";
import { allScenarios, assertMatrixCoverage, getScenariosForMode } from "../scenarios";

describe("perf scenario matrix", () => {
  it("covers full PERF matrix", () => {
    expect(() => assertMatrixCoverage()).not.toThrow();
    expect(allScenarios).toHaveLength(34);
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
    // Invariant: onWriteParsed must actually fire across the workload —
    // a 0 count would mean the coalesced event is dormant in this version.
    expect(sample.metrics!.parseInvocations).toBeGreaterThan(0);
    // Invariant: the last "log line" survives the parser (terminator present).
    expect(sample.metrics!.lastLineLength).toBeGreaterThan(0);
  });
});
