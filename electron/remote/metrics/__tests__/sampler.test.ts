import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_SAMPLE_BUDGET_MS, HostMetricsSampler, type HostSampleSources } from "../sampler.js";
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
      "/sys/class/thermal/thermal_zone0/type": "x86_pkg_temp\n",
      "/sys/class/thermal/thermal_zone1/temp": "88000",
      "/sys/class/thermal/thermal_zone1/type": "acpitz\n",
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
      metricsScope: "host",
      cpuCapacityCores: 1,
      memoryPressure: null,
      memoryPressureSomeAvg10: 15,
      memoryTotalBytes: 1000 * 1024,
      memoryUsedBytes: 600 * 1024,
      swapTotalBytes: 200 * 1024,
      swapUsedBytes: 150 * 1024,
      thermal: null,
      temperatureCelsius: 50,
      temperatureZone: "x86_pkg_temp (thermal_zone0)",
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
    expect(summary.metricsScope).toBe("cgroup");
  });

  describe("cgroup scope", () => {
    const slice = "/sys/fs/cgroup/system.slice/daintree.service";
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/system.slice/daintree.service\n",
      // Machine-wide readings that must not leak into a cgroup's summary.
      "/proc/meminfo":
        "MemTotal: 16000000 kB\nMemAvailable: 8000000 kB\nSwapTotal: 999 kB\nSwapFree: 1 kB\n",
      "/proc/pressure/memory": "some avg10=77.00 avg60=1 avg300=1 total=1\n",
      "/proc/pressure/cpu": "some avg10=66.00 avg60=1 avg300=1 total=1\n",
      // The slice above the service is what bounds it.
      "/sys/fs/cgroup/system.slice/memory.max": "2147483648",
      "/sys/fs/cgroup/system.slice/cpu.max": "150000 100000",
      [`${slice}/memory.max`]: "max",
      [`${slice}/memory.current`]: "536870912",
      [`${slice}/memory.swap.current`]: "1024",
      [`${slice}/memory.swap.max`]: "4096",
      [`${slice}/memory.pressure`]: "some avg10=2.50 avg60=1 avg300=1 total=1\n",
      [`${slice}/cpu.pressure`]: "some avg10=0.50 avg60=1 avg300=1 total=1\n",
      [`${slice}/cpuset.cpus.effective`]: "0-7",
    };

    function cgroupSampler(
      extra: Record<string, string> = {},
      without: string[] = [],
      cores = 8,
      nowMs: () => number = () => 1_000
    ) {
      const all = { ...files, ...extra };
      for (const key of without) delete all[key];
      return new HostMetricsSampler(
        sources({
          cpus: () =>
            Array.from({ length: cores }, () => ({ user: 1, nice: 0, sys: 0, idle: 1, irq: 0 })),
          loadavg: () => [4, 4, 4],
          readText: async (path) => all[path] ?? null,
          now: nowMs,
        })
      );
    }

    it("reads memory, swap, pressure and cores from the cgroup, under the tightest ancestor limit", async () => {
      const summary = await cgroupSampler().sample();
      expect(summary).toMatchObject({
        metricsScope: "cgroup",
        memoryUsedBytes: 536870912,
        memoryTotalBytes: 2147483648,
        swapUsedBytes: 1024,
        swapTotalBytes: 4096,
        memoryPressure: null,
        memoryPressureSomeAvg10: 2.5,
        cpuPressure: 0.5,
        cpuCapacityCores: 1.5,
        cpuLogicalCoreCount: null,
        cpuLoadAverage1m: null,
      });
    });

    it("measures CPU against the cgroup's own counter and quota", async () => {
      let now = 1_000;
      const usage = (usec: number) => ({ [`${slice}/cpu.stat`]: `usage_usec ${usec}\n` });
      const sampler = new HostMetricsSampler(
        sources({
          cpus: () =>
            Array.from({ length: 8 }, () => ({ user: 1, nice: 0, sys: 0, idle: 1, irq: 0 })),
          readText: async (path) =>
            ({ ...files, ...usage(now === 1_000 ? 0 : 750_000) })[path] ?? null,
          now: () => now,
        })
      );
      expect((await sampler.sample()).cpuPercent).toBeNull();
      now = 2_000;
      // 0.75 CPU-seconds in one second against 1.5 cores is half busy.
      expect((await sampler.sample()).cpuPercent).toBe(50);
    });

    it("leaves a reading the cgroup doesn't give null, never the machine's", async () => {
      const summary = await cgroupSampler({}, [
        `${slice}/memory.swap.current`,
        `${slice}/memory.swap.max`,
        `${slice}/memory.pressure`,
        `${slice}/cpu.pressure`,
        "/sys/fs/cgroup/system.slice/cpu.max",
      ]).sample();
      expect(summary).toMatchObject({
        metricsScope: "cgroup",
        swapUsedBytes: null,
        swapTotalBytes: null,
        memoryPressureSomeAvg10: null,
        cpuPressure: null,
        cpuCapacityCores: 8,
        cpuLogicalCoreCount: 8,
      });
    });

    it("scopes to the cgroup for a CPU quota alone, with the machine's RAM as its memory ceiling", async () => {
      const summary = await cgroupSampler({}, [
        "/sys/fs/cgroup/system.slice/memory.max",
        `${slice}/memory.swap.max`,
      ]).sample();
      expect(summary).toMatchObject({
        metricsScope: "cgroup",
        memoryUsedBytes: 536870912,
        memoryTotalBytes: 16000000 * 1024,
      });
    });

    it("stays on the machine when nothing in the hierarchy limits it", async () => {
      const summary = await cgroupSampler({}, [
        "/sys/fs/cgroup/system.slice/memory.max",
        "/sys/fs/cgroup/system.slice/cpu.max",
        `${slice}/memory.swap.max`,
      ]).sample();
      expect(summary).toMatchObject({
        metricsScope: "host",
        memoryTotalBytes: 16000000 * 1024,
        memoryUsedBytes: 8000000 * 1024,
        memoryPressureSomeAvg10: 77,
        cpuPressure: 66,
        cpuCapacityCores: 8,
        cpuLoadAverage1m: 4,
      });
    });

    it("counts a cpuset narrower than the machine as the cores", async () => {
      const summary = await cgroupSampler({ [`${slice}/cpuset.cpus.effective`]: "0-1,4" }, [
        "/sys/fs/cgroup/system.slice/memory.max",
        "/sys/fs/cgroup/system.slice/cpu.max",
      ]).sample();
      expect(summary).toMatchObject({
        metricsScope: "cgroup",
        cpuCapacityCores: 3,
        cpuLogicalCoreCount: 3,
      });
    });

    it("takes the tightest of several finite limits along the hierarchy", async () => {
      const summary = await cgroupSampler({
        "/sys/fs/cgroup/memory.max": "1073741824",
        [`${slice}/memory.max`]: "8589934592",
        "/sys/fs/cgroup/cpu.max": "50000 100000",
      }).sample();
      expect(summary).toMatchObject({ memoryTotalBytes: 1073741824, cpuCapacityCores: 0.5 });
    });

    it("resets the CPU baseline when the counter rolls back or the capacity changes", async () => {
      let now = 0;
      let usage: string | null = null;
      let cpuMax = "100000 100000";
      const sampler = new HostMetricsSampler(
        sources({
          cpus: () =>
            Array.from({ length: 8 }, () => ({ user: 1, nice: 0, sys: 0, idle: 1, irq: 0 })),
          readText: async (path) =>
            path === `${slice}/cpu.stat`
              ? usage
              : path === "/sys/fs/cgroup/system.slice/cpu.max"
                ? cpuMax
                : (files[path] ?? null),
          now: () => now,
        })
      );
      const step = async (at: number, stat: string | null) => {
        now = at;
        usage = stat;
        return (await sampler.sample()).cpuPercent;
      };
      expect(await step(1_000, "usage_usec 1000000\n")).toBeNull();
      // Half a CPU-second in one second of one core.
      expect(await step(2_000, "usage_usec 1500000\n")).toBe(50);
      // A counter that went backwards, then a missing one, are no interval.
      expect(await step(3_000, "usage_usec 100\n")).toBeNull();
      expect(await step(4_000, null)).toBeNull();
      expect(await step(5_000, "usage_usec 2000000\n")).toBeNull();
      expect(await step(6_000, "usage_usec 3000000\n")).toBe(100);
      // A changed quota moves the scale, so the next reading starts over.
      cpuMax = "200000 100000";
      expect(await step(7_000, "usage_usec 3500000\n")).toBeNull();
      expect(await step(8_000, "usage_usec 4500000\n")).toBe(50);
    });

    it("reads a v1-only host as the machine", async () => {
      const summary = await cgroupSampler({
        "/proc/self/cgroup": "4:memory:/docker/abc\n3:cpu:/docker/abc\n",
        "/sys/fs/cgroup/memory.max": "1073741824",
      }).sample();
      expect(summary.metricsScope).toBe("host");
    });
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
      memoryPressureSomeAvg10: null,
      temperatureCelsius: null,
      temperatureZone: null,
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

  it("keeps a measured load average of zero on macOS and Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const summary = await new HostMetricsSampler(
        sources({ platform, loadavg: () => [0, 0, 0] })
      ).sample();
      expect(summary.cpuLoadAverage1m).toBe(0);
    }
  });

  describe("a Windows Shell sampling itself (#15891)", () => {
    function windows(overrides: Partial<HostSampleSources> = {}) {
      const spies = {
        readText: vi.fn(async () => null),
        listDir: vi.fn(async () => []),
        run: vi.fn(async () => null),
        loadavg: vi.fn(() => [0, 0, 0]),
        systemMemorySnapshot: vi.fn(() => null),
        thermalState: vi.fn(() => null),
      };
      return { spies, sources: sources({ platform: "win32", ...spies, ...overrides }) };
    }

    it("reports what Node measures, and everything else as unmeasured rather than zero", async () => {
      const { spies, sources: source } = windows();
      const sampler = new HostMetricsSampler(source);
      const first = await sampler.sample();
      const summary = await sampler.sample();
      expect(first.cpuPercent).toBeNull();
      expect(summary).toMatchObject({
        platform: "win32",
        cpuPercent: 50,
        cpuLogicalCoreCount: 1,
        cpuLoadAverage1m: null,
        memoryTotalBytes: 8 * 1024 ** 3,
        memoryUsedBytes: null,
        memoryPressure: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        swapInBytesPerSec: null,
        swapOutBytesPerSec: null,
        thermal: null,
        cpuPressure: null,
        cpuPerformanceCoreCount: null,
        cpuEfficiencyCoreCount: null,
        agentsObserved: { working: 2, waiting: 1, idle: 3 },
        projectCount: 4,
        worktreeCount: 9,
      });
      expect(summary).not.toHaveProperty("cpuCapacityCores");
      expect(summary).not.toHaveProperty("metricsScope");
      expect(spies.loadavg).not.toHaveBeenCalled();
      expect(spies.systemMemorySnapshot).not.toHaveBeenCalled();
      expect(spies.thermalState).not.toHaveBeenCalled();
    });

    it("attempts no Linux or macOS read", async () => {
      const { spies, sources: source } = windows();
      const sampler = new HostMetricsSampler(source);
      await sampler.sample();
      await sampler.sample();
      expect(spies.readText).not.toHaveBeenCalled();
      expect(spies.listDir).not.toHaveBeenCalled();
      expect(spies.run).not.toHaveBeenCalled();
    });

    it("takes a RAM size that isn't a positive number as unknown", async () => {
      for (const total of [0, Number.NaN]) {
        const summary = await new HostMetricsSampler(
          windows({ totalmem: () => total }).sources
        ).sample();
        expect(summary.memoryTotalBytes).toBeNull();
      }
    });

    it("keeps the CPU reading when another reader runs past the sample budget", async () => {
      vi.useFakeTimers();
      try {
        const { sources: source } = windows({ agents: () => new Promise(() => {}) });
        const sampler = new HostMetricsSampler(source);
        const first = sampler.sample();
        await vi.advanceTimersByTimeAsync(HOST_SAMPLE_BUDGET_MS);
        await first;
        const second = sampler.sample();
        await vi.advanceTimersByTimeAsync(HOST_SAMPLE_BUDGET_MS);
        const summary = await second;
        expect(summary.agentsObserved).toBeNull();
        expect(summary.cpuPercent).toBe(50);
        expect(summary.memoryTotalBytes).toBe(8 * 1024 ** 3);
      } finally {
        vi.useRealTimers();
      }
    });
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
          if (!args.includes("hw.perflevel0.name")) return null;
          probes += 1;
          return "Performance\n2\nEfficiency\n1\n";
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
    await sampler.sample();
    expect(probes).toBe(1);
  });

  it("reports cluster sizes without a split when they don't match the cores read", async () => {
    const sampler = new HostMetricsSampler(
      sources({
        platform: "darwin",
        run: async (_command, args) =>
          args.includes("hw.perflevel0.name") ? "Performance\n10\nEfficiency\n4\n" : null,
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

  it("asks again after a failed cluster read, then takes no answer as final", async () => {
    const answers: Array<string | null> = [null, "Performance\n10\nEfficiency\n4\n"];
    let probes = 0;
    const run = async (_command: string, args: string[]) =>
      args.includes("hw.perflevel0.name") ? (answers[probes++] ?? null) : null;
    const sampler = new HostMetricsSampler(sources({ platform: "darwin", run }));
    expect((await sampler.sample()).cpuPerformanceCoreCount).toBeNull();
    expect((await sampler.sample()).cpuPerformanceCoreCount).toBe(10);

    probes = 0;
    answers.length = 0;
    const intel = new HostMetricsSampler(sources({ platform: "darwin", run }));
    for (let i = 0; i < 6; i += 1) await intel.sample();
    expect(probes).toBe(3);
  });

  it("reports no clusters on Linux or a chip without a performance and efficiency pair", async () => {
    const probed: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      probed.push(args);
      return args.includes("hw.perflevel0.name") ? "Super\n6\nPerformance\n12\n" : null;
    };
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
    // Linux never asks; the Mac asks once per sample until it gives up.
    expect(probed.filter((args) => args.includes("hw.perflevel0.name"))).toHaveLength(2);
  });

  describe("sample budget (#15735)", () => {
    afterEach(() => vi.useRealTimers());

    const after = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

    it("reports what other services don't answer within the budget as unknown, holding nothing else back", async () => {
      vi.useFakeTimers();
      const sampler = new HostMetricsSampler(
        sources({
          readText: async (path) =>
            path === "/proc/meminfo" ? "MemTotal: 1000 kB\nMemAvailable: 400 kB\n" : null,
          agents: () => after(5_000, { working: 8, waiting: 0, idle: 0 }),
          projects: () => after(5_000, { projectCount: 4, worktreeCount: 9 }),
          agentClis: () => after(5_000, [{ agentId: "claude", version: "2.1.0" }]),
          forges: () => after(5_000, []),
        })
      );
      let summary: Awaited<ReturnType<HostMetricsSampler["sample"]>> | null = null;
      void sampler.sample().then((done) => (summary = done));
      await vi.advanceTimersByTimeAsync(HOST_SAMPLE_BUDGET_MS - 1);
      expect(summary).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(summary).toMatchObject({
        memoryTotalBytes: 1000 * 1024,
        memoryUsedBytes: 600 * 1024,
        cpuLogicalCoreCount: 1,
        agentsObserved: null,
        projectCount: null,
        worktreeCount: null,
        agentClis: [],
        forges: null,
      });
      await vi.runAllTimersAsync();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("reads memory a slow resource read hasn't answered as unknown, and a Linux host's CPU scope with it", async () => {
      vi.useFakeTimers();
      const meminfo = "MemTotal: 1000 kB\nMemAvailable: 400 kB\n";
      let meminfoReads = 0;
      const sampler = new HostMetricsSampler(
        sources({
          readText: async (path) => {
            if (path !== "/proc/meminfo") return null;
            meminfoReads += 1;
            return meminfoReads === 1 ? after(12_000, meminfo) : meminfo;
          },
        })
      );
      const first = sampler.sample();
      await vi.advanceTimersByTimeAsync(HOST_SAMPLE_BUDGET_MS);
      // The machine's cores may not be the host's when its cgroup wasn't read.
      await expect(first).resolves.toMatchObject({
        agentsObserved: { working: 2, waiting: 1, idle: 3 },
        memoryTotalBytes: null,
        memoryUsedBytes: null,
        cpuLogicalCoreCount: null,
        cpuCapacityCores: null,
        cpuLoadAverage1m: null,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      const second = sampler.sample();
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toMatchObject({ memoryTotalBytes: null, cpuPercent: null });
      expect(meminfoReads).toBe(1);
      await vi.advanceTimersByTimeAsync(7_000);
      const third = sampler.sample();
      await vi.advanceTimersByTimeAsync(0);
      await expect(third).resolves.toMatchObject({
        memoryTotalBytes: 1000 * 1024,
        cpuLogicalCoreCount: 1,
        metricsScope: "host",
      });
      expect(meminfoReads).toBe(2);
    });

    it("takes an answer that comes within the budget", async () => {
      vi.useFakeTimers();
      const sampler = new HostMetricsSampler(
        sources({
          agents: () => after(HOST_SAMPLE_BUDGET_MS - 1, { working: 8, waiting: 0, idle: 0 }),
        })
      );
      const sampled = sampler.sample();
      await vi.advanceTimersByTimeAsync(HOST_SAMPLE_BUDGET_MS - 1);
      await expect(sampled).resolves.toMatchObject({
        agentsObserved: { working: 8, waiting: 0, idle: 0 },
      });
    });

    it("never starts a late read again while it runs, nor hands its answer to a later sample", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const sampler = new HostMetricsSampler(
        sources({
          agents: () => {
            calls += 1;
            return calls === 1
              ? after(6_000, { working: 1, waiting: 0, idle: 0 })
              : Promise.resolve({ working: 8, waiting: 0, idle: 0 });
          },
        })
      );
      const first = sampler.sample();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(first).resolves.toMatchObject({ agentsObserved: null });
      // Still running from the first sample: neither joined nor started twice.
      const second = sampler.sample();
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toMatchObject({ agentsObserved: null });
      expect(calls).toBe(1);
      // Settled at 6 s with an old tally, which no sample reports.
      await vi.advanceTimersByTimeAsync(1_000);
      const third = sampler.sample();
      await vi.advanceTimersByTimeAsync(0);
      await expect(third).resolves.toMatchObject({
        agentsObserved: { working: 8, waiting: 0, idle: 0 },
      });
      expect(calls).toBe(2);
    });

    it("starts a read that failed after the budget again", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const sampler = new HostMetricsSampler(
        sources({
          agents: () => {
            calls += 1;
            return calls === 1
              ? new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("pty host down")), 6_000)
                )
              : Promise.resolve({ working: 8, waiting: 0, idle: 0 });
          },
        })
      );
      const first = sampler.sample();
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(first).resolves.toMatchObject({ agentsObserved: null });
      const second = sampler.sample();
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toMatchObject({
        agentsObserved: { working: 8, waiting: 0, idle: 0 },
      });
      expect(calls).toBe(2);
    });

    it("leaves no budget timer behind", async () => {
      vi.useFakeTimers();
      await new HostMetricsSampler(sources()).sample();
      expect(vi.getTimerCount()).toBe(0);
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

  describe("swap activity", () => {
    const vmstat = (pswpin: number, pswpout: number) =>
      `pgpgin 1\npswpin ${pswpin}\npswpout ${pswpout}\n`;

    function linuxSampler(
      files: () => Record<string, string>,
      clock: () => number,
      pageSize = "4096\n"
    ) {
      const reads: string[] = [];
      const runs: string[] = [];
      const sampler = new HostMetricsSampler(
        sources({
          readText: async (path) => {
            reads.push(path);
            return files()[path] ?? null;
          },
          run: async (command) => {
            runs.push(command);
            return command === "/usr/bin/getconf" ? pageSize : null;
          },
          now: clock,
        })
      );
      return { sampler, reads, runs };
    }

    it("measures bytes per second between two readings of the machine's counters", async () => {
      let now = 1_000;
      let counters = vmstat(100, 50);
      const { sampler, runs } = linuxSampler(
        () => ({ "/proc/vmstat": counters }),
        () => now
      );
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: null,
      });
      now = 6_000;
      counters = vmstat(110, 50);
      // 10 pages of 4 KiB over five seconds; nothing went out.
      expect(await sampler.sample()).toMatchObject({
        metricsScope: "host",
        swapInBytesPerSec: 8192,
        swapOutBytesPerSec: 0,
      });
      expect(runs.filter((c) => c === "/usr/bin/getconf")).toHaveLength(1);
    });

    it("drops a direction whose counter went backwards, and both across a long gap", async () => {
      let now = 1_000;
      let counters = vmstat(100, 50);
      const { sampler } = linuxSampler(
        () => ({ "/proc/vmstat": counters }),
        () => now
      );
      await sampler.sample();
      now = 6_000;
      counters = vmstat(5, 60);
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: 8192,
      });
      now = 60_000;
      counters = vmstat(10, 70);
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: null,
      });
      now = 65_000;
      counters = vmstat(10, 70);
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: 0,
        swapOutBytesPerSec: 0,
      });
    });

    it("stays unknown without a page size, and stops asking after a few tries", async () => {
      let now = 1_000;
      const { sampler, runs } = linuxSampler(
        () => ({ "/proc/vmstat": vmstat(100, 50) }),
        () => now,
        "garbage"
      );
      for (let i = 0; i < 5; i += 1) {
        expect(await sampler.sample()).toMatchObject({
          swapInBytesPerSec: null,
          swapOutBytesPerSec: null,
        });
        now += 5_000;
      }
      expect(runs.filter((c) => c === "/usr/bin/getconf")).toHaveLength(3);
    });

    it("measures a cgroup by its own memory.stat, never the machine's counters", async () => {
      const slice = "/sys/fs/cgroup/daintree";
      let now = 1_000;
      let stat = "anon 1\npswpin 0\npswpout 0\n";
      const { sampler, reads } = linuxSampler(
        () => ({
          "/proc/self/cgroup": "0::/daintree\n",
          [`${slice}/memory.max`]: "1073741824",
          [`${slice}/memory.stat`]: stat,
          "/proc/vmstat": vmstat(now * 1000, now * 1000),
        }),
        () => now,
        "65536\n"
      );
      await sampler.sample();
      now = 6_000;
      stat = "anon 1\npswpin 0\npswpout 5\n";
      expect(await sampler.sample()).toMatchObject({
        metricsScope: "cgroup",
        swapInBytesPerSec: 0,
        swapOutBytesPerSec: 65536,
      });
      expect(reads).not.toContain("/proc/vmstat");
    });

    it("leaves a cgroup's activity unknown where its kernel doesn't count swap per cgroup", async () => {
      const slice = "/sys/fs/cgroup/daintree";
      let now = 1_000;
      const { sampler } = linuxSampler(
        () => ({
          "/proc/self/cgroup": "0::/daintree\n",
          [`${slice}/memory.max`]: "1073741824",
          [`${slice}/memory.stat`]: "anon 1\nfile 2\n",
          "/proc/vmstat": vmstat(now, now),
        }),
        () => now
      );
      await sampler.sample();
      now = 6_000;
      expect(await sampler.sample()).toMatchObject({
        metricsScope: "cgroup",
        swapInBytesPerSec: null,
        swapOutBytesPerSec: null,
      });
    });

    it("starts over when the scope or cgroup changes, rather than measuring across two counters", async () => {
      let now = 1_000;
      let dir: string | null = null;
      // One counter for every scope, always rising, so only the scope tells the readings apart.
      const counters = () => vmstat(now, now);
      const { sampler } = linuxSampler(
        () => ({
          "/proc/vmstat": counters(),
          ...(dir
            ? {
                "/proc/self/cgroup": `0::/${dir}\n`,
                [`/sys/fs/cgroup/${dir}/memory.max`]: "1073741824",
                [`/sys/fs/cgroup/${dir}/memory.stat`]: counters(),
              }
            : {}),
        }),
        () => now
      );
      const next = async () => {
        now += 5_000;
        return sampler.sample();
      };
      await sampler.sample();
      dir = "a";
      expect(await next()).toMatchObject({ metricsScope: "cgroup", swapInBytesPerSec: null });
      expect((await next()).swapInBytesPerSec).toBe(4096 * 1000);
      dir = "b";
      expect(await next()).toMatchObject({ metricsScope: "cgroup", swapInBytesPerSec: null });
      dir = null;
      expect(await next()).toMatchObject({ metricsScope: "host", swapInBytesPerSec: null });
      expect((await next()).swapInBytesPerSec).toBe(4096 * 1000);
    });

    it("asks getconf for the page size until it answers, then keeps the answer", async () => {
      let now = 1_000;
      const answers: Array<string | null> = [null, "65536\n"];
      const calls: string[][] = [];
      const sampler = new HostMetricsSampler(
        sources({
          readText: async (path) => (path === "/proc/vmstat" ? vmstat(now, 0) : null),
          run: async (command, args) => {
            calls.push([command, ...args]);
            return answers.shift() ?? null;
          },
          now: () => now,
        })
      );
      for (let i = 0; i < 4; i += 1) {
        await sampler.sample();
        now += 5_000;
      }
      expect(calls).toEqual([
        ["/usr/bin/getconf", "PAGESIZE"],
        ["/usr/bin/getconf", "PAGESIZE"],
      ]);
      // 5,000 pages of 64 KiB over five seconds.
      expect((await sampler.sample()).swapInBytesPerSec).toBe(65536 * 1000);
    });

    it("doesn't spend the page-size probes on a kernel without swap counters", async () => {
      const { sampler, runs } = linuxSampler(
        () => ({ "/proc/vmstat": "pgpgin 1\n" }),
        () => 1_000
      );
      await sampler.sample();
      expect(runs).not.toContain("/usr/bin/getconf");
    });

    it("measures a direction again once its missing counter comes back", async () => {
      let now = 1_000;
      let text = vmstat(100, 100);
      const { sampler } = linuxSampler(
        () => ({ "/proc/vmstat": text }),
        () => now
      );
      await sampler.sample();
      now = 6_000;
      text = "pswpout 105\n";
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: 4096,
      });
      now = 11_000;
      text = vmstat(120, 110);
      // A missing counter is unknown, never zero: no rate is measured from it.
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: 4096,
      });
      now = 16_000;
      text = vmstat(125, 110);
      expect((await sampler.sample()).swapInBytesPerSec).toBe(4096);
    });

    it("measures across up to three intervals and no further, and never across a stopped clock", async () => {
      for (const [gap, expected] of [
        [15_000, 4096],
        [15_001, null],
        [0, null],
        [-1_000, null],
      ] as const) {
        let now = 100_000;
        let text = vmstat(0, 0);
        const { sampler } = linuxSampler(
          () => ({ "/proc/vmstat": text }),
          () => now
        );
        await sampler.sample();
        now += gap;
        text = vmstat(15, 0);
        const rate = (await sampler.sample()).swapInBytesPerSec;
        if (expected === null) expect(rate).toBeNull();
        else expect(rate).toBeCloseTo(expected);
      }
    });

    it("forgets its baseline when a reading fails outright", async () => {
      let now = 1_000;
      let fail = false;
      const sampler = new HostMetricsSampler(
        sources({
          readText: async (path) => {
            if (fail && path === "/proc/self/cgroup") throw new Error("EIO");
            return path === "/proc/vmstat" ? vmstat(now, now) : null;
          },
          run: async () => "4096\n",
          now: () => now,
        })
      );
      await sampler.sample();
      now = 6_000;
      fail = true;
      expect(await sampler.sample()).toMatchObject({ swapInBytesPerSec: null });
      now = 11_000;
      fail = false;
      expect(await sampler.sample()).toMatchObject({ swapInBytesPerSec: null });
      now = 16_000;
      expect((await sampler.sample()).swapInBytesPerSec).toBeCloseTo((5_000 * 4096) / 5);
    });

    it("starts over when macOS reports a different page size", async () => {
      let now = 1_000;
      let pageSize = 16384;
      const sampler = new HostMetricsSampler(
        sources({
          platform: "darwin",
          run: async (command) =>
            command === "/usr/bin/vm_stat"
              ? `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)\nSwapins: ${now}.\nSwapouts: 0.\n`
              : null,
          now: () => now,
        })
      );
      await sampler.sample();
      now = 6_000;
      pageSize = 4096;
      expect((await sampler.sample()).swapInBytesPerSec).toBeNull();
      now = 11_000;
      expect((await sampler.sample()).swapInBytesPerSec).toBe(4096 * 1000);
    });

    it("measures macOS swap from vm_stat in the page size it reports", async () => {
      let now = 1_000;
      let swapins = 4000;
      const sampler = new HostMetricsSampler(
        sources({
          platform: "darwin",
          run: async (command) =>
            command === "/usr/bin/vm_stat"
              ? `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: ${swapins}.\nSwapouts: 9.\n`
              : null,
          now: () => now,
        })
      );
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: null,
        swapOutBytesPerSec: null,
      });
      now = 6_000;
      swapins = 4010;
      expect(await sampler.sample()).toMatchObject({
        swapInBytesPerSec: 32768,
        swapOutBytesPerSec: 0,
      });
    });
  });
});
