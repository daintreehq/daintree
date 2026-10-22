import { z } from "zod";
import {
  MAX_LISTED_RUNS,
  type WaitingRunView,
} from "../../services/deviceAnswer/deviceAnswerRuns.js";
import { isAnswerLabel } from "../../services/terminalAnswer.js";

/**
 * Session-level methods behind a device paired with a Shell answering this
 * host's agents. CALLs, not new frame kinds: a host from before them answers
 * UNSUPPORTED, and the Shell says it needs updating.
 */
export const DeviceAnswerLinkMethod = {
  /** Shell → Host: this host's waiting runs, screens read and redacted here. */
  LIST: "deviceAnswer.list",
  /** Shell → Host: press one listed option, under this host's own drive lease. */
  ANSWER: "deviceAnswer.answer",
} as const;

/** Room for a 40-row screen of wide lines; anything longer is not one. */
const MAX_SCREEN_LENGTH = 64 * 1024;
const MAX_CHOICES = 40;

export const DeviceAnswerListPayloadSchema = z.object({});

export const DeviceAnswerAnswerPayloadSchema = z.object({
  runId: z.string().min(1).max(256),
  spawnedAt: z.number().finite(),
  label: z.string().refine(isAnswerLabel),
});
export type DeviceAnswerAnswerPayload = z.infer<typeof DeviceAnswerAnswerPayloadSchema>;

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
}) satisfies z.ZodType<WaitingRunView>;

export const DeviceAnswerListResultSchema = z.object({
  runs: z.array(WaitingRunViewSchema).max(MAX_LISTED_RUNS),
});
export type DeviceAnswerListResult = z.infer<typeof DeviceAnswerListResultSchema>;
