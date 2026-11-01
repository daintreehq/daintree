import type { DecisionsDeviceRole, DecisionsRelayRequestFailure } from "@shared/types/decisions";
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
