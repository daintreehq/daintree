import type { RemoteProcessInventory } from "../../../shared/types/ipc/hostMetrics.js";
import type {
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
import {
  MAX_PROCESS_CLOSED,
  MAX_PROCESS_LABEL,
  MAX_PROCESS_MEMBERS,
  MAX_PROCESS_PLUGINS,
  MAX_PROCESS_TERMINALS,
} from "./linkMethods.js";

/** The link schema's bound on names and titles. */
const MAX_TEXT = 1024;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function clipNullable(text: string | null, max: number): string | null {
  return text === null ? null : clip(text, max);
}

function boundSample(sample: ProcessTreeSample | null): ProcessTreeSample | null {
  if (!sample) return null;
  return {
    cpuPercent: sample.cpuPercent,
    memoryKb: sample.memoryKb,
    // The tree's own totals stay whole; only the members listed are cut.
    processCount: sample.processCount,
    members: sample.members.slice(0, MAX_PROCESS_MEMBERS).map((member) => ({
      pid: member.pid,
      comm: clip(member.comm, MAX_PROCESS_LABEL),
      cpuPercent: member.cpuPercent,
      memoryKb: member.memoryKb,
    })),
  };
}

/**
 * This host's inventory as it goes over a link: every list cut to its bound,
 * display text clipped, identities and paths left whole for the schema to
 * hold. A closed-process list at the pty-host's own cap may already be
 * missing some, so it counts as truncated too.
 */
export function boundProcessInventory(snapshot: ProcessInventorySnapshot): RemoteProcessInventory {
  const truncated =
    snapshot.terminals.length > MAX_PROCESS_TERMINALS ||
    snapshot.closedTerminalProcesses.length >= MAX_PROCESS_CLOSED ||
    snapshot.plugins.length > MAX_PROCESS_PLUGINS;
  return {
    terminals: snapshot.terminals.slice(0, MAX_PROCESS_TERMINALS).map((terminal) => ({
      ...terminal,
      title: terminal.title === undefined ? undefined : clip(terminal.title, MAX_TEXT),
      projectName: clipNullable(terminal.projectName, MAX_TEXT),
      sample: boundSample(terminal.sample),
    })),
    closedTerminalProcesses: snapshot.closedTerminalProcesses
      .slice(0, MAX_PROCESS_CLOSED)
      .map((closed) => ({
        ...closed,
        comm: clip(closed.comm, MAX_PROCESS_LABEL),
        projectName: clipNullable(closed.projectName, MAX_TEXT),
        origin: closed.origin && {
          ...closed.origin,
          title:
            closed.origin.title === undefined ? undefined : clip(closed.origin.title, MAX_TEXT),
        },
      })),
    cleanup: snapshot.cleanup,
    plugins: snapshot.plugins.slice(0, MAX_PROCESS_PLUGINS).map((plugin) => ({
      ...plugin,
      label: clipNullable(plugin.label, MAX_PROCESS_LABEL),
      sample: boundSample(plugin.sample),
    })),
    complete: snapshot.complete,
    samplesAvailable: snapshot.samplesAvailable,
    sampledAt: snapshot.sampledAt,
    truncated,
  };
}
