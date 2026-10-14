import { z } from "zod";

/**
 * Cross-host assistant messaging, as an enrolled lane sees it: the messages
 * addressed to it and the answers it sends back. Both tools run in main and
 * take the caller's lane from its own help-session bearer, never from their
 * arguments, so a lane only ever reads and answers its own inbox.
 *
 * Message bodies arrive from another machine. They come back as tool results,
 * which carry less authority than a user turn, fenced and labelled as data
 * (OWASP ASI07), and never reach the MCP audit log.
 */

export const ASSISTANT_GET_INBOX_TOOL = "assistant.getInbox";
export const ASSISTANT_REPLY_TOOL = "assistant.reply";

export const ASSISTANT_MESSAGING_TOOL_IDS: ReadonlySet<string> = new Set([
  ASSISTANT_GET_INBOX_TOOL,
  ASSISTANT_REPLY_TOOL,
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

export const AssistantGetInboxResultSchema = z.object({
  messages: z.array(AssistantInboxMessageSchema),
  cursor: z.number(),
  hasMore: z.boolean(),
});

export type AssistantGetInboxResult = z.infer<typeof AssistantGetInboxResultSchema>;

export const AssistantReplyArgsSchema = z.object({
  taskId: z
    .string()
    .min(1)
    .max(TASK_ID_MAX_CHARS)
    .describe("The taskId of an inbox message."),
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

/** Why a messaging tool refused. Its message is fixed text, never anything the caller sent. */
export type AssistantMessagingRefusalCode =
  | "NOT_ELIGIBLE"
  | "INVALID_ARGS"
  | "UNKNOWN_TASK"
  | "EXCHANGE_CLOSED"
  | "TOO_MANY_RESPONSES"
  | "UNAVAILABLE";

export type AssistantMessagingOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: AssistantMessagingRefusalCode; message: string };
