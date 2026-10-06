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
import { pluralize } from "@/lib/pluralize";

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

function byMemoryDesc<T extends { sample: ProcessTreeSample | null }>(a: T, b: T): number {
  return (b.sample?.memoryKb ?? -1) - (a.sample?.memoryKb ?? -1);
}

/** Terminals by owning project, named groups first, heaviest rows first within each. */
export function groupTerminalsByProject(terminals: ProcessInventoryTerminal[]): TerminalGroup[] {
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
  for (const group of groups.values()) group.terminals.sort(byMemoryDesc);
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNOWNED_KEY) return 1;
    if (b.key === UNOWNED_KEY) return -1;
    return a.label.localeCompare(b.label);
  });
}

export function sortPluginProcesses(
  processes: ProcessInventoryPluginProcess[]
): ProcessInventoryPluginProcess[] {
  return [...processes].sort(byMemoryDesc);
}

export function formatApproxMemory(memoryKb: number): string {
  const mb = memoryKb / 1024;
  if (mb >= 1024) return `~${(mb / 1024).toFixed(1)} GB`;
  return `~${Math.max(1, Math.round(mb))} MB`;
}

export function formatCpu(cpuPercent: number): string {
  return `${Math.round(cpuPercent)}% CPU`;
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
  projectLabel: string | null;
  closedAt: number;
  processes: ProcessInventoryClosedProcess[];
  /** Summed over processes the census still had a reading for. */
  memoryKb: number | null;
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
        projectLabel: projectId ? (process.projectName ?? "Unknown project") : null,
        closedAt: process.closedAt,
        processes: [],
        memoryKb: null,
      };
      groups.set(key, group);
    }
    group.processes.push(process);
  }
  for (const group of groups.values()) {
    group.processes.sort((a, b) => (b.memoryKb ?? -1) - (a.memoryKb ?? -1));
    group.memoryKb = sumMemory(group.processes);
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
