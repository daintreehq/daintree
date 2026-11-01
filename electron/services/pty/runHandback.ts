import { events } from "../events.js";
import type { HandbackHit } from "./HandbackDetector.js";
import type { TerminalInfo } from "./types.js";

/**
 * Tells Main a scheduled run's launch marker printed (#15982), with the
 * incarnation that printed it, so the run history can settle the run on its
 * own launch code alone. Called from both places a marker is found, the output
 * as it arrives and the agent's settle; the history keeps the first. Nothing
 * for any other request, which reports through the ordinary handback events.
 */
export function reportRunHandback(
  terminal: Pick<TerminalInfo, "id" | "spawnedAt">,
  hit: HandbackHit,
  timestamp: number
): void {
  if (!hit.run) return;
  events.emit("agent:run-handback-observed", {
    terminalId: terminal.id,
    spawnedAt: terminal.spawnedAt,
    code: hit.code,
    report: hit.report,
    message: hit.handback.message,
    truncated: hit.handback.truncated,
    observedAt: hit.handback.observedAt,
    timestamp,
  });
}
