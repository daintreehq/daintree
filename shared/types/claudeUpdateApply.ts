import { z } from "zod";

/**
 * Applying a Claude Code update an assistant asked for (#17908): Daintree
 * types `/restart` alone into the pane, once, when it waits at its own empty
 * prompt, after the person approved it. Everything here is what was seen: the
 * answer never says the conversation came back.
 */

/** How long an approved request waits for the pane's own empty prompt. */
export const CLAUDE_UPDATE_WAIT_MS = 30_000;
/** How long the line may take to go in once the terminal has it. */
export const CLAUDE_UPDATE_DELIVERY_MS = 5_000;
/** How long Claude's answer is read for after the Enter. */
export const CLAUDE_UPDATE_WATCH_MS = 4_000;
/** Everything a request runs for once approved: its wait, the line going in, and the read after. */
export const CLAUDE_UPDATE_AFTER_APPROVAL_MS =
  CLAUDE_UPDATE_WAIT_MS + CLAUDE_UPDATE_DELIVERY_MS + CLAUDE_UPDATE_WATCH_MS;

/** Refused before anyone was asked: the pane doesn't offer `/restart` right now. */
export const CLAUDE_UPDATE_NOT_OFFERED = "UPDATE_RESTART_NOT_OFFERED";

/**
 * Why an approved request ended unsent. `typed`: someone gave the pane input
 * it could take as a prompt. `restarted`: the run it was for was replaced, or
 * Claude Code is no longer seen in it. `observation-changed`: the footer it
 * was approved on was cleared or seen anew. `target-gone`: the pane exited,
 * closed or went to the trash. `not-allowed`: the caller could no longer act
 * there. `expired`: the pane didn't wait at an empty prompt in time.
 * `withheld`: the terminal refused the line as it arrived, because the pane
 * stopped waiting at an empty prompt. `cancelled`: the call ended first.
 */
export const CLAUDE_UPDATE_NOT_SENT_REASONS = [
  "typed",
  "restarted",
  "observation-changed",
  "target-gone",
  "not-allowed",
  "expired",
  "withheld",
  "cancelled",
] as const;

export type ClaudeUpdateNotSentReason = (typeof CLAUDE_UPDATE_NOT_SENT_REASONS)[number];

export const ApplyClaudeUpdateResultSchema = z.object({
  terminalId: z.string(),
  status: z
    .enum(["sent", "not-sent", "unconfirmed"])
    .describe(
      "sent: `/restart` and Enter reached the terminal. unconfirmed: handed over, outcome unknown."
    ),
  reason: z.enum(CLAUDE_UPDATE_NOT_SENT_REASONS).optional().describe("Why it wasn't sent."),
  refusal: z
    .string()
    .nullable()
    .optional()
    .describe("Once sent: Claude's `Can't restart` line as drawn, or null if none was seen."),
  output: z
    .enum(["read", "lost", "unavailable"])
    .optional()
    .describe("Once sent: whether Claude's answer could be read."),
  message: z.string(),
});

export type ApplyClaudeUpdateResult = z.infer<typeof ApplyClaudeUpdateResultSchema>;
