import type { DecisionsRelayCheck } from "@shared/types/decisions";
import type { RelayUpdateEnd } from "./relayUpdate";
import type { RelayObservation } from "./relayCheckCopy";

/** Ctrl-C ends a process with this status in every shell the pane runs. */
const INTERRUPTED = 130;

/** The version the relay answered with when checked after the update, or null when that check saw none. */
export function relayVersionAfter(check: DecisionsRelayCheck | null): string | null {
  return check && "compatibility" in check ? check.compatibility.relay.workerVersion : null;
}

function versionNow(fromVersion: string, toVersion: string | null): string {
  if (toVersion === null) return "Daintree couldn't read the relay's version afterwards.";
  return toVersion === fromVersion
    ? `The relay still runs ${fromVersion}.`
    : `The relay now runs ${toVersion}; it ran ${fromVersion} before.`;
}

/**
 * What an update's end and the check that followed it saw, in words: the
 * pane's exit and the relay's version before and after, never what the
 * terminal printed. A clean exit with the version unchanged has several
 * causes (already current, nothing compatible, cancelled), which only the
 * terminal tells apart, so it names none of them as fact.
 */
export function describeRelayUpdateOutcome(
  end: RelayUpdateEnd,
  fromVersion: string,
  toVersion: string | null
): RelayObservation {
  switch (end.reason) {
    case "not-started":
      return {
        severity: "error",
        label: "The relay update didn't start",
        detail: "Its terminal couldn't start, so nothing on the relay changed",
      };
    case "closed":
      return {
        severity: "warning",
        label: "The update's terminal closed before the update ended",
        detail: versionNow(fromVersion, toVersion),
      };
    case "exited":
      break;
  }
  if (end.exitCode === INTERRUPTED) {
    return {
      severity: "warning",
      label: "The relay update was stopped",
      detail: `${versionNow(fromVersion, toVersion)} Its terminal shows how far it got.`,
    };
  }
  if (end.exitCode !== 0) {
    return {
      severity: "error",
      label: "The relay update failed",
      detail: `${versionNow(fromVersion, toVersion)} Its terminal shows what went wrong${
        end.exitCode === null ? "." : ` (exit code ${end.exitCode}).`
      }`,
    };
  }
  if (toVersion === null) {
    return {
      severity: "warning",
      label: "The relay update finished",
      detail: `${versionNow(fromVersion, toVersion)} Check the relay again to see it.`,
    };
  }
  if (toVersion !== fromVersion) {
    return {
      severity: "success",
      label: `Relay updated to ${toVersion}`,
      detail: `It ran ${fromVersion} before the update`,
    };
  }
  return {
    severity: "info",
    label: "The update left the relay as it was",
    detail: `${versionNow(fromVersion, toVersion)} Its terminal says why, such as no newer release that works with this Daintree, or the update being cancelled.`,
  };
}
