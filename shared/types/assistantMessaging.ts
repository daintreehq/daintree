import { z } from "zod";

/**
 * Cross-host assistant messaging, as an enrolled lane sees it: the messages
 * addressed to it, the answers it sends back, and (for a lane a remote Shell
 * enrolled) messages it starts to that Shell's hub (#13338). Every tool runs
 * in main and takes the caller's lane from its own help-session bearer, never
 * from its arguments, so a lane only ever reads and writes as itself.
 *
 * Message bodies arrive from another machine. They come back as tool results,
 * which carry less authority than a user turn, fenced and labelled as data
 * (OWASP ASI07), and never reach the MCP audit log.
 */

export const ASSISTANT_GET_INBOX_TOOL = "assistant.getInbox";
export const ASSISTANT_REPLY_TOOL = "assistant.reply";
export const ASSISTANT_SEND_MESSAGE_TOOL = "assistant.sendMessage";

export const ASSISTANT_MESSAGING_TOOL_IDS: ReadonlySet<string> = new Set([
  ASSISTANT_GET_INBOX_TOOL,
  ASSISTANT_REPLY_TOOL,
  ASSISTANT_SEND_MESSAGE_TOOL,
]);

/** Longest message body or reply text, in characters. */
export const ASSISTANT_MESSAGE_MAX_CHARS = 16_000;
/** Most messages one `assistant.getInbox` call returns. */
export const ASSISTANT_INBOX_PAGE_MAX = 10;
/**
 * Most UTF-8 bytes one message takes in a result once fenced and serialized as
 * JSON, where a control character can cost six. Checked when a body is
 * admitted, so the largest message still fits one result whole.
 */
export const ASSISTANT_MESSAGE_MAX_SERIALIZED_BYTES = 40_000;
/**
 * Serialized bytes one `assistant.getInbox` call carries across its messages,
 * under the MCP server's per-result cap; a first message always fits.
 */
export const ASSISTANT_INBOX_PAGE_MAX_BYTES = 44_000;
/** Longest sending-host or sending-lane label kept, after control characters go. */
export const ASSISTANT_PROVENANCE_LABEL_MAX_CHARS = 120;
/** Most hops a message may have taken to get here. */
export const ASSISTANT_MAX_HOP_COUNT = 8;
/**
 * Most messages a host's assistants may start in one conversation (contextId)
 * to the hub (#13338), so two assistants can't bounce messages back and forth
 * forever (OWASP ASI08). A reply belongs to the message it answers and spends
 * none.
 */
export const ASSISTANT_CONVERSATION_MAX_HOPS = 2;
/** Most taskIds one `assistant.sendMessage` may reference. */
export const ASSISTANT_REFERENCE_TASK_IDS_MAX = 16;
const TASK_ID_MAX_CHARS = 256;

export const AssistantGetInboxArgsSchema = z.object({
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The cursor a previous call returned with hasMore. Omit to start from the oldest."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(ASSISTANT_INBOX_PAGE_MAX)
    .optional()
    .describe(`Most messages to return, 1-${ASSISTANT_INBOX_PAGE_MAX}.`),
  view: z
    .enum(["received", "sent"])
    .optional()
    .describe("received (default) or sent: yours to the hub, with replies."),
});

export type AssistantGetInboxArgs = z.infer<typeof AssistantGetInboxArgsSchema>;

export const AssistantInboxMessageSchema = z.object({
  taskId: z.string(),
  messageId: z.string(),
  contextId: z.string(),
  state: z.enum(["submitted", "working", "input-required"]),
  receivedAt: z.number(),
  provenance: z.object({
    sendingHost: z.string(),
    sendingLane: z.string(),
    hopCount: z.number(),
  }),
  bodyChars: z.number(),
  untrustedBody: z.string(),
});

export type AssistantInboxMessage = z.infer<typeof AssistantInboxMessageSchema>;

/**
 * Where a message this lane sent the hub stands. `waiting-for-hub` means it is
 * held here until the Shell that enrolled the lane is connected; `refused`
 * and `expired` are final. Anything else is the exchange's own state on the
 * Shell, observed, not a verdict on the work.
 */
export const ASSISTANT_SENT_STATES = [
  "waiting-for-hub",
  "refused",
  "expired",
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
] as const;
export type AssistantSentState = (typeof ASSISTANT_SENT_STATES)[number];

/** Why the Shell refused a sent message. Each is a fixed condition, never the Shell's own words. */
export const ASSISTANT_SEND_REFUSALS = [
  "opted_out",
  "paused",
  "no_hub",
  "hub_unavailable",
  "hop_limit",
  "too_large",
  "unsupported",
  "conflict",
] as const;
export type AssistantSendRefusal = (typeof ASSISTANT_SEND_REFUSALS)[number];

export const AssistantSentReplySchema = z.object({
  state: z.enum(["input-required", "completed"]),
  at: z.number(),
  untrustedText: z.string(),
});

export const AssistantSentMessageSchema = z.object({
  messageId: z.string(),
  contextId: z.string(),
  hopCount: z.number(),
  state: z.enum(ASSISTANT_SENT_STATES),
  refusal: z.enum(ASSISTANT_SEND_REFUSALS).nullable(),
  sentAt: z.number(),
  expiresAt: z.number(),
  /** The newest replies that fit one result whole, oldest first. */
  replies: z.array(AssistantSentReplySchema),
  /** Older replies left out to fit; each was shown when it arrived. */
  repliesOmitted: z.number(),
});

export type AssistantSentMessage = z.infer<typeof AssistantSentMessageSchema>;

export const AssistantGetInboxResultSchema = z.object({
  messages: z.array(AssistantInboxMessageSchema),
  /** With view "sent": the messages this lane sent, in the order they last changed. */
  sent: z.array(AssistantSentMessageSchema).optional(),
  cursor: z.number(),
  hasMore: z.boolean(),
});

export type AssistantGetInboxResult = z.infer<typeof AssistantGetInboxResultSchema>;

export const AssistantReplyArgsSchema = z.object({
  taskId: z.string().min(1).max(TASK_ID_MAX_CHARS).describe("The taskId of an inbox message."),
  state: z
    .enum(["input-required", "completed"])
    .describe(
      "input-required asks the sender a question and keeps the exchange open; completed sends the final reply and closes it."
    ),
  text: z
    .string()
    .min(1)
    .max(ASSISTANT_MESSAGE_MAX_CHARS)
    .describe("The question or the reply, in plain text."),
});

export type AssistantReplyArgs = z.infer<typeof AssistantReplyArgsSchema>;

export const AssistantReplyResultSchema = z.object({
  taskId: z.string(),
  state: z.enum(["input-required", "completed"]),
  revision: z.number(),
});

export type AssistantReplyResult = z.infer<typeof AssistantReplyResultSchema>;

export const AssistantSendMessageArgsSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(ASSISTANT_MESSAGE_MAX_CHARS)
      .describe("The message, in plain text."),
    contextId: z
      .string()
      .min(1)
      .max(TASK_ID_MAX_CHARS)
      .optional()
      .describe("A conversation's contextId, to continue it. Omit to start a new one."),
    referenceTaskIds: z
      .array(z.string().min(1).max(TASK_ID_MAX_CHARS))
      .max(ASSISTANT_REFERENCE_TASK_IDS_MAX)
      .optional()
      .describe(
        `taskIds this message follows on from, at most ${ASSISTANT_REFERENCE_TASK_IDS_MAX}.`
      ),
  })
  .strict();

export type AssistantSendMessageArgs = z.infer<typeof AssistantSendMessageArgsSchema>;

export const AssistantSendMessageResultSchema = z.object({
  messageId: z.string(),
  contextId: z.string(),
  hopCount: z.number(),
  state: z.enum(ASSISTANT_SENT_STATES),
});

export type AssistantSendMessageResult = z.infer<typeof AssistantSendMessageResultSchema>;

/** Why a messaging tool refused. Its message is fixed text, never anything the caller sent. */
export type AssistantMessagingRefusalCode =
  | "NOT_ELIGIBLE"
  | "INVALID_ARGS"
  | "UNKNOWN_TASK"
  | "EXCHANGE_CLOSED"
  | "TOO_MANY_RESPONSES"
  | "PAUSED"
  | "HOP_LIMIT"
  | "TOO_LARGE"
  | "OUTBOX_FULL"
  | "UNAVAILABLE";

export type AssistantMessagingOutcome<T> =
  { ok: true; value: T } | { ok: false; code: AssistantMessagingRefusalCode; message: string };
