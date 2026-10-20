import Module from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAppMetricsMock, logWarnMock } = vi.hoisted(() => ({
  getAppMetricsMock: vi.fn(),
  logWarnMock: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getAppMetrics: getAppMetricsMock } }));
vi.mock("../logger.js", () => ({ logWarn: logWarnMock }));

import {
  attachPhysFootprints,
  getMetricsMemorySource,
  getPressureMemoryKb,
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
  logWarnMock.mockReset();
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

  it("is null, and warns once, when not one pid of a batch could be read", () => {
    useReader();
    readPhysFootprints.mockReturnValue([null, null]);

    expect(readPhysFootprintsKb([10, 11])).toBeNull();
    expect(readPhysFootprintsKb([10, 11])).toBeNull();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith("phys-footprint-batch-unreadable", { pidCount: 2 });
  });
});

describe("loading the addon", () => {
  const originalPlatform = process.platform;
  const originalVitest = process.env.VITEST;
  const originalRequire = Module.prototype.require;
  const requested: string[] = [];

  function loadAs(platform: NodeJS.Platform, addon: unknown): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    delete process.env.VITEST;
    Module.prototype.require = function (this: NodeJS.Module, id: string): unknown {
      if (id === "mac-phys-footprint") {
        requested.push(id);
        if (addon instanceof Error) throw addon;
        return addon;
      }
      return originalRequire.call(this, id);
    } as unknown as typeof Module.prototype.require;
    resetPhysFootprintReaderForTesting();
  }

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    Module.prototype.require = originalRequire;
    requested.length = 0;
  });

  it("reads through the addon on macOS", () => {
    loadAs("darwin", {
      readPhysFootprints: (pids: number[]) => pids.map(() => 5 * MB),
      isAvailable: () => true,
      getLoadError: () => null,
    });

    expect(readPhysFootprintsKb([42])).toEqual(new Map([[42, 5 * 1024]]));
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("warns once and stays on resident memory when the addon can't load", () => {
    loadAs("darwin", new Error("Cannot find module 'mac-phys-footprint'"));

    expect(readPhysFootprintsKb([42])).toBeNull();
    expect(readPhysFootprintsKb([42])).toBeNull();
    expect(requested).toHaveLength(1);
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(logWarnMock).toHaveBeenCalledWith("phys-footprint-unavailable", {
      error: "Cannot find module 'mac-phys-footprint'",
    });
  });

  it("warns when the addon is present but its binary didn't load", () => {
    loadAs("darwin", {
      readPhysFootprints: () => null,
      isAvailable: () => false,
      getLoadError: () => new Error("incompatible architecture"),
    });

    expect(readPhysFootprintsKb([42])).toBeNull();
    expect(logWarnMock).toHaveBeenCalledWith("phys-footprint-unavailable", {
      error: "incompatible architecture",
    });
  });

  it("never loads the addon off macOS", () => {
    loadAs("linux", new Error("must not load"));

    expect(readPhysFootprintsKb([42])).toBeNull();
    expect(requested).toHaveLength(0);
    expect(logWarnMock).not.toHaveBeenCalled();
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

  it("labels a sweep resident when not one of its processes could be read", () => {
    useReader();
    readPhysFootprints.mockReturnValue([null, null]);
    const metrics = [metric(100, 40_000), metric(101, 150_000)];

    attachPhysFootprints(metrics);

    expect(metrics.map(getProcessMemoryKb)).toEqual([40_000, 150_000]);
    expect(getMetricsMemorySource(metrics)).toBe("resident");
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

describe("getPressureMemoryKb", () => {
  it("counts the GPU process at its resident size and every other process at its footprint", () => {
    useReader();
    // IOSurface and Metal memory charged to the GPU process (#13637).
    readPhysFootprints.mockReturnValue([3_328 * MB, 180 * MB]);
    const gpu = { ...metric(100, 205 * 1024), type: "GPU" } as Electron.ProcessMetric;
    const metrics = [gpu, metric(101, 150_000)];

    attachPhysFootprints(metrics);

    expect(metrics.map(getProcessMemoryKb)).toEqual([3_328 * 1024, 180 * 1024]);
    expect(metrics.map(getPressureMemoryKb)).toEqual([205 * 1024, 180 * 1024]);
  });

  it("matches getProcessMemoryKb when there is no footprint to read", () => {
    const gpu = { ...metric(100, 205 * 1024), type: "GPU" } as Electron.ProcessMetric;
    const metrics = [gpu, metric(101, 150_000)];

    attachPhysFootprints(metrics);

    expect(metrics.map(getPressureMemoryKb)).toEqual(metrics.map(getProcessMemoryKb));
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
