import { describe, expect, it } from "vitest";
import { HostMetricsSampler, type HostSampleSources } from "../sampler.js";

function sources(overrides: Partial<HostSampleSources> = {}): HostSampleSources {
  let tick = 0;
  return {
    platform: "linux",
    cpus: () => {
      tick += 1;
      return [{ user: tick * 100, nice: 0, sys: 0, idle: tick * 100, irq: 0 }];
    },
    totalmem: () => 8 * 1024 ** 3,
    freemem: () => 2 * 1024 ** 3,
    readText: async () => null,
    run: async () => null,
    listDir: async () => [],
    thermalState: () => null,
    agents: async () => ({ working: 2, waiting: 1, idle: 3 }),
    projects: async () => ({ projectCount: 4, worktreeCount: 9 }),
    driver: () => null,
    agentClis: async () => [{ agentId: "claude", version: "2.1.0" }],
    now: () => 1_000,
    ...overrides,
  };
}

describe("HostMetricsSampler", () => {
  it("reports every Linux metric from its source", async () => {
    const files: Record<string, string> = {
      "/proc/pressure/memory": "some avg10=15.00 avg60=1 avg300=1 total=1\n",
      "/proc/pressure/cpu": "some avg10=3.50 avg60=1 avg300=1 total=1\n",
      "/proc/meminfo":
        "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n",
      "/sys/class/thermal/thermal_zone0/temp": "50000",
      "/sys/class/thermal/thermal_zone1/temp": "88000",
    };
    const sampler = new HostMetricsSampler(
      sources({
        readText: async (path) => files[path] ?? null,
        listDir: async () => ["thermal_zone0", "thermal_zone1", "cooling_device0"],
      })
    );
    await sampler.sample();
    const summary = await sampler.sample();
    expect(summary).toMatchObject({
      hostId: "local",
      platform: "linux",
      cpuPercent: 50,
      memoryPressure: "warn",
      memoryTotalBytes: 1000 * 1024,
      memoryUsedBytes: 600 * 1024,
      swapTotalBytes: 200 * 1024,
      swapUsedBytes: 150 * 1024,
      thermal: "serious",
      cpuPressure: 3.5,
      agentsObserved: { working: 2, waiting: 1, idle: 3 },
      projectCount: 4,
      worktreeCount: 9,
      agentClis: [{ agentId: "claude", version: "2.1.0" }],
    });
  });

  it("prefers the cgroup limit inside a container", async () => {
    const files: Record<string, string> = {
      "/proc/meminfo": "MemTotal: 1000000 kB\nMemAvailable: 900000 kB\n",
      "/sys/fs/cgroup/memory.current": "1048576",
      "/sys/fs/cgroup/memory.max": "4194304",
    };
    const summary = await new HostMetricsSampler(
      sources({ readText: async (path) => files[path] ?? null })
    ).sample();
    expect(summary.memoryUsedBytes).toBe(1048576);
    expect(summary.memoryTotalBytes).toBe(4194304);
  });

  it("reports missing sources as null, never zero", async () => {
    const summary = await new HostMetricsSampler(sources()).sample();
    expect(summary).toMatchObject({
      cpuPercent: null,
      memoryPressure: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
      thermal: null,
      cpuPressure: null,
    });
  });

  it("reads macOS pressure and swap from sysctl and thermal from the power monitor", async () => {
    const summary = await new HostMetricsSampler(
      sources({
        platform: "darwin",
        run: async (_command, args) =>
          args.includes("kern.memorystatus_vm_pressure_level")
            ? "4\n"
            : "total = 1024.00M  used = 256.00M  free = 768.00M",
        thermalState: () => "fair",
      })
    ).sample();
    expect(summary).toMatchObject({
      platform: "darwin",
      memoryPressure: "critical",
      memoryTotalBytes: 8 * 1024 ** 3,
      memoryUsedBytes: 6 * 1024 ** 3,
      swapTotalBytes: 1024 * 1024 ** 2,
      swapUsedBytes: 256 * 1024 ** 2,
      thermal: "fair",
      cpuPressure: null,
    });
  });

  it("keeps sampling when one source throws", async () => {
    const summary = await new HostMetricsSampler(
      sources({
        agentClis: async () => {
          throw new Error("probe failed");
        },
        driver: () => {
          throw new Error("no lease");
        },
      })
    ).sample();
    expect(summary.agentClis).toEqual([]);
    expect(summary.driver).toBeNull();
    expect(summary.projectCount).toBe(4);
  });
});
