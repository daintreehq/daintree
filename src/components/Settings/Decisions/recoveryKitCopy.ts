import type {
  DecisionsKitCheckRefusal,
  DecisionsKitExportResult,
  DecisionsKitIdentityProblem,
  DecisionsKitVerifyResult,
} from "@shared/types/decisions";
import type { RelayObservation } from "./relayCheckCopy";
import { KEY_STORAGE } from "./relayIdentityCopy";

/** The library's own floor for a kit's passphrase. */
export const MIN_KIT_PASSPHRASE_LENGTH = 12;

const NO_IDENTITY: Record<DecisionsKitIdentityProblem, RelayObservation> = {
  "not-set-up": {
    severity: "error",
    label: "No relay is set up on this computer",
    detail: "Claim or restore a relay first.",
  },
  "keys-missing": {
    severity: "error",
    label: "This computer's Decisions keys are gone",
    detail:
      "There is nothing here to save or check a kit against. Disconnect, then restore the identity from a recovery kit.",
  },
  "keys-mismatch": {
    severity: "error",
    label: "This computer's keys don't match the relay set up here",
    detail:
      "The keys sealed here aren't a working owner identity for this relay. Disconnect, then restore the identity from a recovery kit.",
  },
};

function refusal(reason: DecisionsKitCheckRefusal): RelayObservation {
  switch (reason) {
    case "not-a-kit":
      return {
        severity: "error",
        label: "That file isn't a Decisions recovery kit",
        detail: "Choose the kit file you saved, such as the one Save kit wrote.",
      };
    case "wrong-passphrase":
      return {
        severity: "error",
        label: "The passphrase didn't open this kit",
        detail:
          "Check the passphrase. If it's right, the file may be damaged: save a new kit and verify that.",
      };
    case "another-identity":
      return {
        severity: "error",
        label: "That kit holds a different identity",
        detail:
          "It isn't this computer's Decisions identity, so it couldn't restore it. Choose the kit you saved from this computer.",
      };
    case "missing-epochs":
      return {
        severity: "error",
        label: "That kit is out of date",
        detail:
          "It's this computer's identity, but without every key it holds now, so some of the relay's data couldn't be read with it. Save a new kit and verify that.",
      };
  }
}

/** What saving a kit observed, in words; null when the person cancelled, which needs none. */
export function describeExportResult(result: DecisionsKitExportResult): RelayObservation | null {
  switch (result.result) {
    case "saved":
      return {
        severity: "success",
        label: `Saved ${result.fileName}`,
        detail:
          "Verify it now: choose that file below and enter its passphrase. Then keep it somewhere other than this computer.",
      };
    case "cancelled":
      return null;
    case "no-identity":
      return NO_IDENTITY[result.reason];
    case "key-storage":
      return { severity: "error", label: KEY_STORAGE[result.kind], detail: result.reason };
  }
}

/** What checking a kit observed, in words. */
export function describeVerifyResult(result: DecisionsKitVerifyResult): RelayObservation {
  switch (result.result) {
    case "verified":
      return {
        severity: "success",
        label: "Kit checked",
        detail:
          "It opens with its passphrase and holds this computer's identity with every key. Keep it somewhere other than this computer.",
      };
    case "kit-refused":
      return refusal(result.reason);
    case "no-identity":
      return NO_IDENTITY[result.reason];
    case "key-storage":
      return { severity: "error", label: KEY_STORAGE[result.kind], detail: result.reason };
  }
}

/** A verification time as a date, in the person's locale. */
export function formatVerifiedAt(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
