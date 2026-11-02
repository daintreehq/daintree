import { useState } from "react";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { clientErrorText } from "@/utils/clientAppError";
import type { HostBringBackAnswer } from "@shared/types/hostWake";
import type { HostConnectionState, HostDescriptor, HostId } from "@shared/types/remoteHosts";

/** How a press of Bring back ended: what main observed, or why it couldn't ask. */
export type BringBackOutcome = { answer: HostBringBackAnswer } | { error: string };

/** A host whose link is neither up nor on its way up: what Bring back is for. */
export function canBringBack(connection: HostConnectionState): boolean {
  return connection.status === "unreachable" || connection.status === "disconnected";
}

/** What a host's row says about waking it; null for a host that isn't reached over SSH. */
export function wakeLabel(descriptor: HostDescriptor): string | null {
  if (descriptor.connection.kind !== "ssh") return null;
  return descriptor.wake ? `Wakes over ${descriptor.wake.lan}` : "No wake set up";
}

function observedSuffix(answer: HostBringBackAnswer): string {
  return answer.observed ? `: ${answer.observed}` : "";
}

/**
 * What a finished attempt observed, in a sentence for the host's row; null
 * when the link came up, which the row's own status already says.
 */
export function describeBringBack(
  answer: HostBringBackAnswer,
  hostName: string,
  lan: string | null
): string | null {
  switch (answer.status) {
    case "connected":
    case "woken":
    case "started":
      return null;
    case "unreachable":
      return `Couldn't reach ${hostName}${observedSuffix(answer)}`;
    case "not_wakeable":
      switch (answer.wake) {
        case "not_on_lan":
          return `${hostName} didn't answer over SSH, and this machine isn't on its LAN${lan ? ` (${lan})` : ""} to wake it`;
        case "failed":
          return `${hostName} didn't answer over SSH, and its wake couldn't be sent${observedSuffix(answer)}`;
        default:
          return `${hostName} didn't answer over SSH, and no wake is set up for it${observedSuffix(answer)}`;
      }
    case "not_startable":
      return `Daintree on ${hostName} wasn't started${observedSuffix(answer)}`;
    case "version_mismatch":
      return `${hostName} answered on a link protocol this build can't use`;
    case "timed_out": {
      const seconds = Math.round(answer.elapsedMs / 1000);
      const did =
        answer.wake === "sent" && answer.startRequested
          ? " after a wake and a start"
          : answer.wake === "sent"
            ? " after a wake"
            : answer.startRequested
              ? " after a start"
              : "";
      return `${hostName} wasn't back within ${seconds} s${did}, and may still connect`;
    }
    case "cancelled":
      return `Stopped bringing back ${hostName}: it was disconnected, removed or changed`;
  }
}

/**
 * Presses of Bring back, per host. Main runs one attempt per host and every
 * press, here or in another window, or the assistant's call, joins it.
 */
export function useHostBringBacks() {
  const [pending, setPending] = useState<ReadonlySet<HostId>>(() => new Set());
  const [outcomes, setOutcomes] = useState<ReadonlyMap<HostId, BringBackOutcome>>(() => new Map());
  const settle = (hostId: HostId, outcome: BringBackOutcome) => {
    setPending((current) => {
      const next = new Set(current);
      next.delete(hostId);
      return next;
    });
    setOutcomes((current) => new Map(current).set(hostId, outcome));
  };
  const bringBack = (hostId: HostId) => {
    if (pending.has(hostId)) return;
    setPending((current) => new Set(current).add(hostId));
    setOutcomes((current) => {
      const next = new Map(current);
      next.delete(hostId);
      return next;
    });
    remoteHostsClient.bringBack(hostId).then(
      (answer) => settle(hostId, { answer }),
      (error: unknown) =>
        settle(hostId, {
          error: `Couldn't bring it back: ${clientErrorText(error, "unknown error")}`,
        })
    );
  };
  return {
    isPending: (hostId: HostId) => pending.has(hostId),
    outcomeFor: (hostId: HostId) => outcomes.get(hostId) ?? null,
    bringBack,
  };
}

/**
 * The sentence a row shows for its last press, or null when there is nothing
 * to say: none once the link is up, however it came back.
 */
export function bringBackMessage(
  outcome: BringBackOutcome | null,
  descriptor: HostDescriptor,
  connection: HostConnectionState
): string | null {
  if (outcome === null || connection.status === "connected") return null;
  if ("error" in outcome) return outcome.error;
  return describeBringBack(outcome.answer, descriptor.name, descriptor.wake?.lan ?? null);
}
