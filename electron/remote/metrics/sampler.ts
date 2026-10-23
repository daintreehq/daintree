import type {
  DriveLeaseHolder,
  HostDriverObservation,
  HostForgeObservation,
  HostMetricsSummary,
  HostPlatform,
} from "../../../shared/types/remoteHosts.js";
import type { SystemMemorySnapshot } from "../../utils/systemMemory.js";
import { LOCAL_HOST_ID, MAX_HOST_SUMMARY_DRIVERS } from "../../../shared/types/remoteHosts.js";
import {
  clusterCpuPercentBetween,
  cpuPercentBetween,
  parseCgroupMemory,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseMeminfo,
  parsePsi,
  parseDarwinCpuClusters,
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
  /** Activity Monitor style memory, the reading Daintree's own reclaim uses; null when unavailable. */
  systemMemorySnapshot(): SystemMemorySnapshot | null;
  /** `os.loadavg()`: the 1, 5 and 15 minute load averages. */
  loadavg(): number[];
  /** A small text file's contents, or null when it can't be read. */
  readText(path: string): Promise<string | null>;
  /** A command's stdout, or null when it failed or isn't there. No shell. */
  run(command: string, args: string[]): Promise<string | null>;
  /** Entries of a directory, or [] when it can't be listed. */
  listDir(path: string): Promise<string[]>;
  /** macOS thermal state from the power monitor; null elsewhere or unknown. */
  thermalState(): ThermalState | null;
  /** Null when the agents can't all be observed; never a partial tally. */
  agents(): Promise<ObservedAgents | null>;
  projects(): Promise<{ projectCount: number | null; worktreeCount: number | null }>;
  driver(): DriveLeaseHolder | null;
  /** Every project someone drives, newest control first; absent where nothing reports it. */
  drivers?(): HostDriverObservation[];
  agentClis(): Promise<Array<{ agentId: string; version: string | null }>>;
  /** This host's forge providers and their sign-in state; absent where nothing reports it. */
  forges?(): Promise<HostForgeObservation[]>;
  /**
   * Readers for one sample, so the reads they share (the project list) happen
   * once per sample rather than once per reader. Absent, the sampler uses the
   * plain readers above.
   */
  beginSample?(): SampleReaders;
  now(): number;
}

export type SampleReaders = Pick<HostSampleSources, "agents" | "projects" | "driver" | "drivers">;

const LINUX_THERMAL_DIR = "/sys/class/thermal";

/** Reads of the cluster layout before an unknown answer is taken as final: Intel Macs never have one. */
const CPU_CLUSTER_PROBES = 3;

interface CpuClusters {
  performance: number | null;
  efficiency: number | null;
}

const NO_CLUSTERS: CpuClusters = { performance: null, efficiency: null };

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
  /** Cluster sizes are hardware: kept once read, so only an unknown answer is asked again. */
  private clusters: CpuClusters | null = null;
  private clusterProbes = 0;

  constructor(private readonly sources: HostSampleSources) {}

  async sample(): Promise<HostMetricsSummary> {
    const s = this.sources;
    const cpus = s.cpus();
    const previousCpus = this.previousCpus;
    const cpuPercent = cpuPercentBetween(previousCpus, cpus);
    this.previousCpus = cpus;
    const readers: SampleReaders = s.beginSample?.() ?? s;

    const [clusters, memory, agents, projects, agentClis, forges] = await Promise.all([
      this.cpuClusters(),
      settle(() => (s.platform === "darwin" ? this.darwinMemory() : this.linuxMemory()), {
        memoryPressure: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        thermal: null,
        cpuPressure: null,
      }),
      // A failed read is unknown, not zero: zero working agents lets an update restart the host.
      settle<ObservedAgents | null>(() => readers.agents(), null),
      settle<{ projectCount: number | null; worktreeCount: number | null }>(
        () => readers.projects(),
        {
          projectCount: null,
          worktreeCount: null,
        }
      ),
      settle(() => s.agentClis(), []),
      // A failed read is unknown, never "not connected".
      settle<HostForgeObservation[] | null | undefined>(
        async () => (s.forges ? await s.forges() : undefined),
        null
      ),
    ]);

    let driver: DriveLeaseHolder | null;
    try {
      driver = readers.driver();
    } catch {
      driver = null;
    }
    // A failed read is unknown, never "nobody drives".
    let drivers: HostDriverObservation[] | null | undefined;
    try {
      drivers = readers.drivers?.().slice(0, MAX_HOST_SUMMARY_DRIVERS);
    } catch {
      drivers = null;
    }

    const clusterPercent = clusterCpuPercentBetween(
      previousCpus,
      cpus,
      clusters.efficiency,
      clusters.performance
    );

    return {
      hostId: LOCAL_HOST_ID,
      sampledAt: s.now(),
      platform: s.platform,
      cpuPercent,
      cpuLogicalCoreCount: cpus.length > 0 ? cpus.length : null,
      cpuLoadAverage1m: this.loadAverage1m(),
      cpuPerformanceCoreCount: clusters.performance,
      cpuEfficiencyCoreCount: clusters.efficiency,
      cpuPerformancePercent: clusterPercent.performance,
      cpuEfficiencyPercent: clusterPercent.efficiency,
      ...memory,
      agentsObserved: agents,
      projectCount: projects.projectCount,
      worktreeCount: projects.worktreeCount,
      driver,
      ...(drivers !== undefined ? { drivers } : {}),
      agentClis,
      ...(forges !== undefined ? { forges } : {}),
    };
  }

  private async darwinMemory() {
    const s = this.sources;
    const [level, swap] = await Promise.all([
      s.run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      s.run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    ]);
    const total = s.totalmem();
    const swapUsage = parseDarwinSwapUsage(swap);
    return {
      memoryPressure: parseDarwinPressureLevel(level),
      memoryTotalBytes: total > 0 ? total : null,
      memoryUsedBytes: total > 0 ? this.darwinUsedBytes(total) : null,
      swapUsedBytes: swapUsage?.usedBytes ?? null,
      swapTotalBytes: swapUsage?.totalBytes ?? null,
      thermal: s.thermalState(),
      cpuPressure: null,
    };
  }

  /**
   * Total less what Activity Monitor counts as available (free + purgeable +
   * file-backed), so file cache isn't read as used. Unknown, never the
   * cache-inclusive figure, when that reading isn't there.
   */
  private darwinUsedBytes(total: number): number | null {
    let snapshot: SystemMemorySnapshot | null;
    try {
      snapshot = this.sources.systemMemorySnapshot();
    } catch {
      return null;
    }
    if (!snapshot) return null;
    return Math.max(0, total - snapshot.availableMb * 1024 * 1024);
  }

  private loadAverage1m(): number | null {
    try {
      const value = this.sources.loadavg()[0];
      return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  private async cpuClusters(): Promise<CpuClusters> {
    if (this.sources.platform !== "darwin") return NO_CLUSTERS;
    if (this.clusters) return this.clusters;
    // A timed-out read under load isn't the hardware's answer, so a few samples ask again.
    if (this.clusterProbes >= CPU_CLUSTER_PROBES) return NO_CLUSTERS;
    this.clusterProbes += 1;
    const text = await settle(
      () =>
        this.sources.run("/usr/sbin/sysctl", [
          "-n",
          "hw.perflevel0.name",
          "hw.perflevel0.logicalcpu",
          "hw.perflevel1.name",
          "hw.perflevel1.logicalcpu",
        ]),
      null
    );
    this.clusters = parseDarwinCpuClusters(text);
    return this.clusters ?? NO_CLUSTERS;
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
