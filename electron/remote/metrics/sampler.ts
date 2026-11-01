import type {
  DriveLeaseHolder,
  HostDriverObservation,
  HostForgeObservation,
  HostMetricsSummary,
} from "../../../shared/types/remoteHosts.js";
import type { SystemMemorySnapshot } from "../../utils/systemMemory.js";
import { LOCAL_HOST_ID, MAX_HOST_SUMMARY_DRIVERS } from "../../../shared/types/remoteHosts.js";
import {
  clusterCpuPercentBetween,
  cpuPercentBetween,
  parseCgroupBytes,
  parseCgroupCpuUsageUsec,
  parseCpuMax,
  parseCpuSetCount,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseMeminfo,
  parsePageSize,
  parseProcSelfCgroup,
  parsePsi,
  parseSwapPageCounters,
  parseVmStatPageSize,
  parseVmStatSwapCounters,
  parseDarwinCpuClusters,
  parseThermalZoneTemp,
  pickThermalZone,
  type CpuTimes,
  type SwapCounters,
  type ThermalState,
} from "./parsers.js";

/** How often a host samples and streams its summary. */
export const HOST_METRICS_INTERVAL_MS = 5_000;

/** How long one sample waits on its reads before reporting what hasn't come as unknown. */
export const HOST_SAMPLE_BUDGET_MS = 2_000;

export interface ObservedAgents {
  working: number;
  waiting: number;
  idle: number;
}

/** Where the sampler reads from; faked in tests, real in {@link createHostSampleSources}. */
export interface HostSampleSources {
  platform: HostMetricsSummary["platform"];
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
const CGROUP_ROOT = "/sys/fs/cgroup";
/** Deeper than any real hierarchy; past it the path is not followed. */
const MAX_CGROUP_DEPTH = 32;

/** Reads of the cluster layout before an unknown answer is taken as final: Intel Macs never have one. */
const CPU_CLUSTER_PROBES = 3;
/** Reads of the Linux page size before an unknown answer is taken as final. */
const PAGE_SIZE_PROBES = 3;
/**
 * Longer than this between two readings (a sleep, a stalled loop, a pause with
 * nobody listening) and what's measured across them averages the whole gap,
 * which says little about the load now.
 */
const MAX_READING_GAP_MS = 3 * HOST_METRICS_INTERVAL_MS;

interface CpuClusters {
  performance: number | null;
  efficiency: number | null;
}

const NO_CLUSTERS: CpuClusters = { performance: null, efficiency: null };

type HostMemoryFields = Pick<
  HostMetricsSummary,
  | "memoryPressure"
  | "memoryUsedBytes"
  | "memoryTotalBytes"
  | "swapUsedBytes"
  | "swapTotalBytes"
  | "swapInBytesPerSec"
  | "swapOutBytesPerSec"
  | "thermal"
  | "cpuPressure"
  | "metricsScope"
  | "memoryPressureSomeAvg10"
  | "temperatureCelsius"
  | "temperatureZone"
>;

const NO_MEMORY: HostMemoryFields = {
  memoryPressure: null,
  memoryUsedBytes: null,
  memoryTotalBytes: null,
  swapUsedBytes: null,
  swapTotalBytes: null,
  swapInBytesPerSec: null,
  swapOutBytesPerSec: null,
  thermal: null,
  cpuPressure: null,
};

const NO_SWAP_RATES = { swapInBytesPerSec: null, swapOutBytesPerSec: null };

/** CPU on a Linux host whose scope wasn't read: the machine's figures may not be what it has. */
const UNKNOWN_SCOPE_CPU: CgroupCpu = { cores: null, logicalCores: null, percent: null };

interface CgroupCpu {
  /** Cores the percentage is a share of, fractional under a quota. */
  cores: number | null;
  /** The same when whole: what a Shell that predates `cpuCapacityCores` reads. */
  logicalCores: number | null;
  percent: number | null;
}

function minimum(values: Array<number | null>): number | null {
  let lowest: number | null = null;
  for (const value of values) {
    if (value !== null && (lowest === null || value < lowest)) lowest = value;
  }
  return lowest;
}

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
  /** The core times at the last sample, which machine CPU is measured between. */
  private previousCpus: { at: number; cpus: CpuTimes[] } | null = null;
  /** Cluster sizes are hardware: kept once read, so only an unknown answer is asked again. */
  private clusters: CpuClusters | null = null;
  private clusterProbes = 0;
  /** The cgroup's CPU counter at the last sample, which its busy share is measured between. */
  private previousCgroupCpu: { dir: string; usec: number; at: number; cores: number } | null = null;
  /** The swap counters at the last sample, which swap activity is measured between. */
  private previousSwap: {
    scope: string;
    pageSize: number;
    at: number;
    counters: SwapCounters;
  } | null = null;
  private pageSize: number | null = null;
  private pageSizeProbes = 0;
  /** Reads still running past an earlier sample's budget. */
  private readonly lingering = new Set<string>();

  constructor(private readonly sources: HostSampleSources) {}

  async sample(): Promise<HostMetricsSummary> {
    const s = this.sources;
    const cpusAt = s.now();
    const cpus = s.cpus();
    const previous = this.previousCpus;
    // Core-time shares don't divide by the interval, so only a gap too long (or a clock that went
    // back, which hides how long) loses the baseline; the fresh reading starts the next one.
    const elapsedMs = previous ? cpusAt - previous.at : -1;
    const previousCpus =
      previous && elapsedMs >= 0 && elapsedMs <= MAX_READING_GAP_MS ? previous.cpus : null;
    const cpuPercent = cpuPercentBetween(previousCpus, cpus);
    this.previousCpus = { at: cpusAt, cpus };
    const readers: SampleReaders = s.beginSample?.() ?? s;

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      budgetTimer = setTimeout(resolve, HOST_SAMPLE_BUDGET_MS);
      budgetTimer.unref?.();
    });
    const [clusters, resources, agents, projects, agentClis, forges] = await Promise.all([
      this.withinBudget("clusters", budget, () => this.cpuClusters(), NO_CLUSTERS),
      this.withinBudget<{ memory: HostMemoryFields; cgroupCpu?: CgroupCpu | null } | null>(
        "resources",
        budget,
        async () => {
          try {
            if (s.platform === "darwin") return { memory: await this.darwinMemory() };
            if (s.platform === "win32") return { memory: this.windowsMemory() };
            return await this.linuxResources(cpus.length);
          } catch (error) {
            // A failed reading must not leave a baseline the next one is measured across.
            this.previousSwap = null;
            throw error;
          }
        },
        null
      ).then(
        (read) =>
          read ?? {
            memory: NO_MEMORY,
            ...(s.platform === "linux" ? { cgroupCpu: UNKNOWN_SCOPE_CPU } : {}),
          }
      ),
      // A failed or late read is unknown, not zero: zero working agents lets an update restart the host.
      this.withinBudget<ObservedAgents | null>("agents", budget, () => readers.agents(), null),
      this.withinBudget<{ projectCount: number | null; worktreeCount: number | null }>(
        "projects",
        budget,
        () => readers.projects(),
        { projectCount: null, worktreeCount: null }
      ),
      this.withinBudget("agentClis", budget, () => s.agentClis(), []),
      // A failed or late read is unknown, never "not connected".
      s.forges
        ? this.withinBudget<HostForgeObservation[] | null>(
            "forges",
            budget,
            () => s.forges!(),
            null
          )
        : undefined,
    ]).finally(() => clearTimeout(budgetTimer));

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

    // A cgroup's work is measured by its own counters: the machine-wide core times and load average
    // describe everything else running beside it.
    const cgroupCpu = resources.cgroupCpu;
    return {
      hostId: LOCAL_HOST_ID,
      sampledAt: s.now(),
      platform: s.platform,
      cpuPercent: cgroupCpu ? cgroupCpu.percent : cpuPercent,
      cpuLogicalCoreCount: cgroupCpu
        ? cgroupCpu.logicalCores
        : cpus.length > 0
          ? cpus.length
          : null,
      ...(cgroupCpu !== undefined
        ? { cpuCapacityCores: cgroupCpu ? cgroupCpu.cores : cpus.length > 0 ? cpus.length : null }
        : {}),
      cpuLoadAverage1m: cgroupCpu ? null : this.loadAverage1m(),
      cpuPerformanceCoreCount: clusters.performance,
      cpuEfficiencyCoreCount: clusters.efficiency,
      cpuPerformancePercent: clusterPercent.performance,
      cpuEfficiencyPercent: clusterPercent.efficiency,
      ...resources.memory,
      agentsObserved: agents,
      projectCount: projects.projectCount,
      worktreeCount: projects.worktreeCount,
      driver,
      ...(drivers !== undefined ? { drivers } : {}),
      agentClis,
      ...(forges !== undefined ? { forges } : {}),
    };
  }

  /**
   * A read's answer if it comes within this sample's budget, `unknown` if not.
   * A late read runs on, so the caches behind it are warm for a later sample,
   * but its answer is never taken by one: it would be older than that sample
   * says. Until it settles the read isn't started again.
   */
  private withinBudget<T>(
    key: string,
    budget: Promise<void>,
    read: () => Promise<T>,
    unknown: T
  ): Promise<T> {
    if (this.lingering.has(key)) return Promise.resolve(unknown);
    this.lingering.add(key);
    const answer = settle(read, unknown).finally(() => this.lingering.delete(key));
    return Promise.race([answer, budget.then(() => unknown)]);
  }

  private async darwinMemory() {
    const s = this.sources;
    const readAt = s.now();
    const [level, swap, vmStat] = await Promise.all([
      s.run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
      s.run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
      settle(() => s.run("/usr/bin/vm_stat", []), null),
    ]);
    const total = s.totalmem();
    const swapUsage = parseDarwinSwapUsage(swap);
    return {
      memoryPressure: parseDarwinPressureLevel(level),
      memoryTotalBytes: total > 0 ? total : null,
      memoryUsedBytes: total > 0 ? this.darwinUsedBytes(total) : null,
      swapUsedBytes: swapUsage?.usedBytes ?? null,
      swapTotalBytes: swapUsage?.totalBytes ?? null,
      ...this.swapRates(
        "darwin",
        parseVmStatSwapCounters(vmStat),
        parseVmStatPageSize(vmStat),
        readAt
      ),
      thermal: s.thermalState(),
      cpuPressure: null,
    };
  }

  /**
   * Only what the OS hands over without a Linux or macOS probe: the RAM size.
   * Use, swap, pressure and temperature stay unknown rather than borrowed.
   */
  private windowsMemory(): HostMemoryFields {
    const total = this.sources.totalmem();
    return { ...NO_MEMORY, memoryTotalBytes: total > 0 ? total : null };
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
    // Windows has no load average: Node returns [0, 0, 0] there, which is a stub, not a reading.
    if (this.sources.platform === "win32") return null;
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

  /**
   * One scope per summary. Where the Host's cgroup (or one of its ancestors)
   * caps memory, swap or CPUs, every figure comes from that cgroup and one
   * that can't be read is null, never the machine's. Otherwise all of it is
   * the machine's.
   */
  private async linuxResources(
    machineCores: number
  ): Promise<{ memory: HostMemoryFields; cgroupCpu: CgroupCpu | null }> {
    const s = this.sources;
    // Stamped before the reads, which take a variable time, so the interval doesn't absorb their delay.
    const readAt = s.now();
    const [thermal, cgroup] = await Promise.all([
      this.observedTemperature(),
      this.cgroupScope(machineCores),
    ]);
    const temperature = {
      temperatureCelsius: thermal?.celsius ?? null,
      temperatureZone: thermal?.label ?? null,
    };
    if (!cgroup) {
      this.previousCgroupCpu = null;
      const swapReadAt = s.now();
      const [memPsi, cpuPsi, meminfoText, vmstat] = await Promise.all([
        s.readText("/proc/pressure/memory"),
        s.readText("/proc/pressure/cpu"),
        s.readText("/proc/meminfo"),
        s.readText("/proc/vmstat"),
      ]);
      const swapCounters = parseSwapPageCounters(vmstat);
      const pageSize = await this.pageSizeFor(swapCounters);
      const meminfo = parseMeminfo(meminfoText);
      const swapTotal = meminfo?.swapTotalBytes ?? null;
      const swapFree = meminfo?.swapFreeBytes ?? null;
      const hasMemory = meminfo?.totalBytes != null && meminfo.availableBytes != null;
      return {
        memory: {
          memoryPressure: null,
          memoryTotalBytes: hasMemory ? meminfo!.totalBytes : null,
          memoryUsedBytes: hasMemory
            ? Math.max(0, meminfo!.totalBytes! - meminfo!.availableBytes!)
            : null,
          swapTotalBytes: swapTotal,
          swapUsedBytes: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null,
          ...this.swapRates("host", swapCounters, pageSize, swapReadAt),
          thermal: null,
          cpuPressure: parsePsi(cpuPsi)?.someAvg10 ?? null,
          memoryPressureSomeAvg10: parsePsi(memPsi)?.someAvg10 ?? null,
          metricsScope: "host",
          ...temperature,
        },
        cgroupCpu: null,
      };
    }

    const { dir } = cgroup;
    const swapReadAt = s.now();
    const [memCurrent, swapCurrent, memPsi, cpuPsi, cpuStat, meminfoText, memoryStat] =
      await Promise.all([
        s.readText(`${dir}/memory.current`),
        s.readText(`${dir}/memory.swap.current`),
        s.readText(`${dir}/memory.pressure`),
        s.readText(`${dir}/cpu.pressure`),
        s.readText(`${dir}/cpu.stat`),
        // Only the machine's RAM size, the ceiling of a cgroup with no memory limit of its own.
        cgroup.memoryLimit === null ? s.readText("/proc/meminfo") : Promise.resolve(null),
        // The cgroup's own counters; the machine-wide /proc/vmstat would count its neighbours' swapping.
        s.readText(`${dir}/memory.stat`),
      ]);
    const swapCounters = parseSwapPageCounters(memoryStat);
    const pageSize = await this.pageSizeFor(swapCounters);
    const cores = minimum([machineCores > 0 ? machineCores : null, cgroup.cpuQuota, cgroup.cpuSet]);
    return {
      memory: {
        memoryPressure: null,
        memoryTotalBytes: cgroup.memoryLimit ?? parseMeminfo(meminfoText)?.totalBytes ?? null,
        memoryUsedBytes: parseCgroupBytes(memCurrent),
        swapTotalBytes: cgroup.swapLimit,
        swapUsedBytes: parseCgroupBytes(swapCurrent),
        ...this.swapRates(`cgroup:${dir}`, swapCounters, pageSize, swapReadAt),
        thermal: null,
        cpuPressure: parsePsi(cpuPsi)?.someAvg10 ?? null,
        memoryPressureSomeAvg10: parsePsi(memPsi)?.someAvg10 ?? null,
        metricsScope: "cgroup",
        ...temperature,
      },
      cgroupCpu: {
        cores,
        logicalCores: cores !== null && Number.isInteger(cores) ? cores : null,
        percent: this.cgroupCpuPercent(dir, parseCgroupCpuUsageUsec(cpuStat), cores, readAt),
      },
    };
  }

  /**
   * The cgroup the Host runs in and the limits that bind it, or null when
   * nothing caps it. A limit can sit on any ancestor while the Host's own
   * cgroup says "max", so each limit is the tightest along the way up.
   */
  private async cgroupScope(machineCores: number): Promise<{
    dir: string;
    memoryLimit: number | null;
    swapLimit: number | null;
    cpuQuota: number | null;
    cpuSet: number | null;
  } | null> {
    const s = this.sources;
    const self = await s.readText("/proc/self/cgroup");
    // No membership file reads the mount root, which is where a container's own view starts.
    const segments = self === null ? [] : parseProcSelfCgroup(self);
    if (segments === null || segments.length > MAX_CGROUP_DEPTH) return null;
    const dirs: string[] = [];
    for (let depth = segments.length; depth >= 0; depth -= 1) {
      dirs.push([CGROUP_ROOT, ...segments.slice(0, depth)].join("/"));
    }
    const dir = dirs[0]!;
    const [limits, cpuSetText] = await Promise.all([
      Promise.all(
        dirs.map(async (d) => ({
          memory: parseCgroupBytes(await s.readText(`${d}/memory.max`)),
          swap: parseCgroupBytes(await s.readText(`${d}/memory.swap.max`)),
          cpu: parseCpuMax(await s.readText(`${d}/cpu.max`)),
        }))
      ),
      s.readText(`${dir}/cpuset.cpus.effective`),
    ]);
    const memoryLimit = minimum(limits.map((l) => l.memory));
    const swapLimit = minimum(limits.map((l) => l.swap));
    const cpuQuota = minimum(limits.map((l) => l.cpu));
    const cpuSetCount = parseCpuSetCount(cpuSetText);
    // A cpuset naming every core isn't a constraint; only a narrower one is.
    const cpuSet = cpuSetCount !== null && cpuSetCount < machineCores ? cpuSetCount : null;
    if (memoryLimit === null && swapLimit === null && cpuQuota === null && cpuSet === null) {
      return null;
    }
    return { dir, memoryLimit, swapLimit, cpuQuota, cpuSet };
  }

  /**
   * Busy share of the cgroup's cores between two `cpu.stat` readings; null
   * until there are two close enough together.
   */
  private cgroupCpuPercent(
    dir: string,
    usec: number | null,
    cores: number | null,
    at: number
  ): number | null {
    const previous = this.previousCgroupCpu;
    if (usec === null || cores === null) {
      this.previousCgroupCpu = null;
      return null;
    }
    this.previousCgroupCpu = { dir, usec, at, cores };
    if (!previous || previous.dir !== dir || previous.cores !== cores) return null;
    const elapsedUsec = (at - previous.at) * 1000;
    const used = usec - previous.usec;
    if (elapsedUsec <= 0 || elapsedUsec > MAX_READING_GAP_MS * 1000 || used < 0) return null;
    return Math.min(100, Math.max(0, (used / (elapsedUsec * cores)) * 100));
  }

  /**
   * Bytes per second swapped in and out between this reading and the last.
   * Null until there are two of the same scope and page size close enough
   * together, and for a direction whose counter is missing or went backwards.
   */
  private swapRates(
    scope: string,
    counters: SwapCounters | null,
    pageSize: number | null,
    at: number
  ): Pick<HostMemoryFields, "swapInBytesPerSec" | "swapOutBytesPerSec"> {
    const previous = this.previousSwap;
    if (counters === null || pageSize === null) {
      this.previousSwap = null;
      return NO_SWAP_RATES;
    }
    this.previousSwap = { scope, pageSize, at, counters };
    if (!previous || previous.scope !== scope || previous.pageSize !== pageSize) {
      return NO_SWAP_RATES;
    }
    const elapsedMs = at - previous.at;
    if (elapsedMs <= 0 || elapsedMs > MAX_READING_GAP_MS) return NO_SWAP_RATES;
    const rate = (now: number | null, before: number | null): number | null =>
      now === null || before === null || now < before
        ? null
        : ((now - before) * pageSize * 1000) / elapsedMs;
    return {
      swapInBytesPerSec: rate(counters.inPages, previous.counters.inPages),
      swapOutBytesPerSec: rate(counters.outPages, previous.counters.outPages),
    };
  }

  /**
   * The kernel's page size, which `/proc/vmstat` and `memory.stat` count swap
   * in. Asked only when there are counters to scale, so a kernel without them
   * doesn't spend the probes.
   */
  private async pageSizeFor(counters: SwapCounters | null): Promise<number | null> {
    if (counters === null) return null;
    if (this.pageSize !== null) return this.pageSize;
    if (this.pageSizeProbes >= PAGE_SIZE_PROBES) return null;
    this.pageSizeProbes += 1;
    this.pageSize = parsePageSize(
      await settle(() => this.sources.run("/usr/bin/getconf", ["PAGESIZE"]), null)
    );
    return this.pageSize;
  }

  private async observedTemperature() {
    const s = this.sources;
    const zones = (await s.listDir(LINUX_THERMAL_DIR)).filter((name) =>
      /^thermal_zone\d+$/.test(name)
    );
    if (zones.length === 0) return null;
    const readings = await Promise.all(
      zones.map(async (zone) => {
        const [type, temp] = await Promise.all([
          s.readText(`${LINUX_THERMAL_DIR}/${zone}/type`),
          s.readText(`${LINUX_THERMAL_DIR}/${zone}/temp`),
        ]);
        return {
          zone,
          type: type?.trim() || null,
          celsius: parseThermalZoneTemp(temp),
        };
      })
    );
    return pickThermalZone(readings);
  }
}
