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
  agentIncarnation?: number;
}

/** No project has this many agents; anything past it is not a real request. */
const MAX_REQUEST_ENTRIES = 1_000;

/**
 * What to record of each agent a quit or Sleep is stopping (#17886), read off
 * the host's inventory just before the kill. A renderer save can land after
 * the kill carrying the states the quit keys themselves caused, so the
 * renderer's last report is no record of what the agent was doing.
 *
 * An agent the user's Sleep request found working keeps that reading, unless
 * another run of an agent has taken the pane since: a Sleep that waited for it
 * to settle must not turn it into one that was idle all along. `undefined`
 * marks an agent whose reading is unusable, so an older record goes.
 */
export function stopObservationsFor(
  terminals: Iterable<StoppedTerminal>,
  workingAtRequest: readonly SleepRequestWorking[] = []
): Map<string, TerminalAgentObservation | undefined> {
  const requested = new Map(workingAtRequest.map((entry) => [entry.terminalId, entry]));
  const observations = new Map<string, TerminalAgentObservation | undefined>();
  for (const terminal of terminals) {
    if (!terminal.launchAgentId) continue;
    const request = requested.get(terminal.id);
    const sameRun =
      request !== undefined &&
      (request.agentIncarnation === undefined ||
        request.agentIncarnation === terminal.agentIncarnation);
    observations.set(
      terminal.id,
      sameRun
        ? readLastSeen("working", request.at)
        : readLastSeen(terminal.agentState, terminal.lastStateChange)
    );
  }
  return observations;
}

/**
 * Write each observation onto the saved snapshot of the same pane, in place.
 * Panes with no entry are left as they are. Returns whether anything changed.
 */
export function applyStopObservations(
  snapshots: ReadonlyArray<{ id: string; stopObservation?: TerminalAgentObservation }>,
  observations: ReadonlyMap<string, TerminalAgentObservation | undefined>
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

/** Read the renderer's list of agents its Sleep request found working; untrusted. */
export function sanitizeWorkingAtRequest(value: unknown): SleepRequestWorking[] {
  if (!Array.isArray(value)) return [];
  const entries: SleepRequestWorking[] = [];
  for (const entry of value.slice(0, MAX_REQUEST_ENTRIES)) {
    if (entry === null || typeof entry !== "object") continue;
    const { terminalId, at, agentIncarnation } = entry as Record<string, unknown>;
    if (typeof terminalId !== "string" || terminalId === "") continue;
    const reading = readLastSeen("working", at);
    entries.push({
      terminalId,
      ...(reading?.at !== undefined && { at: reading.at }),
      ...(typeof agentIncarnation === "number" &&
        Number.isSafeInteger(agentIncarnation) &&
        agentIncarnation >= 0 && { agentIncarnation }),
    });
  }
  return entries;
}
