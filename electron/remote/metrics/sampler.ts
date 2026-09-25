import type {
  DriveLeaseHolder,
  HostMetricsSummary,
  HostPlatform,
} from "../../../shared/types/remoteHosts.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import {
  cpuPercentBetween,
  parseCgroupMemory,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseMeminfo,
  parsePsi,
  parseThermalZoneTemp,
  psiToMemoryPressure,
  thermalFromCelsius,
  type CpuTimes,
  type ThermalState,
} from "./parsers.js";

/** How often a host samples and streams its summary. */
export const HOST_METRICS_INTERVAL_MS = 5_000;

export interface ObservedAgents {
  working: number;
  waiting: number;
  idle: number;
}

/** Where the sampler reads from; faked in tests, real in {@link createHostSampleSources}. */
export interface HostSampleSources {
  platform: HostPlatform;
  cpus(): CpuTimes[];
  totalmem(): number;
  freemem(): number;
  /** A small text file's contents, or null when it can't be read. */
  readText(path: string): Promise<string | null>;
  /** A command's stdout, or null when it failed or isn't there. No shell. */
  run(command: string, args: string[]): Promise<string | null>;
  /** Entries of a directory, or [] when it can't be listed. */
  listDir(path: string): Promise<string[]>;
  /** macOS thermal state from the power monitor; null elsewhere or unknown. */
  thermalState(): ThermalState | null;
  agents(): Promise<ObservedAgents>;
  projects(): Promise<{ projectCount: number; worktreeCount: number }>;
  driver(): DriveLeaseHolder | null;
  agentClis(): Promise<Array<{ agentId: string; version: string | null }>>;
  now(): number;
}

const LINUX_THERMAL_DIR = "/sys/class/thermal";

async function settle<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/**
 * Samples this machine's load without root: CPU from core-time deltas, memory
 * pressure, memory and swap use, thermal state, and what its agents, projects
 * and drive lease look like. Anything a platform doesn't expose is null.
 */
export class HostMetricsSampler {
  private previousCpus: CpuTimes[] | null = null;

  constructor(private readonly sources: HostSampleSources) {}

  async sample(): Promise<HostMetricsSummary> {
    const s = this.sources;
    const cpus = s.cpus();
    const cpuPercent = cpuPercentBetween(this.previousCpus, cpus);
    this.previousCpus = cpus;

    const [memory, agents, projects, agentClis] = await Promise.all([
      settle(() => (s.platform === "darwin" ? this.darwinMemory() : this.linuxMemory()), {
        memoryPressure: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        thermal: null,
        cpuPressure: null,
      }),
      settle(() => s.agents(), { working: 0, waiting: 0, idle: 0 }),
      settle(() => s.projects(), { projectCount: 0, worktreeCount: 0 }),
      settle(() => s.agentClis(), []),
    ]);

    let driver: DriveLeaseHolder | null;
    try {
      driver = s.driver();
    } catch {
      driver = null;
    }

    return {
      hostId: LOCAL_HOST_ID,
      sampledAt: s.now(),
      platform: s.platform,
      cpuPercent,
      ...memory,
      agentsObserved: agents,
      projectCount: projects.projectCount,
      worktreeCount: projects.worktreeCount,
      driver,
      agentClis,
    };
  }

  private async darwinMemory() {
    const s = this.sources;
    const [level, swap] = await Promise.all([
      s.run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      s.run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    ]);
    const total = s.totalmem();
    const free = s.freemem();
    const swapUsage = parseDarwinSwapUsage(swap);
    return {
      memoryPressure: parseDarwinPressureLevel(level),
      memoryTotalBytes: total > 0 ? total : null,
      memoryUsedBytes: total > 0 ? Math.max(0, total - free) : null,
      swapUsedBytes: swapUsage?.usedBytes ?? null,
      swapTotalBytes: swapUsage?.totalBytes ?? null,
      thermal: s.thermalState(),
      cpuPressure: null,
    };
  }

  private async linuxMemory() {
    const s = this.sources;
    const [memPsi, cpuPsi, meminfoText, cgCurrent, cgMax, hottest] = await Promise.all([
      s.readText("/proc/pressure/memory"),
      s.readText("/proc/pressure/cpu"),
      s.readText("/proc/meminfo"),
      s.readText("/sys/fs/cgroup/memory.current"),
      s.readText("/sys/fs/cgroup/memory.max"),
      this.hottestThermalZone(),
    ]);
    const meminfo = parseMeminfo(meminfoText);
    const cgroup = parseCgroupMemory(cgCurrent, cgMax);
    let memoryTotalBytes: number | null = null;
    let memoryUsedBytes: number | null = null;
    if (cgroup) {
      // In a container the cgroup's limit is what the host's work actually has.
      memoryTotalBytes = cgroup.limitBytes;
      memoryUsedBytes = cgroup.usedBytes;
    } else if (meminfo?.totalBytes != null && meminfo.availableBytes != null) {
      memoryTotalBytes = meminfo.totalBytes;
      memoryUsedBytes = Math.max(0, meminfo.totalBytes - meminfo.availableBytes);
    }
    const swapTotal = meminfo?.swapTotalBytes ?? null;
    const swapFree = meminfo?.swapFreeBytes ?? null;
    return {
      memoryPressure: psiToMemoryPressure(parsePsi(memPsi)),
      memoryTotalBytes,
      memoryUsedBytes,
      swapTotalBytes: swapTotal,
      swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
      thermal: thermalFromCelsius(hottest),
      cpuPressure: parsePsi(cpuPsi)?.someAvg10 ?? null,
    };
  }

  private async hottestThermalZone(): Promise<number | null> {
    const s = this.sources;
    const zones = (await s.listDir(LINUX_THERMAL_DIR)).filter((name) =>
      /^thermal_zone\d+$/.test(name)
    );
    if (zones.length === 0) return null;
    const temps = await Promise.all(
      zones.map(async (zone) =>
        parseThermalZoneTemp(await s.readText(`${LINUX_THERMAL_DIR}/${zone}/temp`))
      )
    );
    let hottest: number | null = null;
    for (const temp of temps) {
      if (temp !== null) hottest = hottest === null ? temp : Math.max(hottest, temp);
    }
    return hottest;
  }
}
