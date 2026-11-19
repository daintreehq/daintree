import {
  isPendingMessage,
  parseAnswers,
  parseMessages,
  type QuestionRow,
  type StoredMessage,
} from "@daintreehq/decisions-client";
import { threadAwaitsHuman } from "@daintreehq/decisions-protocol";
import type {
  DecisionQuestionListItem,
  DecisionQuestionStall,
  DecisionQuestionStanding,
} from "../../../shared/types/decisionsQuestion.js";
import {
  answerNeedsAttention,
  answerRevision,
  heldFollowUps,
  isHandled,
  pendingEntries,
  type HandledAnswers,
} from "./attentionList.js";
import { reasonOf } from "./paneDecisionState.js";
import { closedReasonOf, declineOf } from "./questionClosed.js";

type AnsweredStatus = Extract<QuestionRow["local_status"], "human-answered" | "proxy-answered">;

function byAlias(a: QuestionRow, b: QuestionRow): number {
  return a.alias - b.alias || (a.question_id < b.question_id ? -1 : 1);
}

function attentionStatus(status: QuestionRow["delivery_status"]): boolean {
  return status === "needs-attention" || status === "delivery-uncertain";
}

/**
 * Every question this computer asked, from the store's rows (#17229), oldest
 * first, `handled` the answers a person marked handled. Imported history and
 * questions another machine asked aren't this computer's, and show nowhere.
 * Only ids, labels, times and statuses are copied, field by field: a row's
 * content and its answers' and follow-ups' sealed text are never read.
 */
export function projectDecisionQuestions(
  rows: readonly QuestionRow[],
  handled: HandledAnswers,
  hostId: string | null
): DecisionQuestionListItem[] {
  if (hostId === null) return [];
  return rows
    .filter(
      (row) =>
        !row.history_only &&
        row.origin.host_id === hostId &&
        row.origin.project_id !== "" &&
        row.origin.pane_id !== ""
    )
    .sort(byAlias)
    .map((row) => {
      const { origin } = row;
      const standing = standingOf(row, handled);
      return {
        reference: {
          hostId,
          projectId: origin.project_id,
          terminalId: origin.pane_id,
          questionId: row.question_id,
        },
        alias: row.alias,
        agentKind: origin.agent_kind,
        projectLabel: origin.project_label?.trim() || null,
        worktreeId: origin.worktree_id,
        worktreeRoot: origin.worktree_root,
        requirement: row.requirement,
        askedAt: row.origin_created_at,
        expiresAt: row.expires_at ?? null,
        settledAt: standing.kind === "settled" ? settledAt(row, standing.outcome) : null,
        standing,
        replyRequest: replyRequestOf(row),
        stall: stallOf(row, handled),
      };
    });
}

/**
 * Where the question stands. One that needs a person's decision about its
 * answer or a follow-up does first, whatever else holds, so this list and the
 * list of answers needing attention never disagree; then a closed question is
 * settled, a waiting one waits, and an answered one waits for a reply its
 * agent asked for, for its answer or follow-up to be typed in, or is settled.
 * A received answer or follow-up waits to be typed by the delivery engine's
 * own test, as the pane's chip shows it.
 */
export function standingOf(row: QuestionRow, handled: HandledAnswers): DecisionQuestionStanding {
  const answerHeld = answerNeedsAttention(row, handled);
  const held = heldFollowUps(row);
  if (answerHeld || held.length > 0) {
    const uncertain =
      (answerHeld && row.delivery_status === "delivery-uncertain") ||
      held.some((message) => message.delivery?.status === "delivery-uncertain");
    return {
      kind: "needs-attention",
      deliveryStatus: uncertain ? "delivery-uncertain" : "needs-attention",
    };
  }
  switch (row.local_status) {
    case "cancelled":
      return {
        kind: "settled",
        outcome: closedReasonOf(row) === "declined" ? "declined" : "withdrawn",
      };
    case "expired":
      return { kind: "settled", outcome: "expired" };
    case "queued":
      return { kind: "queued" };
    case "publish-failed":
      return { kind: "send-failed" };
    case "open":
      return { kind: "waiting", reason: "open" };
    case "human-answered":
    case "proxy-answered":
      return answeredStanding(row, row.local_status, handled);
  }
}

function answeredStanding(
  row: QuestionRow,
  status: AnsweredStatus,
  handled: HandledAnswers
): DecisionQuestionStanding {
  const messages = parseMessages(row.messages_json);
  if (awaitsReply(row, status, messages)) return { kind: "waiting", reason: "reply" };
  // An answer delivery stopped on and a person handled is never typed in.
  const answerPending = !attentionStatus(row.delivery_status) && pendingEntries(row).length > 0;
  if (answerPending || messages.some(isPendingMessage)) return { kind: "to-type" };
  return { kind: "settled", outcome: "answered", handled: isHandled(row, handled) };
}

function awaitsReply(
  row: QuestionRow,
  status: AnsweredStatus,
  messages: readonly StoredMessage[]
): boolean {
  return threadAwaitsHuman({ status, messages, lastHumanActionSeq: lastHumanActionSeq(row) });
}

/**
 * The agent's follow-up asking for a reply, while it still does: its latest,
 * which `threadAwaitsHuman` reads the request from. Whatever the question's
 * standing shows first, an answered one can ask for a reply.
 */
function replyRequestOf(row: QuestionRow): string | null {
  const status = row.local_status;
  if (status !== "human-answered" && status !== "proxy-answered") return null;
  const messages = parseMessages(row.messages_json);
  if (!awaitsReply(row, status, messages)) return null;
  return latestAgentMessage(messages)?.message_id ?? null;
}

/** The agent's latest message on the thread, by ledger seq; null before it sent one. */
function latestAgentMessage(messages: readonly StoredMessage[]): StoredMessage | null {
  let latest: StoredMessage | null = null;
  for (const message of messages) {
    if (message.side === "agent" && (latest === null || message.event_seq > latest.event_seq)) {
      latest = message;
    }
  }
  return latest;
}

/**
 * What each of the questions `ids` names asks of the person now (#17895), by
 * question id: the agent's latest follow-up, which a mark the person made
 * before it doesn't cover, or null for the question alone. For one answered
 * and waiting again, that is the follow-up asking for a reply. Ids only.
 */
export function questionAsks(
  rows: readonly QuestionRow[],
  ids: ReadonlySet<string>
): Map<string, string | null> {
  const asks = new Map<string, string | null>();
  for (const row of rows) {
    if (!ids.has(row.question_id)) continue;
    asks.set(
      row.question_id,
      latestAgentMessage(parseMessages(row.messages_json))?.message_id ?? null
    );
  }
  return asks;
}

/** What delivery stopped on, as `standingOf` reads it; null while nothing needs a person. */
function stallOf(row: QuestionRow, handled: HandledAnswers): DecisionQuestionStall | null {
  const answerHeld = answerNeedsAttention(row, handled);
  const held = heldFollowUps(row);
  if (!answerHeld && held.length === 0) return null;
  return {
    answerRevision: answerHeld ? answerRevision(row) : null,
    followUpIds: held.map((message) => message.message_id),
    reason: reasonOf(answerHeld ? row.error_code : (held[0]!.delivery?.error_code ?? null)),
  };
}

/**
 * The ledger seq of the person's latest answer, correction or confirmation of
 * the model's: what an agent's request for a reply is compared against. An
 * answer stored before threads carries none, and comes before every message.
 */
function lastHumanActionSeq(row: QuestionRow): number | null {
  let latest: number | null = null;
  for (const entry of parseAnswers(row.answers_json)) {
    if (entry.source !== "human" || entry.event_seq === undefined) continue;
    if (
      entry.action !== "answer" &&
      entry.action !== "override" &&
      entry.action !== "confirm-proxy"
    ) {
      continue;
    }
    latest = Math.max(latest ?? 0, entry.event_seq);
  }
  return latest;
}

/**
 * When a settled question settled: its newest answer, or the person's reply
 * to the agent's latest request for one when that came later; its expiry
 * notice, else the time it was set to expire; the person's decline. A
 * withdrawal records no time.
 */
function settledAt(
  row: QuestionRow,
  outcome: "answered" | "withdrawn" | "expired" | "declined"
): string | null {
  if (outcome === "withdrawn") return null;
  if (outcome === "declined") return declineOf(row)?.created_at ?? null;
  const kind = outcome === "answered" ? "answer" : "expired";
  let newest: { revision: number; at: string } | null = null;
  for (const entry of parseAnswers(row.answers_json)) {
    if (entry.kind !== kind) continue;
    if (newest === null || entry.revision >= newest.revision) {
      newest = { revision: entry.revision, at: entry.created_at };
    }
  }
  if (outcome === "expired") return newest?.at ?? row.expires_at ?? null;
  const reply = replyAt(row);
  if (newest === null) return reply;
  return reply !== null && Date.parse(reply) > Date.parse(newest.at) ? reply : newest.at;
}

/**
 * When the person replied to the agent's latest request for a reply: the
 * message right after it, when that is theirs. One of the agent's after the
 * request supersedes it, as `threadAwaitsHuman` reads the thread; null then,
 * and without a request.
 */
function replyAt(row: QuestionRow): string | null {
  const messages = [...parseMessages(row.messages_json)].sort((a, b) => a.event_seq - b.event_seq);
  let asked = -1;
  messages.forEach((message, index) => {
    if (message.side === "agent" && message.expects_reply) asked = index;
  });
  const next = asked === -1 ? undefined : messages[asked + 1];
  return next?.side === "human" ? next.created_at : null;
}
