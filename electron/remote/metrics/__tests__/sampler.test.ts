import { describe, expect, it } from "vitest";
import { HostMetricsSampler, type HostSampleSources } from "../sampler.js";
import { MAX_HOST_SUMMARY_DRIVERS } from "../../../../shared/types/remoteHosts.js";

function sources(overrides: Partial<HostSampleSources> = {}): HostSampleSources {
  let tick = 0;
  return {
    platform: "linux",
    cpus: () => {
      tick += 1;
      return [{ user: tick * 100, nice: 0, sys: 0, idle: tick * 100, irq: 0 }];
    },
    totalmem: () => 8 * 1024 ** 3,
    // 2 GiB free beside 3 GiB of reclaimable cache: what Activity Monitor counts as available.
    systemMemorySnapshot: () => ({
      totalMb: 8 * 1024,
      freeMb: 2 * 1024,
      purgeableMb: 0,
      fileBackedMb: 3 * 1024,
      availableMb: 5 * 1024,
    }),
    loadavg: () => [0, 0, 0],
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
  it("carries every driven project up to its bound, a failed read as unknown, and none from a source without it", async () => {
    const driven = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        projectId: `p${i}`,
        projectName: `project ${i}`,
        holder: {
          leaseId: i,
          endpointId: `s${i}:e1`,
          clientId: `c${i}`,
          clientName: "greg-mbp",
          isHostLocal: false,
          acquiredAt: i,
        },
        state: "live" as const,
        awayUntil: null,
      }));
    const many = await new HostMetricsSampler(
      sources({ drivers: () => driven(MAX_HOST_SUMMARY_DRIVERS + 3) })
    ).sample();
    expect(many.drivers).toHaveLength(MAX_HOST_SUMMARY_DRIVERS);
    expect(many.drivers![0]!.projectId).toBe("p0");
    await expect(
      new HostMetricsSampler(
        sources({
          drivers: () => {
            throw new Error("lease unreadable");
          },
        })
      ).sample()
    ).resolves.toMatchObject({ drivers: null });
    expect(await new HostMetricsSampler(sources()).sample()).not.toHaveProperty("drivers");
  });

  it("carries the host's forge observations, and a failed read as unknown", async () => {
    const github = {
      providerId: "daintree.github.github",
      name: "GitHub",
      hasCredential: true,
      account: "greg",
    };
    await expect(
      new HostMetricsSampler(sources({ forges: async () => [github] })).sample()
    ).resolves.toMatchObject({ forges: [github] });
    await expect(
      new HostMetricsSampler(
        sources({
          forges: async () => {
            throw new Error("store unreadable");
          },
        })
      ).sample()
    ).resolves.toMatchObject({ forges: null });
    expect(await new HostMetricsSampler(sources()).sample()).not.toHaveProperty("forges");
  });

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
            : args.includes("vm.swapusage")
              ? "total = 1024.00M  used = 256.00M  free = 768.00M"
              : null,
        thermalState: () => "fair",
      })
    ).sample();
    expect(summary).toMatchObject({
      platform: "darwin",
      memoryPressure: "critical",
      memoryTotalBytes: 8 * 1024 ** 3,
      memoryUsedBytes: 3 * 1024 ** 3,
      swapTotalBytes: 1024 * 1024 ** 2,
      swapUsedBytes: 256 * 1024 ** 2,
      thermal: "fair",
      cpuPressure: null,
    });
  });

  it("reports macOS memory used as unknown when the Activity Monitor reading isn't there", async () => {
    for (const systemMemorySnapshot of [
      () => null,
      () => {
        throw new Error("no getSystemMemoryInfo");
      },
    ]) {
      const summary = await new HostMetricsSampler(
        sources({ platform: "darwin", systemMemorySnapshot })
      ).sample();
      expect(summary.memoryUsedBytes).toBeNull();
      expect(summary.memoryTotalBytes).toBe(8 * 1024 ** 3);
    }
  });

  it("carries the core count and 1 minute load average the CPU reading covers", async () => {
    const summary = await new HostMetricsSampler(sources({ loadavg: () => [3.25, 2, 1] })).sample();
    expect(summary).toMatchObject({ cpuLogicalCoreCount: 1, cpuLoadAverage1m: 3.25 });
    for (const loadavg of [
      () => [Number.NaN, 0, 0],
      () => [],
      () => {
        throw new Error("no loadavg");
      },
    ]) {
      expect((await new HostMetricsSampler(sources({ loadavg })).sample()).cpuLoadAverage1m).toBe(
        null
      );
    }
  });

  it("splits Apple Silicon load by cluster, efficiency cores first, reading the sizes once", async () => {
    let tick = 0;
    let probes = 0;
    const sampler = new HostMetricsSampler(
      sources({
        platform: "darwin",
        cpus: () => {
          tick += 1;
          // One efficiency core 10% busy, two performance cores 60% busy.
          return [
            { user: tick * 10, nice: 0, sys: 0, idle: tick * 90, irq: 0 },
            { user: tick * 60, nice: 0, sys: 0, idle: tick * 40, irq: 0 },
            { user: tick * 60, nice: 0, sys: 0, idle: tick * 40, irq: 0 },
          ];
        },
        run: async (_command, args) => {
          if (args.includes("hw.perflevel0.logicalcpu")) return ((probes += 1), "2\n");
          if (args.includes("hw.perflevel1.logicalcpu")) return ((probes += 1), "1\n");
          return null;
        },
      })
    );
    const first = await sampler.sample();
    expect(first).toMatchObject({
      cpuLogicalCoreCount: 3,
      cpuPerformanceCoreCount: 2,
      cpuEfficiencyCoreCount: 1,
      cpuPerformancePercent: null,
      cpuEfficiencyPercent: null,
    });
    const second = await sampler.sample();
    expect(second.cpuPerformancePercent).toBeCloseTo(60);
    expect(second.cpuEfficiencyPercent).toBeCloseTo(10);
    expect(probes).toBe(2);
  });

  it("reports cluster sizes without a split when they don't match the cores read", async () => {
    const sampler = new HostMetricsSampler(
      sources({
        platform: "darwin",
        run: async (_command, args) =>
          args.includes("hw.perflevel0.logicalcpu")
            ? "10"
            : args.includes("hw.perflevel1.logicalcpu")
              ? "4"
              : null,
      })
    );
    await sampler.sample();
    expect(await sampler.sample()).toMatchObject({
      cpuPercent: 50,
      cpuPerformanceCoreCount: 10,
      cpuEfficiencyCoreCount: 4,
      cpuPerformancePercent: null,
      cpuEfficiencyPercent: null,
    });
  });

  it("reports no clusters on Linux or a Mac without performance levels, and never probes Linux", async () => {
    const probed: string[][] = [];
    const run = async (_command: string, args: string[]) => (probed.push(args), null);
    for (const platform of ["linux", "darwin"] as const) {
      const sampler = new HostMetricsSampler(sources({ platform, run }));
      await sampler.sample();
      expect(await sampler.sample()).toMatchObject({
        cpuPerformanceCoreCount: null,
        cpuEfficiencyCoreCount: null,
        cpuPerformancePercent: null,
        cpuEfficiencyPercent: null,
      });
    }
    expect(
      probed.filter((args) => args.some((arg) => arg.startsWith("hw.perflevel")))
    ).toHaveLength(2);
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

  it("reports agent and project reads that fail as unknown, never zero", async () => {
    const summary = await new HostMetricsSampler(
      sources({
        agents: async () => {
          throw new Error("pty host down");
        },
        projects: async () => {
          throw new Error("store unreadable");
        },
      })
    ).sample();
    expect(summary.agentsObserved).toBeNull();
    expect(summary.projectCount).toBeNull();
    expect(summary.worktreeCount).toBeNull();
  });

  it("passes an incomplete agent read through as unknown", async () => {
    const summary = await new HostMetricsSampler(sources({ agents: async () => null })).sample();
    expect(summary.agentsObserved).toBeNull();
  });

  it("reads agents, projects and driver from one sample's readers when the sources scope them", async () => {
    let begun = 0;
    const scopedDriver = { shellId: "shell-scoped", acquiredAt: 7 } as never;
    const unscoped = () => {
      throw new Error("unscoped");
    };
    const summary = await new HostMetricsSampler(
      sources({
        agents: unscoped,
        projects: unscoped,
        driver: unscoped,
        beginSample: () => {
          begun += 1;
          return {
            agents: async () => ({ working: 5, waiting: 0, idle: 0 }),
            projects: async () => ({ projectCount: 1, worktreeCount: 2 }),
            driver: () => scopedDriver,
          };
        },
      })
    ).sample();
    expect(begun).toBe(1);
    expect(summary).toMatchObject({
      agentsObserved: { working: 5, waiting: 0, idle: 0 },
      projectCount: 1,
      worktreeCount: 2,
      driver: scopedDriver,
    });
  });

  it("reports a sample's failed scoped readers as unknown, keeping the rest", async () => {
    const failed = () => {
      throw new Error("db locked");
    };
    const summary = await new HostMetricsSampler(
      sources({
        beginSample: () => ({
          agents: async () => failed(),
          projects: async () => failed(),
          driver: failed,
        }),
      })
    ).sample();
    expect(summary).toMatchObject({
      agentsObserved: null,
      projectCount: null,
      worktreeCount: null,
      driver: null,
      agentClis: [{ agentId: "claude", version: "2.1.0" }],
    });
  });
});
