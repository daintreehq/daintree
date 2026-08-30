import { describe, expect, it, vi } from "vitest";

// Vitest resolves imports through Vite, so the fixture's Node loader hook
// never fires here. Hand the same stand-in to Vite's resolver instead, so the
// suite drives the identical seam the perf runner does.
vi.mock("electron", async () => (await import("../lib/projectViewFixture")).perfElectronStub);

import { allScenarios } from "../scenarios";
import type { ScenarioContext } from "../types";

const context: ScenarioContext = { mode: "smoke", now: () => performance.now() };

function scenario(id: string) {
  const found = allScenarios.find((candidate) => candidate.id === id);
  expect(found, `${id} is not registered`).toBeDefined();
  return found!;
}

/**
 * These guard that the scenarios are still driving the real machinery, not
 * that the numbers are fast. Each assertion pins a value the product decides:
 * if `ProjectViewManager` stopped cold-starting, stopped hitting its cache,
 * stopped evicting, or stopped honouring a protection floor, one of these
 * moves. A scenario that quietly began measuring nothing reports all-zero
 * counts, which is exactly what the lower bounds here reject.
 */
describe("project-view perf scenarios", () => {
  it("PERF-074 rotates inside the cache limit without cold-starting", async () => {
    const sample = await scenario("PERF-074").run(context);
    const metrics = sample.metrics!;

    // Eight rotation switches, every one served from cache.
    expect(metrics.warmSwitchCount).toBe(8);
    expect(metrics.coldStartCount).toBe(0);
    expect(metrics.viewCreateCount).toBe(0);
    // The paired reading: a cache hit that skipped its wake signal.
    expect(metrics.warmActivateSendCount).toBe(8);
    expect(metrics.warmSwitchMisses).toBe(0);
    expect(metrics.evictionCount).toBe(0);
    expect(metrics.residentViewCount).toBe(4);
    // Exactly one view attached — two is the duplicated-view regression,
    // zero is a reveal that never happened.
    expect(metrics.attachedViewCount).toBe(1);
    expect(metrics.attachMisses).toBe(0);
    expect(metrics.switchFailureCount).toBe(0);
  }, 30_000);

  it("PERF-075 cold-starts and evicts in LRU order under a two-view cache", async () => {
    const sample = await scenario("PERF-075").run(context);
    const metrics = sample.metrics!;

    // Six projects forward, five back: eleven switches, one of which the
    // two-view cache can still serve warm.
    expect(metrics.coldStartCount).toBe(10);
    expect(metrics.warmSwitchCount).toBe(1);
    expect(metrics.viewCreateCount).toBe(10);
    // Real evictions happened — a zero here would make every "misses" metric
    // below vacuously perfect.
    expect(metrics.evictionCount).toBeGreaterThan(0);
    expect(metrics.capOverflowCount).toBe(0);
    expect(metrics.residentViewCount).toBe(2);
    // Two independent oracles: the manager's own recency stamps, and the walk
    // order this scenario chose — which no product change can move.
    expect(metrics.lruOrderMisses).toBe(0);
    expect(metrics.lruRequestOrderMisses).toBe(0);
    // Every cold start ran the product's wrong-document bootstrap probe.
    expect(metrics.bootstrapProbeCount).toBe(metrics.coldStartCount);
    expect(metrics.bootstrapProbeMisses).toBe(0);
    expect(metrics.closeMisses).toBe(0);
    expect(metrics.listenerLeakCount).toBe(0);
    expect(metrics.attachedViewCount).toBe(1);
    expect(metrics.attachMisses).toBe(0);
  }, 30_000);

  it("PERF-076 sheds one view per pressure tick and holds the protection tiers", async () => {
    const sample = await scenario("PERF-076").run(context);
    const metrics = sample.metrics!;

    // Two sampler ticks deep in the band, one view each — never a collapse
    // (#11477), and never nothing (#11469).
    expect(metrics.pressureEvictionCount).toBe(2);
    expect(metrics.pressureLadderMisses).toBe(0);
    expect(metrics.pressureBudgetMisses).toBe(0);
    // A healthy reading must move nothing at all.
    expect(metrics.healthyBandMisses).toBe(0);
    // The soft tier: the two ordinary candidates go before the active-agent
    // view is touched at all.
    expect(metrics.agentTierOrderMisses).toBe(0);
    // The forced tier-2 pass then takes the remaining active-agent view.
    expect(metrics.forcedEvictionCount).toBe(1);
    expect(metrics.forcedReportMisses).toBe(0);
    // A forced pass that quietly became a no-op leaves a stray view here,
    // where forcedReportMisses would still read |0 - 0| = 0.
    expect(metrics.forcedConvergenceMisses).toBe(0);
    // Active view + the assistant-backed view, which no band admits (#11157).
    expect(metrics.residentAfterCollapseCount).toBe(2);
    expect(metrics.protectedEvictionMisses).toBe(0);
    expect(metrics.assistantFloorMisses).toBe(0);
    expect(metrics.closeMisses).toBe(0);
    expect(metrics.listenerLeakCount).toBe(0);
    expect(metrics.attachedViewCount).toBe(1);
    expect(metrics.attachMisses).toBe(0);
  }, 30_000);

  it("PERF-077 settles a queued switch burst on the last request", async () => {
    const sample = await scenario("PERF-077").run(context);
    const metrics = sample.metrics!;

    expect(metrics.switchRequestCount).toBe(5);
    // A, B, C, D cold; the queued return to A served from cache.
    expect(metrics.coldStartCount).toBe(4);
    expect(metrics.warmSwitchCount).toBe(1);
    expect(metrics.viewCreateCount).toBe(4);
    expect(metrics.finalActiveMisses).toBe(0);
    expect(metrics.residentViewCount).toBe(3);
    expect(metrics.capOverflowCount).toBe(0);
    expect(metrics.attachedViewCount).toBe(1);
    expect(metrics.attachMisses).toBe(0);
    expect(metrics.strandedViewCount).toBe(0);
    expect(metrics.closeMisses).toBe(0);
    expect(metrics.listenerLeakCount).toBe(0);
    expect(metrics.switchFailureCount).toBe(0);
  }, 30_000);

  it("every project-view metric is finite — run.ts throws otherwise", async () => {
    for (const id of ["PERF-074", "PERF-075", "PERF-076", "PERF-077"]) {
      const sample = await scenario(id).run(context);
      expect(Number.isFinite(sample.durationMs), `${id} durationMs`).toBe(true);
      for (const [name, value] of Object.entries(sample.metrics ?? {})) {
        expect(Number.isFinite(value), `${id}.${name} = ${value}`).toBe(true);
      }
    }
  }, 60_000);
});
