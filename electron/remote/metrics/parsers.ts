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

/** Share of time some task stalled on memory, mapped to the same three bands macOS reports. */
export const PSI_MEMORY_WARN_AVG10 = 10;
export const PSI_MEMORY_CRITICAL_AVG10 = 40;

export function psiToMemoryPressure(reading: PsiReading | null): MemoryPressure | null {
  if (!reading) return null;
  if (reading.someAvg10 >= PSI_MEMORY_CRITICAL_AVG10) return "critical";
  if (reading.someAvg10 >= PSI_MEMORY_WARN_AVG10) return "warn";
  return "normal";
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

export interface CgroupMemoryReading {
  usedBytes: number;
  limitBytes: number;
}

/**
 * cgroup v2 `memory.current` and `memory.max`. A limit of "max" means the
 * cgroup is not what bounds memory, so the machine's own numbers apply.
 */
export function parseCgroupMemory(
  current: string | null,
  max: string | null
): CgroupMemoryReading | null {
  if (current === null || max === null) return null;
  const limitText = max.trim();
  if (limitText === "max" || !/^\d+$/.test(limitText)) return null;
  const usedText = current.trim();
  if (!/^\d+$/.test(usedText)) return null;
  const limitBytes = Number(limitText);
  if (limitBytes <= 0) return null;
  return { usedBytes: Number(usedText), limitBytes };
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

/** The hottest zone mapped onto the bands macOS's own thermal state uses. */
export function thermalFromCelsius(hottest: number | null): ThermalState | null {
  if (hottest === null) return null;
  if (hottest >= 95) return "critical";
  if (hottest >= 85) return "serious";
  if (hottest >= 75) return "fair";
  return "nominal";
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
