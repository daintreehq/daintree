import { z } from "zod";
import type {
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsHostAttentionAnswer,
  DecisionsHostAttentionRequest,
} from "../../../shared/types/decisionsAttention.js";
import { QuestionReferenceSchema } from "./questionSchemas.js";

/**
 * What crosses a Remote Host's link for one of its stopped deliveries
 * (#18031). The Shell shows nothing a Host answers, and offers no action on
 * it, until it has been read against these.
 */

/**
 * The most one answer may take as JSON, well inside the link's 16 MiB
 * message: a Host whose item or copy doesn't fit says so rather than sending
 * part of it, so nothing is confirmed against content the person never saw.
 */
export const MAX_HOST_ATTENTION_BYTES = 4 * 1024 * 1024;

/** An item's token, as the Host minted it: a SHA-256 digest of ids and states. */
const Token = z.string().regex(/^[0-9a-f]{64}$/);
const Id = z.string().min(1).max(256);
const QuestionId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
const Time = z.string().min(1).max(64);
const Count = z.number().int().nonnegative();
/** A label as the Host names it: a pane title can run long, and the reply's own bound limits it. */
const Name = z.string().max(64 * 1024);
/** The library's code for why, or `unspecified`. */
const Reason = z.string().regex(/^[a-z0-9_.-]{1,64}$/);
/** Previews are cut to a few thousand characters; this leaves room for any escaping. */
const Preview = z.string().max(64 * 1024);
const Status = z.enum(["needs-attention", "delivery-uncertain"]);

export const HostAttentionRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), reference: QuestionReferenceSchema }).strict(),
  z.object({ action: z.literal("copy"), reference: QuestionReferenceSchema }).strict(),
  z
    .object({ action: z.literal("resume"), reference: QuestionReferenceSchema, expected: Token })
    .strict(),
  z
    .object({ action: z.literal("handled"), reference: QuestionReferenceSchema, expected: Token })
    .strict(),
]) satisfies z.ZodType<DecisionsHostAttentionRequest>;

const OriginSchema = z
  .object({
    projectId: Id,
    projectName: Name.nullable(),
    worktreeId: Name,
    worktreeName: Name.nullable(),
    agentId: z.string().max(256),
    agentName: Name.nullable(),
    paneId: Id,
    paneTitle: Name.nullable(),
    otherHost: z.object({ hostId: Id, name: Name.nullable() }).strict().nullable(),
  })
  .strict();

const AnswerPreviewSchema = z
  .object({
    source: z.enum(["human", "proxy"]),
    choices: z.array(Name).max(64),
    text: Preview.nullable(),
    correction: z.boolean(),
    answeredAt: Time,
  })
  .strict();

const NoticeSchema = z
  .object({
    kind: z.enum(["expired", "never-published"]),
    revision: Count,
    deadline: Time.nullable(),
    delivery: Status,
    disposition: z.enum(["fallback-due", "fallback-withheld"]).nullable(),
  })
  .strict();

const FollowUpSchema = z
  .object({
    messageId: Id,
    onComputer: z.boolean(),
    status: Status,
    reason: Reason,
    text: Preview.nullable(),
    unreadable: z.boolean(),
    sentAt: Time,
  })
  .strict();

export const HostAttentionItemSchema = z
  .object({
    questionId: QuestionId,
    alias: Count,
    status: Status,
    reason: Reason,
    question: Preview.nullable(),
    // The whole question and an advisory round's plan, as the question view would show them.
    fullQuestion: z.string().max(MAX_HOST_ATTENTION_BYTES).nullable(),
    plan: Preview.nullable(),
    reference: QuestionReferenceSchema.nullable(),
    askedAt: Time,
    origin: OriginSchema,
    answer: AnswerPreviewSchema.nullable(),
    answerUnavailable: z.enum(["none", "unreadable"]).nullable(),
    notice: NoticeSchema.nullable(),
    followUps: z.array(FollowUpSchema).max(10_000),
    canResume: z.boolean(),
    canReassign: z.boolean(),
    token: Token,
  })
  .strict() satisfies z.ZodType<DecisionsAttentionItem>;

const Title = Name.nullable();

const OutcomeSchema = z.union([
  z.object({ result: z.literal("delivered"), terminalId: Id, title: Title }).strict(),
  z
    .object({
      result: z.literal("waiting"),
      terminalId: Id,
      title: Title,
      waitsFor: z.enum(["composer", "prompt", "host"]),
      followUpsOnly: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      result: z.literal("needs-attention"),
      status: Status,
      reason: Reason,
      followUpsOnly: z.literal(true).optional(),
    })
    .strict(),
  z.object({ result: z.literal("handled") }).strict(),
  z.object({ result: z.literal("resolved") }).strict(),
  z
    .object({
      result: z.literal("refused"),
      reason: z.enum([
        "not-running",
        "uncertain",
        "no-answer",
        "destination-gone",
        "asker-only",
        "changed",
      ]),
    })
    .strict(),
]) satisfies z.ZodType<DecisionsAnswerOutcome>;

const Off = z.object({ result: z.literal("off") }).strict();
const NotRunning = z.object({ result: z.literal("not-running") }).strict();
const TooLarge = z.object({ result: z.literal("too-large") }).strict();

const HostAttentionReadResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("read"), item: HostAttentionItemSchema.nullable() }).strict(),
  Off,
  NotRunning,
  TooLarge,
]);

const HostAttentionCopyResultSchema = z.discriminatedUnion("result", [
  z
    .object({
      result: z.literal("copied"),
      text: z.string().max(MAX_HOST_ATTENTION_BYTES).nullable(),
    })
    .strict(),
  Off,
  NotRunning,
  TooLarge,
]);

const HostAttentionActResultSchema = z.discriminatedUnion("result", [
  z.object({ result: z.literal("acted"), outcome: OutcomeSchema }).strict(),
  Off,
  NotRunning,
  TooLarge,
]);

/** What the Host may answer `action` with: never another action's answer. */
export function hostAttentionResultSchema(
  action: DecisionsHostAttentionRequest["action"]
): z.ZodType<DecisionsHostAttentionAnswer> {
  switch (action) {
    case "read":
      return HostAttentionReadResultSchema;
    case "copy":
      return HostAttentionCopyResultSchema;
    case "resume":
    case "handled":
      return HostAttentionActResultSchema;
  }
}
