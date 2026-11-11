import { z } from "zod";
import { MAX_ASSISTANT_SLOTS } from "../config/assistantSlots.js";
import {
  CLAUDE_USAGE_STATEMENTS,
  CLAUDE_USAGE_WINDOWS,
  CODEX_QUOTA_UNAVAILABLE_REASONS,
} from "./ipc/agentQuota.js";

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
/**
 * Reopens the conversation a stopped assistant lane keeps (#16763), in its own
 * slot, on its own agent and in its own folder, or refuses: never a fresh one.
 */
export const ASSISTANT_RESUME_TOOL = "assistant.resume";
/**
 * This machine's agent quota as an ordinary tool, so `host.call` reads a
 * host's: the Codex account's own reading and the Claude Code usage messages
 * its panes showed (#15727).
 */
export const AGENT_READ_QUOTA_TOOL = "agent.readQuota";

/** Offered only to an assistant caller, at any in-app tier. */
export const ASSISTANT_CONTROL_TOOL_IDS: ReadonlySet<string> = new Set([
  ASSISTANT_LIST_TOOL,
  ASSISTANT_START_TOOL,
  ASSISTANT_RESUME_TOOL,
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

/**
 * This machine's global Assistant, as a project's assistant may address it
 * (#16410): a send and a status read, nothing else, since it is the person's
 * own conversation. Its state is as last observed; the status read has the rest.
 */
export const GlobalAssistantEntrySchema = z.object({
  terminalId: z.string(),
  generation: z.number(),
  agentState: AssistantEntrySchema.shape.agentState,
});
export type GlobalAssistantEntry = z.infer<typeof GlobalAssistantEntrySchema>;

/**
 * A stopped lane whose conversation the project keeps for the person (#16763):
 * what `assistant.resume` reopens, and a slot no start takes.
 */
export const KeptAssistantSlotSchema = z.object({
  slot: z.number(),
  agentId: z.string(),
  capturedAt: z.number().describe("When its conversation was last recorded, epoch ms."),
});
export type KeptAssistantSlot = z.infer<typeof KeptAssistantSlotSchema>;

export const AssistantListResultSchema = z.object({
  projectId: z.string(),
  assistants: z.array(AssistantEntrySchema),
  vacantSlots: z.array(z.number()).describe("Slots a start may use."),
  keptSlots: z
    .array(KeptAssistantSlotSchema)
    .describe("Stopped slots keeping a conversation: resume one, never start there."),
  global: GlobalAssistantEntrySchema.nullable().describe(
    "This machine's global Assistant: send and status only. Null if none runs."
  ),
});
export type AssistantListResult = z.infer<typeof AssistantListResultSchema>;

export const AssistantStartArgsSchema = z.object({
  slot: slotSchema
    .optional()
    .describe("A vacant slot, not a kept one. Omit for the lowest vacant one."),
  agentId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("claude, codex, copilot or antigravity. Omit for this machine's default."),
});
export type AssistantStartArgs = z.infer<typeof AssistantStartArgsSchema>;

export const AssistantResumeArgsSchema = z.object({
  slot: slotSchema.describe("A slot the assistant listing names as kept."),
});
export type AssistantResumeArgs = z.infer<typeof AssistantResumeArgsSchema>;

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

const claudeUsageReadingSchema = z.object({
  window: z.enum(CLAUDE_USAGE_WINDOWS).describe("The limit as Claude Code named it."),
  statement: z
    .enum(CLAUDE_USAGE_STATEMENTS)
    .describe("used: usedPercent exact. over: past usedPercent. reached: limit hit."),
  usedPercent: z.number().nullable(),
  resetsAt: z.number().nullable().describe("Epoch ms of the reset it printed, or null."),
  terminalId: z.string().describe("The pane that showed it."),
  observedAt: z.number().describe("When it showed, epoch ms."),
});

export const AgentReadQuotaResultSchema = z.object({
  claude: z.object({
    source: z
      .literal("seen-in-panes")
      .describe("Claude Code's own messages in this machine's panes, not a live account reading."),
    readings: z
      .array(claudeUsageReadingSchema)
      .describe("Latest per limit since Daintree started. Empty: none seen."),
  }),
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
  /** Starting one was refused: no project, no vacant slot, a kept slot, or it could not launch. */
  startRefused: "ASSISTANT_START_REFUSED",
  /** Reopening a kept conversation was refused (#16763): nothing started, fresh or otherwise. */
  resumeRefused: "ASSISTANT_RESUME_REFUSED",
  /** The global Assistant takes a project assistant's send or status read, nothing else (#16410). */
  globalSendOnly: "ASSISTANT_GLOBAL_SEND_ONLY",
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
