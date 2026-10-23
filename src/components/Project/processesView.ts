import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import type {
  ClosedProcessKillTarget,
  ClosedProcessOrigin,
  ProcessCleanupReport,
  ProcessInventoryClosedProcess,
  ProcessInventoryPluginProcess,
  ProcessInventoryTerminal,
  ProcessTreeSample,
} from "@shared/types/processes";
import type {
  RendererTerminalBufferEntry,
  RendererTerminalBufferSlice,
  RendererTerminalBufferStatus,
} from "@shared/types/memoryAccounting";
import { pluralize } from "@/lib/pluralize";
import { formatCores } from "./ProjectResourceBadge.utils";

export interface TerminalGroup {
  key: string;
  label: string;
  terminals: ProcessInventoryTerminal[];
}

const UNOWNED_KEY = "\u0000unowned";

/** What the row is, as observed — the launch hint only when nothing was detected. */
export function describeTerminalKind(terminal: ProcessInventoryTerminal): string {
  if (terminal.isAssistantTerminal) return "Assistant";
  return getDefaultPanelTitle(
    terminal.kind ?? "terminal",
    terminal.detectedAgentId ?? terminal.launchAgentId
  );
}

export function terminalTitle(terminal: ProcessInventoryTerminal): string {
  return terminal.title?.trim() || describeTerminalKind(terminal);
}

export function pluginProcessTitle(process: ProcessInventoryPluginProcess): string {
  return process.source === "plugin-worker"
    ? `${process.pluginId} worker`
    : (process.label ?? process.pluginId);
}

/** What the list ranks by; either way the heaviest row is first and unsampled rows are last. */
export type ProcessSort = "memory" | "cpu";

function sampleMetric(sample: ProcessTreeSample | null, sort: ProcessSort): number {
  if (!sample) return -1;
  return sort === "cpu" ? sample.cpuPercent : sample.memoryKb;
}

function bySampleDesc(sort: ProcessSort) {
  return <T extends { sample: ProcessTreeSample | null }>(a: T, b: T): number =>
    sampleMetric(b.sample, sort) - sampleMetric(a.sample, sort);
}

/** Terminals by owning project, named groups first, heaviest rows first within each. */
export function groupTerminalsByProject(
  terminals: ProcessInventoryTerminal[],
  sort: ProcessSort = "memory"
): TerminalGroup[] {
  const groups = new Map<string, TerminalGroup>();
  for (const terminal of terminals) {
    const key = terminal.projectId ?? UNOWNED_KEY;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: terminal.projectId ? (terminal.projectName ?? "Unknown project") : "No project",
        terminals: [],
      };
      groups.set(key, group);
    }
    group.terminals.push(terminal);
  }
  for (const group of groups.values()) group.terminals.sort(bySampleDesc(sort));
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNOWNED_KEY) return 1;
    if (b.key === UNOWNED_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

export type ProjectProcessRow =
  | { kind: "live"; terminal: ProcessInventoryTerminal }
  | { kind: "closed"; closed: ClosedProcessGroup };

/** A project's live terminals and the processes its closed terminals left running. */
export interface ProjectProcessGroup {
  key: string;
  label: string;
  terminals: ProcessInventoryTerminal[];
  closed: ClosedProcessGroup[];
  /** Both kinds together, heaviest first, so the list reads as one ranking. */
  rows: ProjectProcessRow[];
}

function rowMetric(row: ProjectProcessRow, sort: ProcessSort): number {
  if (row.kind === "live") return sampleMetric(row.terminal.sample, sort);
  return (sort === "cpu" ? row.closed.cpuPercent : row.closed.memoryKb) ?? -1;
}

/**
 * Everything a project owns in one place: named projects first, "No project"
 * last, live terminals and closed leftovers ranked together by memory.
 */
export function groupProcessesByProject(
  terminals: ProcessInventoryTerminal[],
  closed: ClosedProcessGroup[],
  sort: ProcessSort = "memory"
): ProjectProcessGroup[] {
  const groups = new Map<string, ProjectProcessGroup>();
  const ensure = (key: string, label: string): ProjectProcessGroup => {
    let group = groups.get(key);
    if (!group) {
      group = { key, label, terminals: [], closed: [], rows: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const group of groupTerminalsByProject(terminals, sort)) {
    ensure(group.key, group.label).terminals.push(...group.terminals);
  }
  for (const group of closed) {
    const key = group.projectId ?? UNOWNED_KEY;
    ensure(
      key,
      group.projectId ? (group.projectLabel ?? "Unknown project") : "No project"
    ).closed.push(group);
  }
  for (const group of groups.values()) {
    group.rows = [
      ...group.terminals.map((terminal) => ({ kind: "live" as const, terminal })),
      ...group.closed.map((closed) => ({ kind: "closed" as const, closed })),
    ].sort((a, b) => rowMetric(b, sort) - rowMetric(a, sort));
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNOWNED_KEY) return 1;
    if (b.key === UNOWNED_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

export function sortPluginProcesses(
  processes: ProcessInventoryPluginProcess[],
  sort: ProcessSort = "memory"
): ProcessInventoryPluginProcess[] {
  return [...processes].sort(bySampleDesc(sort));
}

/**
 * Busy cores on the host that the listed Daintree-launched trees don't add up
 * to: the host's reading less every listed tree's, never below zero. Null when
 * the inventory is partial, truncated or unsampled, any listed row has no
 * reading, or the host reports no core count — a bound from missing rows could be wrong in either direction.
 * Per-tree readings are ps averages, so this is an approximation, not a
 * measurement of what else is running.
 */
export function unaccountedCores(
  inventory: {
    terminals: readonly ProcessInventoryTerminal[];
    closedTerminalProcesses: readonly ProcessInventoryClosedProcess[];
    plugins: readonly ProcessInventoryPluginProcess[];
    complete: boolean;
    samplesAvailable: boolean;
    truncated: boolean;
  },
  hostBusyCores: number | null
): number | null {
  if (hostBusyCores === null || !Number.isFinite(hostBusyCores)) return null;
  if (!inventory.complete || !inventory.samplesAvailable || inventory.truncated) return null;
  let listedPercent = 0;
  // A row with no reading is unknown, not idle: counting it as zero would inflate the remainder.
  for (const row of [...inventory.terminals, ...inventory.plugins]) {
    if (!row.sample) return null;
    listedPercent += row.sample.cpuPercent;
  }
  for (const process of inventory.closedTerminalProcesses) {
    if (process.cpuPercent === null) return null;
    listedPercent += process.cpuPercent;
  }
  return Math.max(0, hostBusyCores - listedPercent / 100);
}

export function formatApproxMemory(memoryKb: number): string {
  const mb = memoryKb / 1024;
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.max(1, Math.round(mb))} MB`;
}

/**
 * A terminal buffer estimate in bytes. Unlike {@link formatApproxMemory} it
 * keeps a real zero (an empty view holds no buffers) and says when a reading
 * is under a megabyte rather than rounding it up to one.
 */
export function formatBufferEstimate(bytes: number): string {
  if (bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.round(mb)} MB`;
}

/** One terminal's renderer buffer reading, with the freshness of the view it came from. */
export interface TerminalBufferReading extends RendererTerminalBufferEntry {
  status: Exclude<RendererTerminalBufferStatus, "unavailable">;
  ageMs: number | null;
  /** Views holding a buffer for this terminal; `estimatedBytes` sums them all. */
  copies: number;
}

/**
 * Terminal id → buffer reading. A terminal shown in two windows holds a
 * buffer in each, and both are memory: the estimate sums every copy, while
 * the line counts, width and age come from the freshest one.
 */
export function indexTerminalBuffers(
  slice: RendererTerminalBufferSlice | null | undefined
): ReadonlyMap<string, TerminalBufferReading> {
  const out = new Map<string, TerminalBufferReading & { sampledAt: number }>();
  for (const view of slice?.views ?? []) {
    if (view.status === "unavailable" || !view.terminals || view.sampledAt === null) continue;
    for (const entry of view.terminals) {
      const prev = out.get(entry.terminalId);
      const better =
        !prev ||
        (view.status === "fresh" && prev.status !== "fresh") ||
        (view.status === prev.status && view.sampledAt > prev.sampledAt);
      const totalBytes = (prev?.estimatedBytes ?? 0) + entry.estimatedBytes;
      const copies = (prev?.copies ?? 0) + 1;
      out.set(
        entry.terminalId,
        better
          ? {
              ...entry,
              status: view.status,
              ageMs: view.ageMs,
              sampledAt: view.sampledAt,
              estimatedBytes: totalBytes,
              copies,
            }
          : { ...prev, estimatedBytes: totalBytes, copies }
      );
    }
  }
  return out;
}

/** "Buffer ~25 MB est. · 10,000 + 40 lines × 182 cols", aged when not current. */
export function describeTerminalBuffer(reading: TerminalBufferReading): string {
  const lines =
    reading.alternateLines > 0
      ? `${reading.normalLines.toLocaleString()} + ${pluralize(reading.alternateLines, "line")}`
      : pluralize(reading.normalLines, "line");
  const copies = reading.copies > 1 ? ` · ${reading.copies} windows` : "";
  const base = `Buffer ${formatBufferEstimate(reading.estimatedBytes)} est.${copies} · ${lines} × ${reading.cols} cols`;
  return reading.status === "last-known" && reading.ageMs !== null
    ? `${base} · from ${formatAgo(reading.ageMs)}`
    : base;
}

/** A process tree's ps %cpu, where 100 is one core. */
export function formatCpu(cpuPercent: number): string {
  return formatCores(cpuPercent / 100);
}

/**
 * The tree's members by name, heaviest first and each name once — enough to say
 * what is running ("zsh, node, esbuild") without command lines.
 */
export function describeMembers(sample: ProcessTreeSample, limit = 4): string {
  const names: string[] = [];
  for (const member of [...sample.members].sort((a, b) => b.memoryKb - a.memoryKb)) {
    const name = member.comm.split(/[\\/]/).pop() || member.comm;
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, limit);
  const hidden = sample.processCount - shown.length;
  return hidden > 0 ? `${shown.join(", ")} +${hidden}` : shown.join(", ");
}

export function trashSecondsLeft(terminal: ProcessInventoryTerminal, now: number): number | null {
  if (!terminal.isTrashed || terminal.trashExpiresAt === undefined) return null;
  return Math.max(0, Math.ceil((terminal.trashExpiresAt - now) / 1000));
}

/** The recorded processes a closed terminal left running, as one row. */
export interface ClosedProcessGroup {
  key: string;
  title: string;
  projectId: string | null;
  projectLabel: string | null;
  closedAt: number;
  processes: ProcessInventoryClosedProcess[];
  /** Summed over processes the census still had a reading for. */
  memoryKb: number | null;
  cpuPercent: number | null;
}

/** What the record says the closed root was — never a guess at what it ran. */
export function describeClosedOrigin(origin: ClosedProcessOrigin | null): string {
  if (!origin) return "Closed terminal";
  if (origin.title?.trim()) return origin.title.trim();
  if (origin.kind === "plugin") return "Plugin terminal";
  return getDefaultPanelTitle(origin.panelKind ?? "terminal", origin.launchAgentId);
}

function originKey(process: ProcessInventoryClosedProcess): string {
  const { origin } = process;
  // Terminal ids are reused across restarts, so the spawn time is part of the
  // identity; the close time separates two lineages that share both.
  return origin
    ? `${origin.kind}:${origin.id}@${origin.spawnedAt ?? ""}#${process.closedAt}`
    : `unknown#${process.closedAt}`;
}

function sumMemory(processes: readonly ProcessInventoryClosedProcess[]): number | null {
  let total: number | null = null;
  for (const process of processes) {
    if (process.memoryKb === null) continue;
    total = (total ?? 0) + process.memoryKb;
  }
  return total;
}

function sumCpu(processes: readonly ProcessInventoryClosedProcess[]): number | null {
  let total: number | null = null;
  for (const process of processes) {
    if (process.cpuPercent === null) continue;
    total = (total ?? 0) + process.cpuPercent;
  }
  return total;
}

/** One row per closed terminal, heaviest first. */
export function groupClosedProcesses(
  processes: readonly ProcessInventoryClosedProcess[]
): ClosedProcessGroup[] {
  const groups = new Map<string, ClosedProcessGroup>();
  for (const process of processes) {
    const key = originKey(process);
    let group = groups.get(key);
    if (!group) {
      const projectId = process.origin?.projectId;
      group = {
        key,
        title: describeClosedOrigin(process.origin),
        projectId: projectId ?? null,
        projectLabel: projectId ? (process.projectName ?? "Unknown project") : null,
        closedAt: process.closedAt,
        processes: [],
        memoryKb: null,
        cpuPercent: null,
      };
      groups.set(key, group);
    }
    group.processes.push(process);
  }
  for (const group of groups.values()) {
    group.processes.sort((a, b) => (b.memoryKb ?? -1) - (a.memoryKb ?? -1));
    group.memoryKb = sumMemory(group.processes);
    group.cpuPercent = sumCpu(group.processes);
  }
  return [...groups.values()].sort((a, b) => (b.memoryKb ?? -1) - (a.memoryKb ?? -1));
}

/** Process names, heaviest first and each once: "node, esbuild +2". */
export function describeClosedMembers(
  processes: readonly ProcessInventoryClosedProcess[],
  limit = 3
): string {
  const names: string[] = [];
  for (const process of processes) {
    const name = process.comm || `PID ${process.pid}`;
    if (!names.includes(name)) names.push(name);
  }
  const shown = names.slice(0, limit);
  const hidden = processes.length - shown.length;
  return hidden > 0 ? `${shown.join(", ")} +${hidden}` : shown.join(", ");
}

/** "3 processes from closed terminals · ~1.2 GB" — what was seen, nothing more. */
export function describeClosedSummary(processes: readonly ProcessInventoryClosedProcess[]): string {
  const memoryKb = sumMemory(processes);
  const count = pluralize(processes.length, "process", "processes");
  return memoryKb === null
    ? `${count} from closed terminals`
    : `${count} from closed terminals · ${formatApproxMemory(memoryKb)}`;
}

export function closedProcessKey(process: ClosedProcessKillTarget): string {
  return `${process.pid}@${process.startTime}`;
}

export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

/**
 * What automatic cleanup of earlier sessions' processes saw, or null when it
 * found nothing and every check answered. Only what it observed.
 */
export function describeCleanupReport(report: ProcessCleanupReport | null): {
  text: string;
  severity: "neutral" | "warning";
} | null {
  if (!report) return null;
  const parts: string[] = [];
  if (report.ended > 0) {
    parts.push(
      `Ended ${pluralize(report.ended, "process", "processes")} left running by an earlier session.`
    );
  }
  if (report.stillRunning > 0) {
    parts.push(
      `${pluralize(report.stillRunning, "process was", "processes were")} still running after being signalled.`
    );
  }
  if (report.unchecked > 0) {
    parts.push(
      `Couldn't check ${pluralize(report.unchecked, "process", "processes")} recorded by an earlier session.`
    );
  }
  if (parts.length === 0) return null;
  return {
    text: parts.join(" "),
    severity: report.stillRunning > 0 || report.unchecked > 0 ? "warning" : "neutral",
  };
}
