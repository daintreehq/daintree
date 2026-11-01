import type {
  DecisionsDeviceRole,
  DecisionsKeyRotationProblem,
  DecisionsRelayRequestFailure,
  DecisionsRevokeDeviceResult,
  DecisionsRotateKeysResult,
} from "@shared/types/decisions";
import { hostOf } from "./relayCheckCopy";

/** What was observed when a request got no usable answer, naming the relay by its host. */
function unreachable(host: string, reason: string): string {
  switch (reason) {
    case "timeout":
      return `The relay at ${host} didn't answer in time.`;
    case "dns":
      return `The relay's address, ${host}, didn't resolve.`;
    case "refused":
      return `The relay at ${host} refused the connection.`;
    case "certificate":
      return `The relay at ${host} presented a certificate that wasn't accepted.`;
    case "server-error":
      return `The relay at ${host} answered with an error.`;
    default:
      return `The request to the relay at ${host} failed.`;
  }
}

/** A signed request that didn't go through, in words: what was observed, and the next step. */
export function describeRelayRequestFailure(failure: DecisionsRelayRequestFailure): string {
  switch (failure.result) {
    case "not-set-up":
      return "No relay is set up on this computer. Connect one above first.";
    case "unreachable":
      return `${unreachable(hostOf(failure.origin), failure.reason)} ${
        failure.reason === "server-error"
          ? "Try again in a moment."
          : "Check your connection, then retry."
      }`;
    case "refused":
      return failure.reason === "rate-limited"
        ? `The relay at ${hostOf(failure.origin)} is limiting requests from this computer. Wait a minute, then retry.`
        : `The relay at ${hostOf(failure.origin)} no longer accepts this computer's keys.`;
    case "key-storage":
      return failure.reason;
  }
}

/** The role a certificate states, as a person would name the device. */
export function deviceRoleLabel(role: DecisionsDeviceRole): string {
  switch (role) {
    case "phone":
      return "Phone";
    case "tablet":
      return "Tablet";
    case "desktop-host":
      return "Remote Host";
    case "owner-desktop":
      return "This computer";
  }
}

/** `123456` as `123 456`, the grouping a person compares fastest. */
export function groupPairingCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** `123456` as a screen reader should read it: digit by digit, in two groups. */
export function spokenPairingCode(code: string): string {
  return code.length === 6
    ? `${code.slice(0, 3).split("").join(" ")}, ${code.slice(3).split("").join(" ")}`
    : code.split("").join(" ");
}

/** Whole seconds left as `m:ss`. */
export function formatCountdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** A reason as a sentence: some arrive without their closing period. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** A revocation or rotation that didn't finish, in words: what was observed, and what follows. */
function describeRotationProblem(
  problem: DecisionsKeyRotationProblem | DecisionsRelayRequestFailure
): string {
  switch (problem.result) {
    case "unconfirmed":
      return `No answer came back from the relay at ${hostOf(problem.origin)}, so whether it took the change isn't known yet. Daintree kept the new key, and sends it again when it next connects.`;
    case "unsaved":
      return `The relay took the change, but the new key couldn't be saved on this computer. ${asSentence(problem.reason)} Daintree saves it when it next connects.`;
    case "conflict":
      return "The relay's devices or key changed while this ran, so nothing was changed. Try again.";
    case "unverified":
      return "A device the relay lists has a certificate that doesn't verify against this computer's key, so no new key was sealed to it and nothing was changed.";
    default:
      return describeRelayRequestFailure(problem);
  }
}

/**
 * What a revocation came to (#16010). `finished` is true when there's nothing
 * left to do for this device: it is revoked, or the relay no longer lists it.
 */
export function describeRevokeResult(
  result: DecisionsRevokeDeviceResult,
  label: string
): { finished: boolean; message: string } {
  switch (result.result) {
    case "revoked":
      return {
        finished: true,
        message: `'${label}' is revoked. The relay holds a new key, sealed to each device that remains.`,
      };
    case "not-found":
      return { finished: true, message: `The relay no longer lists '${label}' as paired.` };
    default:
      return { finished: false, message: describeRotationProblem(result) };
  }
}

/** What rotating the key came to (#16010). */
export function describeRotateResult(result: DecisionsRotateKeysResult): {
  finished: boolean;
  message: string;
} {
  if (result.result === "rotated") {
    return {
      finished: true,
      message:
        "The relay holds a new key, sealed to each paired device. What's sent from now on uses it.",
    };
  }
  return { finished: false, message: describeRotationProblem(result) };
}
