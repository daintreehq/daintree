import { describe, expect, it } from "vitest";
import {
  cpuPercentBetween,
  parseCgroupMemory,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseIoregGpuUtilization,
  parseMeminfo,
  parsePsi,
  parseThermalZoneTemp,
  psiToMemoryPressure,
  thermalFromCelsius,
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

  it("maps memory PSI onto normal / warn / critical", () => {
    expect(psiToMemoryPressure({ someAvg10: 0.5 })).toBe("normal");
    expect(psiToMemoryPressure({ someAvg10: 12.34 })).toBe("warn");
    expect(psiToMemoryPressure({ someAvg10: 55 })).toBe("critical");
  });

  it("is null when the kernel has no PSI or the file is malformed", () => {
    expect(parsePsi(null)).toBeNull();
    expect(parsePsi("full avg10=1.00")).toBeNull();
    expect(parsePsi("some avg60=1.00")).toBeNull();
    expect(psiToMemoryPressure(null)).toBeNull();
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

describe("parseCgroupMemory", () => {
  it("reads usage against a real limit", () => {
    expect(parseCgroupMemory("104857600\n", "536870912\n")).toEqual({
      usedBytes: 104857600,
      limitBytes: 536870912,
    });
  });

  it("is null when the cgroup is unlimited or the files are missing", () => {
    expect(parseCgroupMemory("104857600", "max\n")).toBeNull();
    expect(parseCgroupMemory(null, "536870912")).toBeNull();
    expect(parseCgroupMemory("104857600", null)).toBeNull();
    expect(parseCgroupMemory("junk", "536870912")).toBeNull();
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
  it("reads millidegrees and bands the hottest zone", () => {
    expect(parseThermalZoneTemp("45000\n")).toBe(45);
    expect(thermalFromCelsius(45)).toBe("nominal");
    expect(thermalFromCelsius(80)).toBe("fair");
    expect(thermalFromCelsius(90)).toBe("serious");
    expect(thermalFromCelsius(99)).toBe("critical");
  });

  it("treats unwired zones and missing files as unmeasured", () => {
    expect(parseThermalZoneTemp("-273000")).toBeNull();
    expect(parseThermalZoneTemp("0")).toBeNull();
    expect(parseThermalZoneTemp(null)).toBeNull();
    expect(thermalFromCelsius(null)).toBeNull();
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
