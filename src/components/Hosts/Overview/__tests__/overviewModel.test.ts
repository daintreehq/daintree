import { describe, expect, it } from "vitest";
import type { HostDriverObservation } from "@shared/types/remoteHosts";
import { formatHostTime } from "../../hostTime";
import {
  cpuSeries,
  describeDriver,
  describeDriverDetail,
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

describe("describeDriver", () => {
  const NOW = new Date(2026, 9, 22, 11, 33, 0).getTime();
  const at = (h: number, m: number, sec: number) => new Date(2026, 9, 22, h, m, sec).getTime();

  function driven(
    projectName: string,
    clientId: string,
    clientName: string,
    acquiredAt: number,
    awayUntil: number | null = null,
    isHostLocal = false
  ): HostDriverObservation {
    return {
      projectId: projectName,
      projectName,
      holder: {
        leaseId: 1,
        endpointId: `${clientId}:e`,
        clientId,
        clientName,
        isHostLocal,
        acquiredAt,
      },
      state: awayUntil === null ? "live" : "away",
      awayUntil,
    };
  }

  it("names every launch that drives a project once, not just the newest", () => {
    const summary = makeSummary({
      sampledAt: NOW,
      drivers: [
        driven("site", "c2", "studio-02", at(11, 30, 0)),
        driven("daintree", "c1", "greg-mbp", at(11, 20, 0)),
        driven("docs", "c1", "greg-mbp", at(11, 10, 0)),
      ],
    });
    expect(describeDriver(summary)).toBe("Driven from studio-02 and greg-mbp");
  });

  it("tells two launches of one machine apart, and says which one is away", () => {
    const relaunched = at(11, 32, 41);
    const earlier = at(11, 27, 2);
    const summary = makeSummary({
      sampledAt: NOW,
      drivers: [
        driven("site", "launch-2", "Greg's Mac Studio", relaunched),
        driven("daintree", "launch-1", "Greg's Mac Studio", earlier, at(11, 32, 53)),
      ],
    });
    expect(describeDriver(summary)).toBe(
      `Driven from Greg's Mac Studio (since ${formatHostTime(relaunched, NOW)}) and Greg's Mac Studio (away, since ${formatHostTime(earlier, NOW)})`
    );
    expect(describeDriverDetail(summary)).toBe(
      `site: Greg's Mac Studio (since ${formatHostTime(relaunched, NOW)}); daintree: Greg's Mac Studio (since ${formatHostTime(earlier, NOW)}), away until ${formatHostTime(at(11, 32, 53), NOW)}`
    );
  });

  it("calls a launch away only when it is away from every project it holds", () => {
    const summary = makeSummary({
      sampledAt: NOW,
      drivers: [
        driven("site", "c1", "greg-mbp", at(11, 0, 0), at(11, 40, 0)),
        driven("daintree", "c1", "greg-mbp", at(11, 1, 0)),
        driven("docs", "local", "studio-01", at(11, 2, 0), null, true),
      ],
    });
    expect(describeDriver(summary)).toBe("Driven from greg-mbp and its own screen");
  });

  it("reads a host from before drivers by its newest holder, and nobody driving as nothing", () => {
    const holder = {
      leaseId: 1,
      endpointId: "e",
      clientId: "c",
      clientName: "greg-mbp",
      isHostLocal: false,
      acquiredAt: 1,
    };
    expect(describeDriver(makeSummary({ driver: holder }))).toBe("Driven from greg-mbp");
    expect(describeDriver(makeSummary({ driver: holder, drivers: null }))).toBe(
      "Driven from greg-mbp"
    );
    expect(describeDriver(makeSummary({ driver: null, drivers: [] }))).toBeNull();
    expect(describeDriverDetail(makeSummary({ driver: holder }))).toBeUndefined();
  });
});
