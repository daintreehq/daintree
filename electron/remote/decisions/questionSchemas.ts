import { z } from "zod";
import { LIMITS, PaneSnapshotContentV1 } from "@daintreehq/decisions-protocol";
import type {
  DecisionClosureNotice,
  DecisionPreparation,
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionListItem,
  DecisionQuestionPaneResult,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
} from "../../../shared/types/decisionsQuestion.js";

/**
 * What crosses a Remote Host's link for its Decisions questions (#17230), in
 * both directions. The Shell reads nothing a Host answers until it has been
 * read against these: the list feeds main's own consumers, and content
 * reaches a window and names what an answer from this computer is signed for.
 */

/** The most questions one Host's list carries: its newest. */
export const MAX_HOST_QUESTIONS = 2_000;
/**
 * The most one Host's list may take as JSON: its newest questions that fit,
 * well inside the link's 16 MiB message whatever its questions' fields hold.
 */
export const MAX_HOST_QUESTION_LIST_BYTES = 4 * 1024 * 1024;
/** The most of an image one read answers: the part size a Host's Decisions reads images in. */
export const MAX_HOST_IMAGE_PART_BYTES = 8 * 1024 * 1024;
/** The most references one read of opening lines names, as the IPC op allows. */
export const MAX_HOST_SUMMARY_REFERENCES = 64;

const Id = z.string().min(1).max(256);
const QuestionId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const AttachmentId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Time = z.string().min(1).max(64);
const Count = z.number().int().nonnegative();
const Words = z.string().max(256 * 1024);
const Mime = z.enum(["image/png", "image/jpeg", "image/webp"]);
const Requirement = z.enum(["human-required", "proxy-ok", "proxy-first"]);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
/** Where in an image (at most 20 MiB) a part starts, as the IPC op allows. */
const ImageOffset = z
  .number()
  .int()
  .min(0)
  .max(20 * 1024 * 1024);

export const QuestionReferenceSchema = z
  .object({ hostId: Id, projectId: Id, terminalId: Id, questionId: QuestionId })
  .strict() satisfies z.ZodType<DecisionQuestionReference>;

const StandingSchema = z.union([
  z.object({ kind: z.literal("waiting"), reason: z.enum(["open", "reply"]) }).strict(),
  z.object({ kind: z.literal("queued") }).strict(),
  z.object({ kind: z.literal("send-failed") }).strict(),
  z.object({ kind: z.literal("to-type") }).strict(),
  z
    .object({
      kind: z.literal("needs-attention"),
      deliveryStatus: z.enum(["needs-attention", "delivery-uncertain"]),
    })
    .strict(),
  z
    .object({ kind: z.literal("settled"), outcome: z.literal("answered"), handled: z.boolean() })
    .strict(),
  z
    .object({
      kind: z.literal("settled"),
      outcome: z.enum(["withdrawn", "expired", "declined"]),
    })
    .strict(),
]);

/** A stall's reason: the library's code, or `unspecified`, as the Host's own list reads it. */
const StallReason = z.string().regex(/^[a-z0-9_.-]{1,48}$/);

const StallSchema = z
  .object({
    answerRevision: Count.nullable(),
    followUpIds: z.array(Id).max(100_000),
    reason: StallReason,
  })
  .strict();

/**
 * A list item as a Host sends it: never with `remoteHost` or `inbox`, which
 * only the Shell adds, so an older owner's strict read still takes it.
 */
export const HostQuestionItemSchema = z
  .object({
    reference: QuestionReferenceSchema,
    alias: Count,
    agentKind: z.string().max(64),
    projectLabel: z.string().max(512).nullable(),
    // A worktree's id can be its path.
    worktreeId: z.string().max(4096),
    worktreeRoot: z.string().max(4096),
    requirement: Requirement,
    askedAt: Time,
    expiresAt: Time.nullable(),
    settledAt: Time.nullable(),
    standing: StandingSchema,
    replyRequest: Id.nullable(),
    stall: StallSchema.nullable(),
  })
  .strict() satisfies z.ZodType<Omit<DecisionQuestionListItem, "remoteHost" | "inbox">>;

const ReplyModeSchema = z.enum(["advisory", "blocking"]);
const ClosedReasonV2Schema = z.enum(["declined", "withdrawn", "expired", "never-published"]);
const ClosureNoticeSchema = z
  .object({
    delivery: z.enum(["pending", "delivered", "uncertain", "needs-attention", "stopped"]),
    disposition: z.enum(["fallback-due", "fallback-withheld"]).nullable(),
  })
  .strict() satisfies z.ZodType<DecisionClosureNotice>;

/** The round facts a v3 item and a v2 content read carry beside the rest (#17943). */
const ROUND_FIELDS = ["replyMode", "closedReason", "closureNotice"] as const;

/**
 * A v3 list item (#17943): a v2 item with its round. Each fact stays optional,
 * as the shared type has it: one a Host left out is shown as unknown.
 */
export const HostQuestionItemV3Schema = HostQuestionItemSchema.extend({
  replyMode: ReplyModeSchema.optional(),
  closedReason: ClosedReasonV2Schema.nullable().optional(),
  closureNotice: ClosureNoticeSchema.nullable().optional(),
}).strict() satisfies z.ZodType<Omit<DecisionQuestionListItem, "remoteHost" | "inbox">>;

type HostItem = Omit<DecisionQuestionListItem, "remoteHost" | "inbox">;

/**
 * An item as every list version reads it (#18032): a question waiting to be
 * typed in without what waits, which no strict read takes yet, so its row
 * reads as one from a Host before it rather than being refused.
 */
export function linkedItem(item: HostItem): HostItem {
  return item.standing.kind === "to-type" && item.standing.delivery !== undefined
    ? { ...item, standing: { kind: "to-type" } }
    : item;
}

/** An item as a Shell from before #17943 reads it: without the round its strict read refuses. */
export function legacyItem(item: HostItem): HostItem {
  const legacy: HostItem = { ...linkedItem(item) };
  for (const field of ROUND_FIELDS) delete legacy[field];
  return legacy;
}

/** The owner a Host served a list to, as that owner's announcement named it. */
const ListOwnerSchema = z
  .object({
    installationId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    ownerDeviceId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  })
  .strict();
export type HostQuestionListOwner = z.infer<typeof ListOwnerSchema>;

/**
 * A Host's list: the id its questions name it by, the owner it served them
 * to, and every one of them. The owner travels with the list because nothing
 * orders a list against the Host's answer to a later announcement: a Shell
 * takes a list only for the owner it speaks as now. `hostId` null: the Host
 * serves no list now (its Decisions isn't running for this owner), so it
 * carries none. Each question is read on its own ({@link HostQuestionItemSchema}),
 * so one this Daintree can't read costs only itself.
 */
export const HostQuestionListSchema = z
  .object({
    hostId: Id.nullable(),
    owner: ListOwnerSchema.nullable(),
    questions: z.array(z.unknown()).max(MAX_HOST_QUESTIONS),
  })
  .strict();
export type HostQuestionListPayload = z.infer<typeof HostQuestionListSchema>;

/** A Host's own questions, as its Decisions lists them: its id, and every one of them. */
export interface HostQuestionList {
  hostId: string;
  questions: Omit<DecisionQuestionListItem, "remoteHost" | "inbox">[];
  /** What each of them in Needs you asks now (#17895), by question id; absent from a v1 list. */
  asks?: ReadonlyMap<string, string | null>;
}

/** A Host's pushed list always names the Host and its owner: one that serves none sends nothing. */
export const HostQuestionsChangedPayloadSchema = z
  .object({
    hostId: Id,
    owner: ListOwnerSchema,
    questions: z.array(z.unknown()).max(MAX_HOST_QUESTIONS),
  })
  .strict();

/**
 * What one of a Host's questions in Needs you asks now (#17895): the agent's
 * latest follow-up on it, or null for the question alone. Read on its own,
 * like each question, so one this Daintree can't read costs only itself.
 */
export const HostQuestionAskSchema = z
  .object({ questionId: QuestionId, ask: Id.nullable() })
  .strict();

/** The asks a v2 list carries beside its questions, at most one per question. */
const Asks = z.array(z.unknown()).max(MAX_HOST_QUESTIONS);

/**
 * Where a v2 list stands among those one session was sent, read or pushed:
 * it rises with each, so a Shell keeps the newest whatever order they arrive
 * in. A reply and a push travel apart on the link, and a large one comes in
 * parts, so arrival order alone can't say.
 */
const ListSeq = Count;

/** A Host's list as `QUESTION_LIST_V2` reads it: the v1 list, with the asks (#17895). */
export const HostQuestionListV2Schema = HostQuestionListSchema.extend({
  asks: Asks,
  seq: ListSeq,
}).strict();
export type HostQuestionListV2Payload = z.infer<typeof HostQuestionListV2Schema>;

/** A Host's pushed v2 list (#17895): `HostQuestionsChangedPayloadSchema`, with the asks. */
export const HostQuestionsChangedV2PayloadSchema = HostQuestionsChangedPayloadSchema.extend({
  asks: Asks,
  seq: ListSeq,
}).strict();

/** A v3 list (#17943): the v2 envelope, its items read on their own as v3 ones. */
export const HostQuestionListV3Schema = HostQuestionListV2Schema;
/** A v3 push: the v2 push's envelope, with v3 items. */
export const HostQuestionsChangedV3PayloadSchema = HostQuestionsChangedV2PayloadSchema;

/** A v2 read of the list names nothing: the owner it serves is the session's. */
export const HostQuestionListV2ReadSchema = z.object({}).strict();

export const HostQuestionReadSchema = z.discriminatedUnion("read", [
  z.object({ read: z.literal("list") }).strict(),
  z.object({ read: z.literal("content"), reference: QuestionReferenceSchema }).strict(),
  z
    .object({
      read: z.literal("image"),
      reference: QuestionReferenceSchema,
      attachmentId: AttachmentId,
      offset: ImageOffset,
    })
    .strict(),
  z
    .object({
      read: z.literal("summaries"),
      references: z.array(QuestionReferenceSchema).min(1).max(MAX_HOST_SUMMARY_REFERENCES),
    })
    .strict(),
]);
export type HostQuestionRead = z.infer<typeof HostQuestionReadSchema>;

/** A v2 read of one question's content (#17943), by reference. */
export const HostQuestionContentV2ReadSchema = z
  .object({ reference: QuestionReferenceSchema })
  .strict();

export const HostCancelQuestionPayloadSchema = z
  .object({ reference: QuestionReferenceSchema })
  .strict();

const ThreadImageSchema = z
  .object({ attachmentId: AttachmentId, alt: Words.nullable(), mime: Mime, size: Count })
  .strict();

const ThreadAnswerSchema = z
  .object({
    type: z.literal("answer"),
    entryId: Id,
    revision: Count,
    from: z.enum(["person", "model"]),
    onComputer: z.boolean(),
    correction: z.boolean(),
    confirmsModel: z.boolean(),
    choices: z.array(z.object({ id: Id, label: Words.nullable() }).strict()).max(64),
    text: Words.nullable(),
    reason: Words.nullable(),
    images: z.array(ThreadImageSchema).max(32),
    sentAt: Time,
    unreadable: z.boolean(),
  })
  .strict();

const ThreadExpirySchema = z
  .object({ type: z.literal("expired"), entryId: Id, sentAt: Time })
  .strict();
const ThreadDeclineSchema = z
  .object({ type: z.literal("declined"), entryId: Id, sentAt: Time })
  .strict();
const ThreadMessageSchema = z
  .object({
    type: z.literal("message"),
    messageId: Id,
    from: z.enum(["person", "agent"]),
    text: Words.nullable(),
    images: z.array(ThreadImageSchema).max(32),
    expectsReply: z.boolean(),
    // Optional: absent from a Host from before #17238, as the type has it.
    onComputer: z.boolean().optional(),
    sentAt: Time,
    deliveryStatus: z
      .enum(["received", "terminal-delivered", "needs-attention", "delivery-uncertain"])
      .nullable(),
    deliveryStopped: z.boolean().optional(),
    unreadable: z.boolean(),
  })
  .strict();

const ThreadEntrySchema = z.discriminatedUnion("type", [
  ThreadAnswerSchema,
  ThreadExpirySchema,
  ThreadDeclineSchema,
  ThreadMessageSchema,
]);

/** A v2 read's thread (#17943): each answer may say whether typing it in was confirmed. */
const ThreadEntryV2Schema = z.discriminatedUnion("type", [
  ThreadAnswerSchema.extend({ delivered: z.boolean().optional() }).strict(),
  ThreadExpirySchema,
  ThreadDeclineSchema,
  ThreadMessageSchema,
]);

const QuestionContentSchema = z
  .object({
    questionId: QuestionId,
    alias: Count,
    terminalId: Id,
    reference: QuestionReferenceSchema,
    revision: Count,
    question: Words,
    context: Words.nullable(),
    kind: z.enum(["choice", "approval", "text", "mixed"]),
    options: z
      .array(z.object({ id: Id, label: Words, description: Words.nullable() }).strict())
      .max(64),
    allowText: z.boolean(),
    requirement: Requirement,
    askedAt: Time,
    expiresAt: Time.nullable(),
    status: z.enum([
      "queued",
      "open",
      "proxy-answered",
      "human-answered",
      "cancelled",
      "expired",
      "publish-failed",
    ]),
    closedReason: z.enum(["declined", "withdrawn", "expired"]).nullable(),
    deliveryStatus: z.enum([
      "not-sent",
      "relay-queued",
      "desktop-received",
      "pending-host",
      "needs-attention",
      "delivery-uncertain",
      "terminal-delivered",
    ]),
    attachments: z
      .array(
        z
          .object({
            attachmentId: AttachmentId,
            role: z.enum(["before", "after", "reference", "other"]),
            alt: Words.nullable(),
            mime: Mime,
            size: Count,
            sha256: Sha256,
          })
          .strict()
      )
      .max(32),
    // The whole thread as stored: the link's own message bound is what limits it.
    thread: z.array(ThreadEntrySchema).max(100_000),
  })
  .strict() satisfies z.ZodType<DecisionQuestionContent>;

/** Content as `QUESTION_CONTENT_V2` reads it (#17943): with its round and verified plan. */
const QuestionContentV2Schema = QuestionContentSchema.extend({
  closedReason: ClosedReasonV2Schema.nullable(),
  replyMode: ReplyModeSchema.optional(),
  plannedFallback: z.string().max(LIMITS.plannedFallbackChars).nullable().optional(),
  closureNotice: ClosureNoticeSchema.nullable().optional(),
  thread: z.array(ThreadEntryV2Schema).max(100_000),
})
  .strict()
  // An advisory round always states its plan: one without is never shown as optional.
  .refine(
    (question) =>
      question.replyMode !== "advisory" ||
      (typeof question.plannedFallback === "string" && question.plannedFallback.trim() !== ""),
    { message: "an advisory round states its plan" }
  ) satisfies z.ZodType<DecisionQuestionContent>;

const PreparationSchema = z
  .object({
    agentsConsulted: Count.max(LIMITS.preparationAgentsMax),
    outcome: z.enum(["agreed", "split", "not-run"]),
    summary: z.string().max(LIMITS.preparationSummaryChars).nullable(),
  })
  .strict() satisfies z.ZodType<DecisionPreparation>;

/** Content as `QUESTION_CONTENT_V3` reads it (#18042): v2's, with the agent's preparation. */
const QuestionContentV3Schema = QuestionContentV2Schema.safeExtend({
  preparation: PreparationSchema.nullable().optional(),
}).strict() satisfies z.ZodType<DecisionQuestionContent>;

/**
 * Content as a Shell from before #18042 reads it over `QUESTION_CONTENT_V2`:
 * without the agent's preparation, which its strict read refuses even as null.
 */
export function v2Content(question: DecisionQuestionContent): DecisionQuestionContent {
  const { preparation: _preparation, ...rest } = question;
  return rest;
}

/**
 * Content as a Shell from before #17943 reads it over `QUESTIONS`: without
 * its round, plan and preparation, and a question that was never published
 * closed for no reason it knows, as it read one before.
 */
export function legacyContent(question: DecisionQuestionContent): DecisionQuestionContent {
  const {
    replyMode: _mode,
    plannedFallback: _plan,
    closureNotice: _notice,
    preparation: _preparation,
    ...rest
  } = question;
  return {
    ...rest,
    closedReason: question.closedReason === "never-published" ? null : question.closedReason,
    thread: question.thread.map((entry) => {
      if (entry.type !== "answer") return entry;
      const { delivered: _delivered, ...answer } = entry;
      return answer;
    }),
  };
}

const Off = z.object({ result: z.literal("off") }).strict();
const NotRunning = z.object({ result: z.literal("not-running") }).strict();
const NotFound = z.object({ result: z.literal("not-found") }).strict();
const Unreadable = z.object({ result: z.literal("unreadable") }).strict();

export const HostQuestionContentResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("read"), question: QuestionContentSchema }).strict(),
  Off,
  NotRunning,
  NotFound,
  Unreadable,
]) satisfies z.ZodType<DecisionQuestionContentResult>;

/** What `QUESTION_CONTENT_V2` answers (#17943). */
export const HostQuestionContentV2ResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("read"), question: QuestionContentV2Schema }).strict(),
  Off,
  NotRunning,
  NotFound,
  Unreadable,
]) satisfies z.ZodType<DecisionQuestionContentResult>;

/** What `QUESTION_CONTENT_V3` answers (#18042). */
export const HostQuestionContentV3ResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("read"), question: QuestionContentV3Schema }).strict(),
  Off,
  NotRunning,
  NotFound,
  Unreadable,
]) satisfies z.ZodType<DecisionQuestionContentResult>;

export const HostQuestionImagePartResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("read"),
      part: z
        .object({
          attachmentId: AttachmentId,
          mime: Mime,
          sha256: Sha256,
          bytes: z.instanceof(Uint8Array),
          size: Count.max(20 * 1024 * 1024),
          offset: ImageOffset,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      result: z.literal("unavailable"),
      reason: z.enum([
        "key-unavailable",
        "fetch-failed",
        "size-mismatch",
        "decrypt-failed",
        "digest-mismatch",
        "type-mismatch",
        "timed-out",
      ]),
    })
    .strict(),
  Off,
  NotRunning,
  NotFound,
  Unreadable,
]);

export const HostQuestionSummariesResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("read"),
      summaries: z
        .array(
          z.discriminatedUnion("result", [
            z
              .object({
                questionId: QuestionId,
                result: z.literal("read"),
                line: Words.nullable(),
              })
              .strict(),
            z.object({ questionId: QuestionId, result: z.literal("not-found") }).strict(),
            z.object({ questionId: QuestionId, result: z.literal("unreadable") }).strict(),
          ])
        )
        .max(MAX_HOST_SUMMARY_REFERENCES),
    })
    .strict(),
  Off,
  NotRunning,
]) satisfies z.ZodType<DecisionQuestionSummariesResult>;

/**
 * The asking pane as a Host read it (#18037): plain text within a terminal
 * snapshot's bounds, as the protocol checks a phone's, so nothing a Host
 * sends can steer the renderer or outgrow what a snapshot may carry.
 */
const QuestionPaneSchema = z
  .object({
    agentState: z.string().max(40),
    waitingReason: z.string().max(40).nullable(),
    paneTitle: z.string().max(LIMITS.snapshotPaneTitleChars),
    lines: z.array(z.string()).max(LIMITS.snapshotTerminalLines),
    observedAt: Time,
  })
  .strict()
  .refine(
    (pane) =>
      PaneSnapshotContentV1.safeParse({
        content_version: 1,
        observed_at: pane.observedAt,
        agent_state: pane.agentState,
        waiting_reason: pane.waitingReason,
        pane_title: pane.paneTitle,
        terminal_lines: pane.lines,
      }).success,
    "not a terminal snapshot's text"
  );

/** What `QUESTION_PANE` answers (#18037). */
export const HostQuestionPaneResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("read"),
      reference: QuestionReferenceSchema,
      pane: QuestionPaneSchema,
    })
    .strict(),
  z.object({ result: z.literal("closed") }).strict(),
  z.object({ result: z.literal("moved") }).strict(),
  Off,
  NotRunning,
  NotFound,
  Unreadable,
]) satisfies z.ZodType<DecisionQuestionPaneResult>;

export const HostQuestionCancelResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("cancelled") }).strict(),
  z.object({ result: z.literal("cancelling") }).strict(),
  z
    .object({
      result: z.literal("refused"),
      reason: z.enum(["answered", "expired", "publish-failed", "not-found"]),
    })
    .strict(),
  Off,
  NotRunning,
]) satisfies z.ZodType<DecisionQuestionCancelResult>;
