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

/**
 * What became of a held prompt, as a status read reports it: observations
 * only. The token and terminal it is read by aren't repeated.
 */
export interface QueuedSendRecord {
  status: QueuedSendStatus;
  /** Epoch ms. */
  queuedAt: number;
  expiresAt: number;
  /** While `queued`: what it was last seen waiting on, such as `working` or `approval`. */
  waitingOn?: string;
  /** Set once `delivered`: the line's own token, which the terminal's status read also takes. */
  submissionToken?: string;
  /** Set once `superseded`. */
  supersededBy?: string;
  /** Set once `dropped`. */
  reason?: QueuedSendDropReason;
  /** When it stopped waiting, whatever it ended as: for `delivered`, when the host wrote it. */
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
    "An agent you didn't launch and isn't at its prompt: `refuse` (default) sends nothing; `queue` holds the text for its next prompt."
  );

export const QueueTtlSecondsArgSchema = z
  .number()
  .int()
  .min(QUEUED_SEND_TTL_MIN_SECONDS)
  .max(QUEUED_SEND_TTL_MAX_SECONDS)
  .optional()
  .describe("Seconds held text waits before it is dropped (60-3600, default 1800).");

export const QueuedSendRecordSchema = z.object({
  status: z
    .enum(QUEUED_SEND_STATUSES)
    .describe(
      "`delivered` was written, not acted on; `unconfirmed` may have been, and is never resent."
    ),
  queuedAt: z.number(),
  expiresAt: z.number(),
  waitingOn: z.string().optional(),
  submissionToken: z.string().optional(),
  supersededBy: z.string().optional(),
  reason: z.enum(QUEUED_SEND_DROP_REASONS).optional(),
  endedAt: z.number().optional(),
});

export const QueuedSendTokenArgSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("A held send's `queuedSendToken`.");

export const TerminalCancelQueuedSendArgsSchema = z.object({
  terminalId: z.string().min(1).max(512).describe("The terminal it was held for."),
  queuedSendToken: QueuedSendTokenArgSchema,
});

export const TerminalCancelQueuedSendResultSchema = z.object({
  cancelled: z.boolean().describe("False once it ended or went to the terminal."),
  queuedSend: QueuedSendRecordSchema,
});
