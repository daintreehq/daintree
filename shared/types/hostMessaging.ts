import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../config/assistantSlots.js";
import { ASSISTANT_MESSAGE_MAX_CHARS } from "./assistantMessaging.js";

/**
 * Cross-host assistant messaging, as this Shell's hub sees it (#13336): the
 * hosts it may reach, the assistants enrolled on each, and the messages it
 * sends them. Every tool runs in main for the hub lane's own help session and
 * talks to hosts over the link (#13334), never through a renderer or a host's
 * MCP key.
 *
 * A tool answers with an `outcome` naming what happened. Only a caller that
 * isn't the hub, or arguments that don't parse, are tool errors; a host that
 * is opted out, unreachable or too old, or a send whose fate isn't known yet,
 * is a result the caller can act on. `ambiguous` is never a failure: the
 * message may have arrived, and `host.getTask` finds out.
 */

export const HOST_LIST_TOOL = "host.list";
export const HOST_LIST_ASSISTANTS_TOOL = "host.listAssistants";
export const HOST_SEND_MESSAGE_TOOL = "host.sendMessage";
export const HOST_GET_TASK_TOOL = "host.getTask";
export const HOST_LIST_TASKS_TOOL = "host.listTasks";
export const HOST_CANCEL_TASK_TOOL = "host.cancelTask";

export const HOST_MESSAGING_TOOL_IDS: ReadonlySet<string> = new Set([
  HOST_LIST_TOOL,
  HOST_LIST_ASSISTANTS_TOOL,
  HOST_SEND_MESSAGE_TOOL,
  HOST_GET_TASK_TOOL,
  HOST_LIST_TASKS_TOOL,
  HOST_CANCEL_TASK_TOOL,
]);

/** Longest bounded wait `host.sendMessage` takes, in milliseconds. */
export const HOST_SEND_MAX_WAIT_MS = 30_000;
/** Most tasks one `host.listTasks` call returns. */
export const HOST_TASK_PAGE_MAX = 20;
/** Serialized bytes the replies in one `host.getTask` result may take, oldest dropped first. */
export const HOST_TASK_REPLIES_MAX_BYTES = 40_000;
/** Most reference task ids one message carries. */
export const HOST_REFERENCE_TASK_IDS_MAX = 16;

export const HOST_MESSAGING_OUTCOMES = [
  "ok",
  "ambiguous",
  "opted_out",
  "disconnected",
  "unsupported",
  "lane_unavailable",
  "paused",
  "policy_rejected",
  "expired",
  "not_found",
  "rate_limited",
  "too_large",
  "conflict",
] as const;

export type HostMessagingOutcomeCode = (typeof HOST_MESSAGING_OUTCOMES)[number];

const outcomeSchema = z.enum(HOST_MESSAGING_OUTCOMES);
const hostIdSchema = z.string().min(1).max(64).describe("A host id from the host list.");
const idSchema = z.string().min(1).max(256);
const taskIdSchema = idSchema.describe("The taskId a send returned.");

const outcomeFields = {
  outcome: outcomeSchema,
  /** Plain words on what the outcome means and what to do next; fixed text. */
  detail: z.string().nullable(),
  /** Set with `rate_limited`: how long until a retry may succeed. */
  retryAfterMs: z.number().nullable(),
};

export const HostListArgsSchema = z.object({});
export type HostListArgs = z.infer<typeof HostListArgsSchema>;

const laneSchema = z.object({
  projectId: z.string(),
  projectName: z.string().nullable(),
  slot: z.number(),
  generation: z.string(),
  available: z.boolean(),
  agentId: z.string().nullable(),
});
export type HostAssistantLane = z.infer<typeof laneSchema>;

/** Most projects one `host.listAssistants` returns; those with assistants come first. */
export const HOST_LIST_PROJECTS_MAX = 50;

const hostAssistantSchema = z.object({
  slot: z.number(),
  agentId: z.string().nullable(),
  // Set once the assistant is enrolled for this Shell: what a message to it names.
  generation: z.string().nullable(),
  available: z.boolean(),
});
export type HostProjectAssistant = z.infer<typeof hostAssistantSchema>;

const hostProjectSchema = z.object({
  projectId: z.string(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  assistants: z.array(hostAssistantSchema),
});
export type HostProjectEntry = z.infer<typeof hostProjectSchema>;

export const HostListEntrySchema = z.object({
  hostId: z.string(),
  name: z.string(),
  connection: z.enum(["connected", "connecting", "disconnected"]),
  rttMs: z.number().nullable(),
  lastSeenAt: z.number().nullable(),
  load: z
    .object({
      sampledAt: z.number(),
      cpuPercent: z.number().nullable(),
      memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
      thermal: z.enum(["nominal", "fair", "serious", "critical"]).nullable(),
    })
    .nullable(),
  agentsObserved: z
    .object({ working: z.number(), waiting: z.number(), idle: z.number() })
    .nullable(),
  lanes: z.array(laneSchema).nullable(),
  lanesObservedAt: z.number().nullable(),
});
export type HostListEntry = z.infer<typeof HostListEntrySchema>;

export const HostListResultSchema = z.object({ hosts: z.array(HostListEntrySchema) });
export type HostListResult = z.infer<typeof HostListResultSchema>;

export const HostListAssistantsArgsSchema = z.object({ hostId: hostIdSchema });
export type HostListAssistantsArgs = z.infer<typeof HostListAssistantsArgsSchema>;

export const HostListAssistantsResultSchema = z.object({
  ...outcomeFields,
  projects: z.array(hostProjectSchema).nullable(),
  projectsOmitted: z.number(),
});
export type HostListAssistantsResult = z.infer<typeof HostListAssistantsResultSchema>;

export const HostTaskSchema = z.object({
  taskId: z.string(),
  hostTaskId: z.string(),
  contextId: z.string(),
  laneId: z.string(),
  state: z.enum([
    "submitted",
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
    "rejected",
  ]),
  outcomeCode: z.string().nullable(),
  delivery: z.object({
    acceptedAt: z.number().nullable(),
    wakeTypedAt: z.number().nullable(),
    inboxFetchedAt: z.number().nullable(),
    replyReceivedAt: z.number().nullable(),
    ambiguousAt: z.number().nullable(),
  }),
  cancelRequestedAt: z.number().nullable(),
  updatedAt: z.number(),
  expiresAt: z.number(),
});
export type HostTask = z.infer<typeof HostTaskSchema>;

export const HostSendMessageArgsSchema = z.object({
  hostId: hostIdSchema,
  projectId: idSchema.describe("The lane's projectId, as the host's assistants are listed."),
  slot: z
    .number()
    .int()
    .min(0)
    .max(MAX_ASSISTANT_SLOTS - 1)
    .describe("The lane's slot."),
  generation: idSchema.describe("The lane's generation; a lane enrolled again has a new one."),
  text: z.string().min(1).max(ASSISTANT_MESSAGE_MAX_CHARS).describe("The message, in plain text."),
  contextId: idSchema
    .optional()
    .describe("A conversation's contextId, to continue it. Omit to start a new one."),
  referenceTaskIds: z
    .array(idSchema)
    .max(HOST_REFERENCE_TASK_IDS_MAX)
    .optional()
    .describe(`taskIds this answers or follows on from, at most ${HOST_REFERENCE_TASK_IDS_MAX}.`),
  taskId: idSchema
    .optional()
    .describe("Resend an ambiguous message under its own taskId. Never sends twice."),
  waitMs: z
    .number()
    .int()
    .min(0)
    .max(HOST_SEND_MAX_WAIT_MS)
    .optional()
    .describe(
      `Wait up to this long (max ${HOST_SEND_MAX_WAIT_MS}) for a reply. A timeout ends the wait, not the message.`
    ),
});
export type HostSendMessageArgs = z.infer<typeof HostSendMessageArgsSchema>;

export const HostSendMessageResultSchema = z.object({
  ...outcomeFields,
  taskId: z.string().nullable(),
  contextId: z.string().nullable(),
  task: HostTaskSchema.nullable(),
  wait: z.enum(["none", "settled", "timed_out", "skipped"]),
});
export type HostSendMessageResult = z.infer<typeof HostSendMessageResultSchema>;

export const HostGetTaskArgsSchema = z.object({ hostId: hostIdSchema, taskId: taskIdSchema });
export type HostGetTaskArgs = z.infer<typeof HostGetTaskArgsSchema>;

const replySchema = z.object({
  state: z.enum(["input-required", "completed"]),
  at: z.number(),
  untrustedText: z.string(),
});
export type HostTaskReply = z.infer<typeof replySchema>;

export const HostGetTaskResultSchema = z.object({
  ...outcomeFields,
  task: HostTaskSchema.nullable(),
  /** When `task` was last heard from the host; older than now when it came from this Shell's journal. */
  observedAt: z.number().nullable(),
  replies: z.array(replySchema).nullable(),
  repliesOmitted: z.number(),
});
export type HostGetTaskResult = z.infer<typeof HostGetTaskResultSchema>;

export const HostListTasksArgsSchema = z.object({
  hostId: hostIdSchema,
  cursor: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The cursor a previous call returned. Omit to start from the oldest."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(HOST_TASK_PAGE_MAX)
    .optional()
    .describe(`Most changes to read, 1-${HOST_TASK_PAGE_MAX}.`),
  states: z
    .array(HostTaskSchema.shape.state)
    .min(1)
    .max(7)
    .optional()
    .describe(
      "Only tasks in these states, 1-7 of them. A filtered page can be empty while hasMore."
    ),
});
export type HostListTasksArgs = z.infer<typeof HostListTasksArgsSchema>;

export const HostListTasksResultSchema = z.object({
  ...outcomeFields,
  tasks: z.array(HostTaskSchema).nullable(),
  cursor: z.number().nullable(),
  hasMore: z.boolean(),
  reset: z.boolean(),
});
export type HostListTasksResult = z.infer<typeof HostListTasksResultSchema>;

export const HostCancelTaskArgsSchema = z.object({ hostId: hostIdSchema, taskId: taskIdSchema });
export type HostCancelTaskArgs = z.infer<typeof HostCancelTaskArgsSchema>;

export const HostCancelTaskResultSchema = z.object({
  ...outcomeFields,
  task: HostTaskSchema.nullable(),
});
export type HostCancelTaskResult = z.infer<typeof HostCancelTaskResultSchema>;

/** Why a hub tool refused outright: the caller isn't the hub, or its arguments don't parse. */
export type HostMessagingRefusalCode = "NOT_ELIGIBLE" | "INVALID_ARGS" | "UNAVAILABLE";

export type HostMessagingToolResult =
  | HostListResult
  | HostListAssistantsResult
  | HostSendMessageResult
  | HostGetTaskResult
  | HostListTasksResult
  | HostCancelTaskResult;

export type HostMessagingOutcome<T> =
  { ok: true; value: T } | { ok: false; code: HostMessagingRefusalCode; message: string };
