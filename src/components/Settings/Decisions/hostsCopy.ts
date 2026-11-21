import type { DecisionsConnectionProblem } from "@shared/types/decisions";
import type {
  DecisionsHost,
  DecisionsHostFailure,
  DecisionsHostRuntime,
  DecisionsHostRuntimeObservation,
  DecisionsHostsResult,
} from "@shared/types/decisionsHosts";
import { HOST_DEFAULT_QUESTION_EXPIRY_MS } from "@shared/config/decisionsQuestionExpiry";
import { questionWaitText } from "./policyCopy";

/** The switch's own words: what enrolling gives a Host, and what it lets the Host read. */
export const AUTO_ENROLL_SUBTITLE =
  "Each Remote Host you connect to gets its own keys, so its agents can ask you while this computer sleeps. An enrolled Host can read every question and answer.";

/**
 * A remote window's one note on whose settings these are (#18066): every
 * Decisions setting is this computer's, while a Host this computer enrolled
 * gives `ask_human` to every supported agent launched there, whatever this
 * computer's Agents switches say, and asks under its own default expiry. A
 * Host with a Decisions setup of its own runs under that instead.
 */
export function remoteWindowText(hostName: string, device: string): string {
  return `These settings are saved on ${device}. On ${hostName}, once ${device} enrolls it, every agent that supports ask_human gets it, and a question waits ${questionWaitText(HOST_DEFAULT_QUESTION_EXPIRY_MS)} unless its agent sets a time. Choose which agents on ${device} can ask from a local window.`;
}

/** A Remote Host device the relay lists that no Host this computer knows claims (#16222). */
export const RELAY_ONLY_HOST_TEXT =
  "The relay lists it as an enrolled Remote Host, but this computer has no record of it.";

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
    case "weak-storage-only":
      return "It has no keychain, as Linux and WSL machines without a keyring don't, so nothing was enrolled. Its keys can be kept under a fixed key instead, which protects them only from someone who can't read its files.";
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

function problemText(problem: DecisionsConnectionProblem | undefined): string {
  switch (problem) {
    case "keys":
      return ", as its keys couldn't be read";
    case "storage":
      return ", as its Decisions data couldn't be opened";
    case "other-relay":
      return ", as what it has stored belongs to another relay";
    case undefined:
      return "";
  }
}

/** The Host's own Decisions, as it said it, to follow "it reports Decisions"; null when there is nothing to say. */
function runtimeState(runtime: DecisionsHostRuntime): string | null {
  switch (runtime.state) {
    case "not-enrolled":
      return null;
    case "owner-off":
      return "off, as this computer told it Decisions was off";
    case "revoked":
      return runtime.credentialsRemoved
        ? "stopped, as the relay revoked it, and its keys removed"
        : "stopped, as the relay revoked it; its keys aren't removed yet";
    case "running":
      switch (runtime.connection) {
        case "connected":
          return "connected to the relay";
        case "connecting":
          return "connecting to the relay";
        case "reconnecting":
          return "reconnecting to the relay";
        case "replaced":
          return "replaced on the relay by another connection with its keys";
        case "revoked":
          return "revoked by the relay";
        case "not-connected":
          return `not connected to the relay${problemText(runtime.problem)}`;
      }
  }
}

/**
 * How a running Host said it asks its agents' questions (#17942), to follow
 * what it reports, only where that isn't what every current Host does: a
 * Host from before it, whose agents can't ask for advice; one connected to
 * the relay whose agents still can't, as its delivery didn't start; and a
 * default expiry other than a Host's own. Empty otherwise, and for a Host
 * that isn't running Decisions. A Host that is still connecting hasn't
 * settled advice yet, so its "no" says nothing.
 */
function questionPolicyText(runtime: DecisionsHostRuntime, live: boolean): string {
  if (runtime.state !== "running") return "";
  const policy = runtime.questionPolicy;
  if (policy === undefined) {
    return " Its Daintree is too old for its agents to ask for advice; update it there to let them.";
  }
  const says = live ? "says" : "said";
  const noAdvice = !policy.advisoryQuestions && runtime.connection === "connected";
  const expiry = policy.defaultQuestionExpiryMs;
  const wait =
    expiry === HOST_DEFAULT_QUESTION_EXPIRY_MS
      ? null
      : expiry === null
        ? "waits until it's answered or withdrawn"
        : `waits ${questionWaitText(expiry)}`;
  if (noAdvice && wait !== null) {
    return ` It ${says} its agents can't ask for advice now, and a question asked there without a deadline ${wait}.`;
  }
  if (noAdvice) return ` It ${says} its agents can't ask for advice now.`;
  if (wait !== null) return ` It ${says} a question asked there without a deadline ${wait}.`;
  return "";
}

/**
 * What the Host itself last reported of its own Decisions (#16022), in a
 * sentence to follow its row; empty when it has said nothing to show. A
 * report from before its link closed says so: it may have changed since.
 */
export function hostRuntimeText(observation: DecisionsHostRuntimeObservation | undefined): string {
  if (observation === undefined) return "";
  const state = runtimeState(observation.runtime);
  if (state === null) return "";
  const policy = questionPolicyText(observation.runtime, observation.live);
  return observation.live
    ? ` It reports Decisions ${state}.${policy}`
    : ` Before its connection closed, it reported Decisions ${state}.${policy}`;
}

/** One Host's row, in words: what was last observed of it, and what it last reported. */
export function hostEnrollmentText(host: DecisionsHost, autoEnroll: boolean): string {
  return `${enrollmentText(host, autoEnroll)}${hostRuntimeText(host.runtime)}`;
}

function enrollmentText(host: DecisionsHost, autoEnroll: boolean): string {
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
      return `Enrolled.${offline}`;
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
        autoEnroll &&
        enrollment.failure.reason !== "relay-full" &&
        enrollment.failure.reason !== "weak-storage-only"
          ? " Tried again when it next connects."
          : ""
      }${offline}`;
  }
}

/** Why the Hosts couldn't be listed, from a read that answered. */
export function hostsUnlistedText(
  read: Exclude<DecisionsHostsResult, { result: "listed" }>
): string {
  switch (read.result) {
    case "not-set-up":
      return "No relay is set up on this computer. Connect one above first.";
  }
}
