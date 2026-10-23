import type { RemoteProcessInventory } from "../../../shared/types/ipc/hostMetrics.js";
import type {
  ProcessInventorySnapshot,
  ProcessTreeSample,
} from "../../../shared/types/processes.js";
import {
  MAX_PROCESS_CLOSED,
  MAX_PROCESS_INVENTORY_BYTES,
  MAX_PROCESS_LABEL,
  MAX_PROCESS_MEMBERS,
  MAX_PROCESS_PLUGINS,
  MAX_PROCESS_TERMINALS,
} from "./linkMethods.js";
import { encodeValue } from "../link/encoding.js";

/** The link schema's bound on names and titles. */
const MAX_TEXT = 1024;

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function clipNullable(text: string | null, max: number): string | null {
  return text === null ? null : clip(text, max);
}

function clipOptional(text: string | undefined, max: number): string | undefined {
  return text === undefined ? undefined : clip(text, max);
}

// An OS or Electron reading can come back negative or NaN; the Shell's schema takes neither.
function reading(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function readingOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundSample(sample: ProcessTreeSample | null): ProcessTreeSample | null {
  if (!sample) return null;
  return {
    cpuPercent: reading(sample.cpuPercent),
    memoryKb: reading(sample.memoryKb),
    // The tree's own totals stay whole; only the members listed are cut.
    processCount: Math.trunc(reading(sample.processCount)),
    members: sample.members.slice(0, MAX_PROCESS_MEMBERS).map((member) => ({
      pid: member.pid,
      comm: clip(member.comm, MAX_PROCESS_LABEL),
      cpuPercent: reading(member.cpuPercent),
      memoryKb: reading(member.memoryKb),
    })),
  };
}

/** What a row costs on the link, by its own encoder; one it can't encode never fits. */
function encodedBytes(row: unknown): number {
  try {
    return encodeValue(row).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Keep rows in order while they fit what is left of the byte budget. */
function withinBudget<T>(rows: T[], budget: { left: number }): T[] {
  const kept: T[] = [];
  for (const row of rows) {
    const bytes = encodedBytes(row);
    if (bytes > budget.left) {
      budget.left = 0;
      break;
    }
    budget.left -= bytes;
    kept.push(row);
  }
  return kept;
}

/**
 * This host's inventory as it goes over a link: every list cut to its bound
 * and the whole to a byte budget, display text clipped, readings a schema
 * would refuse zeroed, identities and paths left whole. A closed-process list
 * at the pty-host's own cap may already be missing some, so it counts as
 * truncated too.
 */
export function boundProcessInventory(snapshot: ProcessInventorySnapshot): RemoteProcessInventory {
  const terminals = snapshot.terminals.slice(0, MAX_PROCESS_TERMINALS).map((terminal) => ({
    ...terminal,
    title: clipOptional(terminal.title, MAX_TEXT),
    projectName: clipNullable(terminal.projectName, MAX_TEXT),
    sample: boundSample(terminal.sample),
  }));
  const plugins = snapshot.plugins.slice(0, MAX_PROCESS_PLUGINS).map((plugin) => ({
    ...plugin,
    label: clipNullable(plugin.label, MAX_PROCESS_LABEL),
    sample: boundSample(plugin.sample),
  }));
  const closed = snapshot.closedTerminalProcesses.slice(0, MAX_PROCESS_CLOSED).map((process) => ({
    ...process,
    comm: clip(process.comm, MAX_PROCESS_LABEL),
    memoryKb: readingOrNull(process.memoryKb),
    cpuPercent: readingOrNull(process.cpuPercent),
    projectName: clipNullable(process.projectName, MAX_TEXT),
    origin: process.origin && {
      ...process.origin,
      title: clipOptional(process.origin.title, MAX_TEXT),
    },
  }));

  // Live terminals first: they are what the view is for.
  const budget = { left: MAX_PROCESS_INVENTORY_BYTES };
  const keptTerminals = withinBudget(terminals, budget);
  const keptPlugins = withinBudget(plugins, budget);
  const keptClosed = withinBudget(closed, budget);

  return {
    terminals: keptTerminals,
    closedTerminalProcesses: keptClosed,
    cleanup: snapshot.cleanup,
    plugins: keptPlugins,
    complete: snapshot.complete,
    samplesAvailable: snapshot.samplesAvailable,
    sampledAt: snapshot.sampledAt,
    truncated:
      snapshot.terminals.length > keptTerminals.length ||
      snapshot.plugins.length > keptPlugins.length ||
      snapshot.closedTerminalProcesses.length > keptClosed.length ||
      snapshot.closedTerminalProcesses.length >= MAX_PROCESS_CLOSED,
  };
}
