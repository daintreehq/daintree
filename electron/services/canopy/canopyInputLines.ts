import type { CanopyInputLineReading, CanopyRunTarget } from "../../../shared/types/ipc/canopy.js";
import type { TerminalInputLineState } from "../../../shared/types/terminalStatus.js";
import {
  inputSuggestionRuleFor,
  observeInputLine,
} from "../../../shared/utils/terminalInputLine.js";
import type { PtyClient } from "../PtyClient.js";

/** Screens read at once for one ask: a bulk trash names up to the trash's own limit. */
const READ_CONCURRENCY = 4;

export type InputLinePtyClient = Pick<PtyClient, "getTerminalAsync" | "getSerializedStateAsync">;

/**
 * What one run's input box holds, read off its screen alone. A run that is
 * gone, respawned, exited or unreadable reads as `unknown`: nothing was seen.
 */
async function readInputLine(
  ptyClient: InputLinePtyClient,
  target: CanopyRunTarget
): Promise<TerminalInputLineState> {
  const record = await ptyClient.getTerminalAsync(target.runId).catch(() => null);
  if (!record || record.spawnedAt !== target.spawnedAt || record.isExited === true) {
    return "unknown";
  }
  const snapshot = await ptyClient
    .getSerializedStateAsync(target.runId, { tailRows: 0 })
    .catch(() => null);
  if (!snapshot) return "unknown";
  // The two RPCs resolve the id separately: a respawn between them would hand
  // back another terminal's screen.
  const after = await ptyClient.getTerminalAsync(target.runId).catch(() => null);
  if (!after || after.spawnedAt !== target.spawnedAt || after.isExited === true) return "unknown";
  const rule = inputSuggestionRuleFor(after.detectedAgentId ?? after.launchAgentId);
  return observeInputLine(snapshot.data, rule).inputLine.state;
}

/**
 * The state of each run's input box, read here on the machine its terminal
 * runs on, so a bulk trash can leave a typed draft unticked. A run named twice
 * is read once.
 */
export async function readInputLines(
  ptyClient: InputLinePtyClient,
  targets: readonly CanopyRunTarget[]
): Promise<CanopyInputLineReading[]> {
  const unique = new Map<string, CanopyRunTarget>();
  for (const target of targets) {
    const key = `${target.runId}\u0000${target.spawnedAt}`;
    if (!unique.has(key)) unique.set(key, target);
  }
  const queue = [...unique.values()];
  const readings: CanopyInputLineReading[] = [];
  const worker = async () => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      readings.push({ runId: target.runId, state: await readInputLine(ptyClient, target) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, worker));
  return readings;
}
