import { describe, expect, it } from "vitest";
import {
  cpuSeries,
  describeObservedAgents,
  describeProjects,
  describeSwap,
  pressureSeries,
  rankPlacement,
  type PlacementCandidate,
} from "../overviewModel";
import { makeSummary } from "./fixtures";

function candidate(
  hostId: string,
  overrides: Parameters<typeof makeSummary>[0] | null,
  reachable = true
): PlacementCandidate {
  return {
    hostId,
    name: hostId,
    summary: overrides === null ? null : makeSummary({ hostId, ...overrides }),
    reachable,
  };
}

describe("rankPlacement", () => {
  it("puts the least-loaded host first by CPU, memory pressure and working agents", () => {
    const ranked = rankPlacement([
      candidate("busy", { cpuPercent: 80, agentsObserved: { working: 3, waiting: 0, idle: 0 } }),
      candidate("pressured", {
        cpuPercent: 5,
        memoryPressure: "critical",
        agentsObserved: { working: 0, waiting: 0, idle: 0 },
      }),
      candidate("calm", { cpuPercent: 30, agentsObserved: { working: 1, waiting: 0, idle: 0 } }),
    ]);
    expect(ranked.map((choice) => choice.hostId)).toEqual(["calm", "pressured", "busy"]);
    expect(ranked[0]!.reason).toBe("CPU 30% · memory normal · 1 working (observed)");
  });

  it("leaves out hosts it can't compare or reach", () => {
    const ranked = rankPlacement([
      candidate("unmeasured", { cpuPercent: null, memoryPressure: null }),
      candidate("silent", null),
      candidate("away", { cpuPercent: 1 }, false),
      candidate("ok", { cpuPercent: 50 }),
    ]);
    expect(ranked.map((choice) => choice.hostId)).toEqual(["ok"]);
  });

  it("never lets a host with a missing measurement beat one that measured a light load", () => {
    const ranked = rankPlacement([
      // Reported only normal pressure: its CPU could be anything.
      candidate("pressure-only", {
        cpuPercent: null,
        memoryPressure: "normal",
        agentsObserved: { working: 0, waiting: 0, idle: 0 },
      }),
      candidate("measured", {
        cpuPercent: 5,
        memoryPressure: "normal",
        agentsObserved: { working: 0, waiting: 0, idle: 0 },
      }),
      candidate("cpu-only", {
        cpuPercent: 1,
        memoryPressure: null,
        agentsObserved: { working: 0, waiting: 0, idle: 0 },
      }),
      candidate("agents-unknown", {
        cpuPercent: 2,
        memoryPressure: "normal",
        agentsObserved: null,
      }),
    ]);
    expect(ranked[0]!.hostId).toBe("measured");
    expect(ranked.find((c) => c.hostId === "pressure-only")!.reason).toBe(
      "CPU not reported · memory normal · 0 working (observed)"
    );
    expect(ranked.find((c) => c.hostId === "agents-unknown")!.reason).toBe(
      "CPU 2% · memory normal · agents unknown"
    );
  });

  it("breaks ties toward the host that reported more, then by name", () => {
    const idle = { working: 0, waiting: 0, idle: 0 };
    const ranked = rankPlacement([
      candidate("b-full", { cpuPercent: 100, memoryPressure: "normal", agentsObserved: idle }),
      candidate("a-partial", { cpuPercent: null, memoryPressure: "normal", agentsObserved: idle }),
      candidate("a-full", { cpuPercent: 100, memoryPressure: "normal", agentsObserved: idle }),
    ]);
    expect(ranked.map((choice) => choice.hostId)).toEqual(["a-full", "b-full", "a-partial"]);
  });
});

describe("describeObservedAgents / describeProjects", () => {
  it("shows failed reads as unknown, never 0", () => {
    const unknown = makeSummary({ agentsObserved: null, projectCount: null, worktreeCount: null });
    expect(describeObservedAgents(unknown)).toBe("Agent activity unknown");
    expect(describeProjects(unknown)).toBe("Unknown");
    expect(describeProjects(makeSummary({ worktreeCount: null }))).toBe(
      "2 open · worktrees unknown"
    );
    expect(describeProjects(makeSummary())).toBe("2 open · 5 worktrees");
  });
});

describe("series", () => {
  it("draws oldest first and keeps unmeasured samples as gaps", () => {
    const history = [
      makeSummary({ sampledAt: 3, cpuPercent: 30, memoryPressure: "critical" }),
      makeSummary({ sampledAt: 2, cpuPercent: null, memoryPressure: null }),
      makeSummary({ sampledAt: 1, cpuPercent: 10, memoryPressure: "warn" }),
    ];
    expect(cpuSeries(history)).toEqual([10, null, 30]);
    expect(pressureSeries(history)).toEqual([50, null, 100]);
  });

  it("says nothing about swap a host doesn't report", () => {
    expect(describeSwap(makeSummary({ swapTotalBytes: null, swapUsedBytes: null }))).toBeNull();
    expect(describeSwap(makeSummary({ swapTotalBytes: 0 }))).toBe("No swap");
  });
});
