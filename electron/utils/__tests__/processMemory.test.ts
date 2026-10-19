import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAppMetricsMock } = vi.hoisted(() => ({ getAppMetricsMock: vi.fn() }));

vi.mock("electron", () => ({ app: { getAppMetrics: getAppMetricsMock } }));

import {
  attachPhysFootprints,
  getMetricsMemorySource,
  getProcessMemoryKb,
  readPhysFootprintsKb,
  resetPhysFootprintReaderForTesting,
  setPhysFootprintReaderForTesting,
} from "../processMemory.js";
import {
  refreshAppMetricsSnapshot,
  resetAppMetricsSnapshotForTesting,
} from "../appMetricsSnapshot.js";

const MB = 1024 * 1024;

function metric(pid: number, workingSetKb: number): Electron.ProcessMetric {
  return {
    pid,
    type: "Utility",
    creationTime: 0,
    cpu: { percentCPUUsage: 0, cumulativeCPUUsage: 0, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: workingSetKb, peakWorkingSetSize: workingSetKb },
    sandboxed: false,
    integrityLevel: "unknown",
  } as Electron.ProcessMetric;
}

const readPhysFootprints = vi.fn<(pids: number[]) => Array<number | null> | null>();

function useReader(): void {
  setPhysFootprintReaderForTesting({
    readPhysFootprints,
    isAvailable: () => true,
    getLoadError: () => null,
  });
}

beforeEach(() => {
  readPhysFootprints.mockReset();
  getAppMetricsMock.mockReset();
  resetAppMetricsSnapshotForTesting();
});

afterEach(() => {
  resetPhysFootprintReaderForTesting();
});

describe("readPhysFootprintsKb", () => {
  it("is null when no reader is available, so callers stay on resident memory", () => {
    expect(readPhysFootprintsKb([1, 2])).toBeNull();
  });

  it("converts bytes to KB and leaves out every pid that couldn't be read", () => {
    useReader();
    readPhysFootprints.mockReturnValue([250 * MB, null, 0, Number.NaN, 3 * MB]);

    const kbByPid = readPhysFootprintsKb([10, 11, 12, 13, 14]);

    expect(kbByPid).toEqual(
      new Map([
        [10, 250 * 1024],
        [14, 3 * 1024],
      ])
    );
  });

  it("is null when the reader itself reports no reading", () => {
    useReader();
    readPhysFootprints.mockReturnValue(null);

    expect(readPhysFootprintsKb([10])).toBeNull();
  });
});

describe("getProcessMemoryKb", () => {
  it("reports each process's footprint from the sweep that read it", () => {
    useReader();
    // A process mostly compressed or swapped out: resident size is a sliver of
    // what it actually holds (#13526).
    readPhysFootprints.mockReturnValue([2_882 * MB, 180 * MB]);
    const metrics = [metric(100, 40_000), metric(101, 150_000)];

    attachPhysFootprints(metrics);

    expect(metrics.map(getProcessMemoryKb)).toEqual([2_882 * 1024, 180 * 1024]);
    expect(getMetricsMemorySource(metrics)).toBe("footprint");
  });

  it("falls back to working set for a process whose footprint couldn't be read", () => {
    useReader();
    readPhysFootprints.mockReturnValue([null, 180 * MB]);
    const metrics = [metric(100, 40_000), metric(101, 150_000)];

    attachPhysFootprints(metrics);

    expect(metrics.map(getProcessMemoryKb)).toEqual([40_000, 180 * 1024]);
  });

  it("stays on working set and says so when no reader is available", () => {
    const metrics = [metric(100, 40_000)];

    attachPhysFootprints(metrics);

    expect(getProcessMemoryKb(metrics[0]!)).toBe(40_000);
    expect(getMetricsMemorySource(metrics)).toBe("resident");
  });

  it("never lends one sweep's reading to a recycled pid in another", () => {
    useReader();
    readPhysFootprints.mockReturnValue([2_000 * MB]);
    attachPhysFootprints([metric(100, 40_000)]);

    const later = metric(100, 12_000);

    expect(getProcessMemoryKb(later)).toBe(12_000);
  });
});

describe("refreshAppMetricsSnapshot", () => {
  it("reads every process's footprint in one batch per sweep", () => {
    useReader();
    readPhysFootprints.mockImplementation((pids) => pids.map((pid) => pid * MB));
    getAppMetricsMock.mockReturnValue([metric(7, 1_000), metric(9, 1_000)]);

    const metrics = refreshAppMetricsSnapshot();

    expect(readPhysFootprints).toHaveBeenCalledTimes(1);
    expect(readPhysFootprints).toHaveBeenCalledWith([7, 9]);
    expect(metrics.map(getProcessMemoryKb)).toEqual([7 * 1024, 9 * 1024]);
    expect(getMetricsMemorySource(metrics)).toBe("footprint");
  });
});
