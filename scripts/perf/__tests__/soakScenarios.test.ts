import { describe, expect, it } from "vitest";
import { soakScenarios } from "../scenarios/soak";
import type { ScenarioContext } from "../types";

const context: ScenarioContext = { mode: "soak", now: () => performance.now() };

function scenario(id: string) {
  const found = soakScenarios.find((candidate) => candidate.id === id);
  expect(found, `${id} is not registered`).toBeDefined();
  return found!;
}

/**
 * PERF-060 and PERF-061 soaked `simulateLayoutHydration` /
 * `simulateProjectSwitchCycle`, so the allocation profile they measured was the
 * benchmark's own. They now churn the real layout merge and the real restore
 * builders. These guard that each cycle still runs and is still graded — a soak
 * that stopped churning holds its heap flat and posts the cleanest run on
 * record.
 */
describe("PERF-060/061 churn the real subjects", () => {
  it("PERF-060 runs every mixed cycle with a clean predicate", async () => {
    const found = scenario("PERF-060");
    const sample = await found.run(context);
    const metrics = sample.metrics!;

    for (const name of found.correctness!) {
      expect(metrics[name], `PERF-060.${name}`).toBe(0);
    }
    expect(metrics.checksum).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.memoryGrowthPct)).toBe(true);
    expect(sample.durationMs).toBeGreaterThan(0);
  }, 120_000);

  it("PERF-061 runs every churn cycle with a clean predicate", async () => {
    const found = scenario("PERF-061");
    const sample = await found.run(context);
    const metrics = sample.metrics!;

    for (const name of found.correctness!) {
      expect(metrics[name], `PERF-061.${name}`).toBe(0);
    }
    expect(metrics.checksum).toBeGreaterThan(0);
    expect(sample.durationMs).toBeGreaterThan(0);
  }, 120_000);
});
