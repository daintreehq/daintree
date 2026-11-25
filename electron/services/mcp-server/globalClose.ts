import { getEffectiveAgentConfig } from "../../../shared/config/agentRegistry.js";
import type { ActionError } from "../../../shared/types/actions.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import type { WorktreeLocalWork } from "../../../shared/types/worktreeLocalWork.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import { worktreeLocalWorkFacts } from "../../../shared/utils/worktreeLocalWork.js";
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

/**
 * The longest a panel's title runs in the question: every line must stay well
 * inside what the relay carries, with the id and the stop still on it.
 */
const QUESTION_TITLE_MAX_CHARS = 120;

/** What the question calls a panel: its title, clipped, or its agent's name. */
function panelName(target: GlobalCloseTarget, agent: string): string {
  const title = target.title;
  if (title === undefined) return `${agent} agent`;
  return title.length > QUESTION_TITLE_MAX_CHARS
    ? `${title.slice(0, QUESTION_TITLE_MAX_CHARS - 1)}…`
    : title;
}

/**
 * How much of a panel's id the question shows: its head and its tail, so an
 * id of any length keeps every line inside the relay's cap and two long ids
 * that share a start still read apart.
 */
const QUESTION_ID_MAX_CHARS = 200;

function shownId(terminalId: string): string {
  if (terminalId.length <= QUESTION_ID_MAX_CHARS) return terminalId;
  const half = QUESTION_ID_MAX_CHARS / 2;
  return `${terminalId.slice(0, half)}…${terminalId.slice(-(half - 1))}`;
}

function agentName(target: GlobalCloseTarget): string {
  return getEffectiveAgentConfig(target.agentId)?.name ?? target.agentId;
}

// A panel its launcher set to be discarded when its agent exits is
// discarded by a close too: only its view knows which those are.
const TRASH_LINE =
  "A closed panel goes to the trash, where it stays briefly recoverable, unless it was launched to be discarded when its agent exits.";

const NOT_READ: WorktreeLocalWork = { kind: "not-applicable" };

/**
 * What the question adds of a panel's worktree (#18151): each thing in it that
 * exists only on this machine, or that git couldn't report. Nothing for a
 * worktree that is clean and pushed, or a panel in none.
 */
function worktreeNote(worktree: WorktreeLocalWork): string {
  const facts = worktreeLocalWorkFacts(worktree);
  return facts.length > 0 ? ` — ${facts.join(", ")}` : "";
}

/**
 * Read the worktrees of the panels a question is about, one answer per target
 * in order. Never rejects: a reader that fails or is missing leaves each panel
 * in a worktree unreadable, never clean.
 */
export async function readGlobalCloseWorktrees(
  read:
    | ((
        projectId: string,
        worktreeIds: ReadonlyArray<string | undefined>,
        signal: AbortSignal
      ) => Promise<WorktreeLocalWork[]>)
    | undefined,
  projectId: string,
  targets: ReadonlyArray<Pick<GlobalCloseTarget, "worktreeId">>,
  signal: AbortSignal
): Promise<WorktreeLocalWork[]> {
  const fallback = targets.map(({ worktreeId }): WorktreeLocalWork =>
    worktreeId === undefined ? NOT_READ : { kind: "unreadable" }
  );
  if (read === undefined || targets.every(({ worktreeId }) => worktreeId === undefined)) {
    return fallback;
  }
  try {
    const answers = await read(
      projectId,
      targets.map(({ worktreeId }) => worktreeId),
      signal
    );
    return fallback.map((fallen, index) => answers[index] ?? fallen);
  } catch {
    return fallback;
  }
}

/** The question put to the person at the Shell about one close. */
export function globalCloseQuestion(
  terminalId: string,
  target: GlobalCloseTarget,
  worktree: WorktreeLocalWork = NOT_READ
): { subject: string; lines: string[] } {
  const agent = agentName(target);
  const subject = panelName(target, agent);
  return {
    subject,
    lines: [
      `Panel: ${subject} (${shownId(terminalId)})`,
      `Agent: ${agent}, ${stopOf(target)}${worktreeNote(worktree)}`,
      "Its input box holds nothing typed.",
      TRASH_LINE,
    ],
  };
}

/**
 * The question put to the person about a batch of closes, one line per panel
 * it asks about, and how many of the call's own panels close with them.
 */
export function globalCloseBatchQuestion(
  targets: ReadonlyArray<{
    terminalId: string;
    target: GlobalCloseTarget;
    worktree?: WorktreeLocalWork;
  }>,
  ownCount: number
): { subject: string; lines: string[] } {
  return {
    subject: pluralize(targets.length, "agent panel"),
    lines: [
      ...targets.map(({ terminalId, target, worktree }) => {
        const agent = agentName(target);
        return `${panelName(target, agent)} (${shownId(terminalId)}): ${agent}, ${stopOf(target)}${worktreeNote(worktree ?? NOT_READ)}`;
      }),
      "None of their input boxes holds anything typed.",
      ...(ownCount > 0
        ? [
            `The call also closes up to ${pluralize(ownCount, "panel")} the assistant launched itself; declining closes nothing.`,
          ]
        : []),
      TRASH_LINE,
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
    later.lastStateChange === earlier.lastStateChange &&
    // The worktree the question reported on; its git counts may move meanwhile.
    later.worktreeId === earlier.worktreeId
  );
}

/**
 * One close a batch's question covered (#16750): the run it was about, how it
 * was answered, and until when that answer holds.
 */
export interface GlobalCloseItem {
  target: GlobalCloseTarget;
  settlement: "approved" | "skipped";
  deadline: number;
  /** What the question said of its worktree, returned with the close. */
  worktree: WorktreeLocalWork;
}

/**
 * What a Shell's answer lets the close do, and what the audit says of it. An
 * answer covers the close until `deadline` (this host's clock) and no later.
 */
export type GlobalCloseSettlement =
  | { kind: "approved"; deadline: number }
  | { kind: "skipped"; deadline: number }
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
        return { kind: "approved", deadline: answer.deadline };
      }
      return personOnly ? personOnlyRefusal(what) : { kind: "skipped", deadline: answer.deadline };
    case "rejected":
      return {
        kind: "refused",
        decision: "rejected",
        error: {
          code: USER_REJECTED_CODE,
          message: `The user did not approve closing ${what}. Nothing was closed; don't retry unless the user asks again.`,
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

/** An approval that ran out before the close could reach the pane. */
export function globalCloseExpired(what: string): ActionError {
  return {
    code: CONFIRMATION_TIMEOUT_CODE,
    message: `The approval for closing ${what} ran out before the close could run, so nothing was closed.`,
  };
}

function personOnlyRefusal(what: string): GlobalCloseSettlement {
  return {
    kind: "refused",
    error: {
      code: CONFIRMATION_REQUIRED_CODE,
      message: `Closing ${what} needs the user's own yes: an agent stopped on an error may pick up again, and their confirmations preference doesn't cover that. Nothing was closed.`,
    },
  };
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
