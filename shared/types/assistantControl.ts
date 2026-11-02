import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../config/assistantSlots.js";
import { CODEX_QUOTA_UNAVAILABLE_REASONS } from "./ipc/agentQuota.js";

/**
 * One assistant addressing another (#13496): a help session here, or another
 * machine's assistant reaching this one through its Shell's `host.call`.
 * Finding and starting one are their own tools; everything after that is the
 * agent messaging every caller already uses (`terminal.sendCommand` with
 * `handback`, notices, waits, the last-message read, interrupt and close),
 * taking the terminal id these return. Assistants stay out of every generic
 * terminal listing, and no worker pane, plugin or api-key client may target
 * one on any path.
 */

export const ASSISTANT_LIST_TOOL = "assistant.list";
export const ASSISTANT_START_TOOL = "assistant.start";
/** The Codex account's quota on this machine, as an ordinary tool so `host.call` reads a host's. */
export const AGENT_READ_QUOTA_TOOL = "agent.readQuota";

/** Offered only to an assistant caller, at any in-app tier. */
export const ASSISTANT_CONTROL_TOOL_IDS: ReadonlySet<string> = new Set([
  ASSISTANT_LIST_TOOL,
  ASSISTANT_START_TOOL,
  AGENT_READ_QUOTA_TOOL,
]);

const slotSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_ASSISTANT_SLOTS - 1);

export const AssistantListArgsSchema = z.object({});
export type AssistantListArgs = z.infer<typeof AssistantListArgsSchema>;

export const AssistantEntrySchema = z.object({
  terminalId: z.string().describe("Its terminal: what a send, notice, read or close names."),
  generation: z
    .number()
    .describe("Its run's generation. A send passes it back; a restarted run has a new one."),
  slot: z.number(),
  agentId: z.string().nullable(),
  agentState: z
    .enum(["idle", "working", "waiting", "directing", "completed", "exited"])
    .nullable()
    .describe("As last observed; not proof of what it is doing."),
  waitingReason: z.enum(["prompt", "question", "approval", "error"]).nullable(),
  /** Shown in a window here; false while it runs with no view. */
  attached: z.boolean(),
  /** Started by this caller, so this caller may close it. */
  startedByYou: z.boolean(),
});
export type AssistantEntry = z.infer<typeof AssistantEntrySchema>;

export const AssistantListResultSchema = z.object({
  projectId: z.string(),
  assistants: z.array(AssistantEntrySchema),
  vacantSlots: z.array(z.number()).describe("Slots a start may use."),
});
export type AssistantListResult = z.infer<typeof AssistantListResultSchema>;

export const AssistantStartArgsSchema = z.object({
  slot: slotSchema.optional().describe("A vacant slot. Omit for the lowest vacant one."),
  agentId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("claude, codex or copilot. Omit for this machine's default."),
});
export type AssistantStartArgs = z.infer<typeof AssistantStartArgsSchema>;

export const ASSISTANT_NOT_READY_REASONS = ["timed-out", "agent-error"] as const;

export const AssistantStartResultSchema = z.object({
  assistant: AssistantEntrySchema,
  ready: z
    .boolean()
    .describe("At its prompt. False: it runs but is stopped short of one; don't start another."),
  notReadyReason: z.enum(ASSISTANT_NOT_READY_REASONS).nullable(),
});
export type AssistantStartResult = z.infer<typeof AssistantStartResultSchema>;

export const AgentReadQuotaArgsSchema = z.object({});
export type AgentReadQuotaArgs = z.infer<typeof AgentReadQuotaArgsSchema>;

const codexQuotaWindowSchema = z.object({
  usedPercent: z.number().describe("Percent of this window's limit used, 0-100."),
  windowDurationMins: z.number().describe("The window's length in minutes; 300 is 5 hours."),
  resetsAt: z.number().nullable().describe("When it resets, epoch ms; null when Codex didn't say."),
});

export const AgentReadQuotaResultSchema = z.object({
  codex: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      planType: z.string().nullable(),
      windows: z.array(codexQuotaWindowSchema).describe("Shortest window first."),
      fetchedAt: z.number().describe("When it was read from Codex, epoch ms; cached up to 30 s."),
    }),
    z.object({
      status: z.literal("unavailable"),
      reason: z.enum(CODEX_QUOTA_UNAVAILABLE_REASONS),
      fetchedAt: z.number(),
    }),
  ]),
});
export type AgentReadQuotaResult = z.infer<typeof AgentReadQuotaResultSchema>;

/** Refusal codes the assistant tools and assistant targets answer with. */
export const ASSISTANT_TARGET_REFUSALS = {
  /** No assistant in the caller's project runs under that terminal id. */
  notFound: "ASSISTANT_NOT_FOUND",
  /** The run named by `generation` is not the one running now. */
  restarted: "ASSISTANT_RESTARTED",
  /** Mid-turn, a draft in its composer, or stopped on something only a person answers. */
  busy: "ASSISTANT_BUSY",
  /** Only an assistant this caller started may be closed by it. */
  notStarter: "ASSISTANT_NOT_STARTED_BY_YOU",
  /** Starting one was refused: no project, no vacant slot, or it could not launch. */
  startRefused: "ASSISTANT_START_REFUSED",
} as const;

/**
 * The run an input tool names (#13496, #14551): an assistant by the
 * generation `assistant.list` gave, a worker the global Assistant didn't
 * launch by the `incarnation` from `host.list`. Both are its launch generation.
 */
export const RunGenerationArgSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("Run you read: assistant-listing generation or host-listing incarnation.");

/** Refusal codes the global Assistant's steer of a worker answers with (#14551). */
export const WORKER_STEER_REFUSALS = {
  /** No terminal of the call's project runs under that id, or it can't be read. */
  notFound: "WORKER_NOT_FOUND",
  /** A plain shell, an ended process, or an assistant: no worker agent to steer. */
  notAgent: "WORKER_NOT_AGENT",
  /** The run named by `generation` is not the one running now. */
  restarted: "WORKER_RESTARTED",
  /** Input since its agent settled, or a submission still going in: a person's turn. */
  typing: "WORKER_TYPED_INPUT",
  /** Not where a prompt is admitted, or another call is writing to it. */
  busy: "WORKER_BUSY",
  /** Some keys went in before a check stopped the rest. */
  partial: "WORKER_KEYS_PARTIAL",
  /** A slash command that isn't one of the fixed forms its agent takes from a steer (#16101). */
  commandNotAllowed: "WORKER_COMMAND_NOT_ALLOWED",
} as const;
