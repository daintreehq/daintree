import type { AgentState } from "../../../shared/types/agent.js";
import type { SleepRequestWorking } from "../../../shared/types/ipc/project.js";
import type { TerminalAgentObservation } from "../../../shared/types/panel.js";
import { readLastSeen } from "../../../shared/utils/restoreProvenance.js";

/** The fields of a host terminal record a stop observation is read from. */
export interface StoppedTerminal {
  id: string;
  launchAgentId?: string;
  agentState?: AgentState;
  lastStateChange?: number;
  spawnedAt?: number;
  agentIncarnation?: number;
  isExited?: boolean;
}

/** No project has this many agents; anything past it is not a real request. */
const MAX_REQUEST_ENTRIES = 1_000;

/**
 * What to record of each pane a quit or Sleep is stopping (#17886), read off
 * the host's inventory just before the kill. A renderer save can land after
 * the kill carrying the states the quit keys themselves caused, so the
 * renderer's last report is no record of what the agent was doing.
 *
 * An agent the user's Sleep request found working keeps that reading, unless
 * another process or agent run has taken the pane since: a Sleep that waited for it
 * to settle must not turn it into one that was idle all along. A stopped pane
 * with no usable reading maps to `null`: whatever an earlier stop left on it
 * no longer describes it. A record whose process had already exited is no
 * process this stop stopped, and gets nothing: the host keeps such records
 * through a session-preserving Sleep, so a later quit still lists them.
 */
export function stopObservationsFor(
  stoppedIds: Iterable<string>,
  inventory: ReadonlyMap<string, StoppedTerminal>,
  workingAtRequest: readonly SleepRequestWorking[] = []
): Map<string, TerminalAgentObservation | null> {
  const requested = new Map(workingAtRequest.map((entry) => [entry.terminalId, entry]));
  const observations = new Map<string, TerminalAgentObservation | null>();
  for (const id of stoppedIds) {
    const terminal = inventory.get(id);
    if (terminal?.isExited === true) continue;
    if (!terminal?.launchAgentId) {
      observations.set(id, null);
      continue;
    }
    const request = requested.get(id);
    const sameRun =
      request !== undefined &&
      request.spawnedAt === terminal.spawnedAt &&
      (request.agentIncarnation === undefined ||
        request.agentIncarnation === terminal.agentIncarnation);
    const observation = sameRun
      ? readLastSeen("working", request.at)
      : readLastSeen(terminal.agentState, terminal.lastStateChange);
    observations.set(id, observation ?? null);
  }
  return observations;
}

/** Whether there is a reading to write, as opposed to only older records to drop. */
export function hasStopReading(
  observations: ReadonlyMap<string, TerminalAgentObservation | null>
): boolean {
  for (const observation of observations.values()) if (observation) return true;
  return false;
}

/**
 * Write each observation onto the saved snapshot of the same pane, in place,
 * and drop an older one where there is none. Returns whether anything changed.
 * Callers write only when there is a reading or a captured id to write: a drop
 * alone never earns a write, which keeps a stop with nothing to say off disk.
 */
export function applyStopObservations(
  snapshots: ReadonlyArray<{ id: string; stopObservation?: TerminalAgentObservation }>,
  observations: ReadonlyMap<string, TerminalAgentObservation | null>
): boolean {
  let changed = false;
  for (const snapshot of snapshots) {
    if (!observations.has(snapshot.id)) continue;
    const observation = observations.get(snapshot.id);
    if (observation) {
      snapshot.stopObservation = observation;
      changed = true;
    } else if (snapshot.stopObservation !== undefined) {
      delete snapshot.stopObservation;
      changed = true;
    }
  }
  return changed;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Read the renderer's list of agents its Sleep request found working; untrusted.
 * An entry whose process can't be told apart from a later one is dropped rather
 * than left to match whatever runs in the pane now.
 */
export function sanitizeWorkingAtRequest(value: unknown): SleepRequestWorking[] {
  if (!Array.isArray(value)) return [];
  const entries: SleepRequestWorking[] = [];
  for (const entry of value.slice(0, MAX_REQUEST_ENTRIES)) {
    if (entry === null || typeof entry !== "object") continue;
    const { terminalId, at, spawnedAt, agentIncarnation } = entry as Record<string, unknown>;
    if (typeof terminalId !== "string" || terminalId === "") continue;
    if (!isCount(spawnedAt)) continue;
    if (agentIncarnation !== undefined && !isCount(agentIncarnation)) continue;
    const reading = readLastSeen("working", at);
    entries.push({
      terminalId,
      ...(reading?.at !== undefined && { at: reading.at }),
      spawnedAt,
      ...(agentIncarnation !== undefined && { agentIncarnation }),
    });
  }
  return entries;
}
