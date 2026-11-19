import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { ActionError } from "../../../shared/types/actions.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import type { GlobalCloseTarget } from "../assistants/GlobalWorkerSteer.js";
import type { ViewlessApprovalDecision } from "../viewless/index.js";
import {
  CONFIRMATION_REQUIRED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
} from "./shared.js";

/**
 * The global Assistant closing a finished agent it didn't launch (#16750): the
 * owned close it calls, admitted past the ledger only for that caller, only
 * for an agent whose stop handed its work back or stopped on an error, and
 * only once the person at its Shell, or their Daintree confirmations, said yes.
 */
export const GLOBAL_CLOSE_TOOL = "terminal.closeOwned";

/**
 * What the owned close's refusal adds for the global Assistant: a fact about
 * the caller, never the id, so the refusal reads the same for every id that
 * misses and stays no enumeration oracle (#12980).
 */
export const GLOBAL_CLOSE_REFUSAL_NOTE =
  "As the global Assistant you also close an agent you didn't launch, once its stop handed its work back (completed, or waiting at its prompt) or stopped on an error, with nothing typed in its input box and nothing changed since you asked; anything else is refused like this.";

/** The question put to the person at the Shell about one close. */
export function globalCloseQuestion(
  terminalId: string,
  target: GlobalCloseTarget
): { subject: string; lines: string[] } {
  const agent = getEffectiveAgentConfig(target.agentId)?.name ?? target.agentId;
  const subject = target.title ?? `${agent} agent`;
  return {
    subject,
    lines: [
      `Panel: ${subject} (${terminalId})`,
      `Agent: ${agent}, ${stopOf(target)}`,
      "Its input box holds nothing typed.",
      "It goes to the trash, where it stays briefly recoverable.",
    ],
  };
}

/** The question put to the person about a batch of closes, one line per panel. */
export function globalCloseBatchQuestion(
  targets: ReadonlyArray<{ terminalId: string; target: GlobalCloseTarget }>
): { subject: string; lines: string[] } {
  const count = targets.length;
  return {
    subject: count === 1 ? "1 finished agent" : `${count} finished agents`,
    lines: [
      ...targets.map(({ terminalId, target }) => {
        const agent = getEffectiveAgentConfig(target.agentId)?.name ?? target.agentId;
        return `${target.title ?? `${agent} agent`} (${terminalId}): ${agent}, ${stopOf(target)}`;
      }),
      "None of their input boxes holds anything typed.",
      "They go to the trash, where they stay briefly recoverable.",
    ],
  };
}

function stopOf(target: GlobalCloseTarget): string {
  if (target.closeClass === "requires-person") {
    return "stopped on an error; it may pick up again once that clears, such as a usage limit resetting";
  }
  return target.agentState === "completed" ? "finished its task" : "waiting at its prompt";
}

/**
 * Whether a later read still sees the run an earlier one was about: the same
 * incarnation, the same stop, and no input or state change since. Anything
 * else means the answer was about something that is no longer there.
 */
export function sameGlobalCloseTarget(
  earlier: GlobalCloseTarget,
  later: GlobalCloseTarget | null
): boolean {
  return (
    later !== null &&
    later.generation === earlier.generation &&
    later.closeClass === earlier.closeClass &&
    later.agentId === earlier.agentId &&
    later.agentState === earlier.agentState &&
    later.waitingReason === earlier.waitingReason &&
    later.lastTypedInputAt === earlier.lastTypedInputAt &&
    later.lastStateChange === earlier.lastStateChange
  );
}

/** What a Shell's answer lets the close do, and what the audit says of it. */
export type GlobalCloseSettlement =
  | { kind: "approved"; decision: "approved" }
  | { kind: "skipped" }
  | { kind: "refused"; error: ActionError; decision?: McpConfirmationDecision };

/**
 * Settle a Shell's answer about closing `what`. A skip is the person's Daintree
 * confirmations answering for them, and never answers a close only the person
 * may approve. Nobody answering closes nothing.
 */
export function settleGlobalCloseAnswer(
  answer: ViewlessApprovalDecision,
  personOnly: boolean,
  what: string
): GlobalCloseSettlement {
  switch (answer.decision) {
    case "approved":
      if (answer.authorization !== "skip-preference") {
        return { kind: "approved", decision: "approved" };
      }
      return personOnly ? unasked(what) : { kind: "skipped" };
    case "rejected":
      return {
        kind: "refused",
        decision: "rejected",
        error: {
          code: USER_REJECTED_CODE,
          message: `The user did not approve closing ${what}. Nothing was closed; don't ask again on its behalf.`,
        },
      };
    case "timeout":
      return {
        kind: "refused",
        decision: "timeout",
        error: {
          code: CONFIRMATION_TIMEOUT_CODE,
          message: `Nobody answered the question about closing ${what} in time, so nothing was closed.`,
        },
      };
    case "unavailable":
      return unasked(what);
  }
}

function unasked(what: string): GlobalCloseSettlement {
  return {
    kind: "refused",
    error: {
      code: CONFIRMATION_REQUIRED_CODE,
      message: `Closing ${what} needs the user's approval at your Shell, and it couldn't ask them. Nothing was closed.`,
      details: { confirmationChannel: "unavailable" },
    },
  };
}
