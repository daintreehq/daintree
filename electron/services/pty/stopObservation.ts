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
 * to settle must not turn it into one that was idle all along. An agent with no
 * usable reading gets none; the restore that reads a record consumes it, so
 * there is no older one to correct.
 */
export function stopObservationsFor(
  terminals: Iterable<StoppedTerminal>,
  workingAtRequest: readonly SleepRequestWorking[] = []
): Map<string, TerminalAgentObservation> {
  const requested = new Map(workingAtRequest.map((entry) => [entry.terminalId, entry]));
  const observations = new Map<string, TerminalAgentObservation>();
  for (const terminal of terminals) {
    if (!terminal.launchAgentId) continue;
    const request = requested.get(terminal.id);
    const sameRun =
      request !== undefined &&
      (request.agentIncarnation === undefined ||
        request.agentIncarnation === terminal.agentIncarnation);
    const observation = sameRun
      ? readLastSeen("working", request.at)
      : readLastSeen(terminal.agentState, terminal.lastStateChange);
    if (observation) observations.set(terminal.id, observation);
  }
  return observations;
}

/**
 * Write each observation onto the saved snapshot of the same pane, in place.
 * Returns whether any pane was found to write it on.
 */
export function applyStopObservations(
  snapshots: ReadonlyArray<{ id: string; stopObservation?: TerminalAgentObservation }>,
  observations: ReadonlyMap<string, TerminalAgentObservation>
): boolean {
  let written = false;
  for (const snapshot of snapshots) {
    const observation = observations.get(snapshot.id);
    if (!observation) continue;
    snapshot.stopObservation = observation;
    written = true;
  }
  return written;
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
