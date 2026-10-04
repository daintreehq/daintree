import { getDefaultPanelTitle } from "@shared/config/panelKindRegistry";
import type {
  ProcessInventoryPluginProcess,
  ProcessInventoryTerminal,
  ProcessTreeSample,
} from "@shared/types/processes";

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
