import { describe, expect, it } from "vitest";
import type { HostDriverObservation } from "@shared/types/remoteHosts";
import { formatHostTime } from "../../hostTime";
import {
  busyCores,
  cpuSeries,
  describeCoreClusters,
  describeCpu,
  describeCpuPressure,
  describeLoad,
  describeMemoryCapacity,
  describeDriver,
  describeDriverDetail,
  describeObservedAgents,
  describeProjects,
  describeSwap,
  memoryUsedSeries,
  pressureSeries,
  compareHostCapacity,
  type PlacementCandidate,
} from "../overviewModel";
import { makeCapacitySummary, makeSummary } from "./fixtures";

function candidate(
  hostId: string,
  overrides: Parameters<typeof makeSummary>[0] | null,
  reachable = true
): PlacementCandidate {
  return {
    hostId,
    name: hostId,
    summary: overrides === null ? null : makeCapacitySummary({ hostId, ...overrides }),
    reachable,
  };
}

const GB = 1024 ** 3;

describe("compareHostCapacity", () => {
  it("suggests the host with strictly more free cores and available memory than every other", () => {
    const { suggestedHostId } = compareHostCapacity([
      candidate("busy", { cpuPercent: 80, memoryUsedBytes: 12 * GB }),
      candidate("calm", { cpuPercent: 10, memoryUsedBytes: 2 * GB }),
      candidate("middling", { cpuPercent: 40, memoryUsedBytes: 6 * GB }),
    ]);
    expect(suggestedHostId).toBe("calm");
  });

  it("weighs free cores, not CPU share: a bigger host at a higher share can lead", () => {
    const { suggestedHostId } = compareHostCapacity([
      candidate("small", { cpuPercent: 10, cpuLogicalCoreCount: 4, memoryUsedBytes: 8 * GB }),
      candidate("big", { cpuPercent: 50, cpuLogicalCoreCount: 32, memoryUsedBytes: 4 * GB }),
    ]);
    expect(suggestedHostId).toBe("big");
  });

  it("suggests nothing when no host leads on both free cores and available memory", () => {
    const { suggestedHostId } = compareHostCapacity([
      candidate("cores", { cpuPercent: 5, memoryUsedBytes: 12 * GB }),
      candidate("memory", { cpuPercent: 60, memoryUsedBytes: 2 * GB }),
    ]);
    expect(suggestedHostId).toBeNull();
  });

  it("treats equal memory, or core counts that display alike, as no lead", () => {
    expect(
      compareHostCapacity([
        candidate("a", { cpuPercent: 10, memoryUsedBytes: 4 * GB }),
        candidate("b", { cpuPercent: 60, memoryUsedBytes: 4 * GB }),
      ]).suggestedHostId
    ).toBeNull();
    expect(
      compareHostCapacity([
        candidate("a", { cpuPercent: 10, memoryUsedBytes: 2 * GB }),
        candidate("b", { cpuPercent: 10.2, memoryUsedBytes: 8 * GB }),
      ]).suggestedHostId
    ).toBeNull();
  });

  it("breaks the tie only past the displayed precision, whatever the float arithmetic says", () => {
    const lead = (cpuPercent: number) =>
      compareHostCapacity([
        candidate("a", { cpuPercent, memoryUsedBytes: 2 * GB }),
        candidate("b", { cpuPercent: 30, memoryUsedBytes: 8 * GB }),
      ]).suggestedHostId;
    // 8 cores: 0.625% of CPU is exactly 0.05 cores.
    expect(lead(30 - 0.625)).toBeNull();
    expect(lead(30 - 0.7)).toBe("a");
  });

  it("suggests nothing for a single host", () => {
    expect(compareHostCapacity([candidate("only", {})]).suggestedHostId).toBeNull();
  });

  it("lists every candidate with its facts, in the order given", () => {
    const { options } = compareHostCapacity([
      candidate("b", { cpuPercent: 50, memoryUsedBytes: 4 * GB, cpuLoadAverage1m: 3.5 }),
      candidate("silent", null),
      candidate("away", { cpuPercent: 1 }, false),
    ]);
    expect(options.map((option) => option.hostId)).toEqual(["b", "silent", "away"]);
    expect(options[0]!.facts).toBe(
      "CPU 4 of 8 cores · Memory 4 / 16 GB · Memory pressure Normal · Load (1 min) 3.50"
    );
    expect(options[1]!.facts).toBe("No measurements reported");
    expect(options[2]!.facts).toBe("Not connected");
  });

  it("ignores hosts it can't reach or hear from when looking for a lead", () => {
    const { suggestedHostId } = compareHostCapacity([
      candidate("away", { cpuPercent: 1, memoryUsedBytes: 0 }, false),
      candidate("silent", null),
      candidate("calm", { cpuPercent: 10, memoryUsedBytes: 2 * GB }),
      candidate("busy", { cpuPercent: 70, memoryUsedBytes: 9 * GB }),
    ]);
    expect(suggestedHostId).toBe("calm");
  });

  it.each([
    ["CPU", { cpuPercent: null }],
    ["pressure", { memoryPressure: null }],
    ["memory", { memoryUsedBytes: null }],
    ["core count", { cpuLogicalCoreCount: null }],
  ] as const)("withholds the suggestion while a compared host didn't report its %s", (_, gap) => {
    const { suggestedHostId, options } = compareHostCapacity([
      candidate("calm", { cpuPercent: 5, memoryUsedBytes: 1 * GB }),
      candidate("busy", { cpuPercent: 70, memoryUsedBytes: 12 * GB }),
      candidate("partial", { memoryUsedBytes: 12 * GB, ...gap }),
    ]);
    expect(suggestedHostId).toBeNull();
    expect(options).toHaveLength(3);
  });

  it("lists an older host with what it reported but never compares it", () => {
    const older: PlacementCandidate = {
      hostId: "older",
      name: "older",
      summary: makeSummary({ hostId: "older", cpuPercent: 90 }),
      reachable: true,
    };
    const { suggestedHostId, options } = compareHostCapacity([
      candidate("calm", { cpuPercent: 5, memoryUsedBytes: 1 * GB }),
      candidate("busy", { cpuPercent: 70, memoryUsedBytes: 12 * GB }),
      older,
    ]);
    expect(suggestedHostId).toBeNull();
    expect(options[2]!.facts).toBe("CPU 90% · Memory 4 GB of 16 GB · Memory pressure Normal");
  });

  it("never suggests a host under critical pressure, or one under worse pressure than a peer", () => {
    expect(
      compareHostCapacity([
        candidate("a", { cpuPercent: 5, memoryUsedBytes: 1 * GB, memoryPressure: "critical" }),
        candidate("b", { cpuPercent: 50, memoryUsedBytes: 8 * GB, memoryPressure: "critical" }),
      ]).suggestedHostId
    ).toBeNull();
    expect(
      compareHostCapacity([
        candidate("a", { cpuPercent: 5, memoryUsedBytes: 1 * GB, memoryPressure: "warn" }),
        candidate("b", { cpuPercent: 50, memoryUsedBytes: 8 * GB, memoryPressure: "normal" }),
      ]).suggestedHostId
    ).toBeNull();
    expect(
      compareHostCapacity([
        candidate("a", { cpuPercent: 5, memoryUsedBytes: 1 * GB, memoryPressure: "warn" }),
        candidate("b", { cpuPercent: 50, memoryUsedBytes: 8 * GB, memoryPressure: "warn" }),
      ]).suggestedHostId
    ).toBe("a");
  });

  it("is not moved by observed agents or the load average", () => {
    const base = [
      candidate("calm", { cpuPercent: 5, memoryUsedBytes: 1 * GB }),
      candidate("busy", { cpuPercent: 70, memoryUsedBytes: 9 * GB }),
    ];
    const noisy = [
      candidate("calm", {
        cpuPercent: 5,
        memoryUsedBytes: 1 * GB,
        cpuLoadAverage1m: 40,
        agentsObserved: { working: 9, waiting: 0, idle: 0 },
      }),
      candidate("busy", { cpuPercent: 70, memoryUsedBytes: 9 * GB, agentsObserved: null }),
    ];
    expect(compareHostCapacity(noisy).suggestedHostId).toBe(
      compareHostCapacity(base).suggestedHostId
    );
    expect(compareHostCapacity(noisy).suggestedHostId).toBe("calm");
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

  it("charts memory in use as a share of total, with a gap where either is missing", () => {
    const GB = 1024 ** 3;
    const current = { cpuLogicalCoreCount: 14 };
    const history = [
      makeSummary({ ...current, memoryUsedBytes: 9 * GB, memoryTotalBytes: 36 * GB }),
      makeSummary({ ...current, memoryUsedBytes: null }),
      makeSummary({ ...current, memoryUsedBytes: 4 * GB, memoryTotalBytes: null }),
      // From before the host counted used memory as Activity Monitor does.
      makeSummary({ memoryUsedBytes: 30 * GB, memoryTotalBytes: 36 * GB }),
      makeSummary({ ...current, memoryUsedBytes: 18 * GB, memoryTotalBytes: 36 * GB }),
    ];
    expect(memoryUsedSeries(history)).toEqual([50, null, null, null, 25]);
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

describe("capacity", () => {
  const GB = 1024 ** 3;

  it("reads CPU as busy cores of the count the host reports", () => {
    const summary = makeSummary({ cpuPercent: 45.7, cpuLogicalCoreCount: 14 });
    expect(busyCores(summary)!.busy).toBeCloseTo(6.398);
    expect(describeCpu(summary)).toBe("6.4 of 14 cores");
    expect(describeCpu(makeSummary({ cpuPercent: 0.2, cpuLogicalCoreCount: 8 }))).toBe(
      "<0.1 of 8 cores"
    );
  });

  it("keeps the percentage for a host that doesn't report its core count", () => {
    expect(describeCpu(makeSummary({ cpuPercent: 42.4 }))).toBe("42%");
    expect(describeCpu(makeSummary({ cpuPercent: 42.4, cpuLogicalCoreCount: null }))).toBe("42%");
    expect(describeCpu(makeSummary({ cpuPercent: 42.4, cpuLogicalCoreCount: 0 }))).toBe("42%");
    expect(describeCpu(makeSummary({ cpuPercent: null, cpuLogicalCoreCount: 8 }))).toBeNull();
  });

  it("puts memory in use and total in the total's unit", () => {
    const current = (overrides: Parameters<typeof makeSummary>[0]) =>
      makeSummary({ cpuLogicalCoreCount: null, ...overrides });
    expect(
      describeMemoryCapacity(current({ memoryUsedBytes: 20.1 * GB, memoryTotalBytes: 36 * GB }))
    ).toBe("20.1 / 36 GB");
    expect(
      describeMemoryCapacity(
        current({ memoryUsedBytes: 512 * 1024 ** 2, memoryTotalBytes: 8 * GB })
      )
    ).toBe("0.5 / 8 GB");
    expect(describeMemoryCapacity(current({ memoryUsedBytes: 0 }))).toBe("0 / 16 GB");
    expect(describeMemoryCapacity(current({ memoryUsedBytes: null }))).toBeNull();
    expect(describeMemoryCapacity(current({ memoryTotalBytes: 0 }))).toBeNull();
  });

  it("never reads an older host's cache-inclusive used bytes as capacity", () => {
    expect(describeMemoryCapacity(makeSummary())).toBeNull();
    expect(memoryUsedSeries([makeSummary()])).toEqual([null]);
  });

  it("describes the load, clusters and CPU stall only where the host reports them", () => {
    expect(describeLoad(makeSummary())).toBeNull();
    expect(describeLoad(makeSummary({ cpuLoadAverage1m: 1.5 }))).toBe("1.50");
    expect(describeCoreClusters(makeSummary())).toBeNull();
    expect(
      describeCoreClusters(
        makeSummary({
          cpuEfficiencyPercent: 40,
          cpuEfficiencyCoreCount: 4,
          cpuPerformancePercent: null,
        })
      )
    ).toEqual({ value: "Efficiency 40%", detail: "40% of 4 efficiency cores busy" });
    expect(describeCpuPressure(makeSummary())).toBeNull();
    expect(describeCpuPressure(makeSummary({ cpuPressure: 0 }))).toBe(
      "0% of the last 10 s stalled"
    );
  });
});
