import { z } from "zod";
import { EXCHANGE_STATES } from "../exchange/types.js";

/**
 * Session-level methods between a Shell and a host for the Shell's
 * assistants (#13493). They ride every session, including a summary-only one
 * with no view bound. None names who is asking: the host knows the sender
 * from the credential the session authenticated with. A host from before
 * these existed answers UNSUPPORTED.
 *
 * The exchange methods are what a v0.44 Shell still calls for the messages it
 * sent before its hosts were updated (#13496). A host answers them from its
 * retired records, read-only, so accepted work reads as ended rather than
 * silently gone; anything new is UNSUPPORTED, which that Shell reads as "this
 * host doesn't support assistant messaging".
 */
export const AssistantLinkMethod = {
  /** Shell → Host: bind this session to the Shell's sender credential for this host. */
  AUTHENTICATE: "assistant.authenticate",
  /**
   * Shell → Host: run one of the host's own MCP tools for one of the Shell's
   * assistants (#13493), in a session the host admits through its own MCP
   * gates for this sender and help session. A resend of a callId never runs
   * it twice. A host from before this answers UNSUPPORTED.
   */
  MCP_CALL: "assistant.mcp-call",
  /**
   * Host → Shell: what this host saw of terminals one of the Shell's
   * assistants asked to hear about through MCP_CALL (#13500). Each names the
   * call that armed it, so the Shell types it only into the run that made
   * that call. Observations only, never anything read off a screen, and a
   * resent noticeId is typed once. A Shell from before this answers
   * UNSUPPORTED.
   */
  RELAY_NOTICES: "assistant.relay-notices",
  /**
   * Host → Shell: ask the person about one confirm-gated call a Shell
   * assistant is making through MCP_CALL, while no view here can (#13501).
   * Bound to that call, its action and exact arguments, and answered once;
   * the host keeps nothing to reuse. A Shell from before this answers
   * UNSUPPORTED, which leaves the call refused as needing a view.
   */
  RELAY_APPROVE: "assistant.relay-approve",
} as const;

/** What a v0.44 Shell calls for the exchanges it sent, answered from retired records (#13496). */
export const RetiredExchangeMethod = {
  /** A resend of a message the host took answers from its record; any other is UNSUPPORTED. */
  SEND: "assistant.send",
  GET_EXCHANGE: "assistant.get-exchange",
  LIST_EXCHANGES: "assistant.list-exchanges",
  CANCEL_EXCHANGE: "assistant.cancel-exchange",
  GET_RESPONSES: "assistant.get-responses",
} as const;

export const MAX_EXCHANGE_BODY_CHARS = 256 * 1024;
export const MAX_EXCHANGE_PAGE = 500;
const MAX_REFERENCE_TASK_IDS = 64;

const id = z.string().min(1).max(256);
const timestamp = z.number().int().min(0);
const nullableTimestamp = timestamp.nullable();

/** 32 random bytes, base64url: only its holder can authenticate as the sender it derives. */
export const SenderCredentialSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const AuthenticatePayloadSchema = z.object({ credential: SenderCredentialSchema }).strict();

/** A v0.44 send, read only for its messageId: a resend of one the host took. */
export const SendPayloadSchema = z
  .object({
    messageId: id,
    contextId: id,
    referenceTaskIds: z.array(id).max(MAX_REFERENCE_TASK_IDS),
    projectId: id,
    slot: z.number().int().min(0),
    generation: id,
    body: z.string().min(1).max(MAX_EXCHANGE_BODY_CHARS),
  })
  .strict();

export const MessageIdPayloadSchema = z.object({ messageId: id }).strict();

export const ListExchangesPayloadSchema = z
  .object({
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(1).max(MAX_EXCHANGE_PAGE).optional(),
  })
  .strict();

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

/** Longest a relayed call may run on its host: `project.runCheck`'s own ceiling, with room. */
export const MAX_RELAY_RUN_MS = 65 * 60_000;
/** Serialized bytes a relayed call's arguments may take. */
export const MAX_RELAY_ARGS_BYTES = 256 * 1024;
/** Serialized bytes a relayed call's answer may take; a host's own results stay well under. */
export const MAX_RELAY_RESULT_BYTES = 192 * 1024;

export const McpCallPayloadSchema = z
  .object({
    /** The Shell assistant's own help session: with the sender, who owns what the call makes. */
    helpSessionId: id,
    projectId: id,
    tier: z.enum(["core", "full"]),
    callId: id,
    /** Set on every send after the first: a resend never starts a call the host has no record of. */
    resend: z.boolean(),
    tool: z.string().min(1).max(128),
    args: z
      .record(z.string(), z.unknown())
      .refine((args) => Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_RELAY_ARGS_BYTES),
    /** How long the host may let the tool run; the Shell waits a little longer. */
    runMs: z.number().int().min(1_000).max(MAX_RELAY_RUN_MS),
  })
  .strict();
export type McpCallPayload = z.infer<typeof McpCallPayloadSchema>;

export const RELAY_REFUSALS = ["control-off", "no-project", "server-off"] as const;
export type RelayRefusal = (typeof RELAY_REFUSALS)[number];

const relayInnerResultSchema = z
  .object({
    isError: z.boolean(),
    structured: z.record(z.string(), z.unknown()).nullable(),
    text: z.string().nullable(),
  })
  .strip();

export const McpCallAnswerSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), result: relayInnerResultSchema }).strip(),
  /** A resend the host holds no record of: it may have run, or never arrived. Nothing ran now. */
  z.object({ status: z.literal("unknown") }).strip(),
  /** That callId already named a different call. */
  z.object({ status: z.literal("conflict") }).strip(),
  /** Refused before anything ran; a newer host may name a reason this Shell doesn't know. */
  z
    .object({
      status: z.literal("refused"),
      reason: z.union([
        z.enum(RELAY_REFUSALS),
        z
          .string()
          .max(64)
          .transform(() => "server-off" as const),
      ]),
    })
    .strip(),
]);
export type McpCallAnswer = z.infer<typeof McpCallAnswerSchema>;

/** Notices one relay-notices call carries; the host sends the rest in the next. */
export const MAX_RELAY_NOTICES_PER_CALL = 32;

const agentStateSchema = z.enum(["idle", "working", "waiting", "directing", "completed", "exited"]);
const waitingReasonSchema = z.enum(["prompt", "question", "approval", "error"]);

/** A host's observation of a terminal, as `terminalNotify`'s NoticeObservation has it. */
const relayObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("state"),
      state: agentStateSchema,
      waitingReason: waitingReasonSchema.optional(),
      handback: z.boolean(),
    })
    .strip(),
  z
    .object({
      kind: z.literal("exit"),
      exitCode: z.number().int().optional(),
      handback: z.boolean(),
    })
    .strip(),
  z.object({ kind: z.literal("closed") }).strip(),
  z
    .object({
      kind: z.literal("not-written"),
      phase: z.enum(["failed", "cancelled", "unknown", "unconfirmed"]),
    })
    .strip(),
  z.object({ kind: z.literal("handback") }).strip(),
]);

export const RelayNoticeSchema = z
  .object({
    /** The host's own id for it, the same on every resend. */
    noticeId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    helpSessionId: id,
    /** The MCP_CALL that armed it. */
    callId: id,
    terminalId: id,
    observation: relayObservationSchema,
    /** It stopped without the done marker its prompt asked for; one more notice may follow. */
    awaitingHandback: z.boolean().optional(),
  })
  .strip();
export type RelayNotice = z.infer<typeof RelayNoticeSchema>;

export const RelayNoticesPayloadSchema = z
  .object({ notices: z.array(RelayNoticeSchema).min(1).max(MAX_RELAY_NOTICES_PER_CALL) })
  .strip();
export type RelayNoticesPayload = z.infer<typeof RelayNoticesPayloadSchema>;

/** Lines a relayed approval's preview may carry, and how long each may be. */
export const MAX_RELAY_APPROVAL_LINES = 200;
const MAX_RELAY_APPROVAL_LINE_CHARS = 1_000;

const argsHash = z.string().regex(/^[0-9a-f]{64}$/);

export const RelayApprovePayloadSchema = z
  .object({
    /** The host's own id for this ask; the answer echoes it. */
    approvalId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    helpSessionId: id,
    /** The MCP_CALL being made. */
    callId: id,
    projectId: id,
    /** The action the host would run: the call's own tool, or the one an owned tool stands in for. */
    actionId: z.string().min(1).max(128),
    args: z
      .record(z.string(), z.unknown())
      .refine((args) => Buffer.byteLength(JSON.stringify(args), "utf8") <= MAX_RELAY_ARGS_BYTES),
    /** The canonical hash of `args`, which the answer echoes. */
    argsHash,
    /** What the dialog's question names, read on the host. */
    subject: z.string().min(1).max(256).optional(),
    /** What the call would do, read on the host from the target it acts on. */
    lines: z.array(z.string().max(MAX_RELAY_APPROVAL_LINE_CHARS)).max(MAX_RELAY_APPROVAL_LINES),
  })
  .strict();
export type RelayApprovePayload = z.infer<typeof RelayApprovePayloadSchema>;

/**
 * `refused`: the Shell couldn't put it to anyone — the call isn't one of its
 * own in flight, its assistant's window is gone, or it doesn't ask about that
 * action. Nothing was approved.
 */
export const RelayApproveAnswerSchema = z
  .object({
    approvalId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    argsHash,
    decision: z.enum(["approved", "rejected", "timeout", "refused"]),
  })
  .strip();
export type RelayApproveAnswer = z.infer<typeof RelayApproveAnswerSchema>;
