import { describe, expect, it } from "vitest";
import {
  clusterCpuPercentBetween,
  cpuPercentBetween,
  parseDarwinCpuClusters,
  parseCgroupBytes,
  parseCgroupCpuUsageUsec,
  parseCpuMax,
  parseCpuSetCount,
  parseProcSelfCgroup,
  pickThermalZone,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseIoregGpuUtilization,
  parseMeminfo,
  parsePsi,
  parseThermalZoneTemp,
} from "../parsers.js";

describe("parseDarwinPressureLevel", () => {
  it("maps the memorystatus levels to three bands", () => {
    expect(parseDarwinPressureLevel("1\n")).toBe("normal");
    expect(parseDarwinPressureLevel("2")).toBe("warn");
    expect(parseDarwinPressureLevel("4\n")).toBe("critical");
  });

  it("is null for anything else, including a missing sysctl", () => {
    expect(parseDarwinPressureLevel("3")).toBeNull();
    expect(parseDarwinPressureLevel("")).toBeNull();
    expect(parseDarwinPressureLevel(null)).toBeNull();
  });
});

describe("parsePsi", () => {
  const sample =
    "some avg10=12.34 avg60=8.00 avg300=2.10 total=123456\nfull avg10=1.00 avg60=0.50 avg300=0.10 total=4567\n";

  it("reads the some avg10 share", () => {
    expect(parsePsi(sample)).toEqual({ someAvg10: 12.34 });
  });

  it("is null when the kernel has no PSI or the file is malformed", () => {
    expect(parsePsi(null)).toBeNull();
    expect(parsePsi("full avg10=1.00")).toBeNull();
    expect(parsePsi("some avg60=1.00")).toBeNull();
  });
});

describe("parseMeminfo", () => {
  it("reads kB fields as bytes", () => {
    const text = [
      "MemTotal:       16384000 kB",
      "MemFree:         1000000 kB",
      "MemAvailable:    8192000 kB",
      "SwapTotal:       2048000 kB",
      "SwapFree:        1024000 kB",
    ].join("\n");
    expect(parseMeminfo(text)).toEqual({
      totalBytes: 16384000 * 1024,
      availableBytes: 8192000 * 1024,
      swapTotalBytes: 2048000 * 1024,
      swapFreeBytes: 1024000 * 1024,
    });
  });

  it("leaves fields a kernel doesn't report null", () => {
    expect(parseMeminfo("MemTotal: 1000 kB")).toEqual({
      totalBytes: 1024000,
      availableBytes: null,
      swapTotalBytes: null,
      swapFreeBytes: null,
    });
    expect(parseMeminfo("")).toBeNull();
    expect(parseMeminfo(null)).toBeNull();
  });
});

describe("cgroup v2 readers", () => {
  it("reads a byte count and treats max or junk as no value", () => {
    expect(parseCgroupBytes("536870912\n")).toBe(536870912);
    expect(parseCgroupBytes("0")).toBe(0);
    expect(parseCgroupBytes("max\n")).toBeNull();
    expect(parseCgroupBytes("junk")).toBeNull();
    expect(parseCgroupBytes(null)).toBeNull();
  });

  it("reads the unified entry of /proc/self/cgroup as path segments", () => {
    expect(parseProcSelfCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toEqual([
      "user.slice",
      "user-1000.slice",
      "session-3.scope",
    ]);
    expect(parseProcSelfCgroup("12:memory:/old\n0::/\n")).toEqual([]);
    expect(parseProcSelfCgroup("0::/a/b.service (deleted)\n")).toEqual(["a", "b.service"]);
  });

  it("has no path for a v1-only host, a traversal or an unreadable file", () => {
    expect(parseProcSelfCgroup("4:memory:/docker/abc\n3:cpu:/docker/abc\n")).toBeNull();
    expect(parseProcSelfCgroup("0::/a/../../etc\n")).toBeNull();
    expect(parseProcSelfCgroup("0::relative\n")).toBeNull();
    expect(parseProcSelfCgroup(null)).toBeNull();
  });

  it("reads cpu.max as cores, fractional under a quota", () => {
    expect(parseCpuMax("150000 100000\n")).toBe(1.5);
    expect(parseCpuMax("50000 100000")).toBe(0.5);
    expect(parseCpuMax("max 100000")).toBeNull();
    expect(parseCpuMax("100000 0")).toBeNull();
    expect(parseCpuMax(null)).toBeNull();
  });

  it("counts the CPUs in a cpuset list without counting one twice", () => {
    expect(parseCpuSetCount("0-3,8\n")).toBe(5);
    expect(parseCpuSetCount("2")).toBe(1);
    expect(parseCpuSetCount("0-2,1-3")).toBe(4);
    expect(parseCpuSetCount("")).toBeNull();
    expect(parseCpuSetCount("3-1")).toBeNull();
    expect(parseCpuSetCount("a-b")).toBeNull();
    expect(parseCpuSetCount(null)).toBeNull();
  });

  it("reads usage_usec from cpu.stat", () => {
    expect(parseCgroupCpuUsageUsec("usage_usec 123456\nuser_usec 100\nsystem_usec 5\n")).toBe(
      123456
    );
    expect(parseCgroupCpuUsageUsec("user_usec 100")).toBeNull();
    expect(parseCgroupCpuUsageUsec(null)).toBeNull();
  });
});

describe("parseDarwinSwapUsage", () => {
  it("reads total and used with their units", () => {
    expect(
      parseDarwinSwapUsage("total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)")
    ).toEqual({ totalBytes: 2048 * 1024 ** 2, usedBytes: Math.round(1024.5 * 1024 ** 2) });
    expect(parseDarwinSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M")).toEqual({
      totalBytes: 0,
      usedBytes: 0,
    });
  });

  it("is null for output it can't read", () => {
    expect(parseDarwinSwapUsage("nothing here")).toBeNull();
    expect(parseDarwinSwapUsage(null)).toBeNull();
  });
});

describe("thermal zones", () => {
  it("reads millidegrees as Celsius", () => {
    expect(parseThermalZoneTemp("45000\n")).toBe(45);
  });

  it("ignores readings no sensor made", () => {
    expect(parseThermalZoneTemp("-273000")).toBeNull();
    expect(parseThermalZoneTemp("0")).toBeNull();
    expect(parseThermalZoneTemp(null)).toBeNull();
  });

  it("prefers a CPU sensor over a hotter unrelated one and names it", () => {
    expect(
      pickThermalZone([
        { zone: "thermal_zone0", type: "acpitz", celsius: 90 },
        { zone: "thermal_zone1", type: "iwlwifi_1", celsius: 70 },
        { zone: "thermal_zone2", type: "x86_pkg_temp", celsius: 55 },
      ])
    ).toEqual({ celsius: 55, label: "x86_pkg_temp (thermal_zone2)" });
  });

  it("takes the hottest of equals, falls back below ACPI, and tolerates a missing type", () => {
    expect(
      pickThermalZone([
        { zone: "thermal_zone0", type: "acpitz", celsius: 90 },
        { zone: "thermal_zone1", type: null, celsius: 40 },
        { zone: "thermal_zone2", type: null, celsius: 60 },
      ])
    ).toEqual({ celsius: 60, label: "thermal_zone2" });
    expect(pickThermalZone([{ zone: "thermal_zone0", type: "acpitz", celsius: 90 }])).toEqual({
      celsius: 90,
      label: "acpitz (thermal_zone0)",
    });
    expect(pickThermalZone([{ zone: "thermal_zone0", type: "x", celsius: null }])).toBeNull();
    expect(pickThermalZone([])).toBeNull();
  });
});

describe("parseIoregGpuUtilization", () => {
  it("takes the highest Device Utilization % across accelerators", () => {
    const text = [
      "+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X>",
      '    "PerformanceStatistics" = {"In use system memory"=123,"Device Utilization %"=17,"Renderer Utilization %"=12}',
      "+-o AGXAcceleratorG13X  <class AGXAcceleratorG13X>",
      '    "PerformanceStatistics" = {"Device Utilization %"=42}',
    ].join("\n");
    expect(parseIoregGpuUtilization(text)).toBe(42);
  });

  it("is null for a model that doesn't report it", () => {
    expect(
      parseIoregGpuUtilization('"PerformanceStatistics" = {"GPU Core Utilization"=5}')
    ).toBeNull();
    expect(parseIoregGpuUtilization(null)).toBeNull();
  });
});

describe("cpuPercentBetween", () => {
  const core = (user: number, idle: number) => ({ user, nice: 0, sys: 0, idle, irq: 0 });

  it("is the busy share of all cores over the interval", () => {
    const before = [core(100, 900), core(200, 800)];
    const after = [core(150, 950), core(300, 800)];
    // Busy 50 + 100 of 200 total ticks.
    expect(cpuPercentBetween(before, after)).toBeCloseTo(75);
  });

  it("is null on the first reading, a changed core count, or no ticks", () => {
    expect(cpuPercentBetween(null, [core(1, 1)])).toBeNull();
    expect(cpuPercentBetween([core(1, 1)], [core(1, 1), core(1, 1)])).toBeNull();
    expect(cpuPercentBetween([core(1, 1)], [core(1, 1)])).toBeNull();
  });

  it("is null when counters went backwards", () => {
    expect(cpuPercentBetween([core(100, 100)], [core(50, 200)])).toBeNull();
  });
});

describe("parseDarwinCpuClusters", () => {
  it("reads the performance and efficiency cluster sizes", () => {
    expect(parseDarwinCpuClusters("Performance\n10\nEfficiency\n4\n")).toEqual({
      performance: 10,
      efficiency: 4,
    });
  });

  it("is null for any other layout rather than relabelling it", () => {
    for (const text of [
      null,
      "",
      // M5 Pro/Max: no efficiency cluster; their performance cores are level 1.
      "Super\n6\nPerformance\n12\n",
      // A chip or VM reporting one level, or a failed second read.
      "Performance\n8\n",
      "Performance\n0\nEfficiency\n4\n",
      "Performance\n4.5\nEfficiency\n4\n",
    ]) {
      expect(parseDarwinCpuClusters(text)).toBeNull();
    }
  });
});

describe("clusterCpuPercentBetween", () => {
  const core = (user: number, idle: number) => ({ user, nice: 0, sys: 0, idle, irq: 0 });
  // Two efficiency cores barely busy, then three performance cores mostly busy.
  const before = [core(0, 0), core(0, 0), core(0, 0), core(0, 0), core(0, 0)];
  const after = [core(10, 90), core(10, 90), core(80, 20), core(60, 40), core(70, 30)];

  it("splits the busy share with the efficiency cluster first", () => {
    const split = clusterCpuPercentBetween(before, after, 2, 3);
    expect(split.efficiency).toBeCloseTo(10);
    expect(split.performance).toBeCloseTo(70);
  });

  it("leaves both shares unknown when the clusters don't account for every core", () => {
    const unknown = { efficiency: null, performance: null };
    expect(clusterCpuPercentBetween(before, after, 2, 2)).toEqual(unknown);
    expect(clusterCpuPercentBetween(before, after, null, 3)).toEqual(unknown);
    expect(clusterCpuPercentBetween(before, after, 2, null)).toEqual(unknown);
  });

  it("is unknown on the first reading or a changed core count", () => {
    const unknown = { efficiency: null, performance: null };
    expect(clusterCpuPercentBetween(null, after, 2, 3)).toEqual(unknown);
    expect(clusterCpuPercentBetween(before.slice(1), after, 2, 3)).toEqual(unknown);
  });
});
