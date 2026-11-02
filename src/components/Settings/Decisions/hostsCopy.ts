import type {
  DecisionsHost,
  DecisionsHostFailure,
  DecisionsHostsResult,
} from "@shared/types/decisionsHosts";

/** The switch's own words: what enrolling gives a Host, and what turning it off leaves. */
export const AUTO_ENROLL_SUBTITLE =
  "Each Remote Host you connect to gets its own keys, so its agents can ask you even while this computer sleeps, and it can read every question and answer. Turn this off to enroll Hosts one at a time.";

function sentence(detail: string | undefined): string {
  if (!detail) return "";
  const trimmed = detail.trim().replace(/[.!?…]+$/, "");
  return ` ${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

/** Why the last attempt didn't finish, as one sentence or two. */
export function hostFailureText(failure: DecisionsHostFailure): string {
  switch (failure.reason) {
    case "no-keychain":
      return `It has no keychain that could keep its keys, so nothing was enrolled.${sentence(failure.detail)}`;
    case "host-keys-unreadable":
      return `Its Decisions key file couldn't be read.${sentence(failure.detail)}`;
    case "host-refused":
      return `It refused the enrollment.${sentence(failure.detail)}`;
    case "relay-unreachable":
      return "The relay didn't answer, so nothing was enrolled.";
    case "relay-refused":
      return failure.detail === "rate-limited"
        ? "The relay is limiting requests from this computer, so nothing was enrolled."
        : "The relay no longer accepts this computer's keys, so nothing was enrolled.";
    case "owner-keys":
      return `This computer's Decisions keys couldn't be opened, so nothing was enrolled.${sentence(failure.detail)}`;
    case "relay-full":
      return "The relay already has as many devices as it allows. Revoke one to make room.";
    case "relay-rejected":
      return `The relay didn't take it.${sentence(failure.detail)}`;
    case "disconnected":
      return "Its connection closed before it was enrolled.";
    case "outcome-unknown":
      return "Its connection dropped while it was saving its keys, so it may be enrolled. Its next connection says.";
    case "unexpected-answer":
      return "It answered in a way this Daintree doesn't read. Update Daintree on both computers.";
    case "records-unavailable":
      return "This computer's Decisions data couldn't be read or saved, so nothing was enrolled.";
  }
}

/** One Host's row, in words: what was last observed of it. */
export function hostEnrollmentText(host: DecisionsHost, autoEnroll: boolean): string {
  const offline = host.connected ? "" : " Not connected.";
  const { enrollment } = host;
  switch (enrollment.state) {
    case "unchecked":
      return host.connected
        ? "Connected. Checked once Decisions connects to the relay."
        : "Not connected.";
    case "checking":
      return "Checking…";
    case "enrolling":
      return "Enrolling…";
    case "enrolled":
      return `Enrolled as its own device.${offline}`;
    case "not-enrolled":
      return `Not enrolled.${offline}`;
    case "revoked":
      return `Revoked, so it isn't enrolled automatically again.${offline}`;
    case "stale":
      return `It holds keys this relay no longer lists.${offline}`;
    case "own-setup":
      return `It has its own Decisions setup, which is left as it is.${offline}`;
    case "other-setup":
      return `It's enrolled with another relay, which is left as it is.${offline}`;
    case "needs-update":
      return "It needs a newer Daintree to be enrolled.";
    case "failed":
      return `${hostFailureText(enrollment.failure)}${
        autoEnroll && enrollment.failure.reason !== "relay-full"
          ? " Tried again when it next connects."
          : ""
      }${offline}`;
  }
}

/** Why the Hosts couldn't be listed, from a read that answered. */
export function hostsUnlistedText(read: Exclude<DecisionsHostsResult, { result: "listed" }>): string {
  switch (read.result) {
    case "not-set-up":
      return "No relay is set up on this computer. Connect one above first.";
  }
}
