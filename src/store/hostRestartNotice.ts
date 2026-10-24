import type { HostPreviousEnd } from "@shared/types/remoteHosts";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";

export interface HostRestartOutcome {
  relaunched: number;
  held: number;
}

/**
 * What the host's crash record observed about how its Daintree ended, quoted
 * rather than explained. The watchdog's kill reason alone never says memory
 * pressure: it waits longer for other evidence too, even a missing reading,
 * so only its own note on what made it wait is repeated.
 */
export function describeHostPreviousEnd(end: HostPreviousEnd): string {
  if (end.cause === "watchdog-deadlock") {
    const beats =
      end.missedBeats !== undefined
        ? ` after ${pluralize(end.missedBeats, "missed heartbeat")}`
        : "";
    const waited = end.pressureEvidence
      ? ` It had waited longer because ${end.pressureEvidence}.`
      : "";
    return `Its watchdog stopped Daintree${beats}.${waited}`;
  }
  switch (end.crashCause) {
    case "uncaught-exception":
      return "Daintree crashed with an uncaught error.";
    case "native-crash":
      return "Daintree crashed in native code.";
    case "power-loss":
      return "The machine restarted while Daintree was running.";
    case "suspended-then-lost":
      return "Daintree ended while the machine was asleep.";
    case "external-kill":
      return "Daintree's heartbeat stopped and it ended without shutting down.";
    default:
      return "Daintree ended without shutting down.";
  }
}

function describeOutcome({ relaunched, held }: HostRestartOutcome): string {
  const waiting = held > 0 ? `${pluralize(held, "agent waits", "agents wait")} to be resumed.` : "";
  if (relaunched > 0) {
    return `Relaunched ${pluralize(relaunched, "agent")}.${waiting ? ` ${waiting}` : ""}`;
  }
  return waiting;
}

/**
 * Tell the user a host's Daintree ended uncleanly and what this view brought
 * back (#14368). A planned restart leaves no record, so it never gets here.
 * One notice per host: a later restart replaces the last one's.
 */
export function noticeUncleanHostRestart(
  host: { hostId: string | null; hostName: string },
  projectId: string,
  end: HostPreviousEnd,
  outcome: HostRestartOutcome
): void {
  const counts = describeOutcome(outcome);
  const message = `${describeHostPreviousEnd(end)}${counts ? ` ${counts}` : ""}`;
  notify({
    type: "warning",
    placement: "grid-bar",
    title: `Daintree on ${host.hostName} stopped unexpectedly`,
    message,
    context: { projectId, eventKind: "recovery" },
    supersedeKey: `host-unclean-restart:${host.hostId ?? host.hostName}`,
  });
}
