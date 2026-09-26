import { z } from "zod";
import { NotifyReplyLinesSchema } from "./terminalNotify.js";
import { WaitSecondsSchema } from "./replyWait.js";

/**
 * Batched forms of the two calls an orchestration repeats per participant:
 * launching every named agent with one prompt, and sending each of them its
 * own message. Each item runs as its single-call tool through the same MCP
 * gate — tier, ownership, audit and its own notice — so a batch grants
 * nothing its items would not. They exist because a model writes the shared
 * prompt once instead of once per agent, and an orchestration's round costs
 * one call instead of one per participant.
 */

export const MAX_BATCH_LAUNCHES = 8;
export const MAX_BATCH_SENDS = 16;

const notifyFields = {
  notify: z
    .boolean()
    .optional()
    .describe("As on the single call: each agent's notice quotes its reply when it finishes."),
  handback: z.boolean().optional().describe("As on the single call, for each item."),
  replyLines: NotifyReplyLinesSchema,
  waitForReply: z
    .boolean()
    .optional()
    .describe("Hold the call until every agent finishes; each result has its `reply`."),
  waitSeconds: WaitSecondsSchema,
};

export const AgentLaunchManyArgsSchema = z.object({
  agentIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BATCH_LAUNCHES)
    .describe("1-8 distinct agent ids, launched in order, one terminal each."),
  prompt: z.string().min(1).describe("The first turn every agent receives."),
  name: z
    .string()
    .max(120)
    .optional()
    .describe('Tab title prefix; each tab is "<name>: <agentId>".'),
  worktreeId: z.string().optional().describe("Defaults to the active worktree."),
  ...notifyFields,
});
export type AgentLaunchManyArgs = z.infer<typeof AgentLaunchManyArgsSchema>;

export const TerminalSendCommandManyArgsSchema = z.object({
  sends: z
    .array(
      z.object({
        terminalId: z.string().min(1),
        command: z.string().min(1),
      })
    )
    .min(1)
    .max(MAX_BATCH_SENDS)
    .describe("1-16 messages, one per terminal, each its next prompt."),
  ...notifyFields,
});
export type TerminalSendCommandManyArgs = z.infer<typeof TerminalSendCommandManyArgsSchema>;

export const TerminalCloseManyArgsSchema = z.object({
  terminalIds: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BATCH_SENDS)
    .describe("1-16 terminals to close, each as a single close."),
});
export type TerminalCloseManyArgs = z.infer<typeof TerminalCloseManyArgsSchema>;

/** One item's outcome: the single call's result, or its error. */
export interface BatchItemOutcome {
  /** The agent id or terminal id the item named. */
  target: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
  /** With `waitForReply`: how the wait for this item's agent ended, and its reply. */
  reply?: unknown;
}
