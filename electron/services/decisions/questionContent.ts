import {
  RelayError,
  answeredOn,
  messageSentOn,
  openAnswerContent,
  openMessageContent,
  openQuestionContent,
  parseAnswers,
  parseMessages,
  unsupportedEntry,
  type QuestionRow,
  type RelayClient,
  type SealContext,
} from "@daintreehq/decisions-client";
import { decryptAttachment, sha256Hex, sniffImageMime } from "@daintreehq/decisions-crypto";
import { DecisionContentV1, type PhoneImageReference } from "@daintreehq/decisions-protocol";
import type {
  DecisionPreparation,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionImagePartResult,
  DecisionQuestionImageUnavailable,
  DecisionQuestionSummary,
  DecisionThreadEntry,
  DecisionThreadImage,
  DecisionThreadMessage,
} from "../../../shared/types/decisionsQuestion.js";
import { questionLine } from "./attentionList.js";
import {
  NO_ADVISORY_HOST,
  PLAN_REFUSED,
  roundOf,
  verifiedPlan,
  type AdvisoryHost,
} from "./questionRound.js";
import { RetiredAttemptError } from "./relayTransport.js";

/**
 * Where a read comes from: the pane and the project of the view asking, or
 * those a reference names, and this machine's host id. A question is read
 * only for the pane that asked it, on the machine it was asked on.
 */
export interface QuestionReadScope {
  hostId: string | null;
  projectId: string | null;
  terminalId: string;
}

/**
 * What a read names: the pane and project of the view asking, or, for a read
 * by reference from any window (#17229), the reference's machine too, which
 * must be this one.
 */
export type QuestionReadRequest = Omit<QuestionReadScope, "hostId"> & { hostId?: string };

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
  row: QuestionRow,
  host: AdvisoryHost = NO_ADVISORY_HOST
): Promise<DecisionQuestionContentResult> {
  const content = await openedQuestion(ctx, row);
  if (content === null) return { result: "unreadable" };
  const entries = parseAnswers(row.answers_json);
  const plannedFallback = verifiedPlan(row, entries, content);
  // Advisory content the protocol refuses is malformed: never shown, as a phone never offers it.
  if (plannedFallback === PLAN_REFUSED) return { result: "unreadable" };
  const round = roundOf(row, entries, host);
  const question: DecisionQuestionContent = {
    questionId: row.question_id,
    alias: row.alias,
    terminalId: row.origin.pane_id,
    reference: {
      hostId: row.origin.host_id,
      projectId: row.origin.project_id,
      terminalId: row.origin.pane_id,
      questionId: row.question_id,
    },
    revision: row.question_revision,
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
    closedReason: round.closedReason,
    replyMode: round.replyMode,
    plannedFallback,
    preparation: preparationOf(content),
    closureNotice: round.closureNotice,
    deliveryStatus: row.delivery_status,
    attachments: content.attachments.map((attachment) => ({
      attachmentId: attachment.attachment_id,
      role: attachment.role,
      alt: attachment.alt ?? null,
      mime: attachment.mime,
      size: attachment.size,
      sha256: attachment.sha256,
    })),
    thread: await readThread(ctx, row),
  };
  return { result: "read", question };
}

/**
 * The whole question and the plan its round states, from content already
 * opened (#18055), as the question view would show them: null where it would
 * refuse the question as unreadable, its content malformed or its advisory
 * plan refused by the protocol.
 */
export function questionDetail(
  row: QuestionRow,
  opened: DecisionContentV1 | null
): { question: string; plan: string | null } | null {
  const parsed = DecisionContentV1.safeParse(opened);
  if (!parsed.success) return null;
  const plan = verifiedPlan(row, parseAnswers(row.answers_json), parsed.data);
  if (plan === PLAN_REFUSED) return null;
  return { question: parsed.data.question, plan };
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

/** What reading an image needs beyond sealing: the relay its ciphertext is fetched from. */
export interface ImageReadContext extends SealContext {
  client: Pick<RelayClient, "downloadAttachment">;
}

/** How long one image may take to fetch, open and check before it's reported as timed out. */
export const QUESTION_IMAGE_TIMEOUT_MS = 30_000;

/**
 * The most of an image one read returns: well inside the 16 MiB a Remote
 * Host's link carries in one message, so an image of up to the protocol's
 * 20 MiB crosses it in at most three reads.
 */
export const QUESTION_IMAGE_PART_BYTES = 8 * 1024 * 1024;

/** AES-GCM appends a 16-byte tag: the ciphertext is exactly this much longer than the image. */
const GCM_TAG_BYTES = 16;

const TIMED_OUT = { result: "unavailable", reason: "timed-out" } as const;

/**
 * Part of one of the question's images (#17100), starting at `offset`. The
 * whole image is fetched from the relay and opened in memory for every read,
 * then checked as the library checks a phone's image: exactly the declared
 * size, opened under the question's binding, hashing to the digest the
 * question carries, and the declared PNG, JPEG or WebP. Nothing is written,
 * logged or kept between reads: the bytes go only to the view that asked.
 */
export async function readQuestionImage(
  ctx: ImageReadContext,
  row: QuestionRow,
  attachmentId: string,
  offset: number,
  timeoutMs = QUESTION_IMAGE_TIMEOUT_MS
): Promise<DecisionQuestionImagePartResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      over = true;
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([readImagePart(ctx, row, attachmentId, offset, () => over), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function readImagePart(
  ctx: ImageReadContext,
  row: QuestionRow,
  attachmentId: string,
  offset: number,
  isOver: () => boolean
): Promise<DecisionQuestionImagePartResult> {
  const content = await openedQuestion(ctx, row);
  if (content === null) return { result: "unreadable" };
  const descriptor = content.attachments.find(
    (attachment) => attachment.attachment_id === attachmentId
  );
  if (descriptor === undefined) return { result: "not-found" };
  const checked = await checkedImage(ctx, row.question_id, descriptor, isOver);
  if (typeof checked === "string") return { result: "unavailable", reason: checked };
  return {
    result: "read",
    part: {
      attachmentId,
      mime: descriptor.mime,
      sha256: descriptor.sha256,
      size: checked.length,
      offset,
      // A copy, so the part crosses IPC without the rest of the image's buffer.
      bytes: checked.slice(offset, offset + QUESTION_IMAGE_PART_BYTES),
    },
  };
}

type AttachmentDescriptor = DecisionContentV1["attachments"][number];

async function checkedImage(
  ctx: ImageReadContext,
  questionId: string,
  descriptor: AttachmentDescriptor,
  isOver: () => boolean
): Promise<Uint8Array | DecisionQuestionImageUnavailable> {
  let key = ctx.identity.epochs.get(descriptor.key_epoch);
  if (!key && ctx.refreshIdentity) {
    try {
      await ctx.refreshIdentity();
    } catch (error) {
      rethrowRetired(error);
    }
    key = ctx.identity.epochs.get(descriptor.key_epoch);
  }
  if (!key) return "key-unavailable";
  if (isOver()) return "timed-out";
  const expected = descriptor.size + GCM_TAG_BYTES;
  let ciphertext: Uint8Array;
  try {
    ciphertext = await ctx.client.downloadAttachment(descriptor.attachment_id, {
      maxBytes: expected,
    });
  } catch (error) {
    rethrowRetired(error);
    return error instanceof RelayError && error.code === "payload_too_large"
      ? "size-mismatch"
      : "fetch-failed";
  }
  if (ciphertext.length !== expected) return "size-mismatch";
  // A read already answered as timed out does no more work.
  if (isOver()) return "timed-out";
  let bytes: Uint8Array;
  try {
    bytes = await decryptAttachment(
      key,
      {
        installationId: ctx.identity.config.installationId,
        questionId,
        attachmentId: descriptor.attachment_id,
        keyEpoch: descriptor.key_epoch,
      },
      descriptor.nonce,
      ciphertext
    );
  } catch {
    return "decrypt-failed";
  }
  if ((await sha256Hex(bytes)) !== descriptor.sha256) return "digest-mismatch";
  if (sniffImageMime(bytes) !== descriptor.mime) return "type-mismatch";
  return bytes;
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
 * Answers, expiry and decline notices, and follow-ups merged by the ledger
 * seq of the event that carried each, as the library orders a thread: answers
 * stored before threads existed carry none and come first, in the order stored.
 */
async function readThread(ctx: SealContext, row: QuestionRow): Promise<DecisionThreadEntry[]> {
  const placed: { seq: number; entry: DecisionThreadEntry }[] = [];
  for (const entry of parseAnswers(row.answers_json)) {
    const seq = entry.event_seq ?? 0;
    // A question that never reached the relay (0.9.0) says so by its status;
    // the notice its agent is typed is no entry of the thread.
    if (entry.kind === "unpublished") continue;
    // A decline from a source the library doesn't know is no one's (#17943), as the bridge reads it.
    if (entry.kind === "declined" && unsupportedEntry(entry) !== null) continue;
    // Content-free notices: nothing to open, and never an answer.
    if (entry.kind === "expired" || entry.kind === "declined") {
      placed.push({
        seq,
        entry: { type: entry.kind, entryId: entry.entry_id, sentAt: entry.created_at },
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
        onComputer: answeredOn(entry) === "computer",
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
        delivered: entry.delivered,
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
        onComputer: messageSentOn(message) === "computer",
        sentAt: message.created_at,
        deliveryStatus: (message.delivery?.status ??
          null) as DecisionThreadMessage["deliveryStatus"],
        deliveryStopped: message.delivery !== null && !message.delivery.deliver,
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

/** The agent's account of its preparation; the content parse has already dropped a malformed one. */
function preparationOf(content: DecisionContentV1): DecisionPreparation | null {
  const report = content.preparation;
  if (report === undefined) return null;
  return {
    agentsConsulted: report.agents_consulted,
    outcome: report.outcome,
    summary: nonEmpty(report.summary),
  };
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text.trim() === "" ? null : text;
}
