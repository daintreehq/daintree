import { describe, expect, it } from "vitest";
import type { HostMetricsSummary } from "../../types/remoteHosts.js";
import { busyCores, reportedCapacity, reportsMemoryCapacity } from "../hostCapacity.js";

const summary = (over: Partial<HostMetricsSummary>): HostMetricsSummary =>
  ({
    cpuPercent: 50,
    memoryUsedBytes: 8,
    memoryTotalBytes: 16,
    ...over,
  }) as HostMetricsSummary;

describe("hostCapacity", () => {
  it("marks a newer host by the core-count field being present, even as null", () => {
    expect(reportsMemoryCapacity(summary({}))).toBe(false);
    expect(reportsMemoryCapacity(summary({ cpuLogicalCoreCount: null }))).toBe(true);
  });

  it("reports memory capacity only for a newer host with a valid used and total", () => {
    expect(reportedCapacity(summary({}))).toBeNull();
    expect(reportedCapacity(summary({ cpuLogicalCoreCount: 4 }))).toEqual({ used: 8, total: 16 });
    expect(reportedCapacity(summary({ cpuLogicalCoreCount: 4, memoryUsedBytes: null }))).toBeNull();
    expect(reportedCapacity(summary({ cpuLogicalCoreCount: 4, memoryTotalBytes: 0 }))).toBeNull();
    expect(reportedCapacity(summary({ cpuLogicalCoreCount: 4, memoryUsedBytes: 0 }))).toEqual({
      used: 0,
      total: 16,
    });
  });

  it("derives busy cores only from a measured share and a positive core count", () => {
    expect(busyCores(summary({ cpuLogicalCoreCount: 8 }))).toEqual({ busy: 4, total: 8 });
    expect(busyCores(summary({ cpuLogicalCoreCount: 8, cpuPercent: 0 }))).toEqual({
      busy: 0,
      total: 8,
    });
    expect(busyCores(summary({}))).toBeNull();
    expect(busyCores(summary({ cpuLogicalCoreCount: 0 }))).toBeNull();
    expect(busyCores(summary({ cpuLogicalCoreCount: 8, cpuPercent: null }))).toBeNull();
  });
});
