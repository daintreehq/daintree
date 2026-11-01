import {
  TERMINAL_SPAWN_SOURCES,
  type ScheduledRunRef,
  type TerminalSpawnSource,
} from "../types/panel.js";

/**
 * A scheduled-run reference read from anywhere it could have been mangled: a
 * snapshot on disk, the session journal, an IPC payload. Both ids must be
 * non-empty strings, as `ScheduledRunSchema` requires; anything else is no
 * reference. Extra keys are dropped so a copy never carries more than the pair.
 */
export function readScheduledRunRef(value: unknown): ScheduledRunRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { scheduleId, runId } = value as { scheduleId?: unknown; runId?: unknown };
  if (typeof scheduleId !== "string" || scheduleId.length === 0) return undefined;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  return { scheduleId, runId };
}

function isTerminalSpawnSource(value: unknown): value is TerminalSpawnSource {
  return (TERMINAL_SPAWN_SOURCES as readonly unknown[]).includes(value);
}

export interface SpawnProvenance {
  spawnedBy?: TerminalSpawnSource;
  scheduledRun?: ScheduledRunRef;
}

/**
 * A terminal's provenance as it is read back (#15977). `"schedule"` and its
 * reference only ever come as a pair: a schedule source without a readable
 * reference loses both, and a reference on any other source is dropped. An
 * unrecognised source is no source, as the snapshot schema already reads it.
 * Losing the attribution never costs the pane.
 */
export function readSpawnProvenance(spawnedBy: unknown, scheduledRun: unknown): SpawnProvenance {
  if (!isTerminalSpawnSource(spawnedBy)) return {};
  if (spawnedBy !== "schedule") return { spawnedBy };
  const ref = readScheduledRunRef(scheduledRun);
  return ref ? { spawnedBy, scheduledRun: ref } : {};
}

/**
 * The provenance a launch stamps: a trusted scheduled run makes it a schedule
 * launch, and otherwise the caller's source stands, with `"schedule"` refused
 * since only the reference may claim it.
 */
export function launchSpawnProvenance(
  spawnedBy: TerminalSpawnSource | undefined,
  scheduledRun: ScheduledRunRef | undefined
): SpawnProvenance {
  const ref = readScheduledRunRef(scheduledRun);
  if (ref) return { spawnedBy: "schedule", scheduledRun: ref };
  return spawnedBy !== undefined && spawnedBy !== "schedule" ? { spawnedBy } : {};
}

/**
 * The scheduled run a captured session record names, spread into each record
 * built from a terminal: `{}` unless the terminal holds a readable reference.
 */
export function scheduledRunForRecord(terminal: {
  scheduledRun?: unknown;
}): { scheduledRun: ScheduledRunRef } | Record<string, never> {
  const ref = readScheduledRunRef(terminal.scheduledRun);
  return ref ? { scheduledRun: ref } : {};
}
