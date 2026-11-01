import type {
  DecisionsClaimRefusal,
  DecisionsConnectResult,
  DecisionsKeyStorageFailure,
  DecisionsKitRefusal,
} from "@shared/types/decisions";
import {
  describeRelayCheck,
  describeUnreachable,
  hostOf,
  type RelayObservation,
} from "./relayCheckCopy";

const KEPT =
  "The claim's keys stay on this computer, so a later claim of this relay can finish with them.";

const KEY_STORAGE: Record<DecisionsKeyStorageFailure, string> = {
  locked: "The keychain is locked",
  unavailable: "Secure storage isn't available",
  timeout: "The keychain didn't answer in time",
  "weak-storage-unconfirmed": "Only weaker key storage is available",
  unreadable: "The Decisions key file couldn't be read",
  "unsupported-format": "The Decisions key file is from another version",
};

function refusal(host: string, reason: DecisionsClaimRefusal): RelayObservation {
  switch (reason) {
    case "wrong-secret":
      return {
        severity: "error",
        label: `${host} refused the claim secret`,
        detail: "It doesn't match the CLAIM_SECRET set on the Worker.",
      };
    case "already-claimed":
      return {
        severity: "error",
        label: `${host} is already claimed`,
        detail:
          "It refused the keys this claim made. Restore its owner's identity from a recovery kit instead.",
      };
    case "not-configured":
      return {
        severity: "warning",
        label: `${host} has no claim secret set`,
        detail: "It can't be claimed until CLAIM_SECRET is set on the Worker.",
      };
    case "rate-limited":
      return {
        severity: "warning",
        label: `${host} is limiting claim attempts`,
        detail: "It refused more attempts from this network for now. Try again later.",
      };
    case "rejected":
      return {
        severity: "error",
        label: `${host} refused the claim`,
        detail: "It refused the request without saying why.",
      };
  }
}

function kitRefusal(host: string, reason: DecisionsKitRefusal): RelayObservation {
  switch (reason) {
    case "not-a-kit":
      return {
        severity: "error",
        label: "That file isn't a Decisions recovery kit",
        detail:
          "Choose the kit saved when this relay was set up, such as the file `decisions recovery export` writes.",
      };
    case "wrong-passphrase":
      return {
        severity: "error",
        label: "The passphrase didn't open this kit",
        detail: "Check the passphrase. If it's right, the file may be damaged.",
      };
    case "another-relay":
      return {
        severity: "error",
        label: "That kit is for a different relay",
        detail: `The identity in it belongs to a relay other than ${host}.`,
      };
    case "not-owner":
      return {
        severity: "error",
        label: "That kit holds a Remote Host's identity",
        detail: "Restore the owner's recovery kit. A Host gets its identity from the owner.",
      };
    case "unfinished":
      return {
        severity: "error",
        label: "That kit is from a setup that didn't finish",
        detail: "The relay never confirmed the claim it was saved from.",
      };
    case "not-recognised":
      return {
        severity: "error",
        label: `${host} doesn't accept this identity`,
        detail:
          "The relay doesn't list its keys as its owner. It may have been claimed again, or this computer revoked.",
      };
  }
}

/**
 * What a claim or restore observed, in words. Null for `saved`, which the
 * connection's status says, and for an address that was never sent, whose
 * words belong on the field.
 */
export function describeConnectResult(result: DecisionsConnectResult): RelayObservation | null {
  switch (result.result) {
    case "saved":
      return null;
    case "relay":
      return describeRelayCheck(result.check);
    case "refused": {
      const host = hostOf(result.origin);
      if (result.reason === "already-claimed" && result.kept) {
        return {
          severity: "warning",
          label: `${host} is already claimed`,
          detail:
            "It refused a request signed with the keys an earlier claim from this computer left here, so they may not be its owner's. They stay on this computer until you remove them.",
        };
      }
      const observed = refusal(host, result.reason);
      const outcome = result.kept ? KEPT : "Nothing was saved.";
      return { ...observed, detail: `${observed.detail} ${outcome}` };
    }
    case "unreachable": {
      const host = hostOf(result.origin);
      const why =
        result.reason === "server-error"
          ? "It answered with a server error."
          : `${describeUnreachable(result.reason)}.`;
      return result.kept
        ? {
            severity: "warning",
            label: `${host} didn't confirm the claim`,
            detail: `${why} It may have received the claim, so this computer kept its keys. Claim it again with the same secret to finish.`,
          }
        : {
            severity: "error",
            label: `Couldn't reach ${host}`,
            detail: `${why} Nothing was saved.`,
          };
    }
    case "kit-refused": {
      const observed = kitRefusal(hostOf(result.origin), result.reason);
      return { ...observed, detail: `${observed.detail} Nothing was saved.` };
    }
    case "conflict": {
      const relay = result.origin ? hostOf(result.origin) : "a relay it can't name";
      return result.unfinished
        ? {
            severity: "warning",
            label: "This computer holds keys from an unfinished claim",
            detail: `They are for ${relay}. Finish that claim, or remove the keys first.`,
          }
        : {
            severity: "warning",
            label: "This computer already holds a Decisions identity",
            detail: `It is for ${relay}. Disconnect it before setting up another.`,
          };
    }
    case "key-storage":
      return {
        severity: "error",
        label: KEY_STORAGE[result.kind],
        detail: result.kept ? `${result.reason}. ${KEPT}` : result.reason,
      };
  }
}
