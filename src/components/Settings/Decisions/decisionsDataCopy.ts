import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsExportResult,
  DecisionsLocalDeleteResult,
  DecisionsRelayDeleteRefusal,
  DecisionsRelayDeleteResult,
} from "@shared/types/decisions";
import { describeUnreachable, hostOf, type RelayObservation } from "./relayCheckCopy";
import { describeKeyStorage } from "./relayIdentityCopy";

/** What an export observed, in words. Null for a cancelled one, which shows nothing. */
export function describeExportResult(result: DecisionsExportResult): RelayObservation | null {
  switch (result.result) {
    case "saved":
      return {
        severity: "success",
        label: "Decision history exported",
        detail: `${pluralize(result.questions, "question")} and ${pluralize(result.auditEvents, "audit event")}, encrypted, in ${result.path}`,
      };
    case "cancelled":
      return null;
    case "no-identity":
      return {
        severity: "error",
        label: "No Decisions keys to open the history with",
        detail:
          "The stored history is sealed under this computer's keys for its relay, and it holds none. Nothing was exported.",
      };
    case "key-storage":
      return {
        severity: "error",
        label: describeKeyStorage(result.kind),
        detail: `${result.reason}. Nothing was exported.`,
      };
    case "store-unavailable":
      return {
        severity: "error",
        label: "The stored history isn't open",
        detail:
          "It couldn't be opened when Decisions started. Turn Decisions off and on again to try again. Nothing was exported.",
      };
  }
}

function relayRefusal(
  host: string,
  reason: DecisionsRelayDeleteRefusal,
  status: number
): RelayObservation {
  switch (reason) {
    case "not-recognised":
      return {
        severity: "error",
        label: `${host} refused the deletion`,
        detail: "It doesn't accept this computer as its owner. Nothing was deleted.",
      };
    case "rate-limited":
      return {
        severity: "warning",
        label: `${host} is limiting requests`,
        detail: "Nothing was deleted. Try again in a minute.",
      };
    case "rejected":
      return {
        severity: "error",
        label: `${host} refused the deletion`,
        detail: `It answered HTTP ${status}. Nothing was deleted.`,
      };
  }
}

/** What deleting the relay's data observed, in words. */
export function describeRelayDeleteResult(result: DecisionsRelayDeleteResult): RelayObservation {
  switch (result.result) {
    case "deleted":
      return {
        severity: "success",
        label: "Relay data deleted",
        detail: `${hostOf(result.origin)} answered that its questions, answers and attachments are deleted.`,
      };
    case "not-sent":
      return {
        severity: "error",
        label: `Couldn't reach ${hostOf(result.origin)}`,
        detail: `${describeUnreachable(result.reason)}. The request never reached it, so nothing there changed.`,
      };
    case "unconfirmed": {
      const why =
        result.reason === "server-error"
          ? "It answered with a server error"
          : result.reason === "unexpected-answer"
            ? "Its answer wasn't the relay's"
            : describeUnreachable(result.reason);
      return {
        severity: "warning",
        label: `${hostOf(result.origin)} didn't confirm the deletion`,
        detail: `${why}. It may have deleted some or all of its questions, answers and attachments. Delete again to finish.`,
      };
    }
    case "refused":
      return relayRefusal(hostOf(result.origin), result.reason, result.status);
    case "changed":
      return {
        severity: "warning",
        label: "The relay changed",
        detail: result.origin
          ? `This computer is now set up with ${hostOf(result.origin)}, not the relay you confirmed. Nothing was sent.`
          : "This computer no longer has a relay set up. Nothing was sent.",
      };
    case "no-identity":
      return {
        severity: "error",
        label: `No owner keys for ${hostOf(result.origin)}`,
        detail: "Only its owner's keys can sign a deletion, and this computer holds none. Nothing was sent.",
      };
    case "key-storage":
      return {
        severity: "error",
        label: describeKeyStorage(result.kind),
        detail: `${result.reason}. Nothing was sent.`,
      };
  }
}

const NOTHING_DELETED: Record<
  Extract<DecisionsLocalDeleteResult, { result: "failed" }>["reason"],
  string
> = {
  "disk-pressure": "Disk space is critical, so the database refuses writes.",
  storage: "The database refused the deletion.",
  keys: "The Decisions key file couldn't be moved.",
};

/** What deleting this computer's Decisions data observed, in words. */
export function describeLocalDeleteResult(result: DecisionsLocalDeleteResult): RelayObservation {
  switch (result.result) {
    case "deleted":
      return {
        severity: "success",
        label: "Local data deleted",
        detail:
          "This computer's decision history, Decisions keys and relay record are gone. Nothing on the relay changed.",
      };
    case "failed":
      return {
        severity: "error",
        label: "Couldn't delete local data",
        detail: `${NOTHING_DELETED[result.reason]} Nothing was deleted.`,
      };
    case "incomplete":
      return {
        severity: "warning",
        label: "Deleting local data didn't finish",
        detail: result.erased
          ? "The decision history is deleted, but the keys or the relay record are still to go. Delete again to finish."
          : "Nothing was deleted, but the keys are still set aside. Restart Daintree to put them back, or delete again to finish.",
      };
  }
}
