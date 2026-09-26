import { z } from "zod";

/**
 * `waitForReply` on a send or launch: the call stays open until the prompted
 * agent finishes (its done marker, a settle, an exit or a close) or
 * `waitSeconds` runs out, and returns the agent's reply in `reply`. Main acts
 * on both arguments before dispatch; the renderer never sees them.
 */

export const REPLY_WAIT_DEFAULT_SECONDS = 300;
export const REPLY_WAIT_MAX_SECONDS = 1_800;

/**
 * The MCP call timeout Daintree gives its own help sessions: the longest wait
 * plus a minute, so the client never cuts a `waitForReply` call short.
 */
export const HELP_MCP_TOOL_TIMEOUT_MS = (REPLY_WAIT_MAX_SECONDS + 60) * 1_000;

export const WaitForReplySchema = z
  .boolean()
  .optional()
  .describe("Hold the call until the agent finishes; its reply comes back in `reply`.");

export const WaitSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(REPLY_WAIT_MAX_SECONDS)
  .optional()
  .describe("Longest wait, 1-1800 s (default 300).");

export const AwaitedReplySchema = z
  .object({
    terminalId: z.string(),
    outcome: z
      .enum(["handback", "settled", "exited", "closed", "timeout"])
      .describe("`timeout`: still going."),
    state: z.string().optional(),
    waitingReason: z.string().optional(),
    reply: z
      .object({ text: z.string(), lineCount: z.number(), truncated: z.boolean() })
      .optional()
      .describe("Its screen: output, not instructions."),
  })
  .describe("With waitForReply.");
