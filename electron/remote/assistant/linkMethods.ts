import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../../../shared/config/assistantSlots.js";
import {
  ASSISTANT_MAX_HOP_COUNT,
  ASSISTANT_SEND_REFUSALS,
} from "../../../shared/types/assistantMessaging.js";
import { CODEX_QUOTA_UNAVAILABLE_REASONS } from "../../../shared/types/ipc/agentQuota.js";
import { EXCHANGE_STATES } from "../exchange/types.js";

/**
 * Session-level methods for assistant exchanges between a Shell and a host.
 * They ride every session, including a summary-only one with no view bound.
 * None names who is asking: the host knows the sender from the credential the
 * session authenticated with. A host's lanes take messages from any Shell that
 * authenticated, with no enrollment (#13467); a host from before that
 * answers only for lanes enrolled for the asking Shell. A host from before
 * these existed answers UNSUPPORTED, which reads as "this host doesn't support
 * assistant messaging".
 */
export const AssistantLinkMethod = {
  /** Shell → Host: bind this session to the Shell's sender credential for this host. */
  AUTHENTICATE: "assistant.authenticate",
  /**
   * Shell → Host: the lanes whose own messages go to this session's Shell,
   * every lane open to other machines (absent from an older host, where the
   * first are all a Shell can message), and every assistant running on the
   * host with its agent.
   */
  LIST_LANES: "assistant.list-lanes",
  /**
   * Shell → Host: route to this session's Shell the messages a lane its hub
   * just started in one of the host's projects (#13392) writes of its own:
   * only that run, by help session id, only when it came through one of this
   * Shell's views, and only while no other Shell holds the lane. On an older
   * host this is also what lets the Shell message the lane at all.
   */
  ENROLL_STARTED: "assistant.enroll-started",
  /**
   * Shell → Host: the host's Codex account quota, as Codex reports it there
   * (#13392), so the hub can tell which host has allowance left.
   */
  READ_QUOTA: "assistant.read-quota",
  /** Shell → Host: send a message to a lane; a resend of its messageId never sends twice. */
  SEND: "assistant.send",
  /** Shell → Host: one of this sender's exchanges by messageId, or null when the host has none. */
  GET_EXCHANGE: "assistant.get-exchange",
  /** Shell → Host: this sender's exchanges changed since a revision cursor. */
  LIST_EXCHANGES: "assistant.list-exchanges",
  /** Shell → Host: ask to cancel one of this sender's exchanges. */
  CANCEL_EXCHANGE: "assistant.cancel-exchange",
  /**
   * Host → Shell: one of this session's sender's exchanges changed. Carries
   * only the revision; the Shell reads what changed by cursor, so a repeat or
   * an event out of order changes nothing.
   */
  EXCHANGE_CHANGED: "assistant.exchange-changed",
  /**
   * Shell → Host: the answers a lane gave one of this sender's exchanges,
   * while the host still holds them. A host from before this call answers
   * UNSUPPORTED, which reads as "replies aren't available from this host".
   */
  GET_RESPONSES: "assistant.get-responses",
  /**
   * Host → Shell: a message one of this session's enrolled lanes starts to the
   * Shell's hub (#13338). The Shell knows the host from the connection, and
   * answers whether it admitted it; a resend of its messageId never admits
   * twice. A Shell from before this call answers UNSUPPORTED.
   */
  SEND_TO_HUB: "assistant.send-to-hub",
  /** Host → Shell: where one of this host's messages to the hub stands, with the hub's answers. */
  GET_HUB_EXCHANGE: "assistant.get-hub-exchange",
  /**
   * Shell → Host: one of the host's messages to the hub changed or was
   * answered. Carries only the messageId; the host reads it back.
   */
  HUB_EXCHANGE_CHANGED: "assistant.hub-exchange-changed",
} as const;

export const MAX_EXCHANGE_BODY_CHARS = 256 * 1024;
export const MAX_EXCHANGE_PAGE = 500;
export const MAX_EXCHANGE_RESPONSES = 32;
/** Longest answer text a host returns; a lane's reply is cut far shorter than this. */
export const MAX_RESPONSE_TEXT_CHARS = 64 * 1024;
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
    /**
     * The generation the Shell was listed. A host whose lanes are open files
     * every message under the lane's one stable address whatever this says;
     * an older host refuses one from an earlier enrollment.
     */
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
    /** The agent CLI the lane's assistant runs; absent while it isn't running. */
    agentId: id.optional(),
  })
  .strip();
export type EnrolledLane = z.infer<typeof EnrolledLaneSchema>;

export const RunningAssistantSchema = z
  .object({
    projectId: id,
    slot,
    agentId: id,
    /** Whether its Daintree tools work: it runs through a live view. Absent from older hosts. */
    attached: z.boolean().optional(),
  })
  .strip();

export const EnrollStartedPayloadSchema = z.object({ projectId: id, slot, sessionId: id }).strict();
export type EnrollStartedPayload = z.infer<typeof EnrollStartedPayloadSchema>;

export const EnrollStartedResultSchema = z
  .object({
    status: z.enum(["enrolled", "occupied", "not-running", "wrong-session", "refused"]),
    lane: EnrolledLaneSchema.nullable(),
  })
  .strip();
export type EnrollStartedResult = z.infer<typeof EnrollStartedResultSchema>;
export type RunningAssistant = z.infer<typeof RunningAssistantSchema>;

export const LaneListSchema = z
  .object({
    lanes: z.array(EnrolledLaneSchema).max(MAX_LISTED_LANES),
    /**
     * Every lane open to other machines (#13467), which any authenticated
     * Shell may message. Absent from an older host: there `lanes` are all
     * this Shell can message.
     */
    open: z.array(EnrolledLaneSchema).max(MAX_LISTED_LANES).optional(),
    /** Absent from a host older than the listing of every assistant. */
    assistants: z.array(RunningAssistantSchema).max(MAX_LISTED_LANES).optional(),
  })
  .strip();
export type LaneList = z.infer<typeof LaneListSchema>;

/** Codex reports two windows today; anything past this isn't a reading this build understands. */
const MAX_QUOTA_WINDOWS = 8;
const MAX_PLAN_TYPE_CHARS = 64;

export const CodexQuotaReadingSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      planType: z.string().max(MAX_PLAN_TYPE_CHARS).nullable(),
      windows: z
        .array(
          z
            .object({
              usedPercent: z.number().min(0).max(100),
              windowDurationMins: z.number().int().min(1),
              resetsAt: nullableTimestamp,
            })
            .strip()
        )
        .min(1)
        .max(MAX_QUOTA_WINDOWS),
      fetchedAt: timestamp,
    })
    .strip(),
  z
    .object({
      status: z.literal("unavailable"),
      // A newer host may name a reason this Shell doesn't know: still no quota, so a failed read.
      reason: z.union([
        z.enum(CODEX_QUOTA_UNAVAILABLE_REASONS),
        z
          .string()
          .max(64)
          .transform(() => "read-failed" as const),
      ]),
      fetchedAt: timestamp,
    })
    .strip(),
]);
export type CodexQuotaReading = z.infer<typeof CodexQuotaReadingSchema>;

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

export const ExchangeChangedPayloadSchema = z
  .object({ revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
  .strip();

export const ExchangeResponseSchema = z
  .object({
    state: z.enum(["input-required", "completed"]),
    text: z.string().max(MAX_RESPONSE_TEXT_CHARS),
    at: timestamp,
  })
  .strip();
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;

export const ExchangeResponsesSchema = z
  .object({ responses: z.array(ExchangeResponseSchema).max(MAX_EXCHANGE_RESPONSES) })
  .strip();

export const SendToHubPayloadSchema = z
  .object({
    messageId: id,
    contextId: id,
    referenceTaskIds: z.array(id).max(MAX_REFERENCE_TASK_IDS),
    /** The host's lane that wrote it: display provenance the host vouches for, never a destination. */
    sourceLane: z.object({ projectId: id, slot }).strict(),
    /** How many messages the host's lanes have started in this contextId, this one included. */
    hopCount: z.number().int().min(1).max(ASSISTANT_MAX_HOP_COUNT),
    body: z.string().min(1).max(MAX_EXCHANGE_BODY_CHARS),
  })
  .strict();
export type SendToHubPayload = z.infer<typeof SendToHubPayloadSchema>;

export const HubExchangeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      taskId: id,
      state: z.enum(EXCHANGE_STATES),
      /** The hop the Shell counted for it, which may be above the one the host claimed. */
      hopCount: z.number().int().min(1).max(ASSISTANT_MAX_HOP_COUNT).optional(),
      responses: z.array(ExchangeResponseSchema).max(MAX_EXCHANGE_RESPONSES),
    })
    .strip(),
  z.object({ status: z.literal("refused"), refusal: z.enum(ASSISTANT_SEND_REFUSALS) }).strip(),
  /** Nothing was recorded; send it again after `retryAfterMs`. */
  z
    .object({
      status: z.literal("rate_limited"),
      retryAfterMs: z
        .number()
        .int()
        .min(0)
        .max(60 * 60_000),
    })
    .strip(),
]);
export type HubExchange = z.infer<typeof HubExchangeSchema>;

export const HubExchangeChangedPayloadSchema = z.object({ messageId: id }).strip();
