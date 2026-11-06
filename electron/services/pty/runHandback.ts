import { events } from "../events.js";
import type { HandbackHit } from "./HandbackDetector.js";
import type { TerminalInfo } from "./types.js";

/**
 * Tells Main a marker printed for a run's request (#15982, #16171), with the
 * incarnation that printed it: a scheduled run's launch, which the run history
 * settles on its own launch code alone, or a prompt to a terminal armed with a
 * When done choice, which Main acts on only for the code it minted for that
 * terminal's outstanding request. Called where a capture retires the code, as every
 * handback request's last look does: a marker seen outside `working`, or the
 * agent's settle. A marker drafted mid-reply is no report until then, and the
 * agent's state never stands in for one. Nothing for any other request, which
 * reports through the ordinary handback events.
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
