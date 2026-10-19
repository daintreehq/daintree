import type { MemorySource } from "../../shared/types/memoryAccounting.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logWarn } from "./logger.js";

/**
 * One process-memory reading for every consumer (#13526, lesson #10497).
 *
 * On macOS both `ps` RSS and Electron's `workingSetSize` are resident size,
 * which drops every compressed and swapped page — under memory pressure they
 * read an order of magnitude low, exactly when anyone looks. Physical
 * footprint counts that memory, and the `mac-phys-footprint` addon reads it
 * per pid from the kernel ledger in microseconds, with no exec to time out.
 *
 * Elsewhere, and on macOS if the addon fails to load, readings stay on
 * resident memory and report `resident` as their source.
 */

export interface PhysFootprintReader {
  readPhysFootprints(pids: number[]): Array<number | null> | null;
  isAvailable(): boolean;
  getLoadError(): unknown;
}

let reader: PhysFootprintReader | null | undefined;

// A suite feeding made-up PIDs through the real reader would measure whatever
// live process holds them. Tests inject a reader.
function underTest(): boolean {
  return process.env.VITEST !== undefined;
}

function loadReader(): PhysFootprintReader | null {
  if (reader !== undefined) return reader;
  reader = null;
  if (process.platform !== "darwin" || underTest()) return reader;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("mac-phys-footprint") as PhysFootprintReader;
    if (mod.isAvailable()) {
      reader = mod;
    } else {
      logWarn("phys-footprint-unavailable", {
        error: formatErrorMessage(mod.getLoadError(), "unknown error"),
      });
    }
  } catch (err) {
    logWarn("phys-footprint-unavailable", { error: formatErrorMessage(err, "load failed") });
  }
  return reader;
}

/**
 * Physical footprint in KB for each pid that could be read, or null when the
 * reader is unavailable in this process. A pid missing from the map was
 * unreadable — another user's or a protected process, or one that exited
 * since it was listed — and the caller keeps its resident reading for it.
 */
export function readPhysFootprintsKb(pids: readonly number[]): Map<number, number> | null {
  const active = loadReader();
  if (!active) return null;
  const bytes = active.readPhysFootprints([...pids]);
  if (!bytes) return null;
  const kbByPid = new Map<number, number>();
  for (let i = 0; i < pids.length; i++) {
    const value = bytes[i];
    // Every live process has dirty pages; a zero is a failed read, not a reading.
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      kbByPid.set(pids[i]!, Math.round(value / 1024));
    }
  }
  return kbByPid;
}

// Keyed by the metric objects of one sweep, never by pid: a recycled pid in a
// later sweep must not inherit an earlier process's reading.
const footprintKbByMetric = new WeakMap<Electron.ProcessMetric, number>();
const footprintSweeps = new WeakSet<readonly Electron.ProcessMetric[]>();

/** Read the footprint of every process in one `app.getAppMetrics()` sweep, in one batch. */
export function attachPhysFootprints(metrics: Electron.ProcessMetric[]): void {
  const kbByPid = readPhysFootprintsKb(metrics.map((metric) => metric.pid));
  if (!kbByPid) return;
  footprintSweeps.add(metrics);
  for (const metric of metrics) {
    const kb = kbByPid.get(metric.pid);
    if (kb !== undefined) footprintKbByMetric.set(metric, kb);
  }
}

/**
 * Memory of one Electron process in KB: its physical footprint when the sweep
 * read one, else `workingSetSize` — the only field Electron reports on all
 * three platforms (`privateBytes` is Windows-only and 0 elsewhere, #8646).
 */
export function getProcessMemoryKb(metric: Electron.ProcessMetric): number {
  return footprintKbByMetric.get(metric) ?? metric.memory.workingSetSize;
}

export function getProcessMemoryMb(metric: Electron.ProcessMetric): number {
  return getProcessMemoryKb(metric) / 1024;
}

/** What {@link getProcessMemoryKb} measures for the processes of this sweep. */
export function getMetricsMemorySource(metrics: readonly Electron.ProcessMetric[]): MemorySource {
  return footprintSweeps.has(metrics) ? "footprint" : "resident";
}

export function setPhysFootprintReaderForTesting(next: PhysFootprintReader | null): void {
  reader = next;
}

export function resetPhysFootprintReaderForTesting(): void {
  reader = undefined;
}
