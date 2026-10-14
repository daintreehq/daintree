import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import { EXCHANGE_STATES } from "../exchange/types.js";

/**
 * Session-level methods for assistant exchanges between a Shell and a host.
 * They ride every session, including a summary-only one with no view bound.
 * None names who is asking: the host knows the sender from the credential the
 * session authenticated with, and the lane's consent from its enrollment. A
 * host from before these existed answers UNSUPPORTED, which reads as "this
 * host doesn't support assistant messaging".
 */
export const AssistantLinkMethod = {
  /** Shell → Host: bind this session to the Shell's sender credential for this host. */
  AUTHENTICATE: "assistant.authenticate",
  /** Shell → Host: the lanes this session enrolled. */
  LIST_LANES: "assistant.list-lanes",
  /** Shell → Host: send a message to an enrolled lane; a resend of its messageId never sends twice. */
  SEND: "assistant.send",
  /** Shell → Host: one of this sender's exchanges by messageId, or null when the host has none. */
  GET_EXCHANGE: "assistant.get-exchange",
  /** Shell → Host: this sender's exchanges changed since a revision cursor. */
  LIST_EXCHANGES: "assistant.list-exchanges",
  /** Shell → Host: ask to cancel one of this sender's exchanges. */
  CANCEL_EXCHANGE: "assistant.cancel-exchange",
} as const;

export const MAX_EXCHANGE_BODY_CHARS = 256 * 1024;
export const MAX_EXCHANGE_PAGE = 500;
export const MAX_LISTED_LANES = 256;
const MAX_REFERENCE_TASK_IDS = 64;

const id = z.string().min(1).max(256);
const timestamp = z.number().int().min(0);
const nullableTimestamp = timestamp.nullable();
const slot = z
  .number()
  .int()
  .min(0)
  .max(MAX_ASSISTANT_SLOTS - 1);

/** 32 random bytes, base64url: only its holder can authenticate as the sender it derives. */
export const SenderCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AuthenticatePayloadSchema = z.object({ credential: SenderCredentialSchema }).strict();

export const SendPayloadSchema = z
  .object({
    messageId: id,
    contextId: id,
    referenceTaskIds: z.array(id).max(MAX_REFERENCE_TASK_IDS),
    projectId: id,
    slot,
    /** The enrollment generation the Shell was told; a later enrollment refuses it. */
    generation: id,
    body: z.string().min(1).max(MAX_EXCHANGE_BODY_CHARS),
  })
  .strict();
export type AssistantSendPayload = z.infer<typeof SendPayloadSchema>;

export const MessageIdPayloadSchema = z.object({ messageId: id }).strict();

export const ListExchangesPayloadSchema = z
  .object({
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_EXCHANGE_PAGE).optional(),
  })
  .strict();

export const EnrolledLaneSchema = z
  .object({
    projectId: id,
    slot,
    generation: id,
    /** Whether the lane would take a message now: its assistant is running and messaging isn't paused. */
    available: z.boolean(),
  })
  .strip();
export type EnrolledLane = z.infer<typeof EnrolledLaneSchema>;

export const LaneListSchema = z
  .object({ lanes: z.array(EnrolledLaneSchema).max(MAX_LISTED_LANES) })
  .strip();

export const ExchangeRecordSchema = z
  .object({
    taskId: id,
    senderId: id,
    messageId: id,
    contextId: id,
    referenceTaskIds: z.array(id).max(MAX_REFERENCE_TASK_IDS),
    receiver: z.object({ hostId: id, laneId: id, enrollmentGeneration: id }).strip(),
    state: z.enum(EXCHANGE_STATES),
    outcome: z.string().max(64).nullable(),
    bodyDigest: z.string().max(128),
    bodyBytes: z.number().int().min(0),
    replyDigest: z.string().max(128).nullable(),
    replyBytes: z.number().int().min(0).nullable(),
    delivery: z
      .object({
        attemptedAt: nullableTimestamp,
        acceptedAt: nullableTimestamp,
        wakeTypedAt: nullableTimestamp,
        inboxFetchedAt: nullableTimestamp,
        replyReceivedAt: nullableTimestamp,
        ambiguousAt: nullableTimestamp,
      })
      .strip(),
    cancelRequestedAt: nullableTimestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    terminalAt: nullableTimestamp,
    tombstonedAt: nullableTimestamp,
    revision: timestamp,
  })
  .strip();

export const SendResultSchema = z
  .object({
    disposition: z.enum(["created", "existing", "tombstoned"]),
    record: ExchangeRecordSchema,
  })
  .strip();

export const ExchangeChangesSchema = z
  .object({
    records: z.array(ExchangeRecordSchema).max(MAX_EXCHANGE_PAGE),
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    hasMore: z.boolean(),
    reset: z.boolean(),
  })
  .strip();
