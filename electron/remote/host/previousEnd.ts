import type { PendingCrash } from "../../../shared/types/ipc/crashRecovery.js";
import type { HostPreviousEnd } from "../../../shared/types/remoteHosts.js";

/** The schema's bound, so a long note is cut here rather than dropped there. */
const MAX_PRESSURE_EVIDENCE_CHARS = 256;

let captured: HostPreviousEnd | undefined;

/**
 * What a pending crash record says about how the previous process ended, in
 * the shape a WELCOME carries. Nothing a planned quit leaves (it leaves no
 * record), and none of the record's stacks, paths or breadcrumbs. Pure.
 */
export function readHostPreviousEnd(pending: PendingCrash | null): HostPreviousEnd | undefined {
  const entry = pending?.entry;
  if (!entry) return undefined;
  const watchdog = entry.cause === "watchdog-deadlock";
  const crashCause = entry.crashCause ?? (watchdog ? "external-kill" : "unknown");
  const at =
    watchdog && typeof entry.watchdogKilledAt === "number"
      ? entry.watchdogKilledAt
      : entry.timestamp;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  const missedBeats = watchdog ? entry.watchdogMissedBeats : undefined;
  const evidence = watchdog ? entry.watchdogPressureEvidence?.trim() : undefined;
  return {
    crashCause,
    ...(watchdog && { cause: "watchdog-deadlock" as const }),
    ...(watchdog &&
      entry.watchdogKillReason !== undefined && { watchdogKillReason: entry.watchdogKillReason }),
    ...(typeof missedBeats === "number" && missedBeats > 0 && { missedBeats }),
    ...(evidence && { pressureEvidence: evidence.slice(0, MAX_PRESSURE_EVIDENCE_CHARS) }),
    at,
  };
}

/**
 * Taken once at boot, right after the crash marker is consumed and before a
 * recovery dialog can clear the pending record: it describes the process
 * before this one for as long as this one runs, however often Host mode is
 * switched off and on.
 */
export function captureHostPreviousEnd(pending: PendingCrash | null): void {
  captured = readHostPreviousEnd(pending);
}

export function getHostPreviousEnd(): HostPreviousEnd | undefined {
  return captured;
}
