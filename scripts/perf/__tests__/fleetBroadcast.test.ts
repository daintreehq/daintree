import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PanelInstance } from "../../../shared/types/panel";
import { buildFleet, loadFleetEligibility } from "../lib/fleetBroadcastFixture";
import { fleetBroadcastScenarios } from "../scenarios/fleetBroadcast";

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIO_SOURCE = resolve(here, "../scenarios/fleetBroadcast.ts");
const context = { mode: "smoke" as const, now: () => performance.now() };

describe("fleet eligibility is the real predicate", () => {
  it("loads isTerminalFleetEligible out of src/store/fleetEligibility.ts", async () => {
    const { isTerminalFleetEligible } = await loadFleetEligibility();
    expect(typeof isTerminalFleetEligible).toBe("function");
  }, 60_000);

  it("accepts a live grid terminal and rejects one panel per rejection clause", async () => {
    const { isTerminalFleetEligible } = await loadFleetEligibility();
    const check = (panel: unknown): boolean =>
      isTerminalFleetEligible(panel as unknown as PanelInstance);

    const live = {
      id: "t",
      worktreeId: "w",
      kind: "terminal",
      location: "grid",
      hasPty: true,
      runtimeStatus: "running",
    };
    expect(check(live)).toBe(true);
    // Legacy undefined location is still a grid member.
    expect(check({ ...live, location: undefined })).toBe(true);
    expect(check({ ...live, location: "dock" })).toBe(false);
    expect(check({ ...live, kind: "browser" })).toBe(false);
    expect(check({ ...live, hasPty: false })).toBe(false);
    expect(check({ ...live, runtimeStatus: "exited" })).toBe(false);
    expect(check({ ...live, runtimeStatus: "error" })).toBe(false);
    expect(check(undefined)).toBe(false);
  }, 60_000);

  it("builds an armed set whose eligible count is fixture arithmetic", async () => {
    const { isTerminalFleetEligible } = await loadFleetEligibility();
    const panels = buildFleet(24, 12, 150);
    expect(panels).toHaveLength(36);
    const kept = panels.filter((panel) =>
      isTerminalFleetEligible(panel as unknown as PanelInstance)
    );
    expect(kept).toHaveLength(24);
  }, 60_000);

  it("keeps the retired hand-mirror out of the scenario file", () => {
    // The mirror this replaced re-implemented the gate inline. A copy of a
    // predicate cannot regress when the predicate does, so its return is worth
    // a cheap source guard rather than a rediscovery in six months.
    const source = readFileSync(SCENARIO_SOURCE, "utf8");
    expect(source).toContain("loadFleetEligibility");
    expect(source).not.toContain("isGridPanelLocation");
    expect(source).not.toContain('runtimeStatus === "exited"');
  });
});

describe.each(fleetBroadcastScenarios.map((scenario) => [scenario.id, scenario] as const))(
  "%s",
  (_id, scenario) => {
    it("fans out with every paired reading at zero", async () => {
      const sample = await scenario.run(context);
      const metrics = sample.metrics as Record<string, number>;
      for (const name of scenario.correctness ?? []) {
        expect(metrics[name], name).toBe(0);
      }
      expect(sample.durationMs).toBeGreaterThan(0);
      expect(sample.notes).toBeUndefined();
    }, 60_000);

    it("declares one paired reading per operation in the timed bracket", () => {
      expect(scenario.correctness).toEqual([
        "eligibilityMisses",
        "substitutionMisses",
        "dispatchMisses",
      ]);
    });
  }
);

describe("PERF-150 target count", () => {
  it("dispatches to exactly the 24 live grid terminals the fixture built", async () => {
    const scenario = fleetBroadcastScenarios.find((s) => s.id === "PERF-150")!;
    const sample = await scenario.run(context);
    const metrics = sample.metrics as Record<string, number>;
    expect(metrics.eligibleTargets).toBe(24);
    expect(metrics.totalPanels).toBe(36);
    // 24 substituted payloads, each carrying its own worktree and panel id.
    expect(metrics.ackBytes).toBeGreaterThan(24 * 40);
  }, 60_000);
});
