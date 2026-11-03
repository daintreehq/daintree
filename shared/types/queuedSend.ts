import { z } from "zod";

/**
 * A global Assistant's prompt held for the next time a busy worker waits at
 * its own prompt (#16187): what `terminal.sendCommandOwned` answers with
 * `whenBusy: "queue"`, and what a status read says became of it. Kept in the
 * memory of the host that runs the worker; a restart forgets it.
 */

/** How long a held prompt waits by default, and the bounds a caller may set. */
export const QUEUED_SEND_TTL_DEFAULT_SECONDS = 30 * 60;
export const QUEUED_SEND_TTL_MIN_SECONDS = 60;
export const QUEUED_SEND_TTL_MAX_SECONDS = 60 * 60;

/**
 * `queued` still waits; `delivered` was written to the worker's terminal;
 * `superseded` gave way to a newer one for the same worker; `dropped` ended
 * unwritten, for its `reason`; `cancelled` was withdrawn by its sender;
 * `unconfirmed` went to the terminal's lane, but the host never confirmed
 * whether it was written, so it is never sent again.
 */
export type QueuedSendStatus =
  "queued" | "delivered" | "superseded" | "dropped" | "cancelled" | "unconfirmed";

/**
 * Why a held prompt ended unwritten. `typed`: someone else sent the worker
 * input it could take as a prompt. `restarted`: the run it was for was
 * replaced. `target-gone`: the terminal exited, closed or left the project.
 * `session-gone`: the Assistant session that queued it ended. `not-allowed`:
 * it could no longer act there when it came to be written. `expired`: its time
 * ran out. `stopped`: notices were stopped, or turned off.
 */
export type QueuedSendDropReason =
  "typed" | "restarted" | "target-gone" | "session-gone" | "not-allowed" | "expired" | "stopped";

/** What became of a held prompt, as a status read reports it: observations only. */
export interface QueuedSendRecord {
  queuedSendToken: string;
  terminalId: string;
  status: QueuedSendStatus;
  /** Epoch ms. */
  queuedAt: number;
  expiresAt: number;
  /** While `queued`: what it was last seen waiting on, such as `working` or `approval`. */
  waitingOn?: string;
  /** Set once `delivered`: the line's own token, which the terminal's status read also takes. */
  submissionToken?: string;
  deliveredAt?: number;
  /** Set once `superseded`. */
  supersededBy?: string;
  /** Set once `dropped`. */
  reason?: QueuedSendDropReason;
  /** When it stopped waiting, whatever it ended as. */
  endedAt?: number;
}

/** The answer to a send held rather than written. */
export interface QueuedSendReceipt {
  sent: false;
  queued: true;
  terminalId: string;
  command: string;
  queuedSendToken: string;
  expiresAt: number;
  /** The caller's earlier held prompt to this worker, which this one replaces and which won't arrive. */
  supersededToken?: string;
  message: string;
}

/** Withdraws a held prompt not yet on its worker's line (#16187). Runs in main. */
export const TERMINAL_CANCEL_QUEUED_SEND_TOOL = "terminal.cancelQueuedSend";

export const QUEUED_SEND_STATUSES = [
  "queued",
  "delivered",
  "superseded",
  "dropped",
  "cancelled",
  "unconfirmed",
] as const satisfies readonly QueuedSendStatus[];

export const QUEUED_SEND_DROP_REASONS = [
  "typed",
  "restarted",
  "target-gone",
  "session-gone",
  "not-allowed",
  "expired",
  "stopped",
] as const satisfies readonly QueuedSendDropReason[];

/** `terminal.sendCommandOwned`'s answer to a worker that isn't at its prompt. */
export const WhenBusyArgSchema = z
  .enum(["refuse", "queue"])
  .optional()
  .describe(
    "For an agent you neither launched nor were handed, when it isn't waiting at its prompt: `refuse` (default) sends nothing; `queue` holds the text and types it the next time it waits at its own prompt with nothing typed there, dropping it if someone else sends it input or its run changes first. One held message per agent: a newer one replaces it. Not with `waitForReply`, and not for a slash command."
  );

export const QueueTtlSecondsArgSchema = z
  .number()
  .int()
  .min(QUEUED_SEND_TTL_MIN_SECONDS)
  .max(QUEUED_SEND_TTL_MAX_SECONDS)
  .optional()
  .describe(
    "How long a held message waits before it is dropped, in seconds (60-3600, default 1800)."
  );

export const QueuedSendRecordSchema = z.object({
  queuedSendToken: z.string(),
  terminalId: z.string(),
  status: z
    .enum(QUEUED_SEND_STATUSES)
    .describe(
      "`queued` still waits. `delivered` was written to the terminal, which says nothing of what the agent did with it. `unconfirmed` went to the terminal but was never confirmed written, and is never sent again."
    ),
  queuedAt: z.number(),
  expiresAt: z.number(),
  waitingOn: z
    .string()
    .optional()
    .describe("While queued: what it was last seen waiting on, such as `working` or `approval`."),
  submissionToken: z
    .string()
    .optional()
    .describe(
      "Once delivered: the line's token, which a status read with `submissionToken` also takes."
    ),
  deliveredAt: z.number().optional(),
  supersededBy: z.string().optional(),
  reason: z.enum(QUEUED_SEND_DROP_REASONS).optional().describe("Why it was dropped unwritten."),
  endedAt: z.number().optional(),
});

export const QueuedSendTokenArgSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("The `queuedSendToken` a held send answered with.");

export const TerminalCancelQueuedSendArgsSchema = z.object({
  terminalId: z.string().min(1).max(512).describe("The terminal the message was held for."),
  queuedSendToken: QueuedSendTokenArgSchema,
});

export const TerminalCancelQueuedSendResultSchema = z.object({
  terminalId: z.string(),
  queuedSendToken: z.string(),
  cancelled: z
    .boolean()
    .describe(
      "False when it had already ended, or was already on its way into the terminal: `queuedSend` says which."
    ),
  queuedSend: QueuedSendRecordSchema,
});
