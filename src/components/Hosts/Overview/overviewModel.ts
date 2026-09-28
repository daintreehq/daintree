import type { HostId, HostMetricsSummary } from "@shared/types/remoteHosts";
import type { HostMenuRow } from "../hostModel";

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

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** "3.1 GB of 8 GB swap", or null when the host doesn't report swap. */
export function describeSwap(summary: HostMetricsSummary): string | null {
  if (summary.swapTotalBytes === null) return null;
  if (summary.swapTotalBytes === 0) return "No swap";
  const used = summary.swapUsedBytes;
  return used === null
    ? `${formatBytes(summary.swapTotalBytes)} swap`
    : `${formatBytes(used)} of ${formatBytes(summary.swapTotalBytes)} swap`;
}

export function describeMemory(summary: HostMetricsSummary): string | null {
  if (summary.memoryUsedBytes === null || summary.memoryTotalBytes === null) return null;
  return `${formatBytes(summary.memoryUsedBytes)} of ${formatBytes(summary.memoryTotalBytes)} memory`;
}

export function describeThermal(summary: HostMetricsSummary): string | null {
  return summary.thermal === null ? null : `Thermal ${summary.thermal}`;
}

/** Observed agent counts, always labelled as observations; a failed read says so, never 0. */
export function describeObservedAgents(summary: HostMetricsSummary): string {
  if (!summary.agentsObserved) return "Agent activity unknown";
  const { working, waiting, idle } = summary.agentsObserved;
  return `${working} working · ${waiting} waiting · ${idle} idle (observed)`;
}

/** "2 open · 5 worktrees", with whichever count failed to read shown as unknown, never 0. */
export function describeProjects(summary: HostMetricsSummary): string {
  const { projectCount, worktreeCount } = summary;
  if (projectCount === null && worktreeCount === null) return "Unknown";
  const open = projectCount === null ? "? open" : `${projectCount} open`;
  const worktrees = worktreeCount === null ? "worktrees unknown" : `${worktreeCount} worktrees`;
  return `${open} · ${worktrees}`;
}

export function describeDriver(summary: HostMetricsSummary): string | null {
  const driver = summary.driver;
  if (!driver) return null;
  return driver.isHostLocal ? "Driven from its own screen" : `Driven from ${driver.clientName}`;
}

export function describeRtt(row: HostMenuRow): string | null {
  const connection = row.connection;
  if (connection?.status !== "connected" || connection.rttMs === null) return null;
  return `${Math.round(connection.rttMs)} ms link`;
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

export interface PlacementChoice {
  hostId: HostId;
  name: string;
  score: number;
  /** Why it ranks where it does, from the numbers it reported. */
  reason: string;
}

const PRESSURE_PENALTY: Record<NonNullable<HostMetricsSummary["memoryPressure"]>, number> = {
  normal: 0,
  warn: 40,
  critical: 100,
};
const WORKING_AGENT_PENALTY = 15;
/**
 * What a measurement the host didn't report costs: as much as the worst it
 * could have been. A host with less evidence must never outrank one that
 * measured a light load.
 */
const UNMEASURED_PENALTY = 100;

/**
 * Least-loaded first, from what each reachable host last reported: its CPU,
 * memory pressure and observed working agents. A host that reported neither
 * CPU nor pressure can't be compared and is left out, as is one that can't
 * be reached. A missing measurement counts as the worst case, so partial data
 * sinks below full data; ties go to the host that reported more, then by name.
 * The result is a suggestion; the user always picks.
 */
export function rankPlacement(candidates: readonly PlacementCandidate[]): PlacementChoice[] {
  const ranked: Array<PlacementChoice & { missing: number }> = [];
  for (const candidate of candidates) {
    const summary = candidate.summary;
    if (!candidate.reachable || !summary) continue;
    if (summary.cpuPercent === null && summary.memoryPressure === null) continue;
    const working = summary.agentsObserved?.working ?? null;
    let score = 0;
    let missing = 0;
    const parts: string[] = [];
    if (summary.cpuPercent !== null) {
      score += summary.cpuPercent;
      parts.push(`CPU ${Math.round(summary.cpuPercent)}%`);
    } else {
      score += UNMEASURED_PENALTY;
      missing += 1;
      parts.push("CPU not reported");
    }
    if (summary.memoryPressure !== null) {
      score += PRESSURE_PENALTY[summary.memoryPressure];
      parts.push(`memory ${summary.memoryPressure}`);
    } else {
      score += UNMEASURED_PENALTY;
      missing += 1;
      parts.push("memory not reported");
    }
    if (working !== null) {
      score += working * WORKING_AGENT_PENALTY;
      parts.push(`${working} working (observed)`);
    } else {
      score += UNMEASURED_PENALTY;
      missing += 1;
      parts.push("agents unknown");
    }
    ranked.push({
      hostId: candidate.hostId,
      name: candidate.name,
      score,
      reason: parts.join(" · "),
      missing,
    });
  }
  return ranked
    .sort((a, b) => a.score - b.score || a.missing - b.missing || a.name.localeCompare(b.name))
    .map(({ missing: _missing, ...choice }) => choice);
}
