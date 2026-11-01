import {
  MAX_HOST_SUMMARY_DRIVERS,
  type HostDriverObservation,
  type HostId,
  type HostMetricsSummary,
} from "@shared/types/remoteHosts";
import { busyCores, reportedCapacity, reportsMemoryCapacity } from "@shared/utils/hostCapacity";
import type { HostMenuRow } from "../hostModel";
import { formatHostTime } from "../hostTime";
import { formatBytes } from "@/lib/formatBytes";
import { pluralize, pluralNoun } from "@/lib/pluralize";
import { formatCoreCount } from "@/components/Project/ProjectResourceBadge.utils";

export { busyCores, reportsMemoryCapacity };

/** A pressure band drawn on the same 0–100 axis as CPU, so both sparklines read alike. */
const PRESSURE_LEVEL: Record<NonNullable<HostMetricsSummary["memoryPressure"]>, number> = {
  normal: 0,
  warn: 50,
  critical: 100,
};

/** Oldest first, for drawing. Unmeasured samples stay gaps rather than zeros. */
export function cpuSeries(history: readonly HostMetricsSummary[]): Array<number | null> {
  return [...history].reverse().map((entry) => entry.cpuPercent);
}

export function pressureSeries(history: readonly HostMetricsSummary[]): Array<number | null> {
  return [...history]
    .reverse()
    .map((entry) => (entry.memoryPressure === null ? null : PRESSURE_LEVEL[entry.memoryPressure]));
}

/** Used memory as a share of total, oldest first; a sample missing either stays a gap. */
export function memoryUsedSeries(history: readonly HostMetricsSummary[]): Array<number | null> {
  return [...history].reverse().map(memoryUsedPercent);
}

function memoryUsedPercent(summary: HostMetricsSummary): number | null {
  const capacity = reportedCapacity(summary);
  return capacity && Math.min(100, Math.max(0, (capacity.used / capacity.total) * 100));
}

/** "6.4 of 14 cores" where the host reports its core count, "42%" otherwise; null when unmeasured. */
export function describeCpu(summary: HostMetricsSummary): string | null {
  const cores = busyCores(summary);
  if (cores) {
    // Two significant figures keeps a 0.001-core quota from reading as zero.
    const total =
      cores.total >= 10 ? Math.round(cores.total) : parseFloat(cores.total.toPrecision(2));
    return `${formatCoreCount(cores.busy)} of ${total} ${pluralNoun(total, "core")}`;
  }
  return summary.cpuPercent === null ? null : `${Math.round(summary.cpuPercent)}%`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * "20.1 / 36 GB": both numbers in the total's unit, so the two read against
 * each other at a glance. Null when the host didn't report both.
 */
export function describeMemoryCapacity(summary: HostMetricsSummary): string | null {
  const capacity = reportedCapacity(summary);
  if (!capacity) return null;
  const { used, total } = capacity;
  const unit = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(total) / Math.log(1024)));
  const scale = 1024 ** unit;
  const amount = (bytes: number) => String(parseFloat((bytes / scale).toFixed(1)));
  return `${amount(used)} / ${amount(total)} ${BYTE_UNITS[unit]}`;
}

const PRESSURE_WORD: Record<NonNullable<HostMetricsSummary["memoryPressure"]>, string> = {
  normal: "Normal",
  warn: "High",
  critical: "Critical",
};

/** The OS's pressure word on macOS; on Linux the kernel's own PSI reading, with no band put on it. */
export function describeMemoryPressure(summary: HostMetricsSummary): string | null {
  if (summary.memoryPressure !== null) return PRESSURE_WORD[summary.memoryPressure];
  return describeStall(summary.memoryPressureSomeAvg10);
}

function isFiniteReading(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function describeStall(pressure: number | null | undefined): string | null {
  if (!isFiniteReading(pressure)) return null;
  return `${parseFloat(pressure.toFixed(1))}% of the last 10 s stalled`;
}

/** The 1 minute load average as the OS reports it; null for a host that doesn't. */
export function describeLoad(summary: HostMetricsSummary): string | null {
  const load = summary.cpuLoadAverage1m;
  return load === null || load === undefined || !Number.isFinite(load) ? null : load.toFixed(2);
}

/** "Performance 62% · efficiency 18%" on Apple Silicon; null when neither cluster was read. */
export function describeCoreClusters(summary: HostMetricsSummary): {
  value: string;
  detail: string;
} | null {
  const read: Array<{ name: string; percent: number; count: number | null | undefined }> = [];
  for (const [name, percent, count] of [
    ["performance", summary.cpuPerformancePercent, summary.cpuPerformanceCoreCount],
    ["efficiency", summary.cpuEfficiencyPercent, summary.cpuEfficiencyCoreCount],
  ] as const) {
    if (typeof percent === "number" && Number.isFinite(percent))
      read.push({ name, percent, count });
  }
  if (read.length === 0) return null;
  const value = read.map(({ name, percent }) => `${name} ${Math.round(percent)}%`).join(" · ");
  const detail = read
    .map(({ name, percent, count }) =>
      count
        ? `${Math.round(percent)}% of ${count} ${name} cores busy`
        : `${name} cores ${Math.round(percent)}% busy`
    )
    .join(" · ");
  return { value: value.charAt(0).toUpperCase() + value.slice(1), detail };
}

/** Linux PSI: the share of the last 10 s some task waited for a CPU. Null off Linux. */
export function describeCpuPressure(summary: HostMetricsSummary): string | null {
  return describeStall(summary.cpuPressure);
}

/** "3.1 GB of 8 GB" under a Swap label, or null when the host doesn't report swap. */
export function describeSwap(summary: HostMetricsSummary): string | null {
  if (summary.swapTotalBytes === null) return null;
  if (summary.swapTotalBytes === 0) return "No swap";
  const used = summary.swapUsedBytes;
  return used === null
    ? formatBytes(summary.swapTotalBytes)
    : `${formatBytes(used)} of ${formatBytes(summary.swapTotalBytes)}`;
}

/**
 * "In 12 KB/s · out 0 B/s": swap moving now, which the used figure can't tell
 * from swap left over from last week. Null when neither direction was measured,
 * and when there's no swap and nothing moved.
 */
export function describeSwapActivity(summary: HostMetricsSummary): string | null {
  const read: string[] = [];
  let moved = false;
  for (const [name, rate] of [
    ["in", summary.swapInBytesPerSec],
    ["out", summary.swapOutBytesPerSec],
  ] as const) {
    if (!isFiniteReading(rate)) continue;
    read.push(`${name} ${formatBytes(rate)}/s`);
    if (rate > 0) moved = true;
  }
  if (read.length === 0 || (summary.swapTotalBytes === 0 && !moved)) return null;
  const value = read.join(" · ");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "4 GB of 16 GB": an older host's reading, which counts the file cache as used. */
export function describeMemory(summary: HostMetricsSummary): string | null {
  if (summary.memoryUsedBytes === null || summary.memoryTotalBytes === null) return null;
  return `${formatBytes(summary.memoryUsedBytes)} of ${formatBytes(summary.memoryTotalBytes)}`;
}

/** The OS's thermal word on macOS; on Linux the sensor's temperature and which sensor it was. */
export function describeThermal(summary: HostMetricsSummary): string | null {
  const thermal = summary.thermal;
  if (thermal !== null) return thermal.charAt(0).toUpperCase() + thermal.slice(1);
  const celsius = summary.temperatureCelsius;
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return null;
  const reading = `${parseFloat(celsius.toFixed(1))}°C`;
  return summary.temperatureZone ? `${reading} · ${summary.temperatureZone}` : reading;
}

/**
 * Observed agent counts, always labelled as observations; a failed read says
 * so, never 0. Waiting and blocked are the host's fleet bands, so a run at its
 * prompt with no reading is idle here; a host too old to band its runs gives
 * no waiting figure rather than its raw waits.
 */
export function describeObservedAgents(summary: HostMetricsSummary): string {
  if (!summary.agentsObserved) return "Agent activity unknown";
  const { working, idle } = summary.agentsObserved;
  const attention = summary.agentAttention;
  if (!attention) return `${working} working · ${idle} idle (observed)`;
  const blocked = attention.blocked > 0 ? ` · ${attention.blocked} blocked` : "";
  return `${working} working · ${attention.waiting} waiting${blocked} · ${attention.idle} idle (observed)`;
}

/** "2 open · 5 worktrees", with whichever count failed to read shown as unknown, never 0. */
export function describeProjects(summary: HostMetricsSummary): string {
  const { projectCount, worktreeCount } = summary;
  if (projectCount === null && worktreeCount === null) return "Unknown";
  const open = projectCount === null ? "? open" : `${projectCount} open`;
  const worktrees =
    worktreeCount === null ? "worktrees unknown" : pluralize(worktreeCount, "worktree");
  return `${open} · ${worktrees}`;
}

interface DriverLaunch {
  clientId: string;
  name: string;
  isHostLocal: boolean;
  /** Away from every project it holds. */
  away: boolean;
  /** When it first took control of one of them. */
  since: number;
}

/** One entry per launch: two windows of one launch drive as one, two launches of a machine as two. */
function driverLaunches(drivers: readonly HostDriverObservation[]): DriverLaunch[] {
  const byClient = new Map<string, DriverLaunch>();
  for (const { holder, state } of drivers) {
    const known = byClient.get(holder.clientId);
    if (known) {
      known.away = known.away && state === "away";
      known.since = Math.min(known.since, holder.acquiredAt);
      continue;
    }
    byClient.set(holder.clientId, {
      clientId: holder.clientId,
      name: holder.clientName,
      isHostLocal: holder.isHostLocal,
      away: state === "away",
      since: holder.acquiredAt,
    });
  }
  return [...byClient.values()];
}

function launchLabel(launch: DriverLaunch, all: readonly DriverLaunch[], now: number): string {
  if (launch.isHostLocal) return launch.away ? "its own screen (away)" : "its own screen";
  const notes: string[] = [];
  if (launch.away) notes.push("away");
  // Two launches of one machine share its name; when each took control tells them apart.
  const namesake = (other: DriverLaunch) =>
    other.clientId !== launch.clientId && !other.isHostLocal && other.name === launch.name;
  if (all.some(namesake)) {
    notes.push(`since ${formatHostTime(launch.since, now)}`);
  }
  return notes.length > 0 ? `${launch.name} (${notes.join(", ")})` : launch.name;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Who has control of the host's projects: every launch holding one, once, and
 * whether it is away inside its reservation, in the words the window banner
 * uses. A host from before `drivers` names only its newest holder.
 */
export function describeDriver(summary: HostMetricsSummary): string | null {
  const drivers = summary.drivers;
  if (!drivers) {
    const driver = summary.driver;
    if (!driver) return null;
    return driver.isHostLocal ? "Its own screen has control" : `${driver.clientName} has control`;
  }
  const launches = driverLaunches(drivers);
  if (launches.length === 0) return null;
  const labels = launches.map((launch) => launchLabel(launch, launches, summary.sampledAt));
  // A machine's name keeps its own case; only "its own screen" opens a sentence.
  const names = joinNames(labels).replace(/^its own screen/, "Its own screen");
  return `${names} ${launches.length === 1 ? "has" : "have"} control`;
}

/**
 * Who drives these projects on the host, as its summary reports. Null when the
 * summary doesn't say: from before `drivers`, a failed read, or a list at its
 * cap, where a project missing from it may only have been cut. An empty answer
 * means the host reported the project undriven.
 */
export function describeProjectDriver(
  summary: HostMetricsSummary,
  projectIds: readonly string[]
): string | null {
  const drivers = summary.drivers;
  if (!drivers) return null;
  const mine = drivers.filter((driver) => projectIds.includes(driver.projectId));
  if (mine.length === 0) return drivers.length >= MAX_HOST_SUMMARY_DRIVERS ? null : "";
  return describeDriver({ ...summary, drivers: mine });
}

/** Each driven project and who holds it, for the full wording behind {@link describeDriver}. */
export function describeDriverDetail(summary: HostMetricsSummary): string | undefined {
  const drivers = summary.drivers;
  if (!drivers || drivers.length === 0) return undefined;
  const launches = driverLaunches(drivers);
  return drivers
    .map(({ projectName, holder, state, awayUntil }) => {
      const launch = launches.find((entry) => entry.clientId === holder.clientId)!;
      const who = launchLabel({ ...launch, away: false }, launches, summary.sampledAt);
      const away =
        state !== "away"
          ? ""
          : awayUntil === null
            ? ", away"
            : `, away until ${formatHostTime(awayUntil, summary.sampledAt)}`;
      return `${projectName ?? "Unknown project"}: ${who}${away}`;
    })
    .join("; ");
}

export function describeRtt(row: HostMenuRow): string | null {
  const connection = row.connection;
  if (connection?.status !== "connected" || connection.rttMs === null) return null;
  return `${Math.round(connection.rttMs)} ms`;
}

/** Whether the card's numbers are current: this machine, or a host whose link is up. */
export function isLive(row: HostMenuRow): boolean {
  return row.isLocal || row.connection?.status === "connected";
}

export interface PlacementCandidate {
  hostId: HostId;
  name: string;
  summary: HostMetricsSummary | null;
  /** This machine, or a remote host whose link is up now. */
  reachable: boolean;
}

export interface PlacementOption {
  hostId: HostId;
  name: string;
  /** What the host reported, worded as its card words it; never an interpretation. */
  facts: string;
  /** The same facts one per entry, for a caller that sets them apart. */
  parts: string[];
}

export interface PlacementComparison {
  /** Every candidate, in the order given: there is no ranking to sort by. */
  options: PlacementOption[];
  /** The one host with strictly more free cores and available memory than every other; else null. */
  suggestedHostId: HostId | null;
}

/** Cores whose difference is under the card's one-decimal display are the same count. */
const CORE_TIE = 0.05;
/** A difference of exactly the tie, as float arithmetic lands it, is still a tie. */
const FLOAT_SLACK = 1e-9;

interface FreeCapacity {
  hostId: HostId;
  freeCores: number;
  availableBytes: number;
  /** Null for a Linux host, whose raw PSI has no band to rank by: shown, not scored. */
  pressure: HostMetricsSummary["memoryPressure"];
}

function freeCapacity(candidate: PlacementCandidate, summary: HostMetricsSummary) {
  const cores = busyCores(summary);
  const memory = reportedCapacity(summary);
  const pressure = summary.memoryPressure;
  if (!cores || !memory) return null;
  if (pressure === null && !isFiniteReading(summary.memoryPressureSomeAvg10)) return null;
  return {
    hostId: candidate.hostId,
    freeCores: Math.max(0, cores.total - cores.busy),
    availableBytes: Math.max(0, memory.total - memory.used),
    pressure,
  } satisfies FreeCapacity;
}

function placementFactParts(candidate: PlacementCandidate): string[] {
  if (!candidate.reachable) return ["Not connected"];
  const summary = candidate.summary;
  if (!summary) return ["No measurements reported"];
  const memory = reportsMemoryCapacity(summary)
    ? describeMemoryCapacity(summary)
    : describeMemory(summary);
  const load = describeLoad(summary);
  return [
    `CPU ${describeCpu(summary) ?? "not measured"}`,
    `Memory ${memory ?? "not measured"}`,
    `Memory pressure ${describeMemoryPressure(summary) ?? "not measured"}`,
    ...(load ? [`Load (1 min) ${load}`] : []),
  ];
}

/**
 * What each host has free, side by side. A host is suggested only when every
 * reachable host with a reading reported free cores, available memory and a
 * memory pressure reading, and one of them has strictly more free cores and
 * more available memory than each of the others without a worse pressure band.
 * Linux reports raw PSI with no band, so a pair where either side has only PSI
 * is compared on cores and memory alone; the PSI is shown, never scored.
 * Otherwise the facts stand alone and the user picks. Nothing is blended into
 * a score, and observed agent activity is never a capacity claim. A host from
 * before the core count (see {@link reportsMemoryCapacity}) can't be compared,
 * so its presence withholds the suggestion.
 */
export function compareHostCapacity(
  candidates: readonly PlacementCandidate[]
): PlacementComparison {
  const options = candidates.map(({ hostId, name, ...rest }) => {
    const parts = placementFactParts({ hostId, name, ...rest });
    return { hostId, name, facts: parts.join(" · "), parts };
  });
  const compared: FreeCapacity[] = [];
  for (const candidate of candidates) {
    if (!candidate.reachable || !candidate.summary) continue;
    const capacity = freeCapacity(candidate, candidate.summary);
    if (!capacity) return { options, suggestedHostId: null };
    compared.push(capacity);
  }
  const leader = compared.find((host) =>
    compared.every(
      (peer) =>
        peer === host ||
        (host.freeCores - peer.freeCores > CORE_TIE + FLOAT_SLACK &&
          host.availableBytes > peer.availableBytes &&
          (host.pressure === null ||
            peer.pressure === null ||
            PRESSURE_RANK[host.pressure] <= PRESSURE_RANK[peer.pressure]))
    )
  );
  const suggested = leader && leader.pressure !== "critical" && compared.length > 1 ? leader : null;
  return { options, suggestedHostId: suggested?.hostId ?? null };
}

const PRESSURE_RANK: Record<NonNullable<HostMetricsSummary["memoryPressure"]>, number> = {
  normal: 0,
  warn: 1,
  critical: 2,
};
