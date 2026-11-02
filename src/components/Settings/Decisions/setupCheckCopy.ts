import type { StatusSeverity } from "@/lib/statusSeverity";
import { pluralize } from "@/lib/pluralize";
import type {
  DecisionsSetupCheckObservations,
  DecisionsSetupCheckRun,
  DecisionsSetupCheckStep,
  DecisionsSetupStepState,
  DecisionsStatus,
} from "@shared/types/decisions";
import { describeRelayRequestFailure } from "./devicesCopy";
import { describeRelayCheck } from "./relayCheckCopy";

/** Each step's name, as Connection lists it. */
export const SETUP_STEP_LABEL: Record<DecisionsSetupCheckStep, string> = {
  relay: "Relay health and protocol",
  claim: "Claim",
  socket: "Socket with a fresh ticket",
  push: "Push configuration",
  attachment: "Encrypted attachment round trip",
  question: "Test question to your phones",
};

const RUNNING: Record<DecisionsSetupCheckStep, string> = {
  relay: "Reading the relay's /health and /api/v1/info…",
  claim: "Asking the relay which devices it accepts…",
  socket: "Opening a socket with a new ticket…",
  push: "Reading the relay's push configuration and your phones' notifications…",
  attachment: "Uploading an encrypted test image with the question, then downloading it…",
  question:
    "Sent to your paired phones. Answer the Daintree setup check there, and your answer is typed into the diagnostic terminal below.",
};

const UNEXPECTED = "Daintree couldn't finish this step. Check again to retry.";

const CONNECTION_PROBLEM: Record<NonNullable<DecisionsStatus["problem"]>, string> = {
  keys: "This computer's Decisions keys couldn't be read, or they belong to another relay",
  storage: "The local Decisions database isn't accepting writes",
  "other-relay": "This computer's Decisions data came from another relay identity",
};

export interface SetupStepView {
  label: string;
  detail: string;
  /** Absent while the step hasn't finished. */
  severity?: StatusSeverity;
}

/** What each step observed, in words. */
const OBSERVED: {
  [S in DecisionsSetupCheckStep]: (observation: DecisionsSetupCheckObservations[S]) => string;
} = {
  relay: (relay) => {
    if (relay.result === "unexpected") return UNEXPECTED;
    const words = describeRelayCheck(relay);
    return words ? `${words.label}. ${words.detail}` : UNEXPECTED;
  },
  claim: (claim) => {
    switch (claim.result) {
      case "recognised":
        return "The relay lists this computer as its owner, under the keys stored here";
      case "not-recognised":
        return "The relay answered, but it lists another owner, or other keys for this computer";
      case "unexpected":
        return UNEXPECTED;
      default:
        return describeRelayRequestFailure(claim);
    }
  },
  socket: (socket) => {
    switch (socket.result) {
      case "connected":
        return "A socket opened with a new ticket, and the relay answered on it";
      case "no-hello":
        return "Daintree asked for a socket with a new ticket, but it closed or the relay didn't answer on it in time";
      case "replaced":
        return "Another connection is using this computer's identity, most likely another copy of Daintree with the same keys. Daintree waits a few minutes before connecting again.";
      case "revoked":
        return "The relay revoked this computer";
      case "not-connected":
        return socket.problem
          ? CONNECTION_PROBLEM[socket.problem]
          : "Decisions isn't connected to the relay";
      case "unexpected":
        return UNEXPECTED;
    }
  },
  push: (push) => {
    switch (push.result) {
      case "configured":
        return `The relay has a push key, and holds notifications for ${push.pushEnabled} of ${pluralize(push.phones, "paired phone")}`;
      case "no-push-key":
        return "The relay didn't give a push key, so it can't notify a phone";
      case "no-phone":
        return "No phone is paired. Pair one under Devices, then check again.";
      case "push-off":
        return `${pluralize(push.phones, "phone is", "phones are")} paired, but the relay holds notifications for none of them. Turn notifications on in the Decisions app, then check again.`;
      case "unexpected":
        return UNEXPECTED;
      default:
        return describeRelayRequestFailure(push);
    }
  },
  attachment: (attachment) => {
    switch (attachment.result) {
      case "matched":
        return `An encrypted test image (${pluralize(attachment.bytes, "byte")}) went up with the question and came back the same`;
      case "not-asked":
        return "The test question couldn't be asked on this computer";
      case "not-published":
        return "The relay hadn't taken the test question and its image in time";
      case "publish-failed":
        return "The relay refused the test question and its image";
      case "mismatch":
        return "The image that came back didn't decrypt to the one sent";
      case "unexpected":
        return UNEXPECTED;
      default:
        return describeRelayRequestFailure(attachment);
    }
  },
  question: (question) => {
    switch (question.result) {
      case "typed":
        return "Your answer came back from the phone and was typed into the diagnostic terminal";
      case "not-answered":
        return "No answer came from a phone in time. Check that a phone shows the test question, then check again.";
      case "expired":
        return "The test question expired before it was answered";
      case "cancelled":
        return "The test question was cancelled before it was answered";
      case "not-typed":
        return "An answer came back, but it wasn't typed into the diagnostic terminal";
      case "unexpected":
        return UNEXPECTED;
    }
  },
};

function observed<S extends DecisionsSetupCheckStep>(
  step: S,
  observation: DecisionsSetupCheckObservations[S]
): string {
  const describe: (observation: DecisionsSetupCheckObservations[S]) => string = OBSERVED[step];
  return describe(observation);
}

/** One step as Connection shows it: what it is, and what it observed. */
export function describeSetupStep<S extends DecisionsSetupCheckStep>(
  step: S,
  state: DecisionsSetupStepState<DecisionsSetupCheckObservations[S]>,
  run: Pick<DecisionsSetupCheckRun, "state">
): SetupStepView {
  const label = SETUP_STEP_LABEL[step];
  switch (state.state) {
    case "waiting":
      return { label, detail: "Not run yet" };
    case "running":
      return { label, detail: RUNNING[step] };
    case "skipped":
      return {
        label,
        detail:
          run.state === "cancelled"
            ? "Not run: the check was cancelled"
            : "Not run: an earlier step didn't pass",
      };
    case "passed":
      return { label, detail: observed(step, state.observation), severity: "success" };
    case "failed":
      return { label, detail: observed(step, state.observation), severity: "error" };
  }
}

/** Why setup isn't finished, from the status alone; null once it is, or with no relay set up. */
export function unfinishedReason(
  status: Pick<DecisionsStatus, "relayOrigin" | "recoveryKitVerifiedAt" | "setupCheck">
): "kit" | "check" | { failedStep: DecisionsSetupCheckStep } | null {
  if (status.relayOrigin === undefined) return null;
  if (status.recoveryKitVerifiedAt === undefined) return "kit";
  if (status.setupCheck === undefined) return "check";
  const { failedStep } = status.setupCheck;
  return failedStep === null ? null : { failedStep };
}
