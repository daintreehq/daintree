import { z } from "zod";
import {
  MAX_LISTED_RUNS,
  MAX_OMITTED_RUNS,
  type WaitingRunSummary,
  type WaitingRunView,
} from "../../services/deviceAnswer/deviceAnswerRuns.js";
import { isAnswerLabel } from "../../services/terminalAnswer.js";
import { isQuestionId } from "../../services/deviceAnswer/questionId.js";

/**
 * Session-level methods behind a device paired with a Shell answering this
 * host's agents. CALLs, not new frame kinds: a host from before them answers
 * UNSUPPORTED, and the Shell says it needs updating.
 */
export const DeviceAnswerLinkMethod = {
  /** Shell → Host: this host's waiting runs, screens read and redacted here. */
  LIST: "deviceAnswer.list",
  /**
   * Shell → Host, from Shells before answers named their question: refused
   * here, since it would press by label alone.
   */
  ANSWER: "deviceAnswer.answer",
  /**
   * Shell → Host: press one listed option, under this host's own drive lease,
   * only into the question it was listed for. A new method rather than a new
   * field, so a host from before it answers UNSUPPORTED instead of dropping
   * the question and pressing by label alone.
   */
  ANSWER_QUESTION: "deviceAnswer.answerQuestion",
} as const;

/** Room for a 40-row screen of wide lines; anything longer is not one. */
const MAX_SCREEN_LENGTH = 64 * 1024;
const MAX_CHOICES = 40;

const WaitingRunRefSchema = z.object({
  runId: z.string().min(1).max(256),
  spawnedAt: z.number().finite(),
});

/**
 * `read` names one run to read ahead of the rest. A host from before it
 * strips it and lists its usual runs.
 */
export const DeviceAnswerListPayloadSchema = z.object({
  read: WaitingRunRefSchema.optional(),
});
export type DeviceAnswerListPayload = z.infer<typeof DeviceAnswerListPayloadSchema>;

export const DeviceAnswerAnswerPayloadSchema = z.object({
  runId: z.string().min(1).max(256),
  spawnedAt: z.number().finite(),
  label: z.string().refine(isAnswerLabel),
});
export type DeviceAnswerAnswerPayload = z.infer<typeof DeviceAnswerAnswerPayloadSchema>;

export const DeviceAnswerAnswerQuestionPayloadSchema = DeviceAnswerAnswerPayloadSchema.extend({
  questionId: z.string().refine(isQuestionId),
});
export type DeviceAnswerAnswerQuestionPayload = z.infer<
  typeof DeviceAnswerAnswerQuestionPayloadSchema
>;

const nullableText = (max: number) => z.string().max(max).nullable();

/** What a host lists, read by a Shell that trusts its shape no more than its words. */
export const WaitingRunViewSchema = z.object({
  runId: z.string().min(1).max(256),
  spawnedAt: z.number().finite(),
  project: nullableText(256),
  title: nullableText(1024),
  agentId: nullableText(128),
  agentState: z.enum(["idle", "working", "waiting", "directing", "completed", "exited"]),
  waitingReason: z.enum(["prompt", "question", "approval", "error"]).nullable(),
  since: z.number().finite().nullable(),
  parked: z.boolean(),
  snoozed: z.boolean(),
  screen: nullableText(MAX_SCREEN_LENGTH),
  choices: z.array(z.string().refine(isAnswerLabel)).max(MAX_CHOICES),
  questionId: z.string().refine(isQuestionId).nullable(),
}) satisfies z.ZodType<WaitingRunView>;

const WaitingRunSummarySchema = WaitingRunViewSchema.omit({
  screen: true,
  choices: true,
  questionId: true,
}) satisfies z.ZodType<WaitingRunSummary>;

export const DeviceAnswerListResultSchema = z
  .object({
    // Never more than this, so a Shell from before `omitted` still reads the list.
    runs: z.array(WaitingRunViewSchema).max(MAX_LISTED_RUNS),
    /**
     * The host checks each answer against the question it listed. One from
     * before lists without it, and is shown as needing an update rather than
     * offered answers it would press by label alone.
     */
    questionIds: z.literal(true),
    /**
     * How many runs wait on the host, listed or not, and the ones its cap
     * left unread. A host from before sends neither, and may have cut its
     * list without saying so.
     */
    waiting: z.number().int().nonnegative().optional(),
    omitted: z.array(WaitingRunSummarySchema).max(MAX_OMITTED_RUNS).optional(),
  })
  .refine(
    ({ runs, waiting, omitted = [] }) =>
      waiting === undefined || waiting >= runs.length + omitted.length,
    { message: "waiting is fewer than the runs listed" }
  );
export type DeviceAnswerListResult = z.infer<typeof DeviceAnswerListResultSchema>;
