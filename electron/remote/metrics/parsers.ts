import type { HostMetricsSummary } from "../../../shared/types/remoteHosts.js";

/**
 * Pure readers for the numbers a host samples. Every one answers null when its
 * source is missing or unreadable, so the summary says "not measured" instead
 * of reporting a zero nobody saw.
 */

export type MemoryPressure = NonNullable<HostMetricsSummary["memoryPressure"]>;
export type ThermalState = NonNullable<HostMetricsSummary["thermal"]>;

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseDarwinPressureLevel(text: string | null): MemoryPressure | null {
  if (text === null) return null;
  switch (text.trim()) {
    case "1":
      return "normal";
    case "2":
      return "warn";
    case "4":
      return "critical";
    default:
      return null;
  }
}

export interface PsiReading {
  someAvg10: number;
}

/** `/proc/pressure/{memory,cpu}`: the `some avg10=` share of the last ten seconds. */
export function parsePsi(text: string | null): PsiReading | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("some ")) continue;
    const match = /(?:^|\s)avg10=(\d+(?:\.\d+)?)/.exec(line);
    if (!match) return null;
    const value = finiteOrNull(Number(match[1]));
    return value === null ? null : { someAvg10: value };
  }
  return null;
}

export interface MeminfoReading {
  totalBytes: number | null;
  availableBytes: number | null;
  swapTotalBytes: number | null;
  swapFreeBytes: number | null;
}

/** `/proc/meminfo`, whose sizes are in kB. */
export function parseMeminfo(text: string | null): MeminfoReading | null {
  if (text === null) return null;
  const fields = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line.trim());
    if (match) fields.set(match[1]!, Number(match[2]) * 1024);
  }
  if (fields.size === 0) return null;
  return {
    totalBytes: fields.get("MemTotal") ?? null,
    availableBytes: fields.get("MemAvailable") ?? null,
    swapTotalBytes: fields.get("SwapTotal") ?? null,
    swapFreeBytes: fields.get("SwapFree") ?? null,
  };
}

/** A cgroup v2 byte count or limit. "max" means unlimited and is null, as is anything unreadable. */
export function parseCgroupBytes(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return finiteOrNull(Number(trimmed));
}

/**
 * The cgroup v2 path of `/proc/self/cgroup` (`0::/system.slice/x.service`) as
 * its segments, empty for the mount root. Null when there is no v2 entry, so a
 * v1-only host isn't read as if it had one, or the path is one we won't follow.
 */
export function parseProcSelfCgroup(text: string | null): string[] | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).replace(/ \(deleted\)$/, "");
    if (!path.startsWith("/")) return null;
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "." || segment === "..")) return null;
    return segments;
  }
  return null;
}

/** `cpu.max` (`$MAX $PERIOD`) as the cores it allows; null for "max" or anything unreadable. */
export function parseCpuMax(text: string | null): number | null {
  if (text === null) return null;
  const match = /^(\d+)\s+(\d+)$/.exec(text.trim());
  if (!match) return null;
  const quota = Number(match[1]);
  const period = Number(match[2]);
  return quota > 0 && period > 0 ? finiteOrNull(quota / period) : null;
}

/** `cpuset.cpus.effective` (`0-3,8`) as a count of CPUs. */
export function parseCpuSetCount(text: string | null): number | null {
  if (text === null) return null;
  const ids = new Set<number>();
  const trimmed = text.trim();
  if (trimmed === "") return null;
  for (const part of trimmed.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) return null;
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    if (end < start || end - start > 65_536) return null;
    for (let id = start; id <= end; id += 1) ids.add(id);
  }
  return ids.size > 0 ? ids.size : null;
}

/** `cpu.stat`'s `usage_usec`: CPU time the cgroup has used, in microseconds. */
export function parseCgroupCpuUsageUsec(text: string | null): number | null {
  if (text === null) return null;
  const match = /^usage_usec\s+(\d+)$/m.exec(text);
  return match ? finiteOrNull(Number(match[1])) : null;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)`. */
export function parseDarwinSwapUsage(
  text: string | null
): { totalBytes: number; usedBytes: number } | null {
  if (text === null) return null;
  const read = (name: string): number | null => {
    const match = new RegExp(`${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)([BKMGT])`).exec(text);
    if (!match) return null;
    return finiteOrNull(Number(match[1]) * SIZE_UNITS[match[2]!]!);
  };
  const totalBytes = read("total");
  const usedBytes = read("used");
  if (totalBytes === null || usedBytes === null) return null;
  return { totalBytes: Math.round(totalBytes), usedBytes: Math.round(usedBytes) };
}

/** `/sys/class/thermal/thermal_zone*\/temp`, in millidegrees Celsius. */
export function parseThermalZoneTemp(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const celsius = Number(trimmed) / 1000;
  // Zones that aren't wired report nonsense such as -273 or 0; neither was measured.
  return celsius > 0 && celsius < 150 ? celsius : null;
}

export interface ThermalZoneReading {
  /** The directory name, such as `thermal_zone0`. */
  zone: string;
  /** The zone's `type` file: what the sensor is attached to. */
  type: string | null;
  celsius: number | null;
}

export interface ThermalObservation {
  celsius: number;
  /** "x86_pkg_temp (thermal_zone0)": the sensor type with its directory. */
  label: string;
}

/** CPU and SoC sensors say more about the machine's load than the board's ACPI zone. */
function thermalZoneTier(type: string | null): number {
  if (type === null) return 1;
  if (/^(x86_pkg_temp|cpu[-_]?thermal|soc[-_]?thermal)/i.test(type)) return 0;
  return type.toLowerCase() === "acpitz" ? 2 : 1;
}

/** The hottest zone of the most CPU-like type, reported as the kernel names it. */
export function pickThermalZone(zones: readonly ThermalZoneReading[]): ThermalObservation | null {
  let best: { zone: ThermalZoneReading; tier: number } | null = null;
  for (const zone of zones) {
    if (zone.celsius === null) continue;
    const tier = thermalZoneTier(zone.type);
    if (
      !best ||
      tier < best.tier ||
      (tier === best.tier &&
        (zone.celsius > best.zone.celsius! ||
          (zone.celsius === best.zone.celsius && zone.zone < best.zone.zone)))
    ) {
      best = { zone, tier };
    }
  }
  if (!best) return null;
  const { zone } = best;
  return {
    celsius: zone.celsius!,
    label: zone.type ? `${zone.type} (${zone.zone})` : zone.zone,
  };
}

/**
 * `ioreg -r -d 1 -c IOAccelerator`: the GPU's `"Device Utilization %"` from its
 * `PerformanceStatistics`. Only some models report it; the highest across
 * accelerators wins, and a machine that reports none is unmeasured.
 */
export function parseIoregGpuUtilization(text: string | null): number | null {
  if (text === null) return null;
  let highest: number | null = null;
  for (const match of text.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    highest = highest === null ? value : Math.max(highest, value);
  }
  return highest;
}

export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/**
 * Busy share of every core between two `os.cpus()` readings. Null for the
 * first reading, a changed core count, or an interval with no ticks.
 */
export function cpuPercentBetween(
  previous: readonly CpuTimes[] | null,
  next: readonly CpuTimes[]
): number | null {
  if (!previous || previous.length === 0 || previous.length !== next.length) return null;
  let busy = 0;
  let total = 0;
  for (let i = 0; i < next.length; i += 1) {
    const a = previous[i]!;
    const b = next[i]!;
    const idle = b.idle - a.idle;
    const used = b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq);
    if (idle < 0 || used < 0) return null;
    busy += used;
    total += used + idle;
  }
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, (busy / total) * 100));
}

function parseCoreCount(text: string | undefined): number | null {
  if (!text || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Apple Silicon cluster sizes from `sysctl -n hw.perflevel0.name
 * hw.perflevel0.logicalcpu hw.perflevel1.name hw.perflevel1.logicalcpu`.
 * Only the Performance + Efficiency layout counts: other chips name their
 * levels differently (M5 Pro/Max report Super and Performance), and Intel Macs
 * have no perflevels at all, so anything else is null rather than relabelled.
 */
export function parseDarwinCpuClusters(
  text: string | null
): { performance: number; efficiency: number } | null {
  if (text === null) return null;
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines.length !== 4 || lines[0] !== "Performance" || lines[2] !== "Efficiency") return null;
  const performance = parseCoreCount(lines[1]);
  const efficiency = parseCoreCount(lines[3]);
  return performance !== null && efficiency !== null ? { performance, efficiency } : null;
}

/**
 * Busy share of each Apple Silicon cluster between two `os.cpus()` readings.
 * libuv lists cores in kernel logical-cpu-id order, which on Apple Silicon puts
 * the efficiency cluster first (`ioreg -p IODeviceTree` reports `cluster-type`
 * E for the lowest ids). That holds only while the cluster sizes account for
 * every core, so any mismatch leaves both shares null rather than guessing.
 */
export function clusterCpuPercentBetween(
  previous: readonly CpuTimes[] | null,
  next: readonly CpuTimes[],
  efficiencyCores: number | null,
  performanceCores: number | null
): { efficiency: number | null; performance: number | null } {
  const unknown = { efficiency: null, performance: null };
  if (!efficiencyCores || !performanceCores) return unknown;
  if (efficiencyCores + performanceCores !== next.length) return unknown;
  if (!previous || previous.length !== next.length) return unknown;
  return {
    efficiency: cpuPercentBetween(
      previous.slice(0, efficiencyCores),
      next.slice(0, efficiencyCores)
    ),
    performance: cpuPercentBetween(previous.slice(efficiencyCores), next.slice(efficiencyCores)),
  };
}
