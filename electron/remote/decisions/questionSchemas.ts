import { z } from "zod";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionListItem,
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

export const HostCancelQuestionPayloadSchema = z
  .object({ reference: QuestionReferenceSchema })
  .strict();

const ThreadImageSchema = z
  .object({ attachmentId: AttachmentId, alt: Words.nullable(), mime: Mime, size: Count })
  .strict();

const ThreadEntrySchema = z.discriminatedUnion("type", [
  z
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
    .strict(),
  z.object({ type: z.literal("expired"), entryId: Id, sentAt: Time }).strict(),
  z.object({ type: z.literal("declined"), entryId: Id, sentAt: Time }).strict(),
  z
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
    .strict(),
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
