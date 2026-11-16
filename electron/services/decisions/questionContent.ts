import {
  openAnswerContent,
  openMessageContent,
  openQuestionContent,
  parseAnswers,
  parseMessages,
  type QuestionRow,
  type SealContext,
} from "@daintreehq/decisions-client";
import { DecisionContentV1, type PhoneImageReference } from "@daintreehq/decisions-protocol";
import type {
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionSummary,
  DecisionThreadEntry,
  DecisionThreadImage,
  DecisionThreadMessage,
} from "../../../shared/types/decisionsQuestion.js";
import { questionLine } from "./attentionList.js";
import { RetiredAttemptError } from "./relayTransport.js";

/**
 * Where a read comes from: the pane and the project of the view asking, and
 * this machine's host id. A question is read only by a view of the pane that
 * asked it, on the machine it was asked on.
 */
export interface QuestionReadScope {
  hostId: string | null;
  projectId: string | null;
  terminalId: string;
}

export function inScope(row: QuestionRow, scope: QuestionReadScope): boolean {
  const { origin } = row;
  return (
    scope.hostId !== null &&
    scope.projectId !== null &&
    scope.projectId !== "" &&
    origin.host_id === scope.hostId &&
    origin.project_id === scope.projectId &&
    origin.pane_id === scope.terminalId
  );
}

/**
 * The question with its content, answers and follow-ups opened in memory.
 * Nothing opened is logged or kept: a failure to open is reported as
 * `unreadable`, never with the error that said why.
 */
export async function readQuestionContent(
  ctx: SealContext,
  row: QuestionRow
): Promise<DecisionQuestionContentResult> {
  const content = await openedQuestion(ctx, row);
  if (content === null) return { result: "unreadable" };
  const question: DecisionQuestionContent = {
    questionId: row.question_id,
    alias: row.alias,
    terminalId: row.origin.pane_id,
    question: content.question,
    context: content.context ?? null,
    kind: content.kind,
    options: content.options.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description ?? null,
    })),
    allowText: content.allow_text,
    requirement: row.requirement,
    askedAt: row.origin_created_at,
    expiresAt: row.expires_at,
    status: row.local_status,
    deliveryStatus: row.delivery_status,
    attachments: content.attachments.map((attachment) => ({
      attachmentId: attachment.attachment_id,
      role: attachment.role,
      alt: attachment.alt ?? null,
      mime: attachment.mime,
      size: attachment.size,
    })),
    thread: await readThread(ctx, row),
  };
  return { result: "read", question };
}

/** The question's opening line; `unreadable` when its content can't be opened here. */
export async function readQuestionSummary(
  ctx: SealContext,
  row: QuestionRow
): Promise<DecisionQuestionSummary> {
  const content = await openedQuestion(ctx, row);
  if (content === null) return { questionId: row.question_id, result: "unreadable" };
  return { questionId: row.question_id, result: "read", line: questionLine(content.question) };
}

/**
 * The question's content, opened and checked against the protocol's shape;
 * null when the row has none, or it can't be opened or doesn't parse.
 */
async function openedQuestion(
  ctx: SealContext,
  row: QuestionRow
): Promise<DecisionContentV1 | null> {
  let raw: unknown;
  try {
    raw = await openQuestionContent(ctx, row);
  } catch (error) {
    rethrowRetired(error);
    return null;
  }
  if (raw === null) return null;
  const parsed = DecisionContentV1.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Answers, expiry notices and follow-ups merged by the ledger seq of the
 * event that carried each, as the library orders a thread: answers stored
 * before threads existed carry none and come first, in the order stored.
 */
async function readThread(ctx: SealContext, row: QuestionRow): Promise<DecisionThreadEntry[]> {
  const placed: { seq: number; entry: DecisionThreadEntry }[] = [];
  for (const entry of parseAnswers(row.answers_json)) {
    const seq = entry.event_seq ?? 0;
    if (entry.kind === "expired") {
      placed.push({
        seq,
        entry: { type: "expired", entryId: entry.entry_id, sentAt: entry.created_at },
      });
      continue;
    }
    let opened;
    try {
      opened = await openAnswerContent(ctx, row.question_id, entry);
    } catch (error) {
      rethrowRetired(error);
      opened = null;
    }
    placed.push({
      seq,
      entry: {
        type: "answer",
        entryId: entry.entry_id,
        revision: entry.revision,
        from: entry.source === "proxy" ? "model" : "person",
        correction: entry.correction,
        confirmsModel: entry.action === "confirm-proxy",
        choices: (opened?.choices ?? []).map((choice) => ({
          id: choice.id,
          label: choice.label ?? null,
        })),
        text: nonEmpty(opened?.text),
        reason: nonEmpty(opened?.reason),
        images: (opened?.images ?? []).map(threadImage),
        sentAt: entry.created_at,
        unreadable: opened === null,
      },
    });
  }
  for (const message of parseMessages(row.messages_json)) {
    let opened;
    try {
      opened = await openMessageContent(ctx, row.question_id, message);
    } catch (error) {
      rethrowRetired(error);
      opened = null;
    }
    placed.push({
      seq: message.event_seq,
      entry: {
        type: "message",
        messageId: message.message_id,
        from: message.side === "agent" ? "agent" : "person",
        text: nonEmpty(opened?.text),
        images: (opened?.images ?? []).map(threadImage),
        expectsReply: message.expects_reply,
        sentAt: message.created_at,
        deliveryStatus: (message.delivery?.status ??
          null) as DecisionThreadMessage["deliveryStatus"],
        unreadable: opened === null,
      },
    });
  }
  // Stable, so entries sharing a seq (answers stored before threads) keep their stored order.
  return placed.sort((a, b) => a.seq - b.seq).map((item) => item.entry);
}

/**
 * A delivery that stopped under a read refuses the key reload an open may
 * need: that is the read stopping, not the content being unreadable.
 */
function rethrowRetired(error: unknown): void {
  if (error instanceof RetiredAttemptError) throw error;
}

function threadImage(image: PhoneImageReference): DecisionThreadImage {
  return {
    attachmentId: image.attachment_id,
    alt: image.alt ?? null,
    mime: image.mime,
    size: image.size,
  };
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text.trim() === "" ? null : text;
}
