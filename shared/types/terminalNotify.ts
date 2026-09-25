import { z } from "zod";

/**
 * Terminal notices: an orchestrating pane asks Daintree to tell it when an
 * agent terminal stops working, instead of spending model turns to find out.
 *
 * Asked for per call — `notify: true` on a send or launch, or
 * `terminal.notifyWhenIdle` for a terminal that is already working — and never
 * on Daintree's own initiative. A notice fires once, at the first settle out
 * of `working`, and Daintree types one self-contained line into the asking
 * pane's own prompt. The line carries only what Daintree observed and, for
 * `terminal.notifyWhenIdle`, the caller's own note; nothing the watched
 * terminal printed ever goes into it. Notices live in main, belong to the
 * asking pane, and go when it exits.
 */

/** Notices one pane may have pending at once, launches still in flight included. */
export const MAX_PENDING_NOTICES_PER_PANE = 32;
/** Fired notices held for delivery per pane; the oldest go first, and are counted. */
export const MAX_UNDELIVERED_NOTICES_PER_PANE = 64;
/** Fired notices spelled out in one delivered line; the rest are listed by id. */
export const MAX_DETAILED_NOTICES_PER_LINE = 10;
/** Longest note `terminal.notifyWhenIdle` echoes back. */
export const NOTIFY_NOTE_MAX_CHARS = 160;
/**
 * How long a target must stay out of `working` before its notice fires, so a
 * mid-turn flap or a boot settle is not reported as the end of the work.
 */
export const NOTIFY_TARGET_SETTLE_MS = 2_000;
/** Minimum spacing between two deliveries to one pane. */
export const MIN_NOTIFY_INTERVAL_MS = 5_000;
/**
 * How long fired notices gather before a delivery is attempted. Fixed from the
 * first of a batch and never extended, so a busy fleet cannot postpone its own
 * delivery indefinitely.
 */
export const NOTIFY_COALESCE_MS = 2_000;
/** How long the asking pane must have been settled before it is typed into. */
export const NOTIFY_SETTLE_GRACE_MS = 1_500;

/**
 * Where a pane's next delivery stands.
 *
 * - `idle` — nothing waiting to be delivered.
 * - `scheduled` — notices are gathering; a delivery will be attempted shortly.
 * - `held` — the pane is working, being typed into, or inside the minimum
 *   interval; the line goes out once that passes.
 * - `blocked` — the pane is at an approval, a question or an error, or has no
 *   agent at a prompt. Nothing is typed until it changes.
 * - `outstanding` — a line went out and the turn it started has not ended. No
 *   second one is sent meanwhile.
 * - `failed` — a line could not be confirmed written. It is never retried
 *   blind; its notices go out after the pane's next finished turn.
 */
export const TERMINAL_NOTIFY_DELIVERY_STATUSES = [
  "idle",
  "scheduled",
  "held",
  "blocked",
  "outstanding",
  "failed",
] as const;
export type TerminalNotifyDeliveryStatus = (typeof TERMINAL_NOTIFY_DELIVERY_STATUSES)[number];

export const TERMINAL_NOTIFY_DELIVERY_REASONS = [
  "working",
  "typing",
  "interval",
  "approval",
  "question",
  "error",
  "no-agent",
  "not-at-prompt",
  "unreadable",
  "cancelled",
  "unknown",
] as const;
export type TerminalNotifyDeliveryReason = (typeof TERMINAL_NOTIFY_DELIVERY_REASONS)[number];

const AGENT_STATE_VALUES = [
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
] as const;
const WAITING_REASON_VALUES = ["prompt", "question", "approval", "error"] as const;

/**
 * Model-facing description of `notify` on `terminal.sendCommand`,
 * `terminal.sendCommandOwned` and `agent.launch`, shared so the copies cannot
 * drift apart.
 */
export const NOTIFY_ARG_DESCRIPTION =
  "Daintree types one line into your own prompt when this agent next stops working, so end your turn instead of polling. Agent panes and assistants only.";

export const TerminalNotifyWhenIdleArgsSchema = z.object({
  terminalId: z
    .string()
    .min(1)
    .max(512)
    .describe("A working agent terminal in your project, not your own."),
  note: z
    .string()
    .max(NOTIFY_NOTE_MAX_CHARS)
    .optional()
    .describe(
      "Echoed back in the notice, such as what to do next. One line, at most 160 characters."
    ),
});
export type TerminalNotifyWhenIdleArgs = z.infer<typeof TerminalNotifyWhenIdleArgsSchema>;

export const TerminalNotifyWhenIdleResultSchema = z.object({
  armed: z
    .boolean()
    .describe(
      "False when the terminal was not working: nothing was set up, and `state` is where it is now."
    ),
  terminalId: z.string(),
  state: z.enum(AGENT_STATE_VALUES).optional(),
  waitingReason: z.enum(WAITING_REASON_VALUES).optional(),
});
export type TerminalNotifyWhenIdleResult = z.infer<typeof TerminalNotifyWhenIdleResultSchema>;

export const TerminalNotifyDeliverySchema = z.object({
  status: z.enum(TERMINAL_NOTIFY_DELIVERY_STATUSES),
  reason: z.enum(TERMINAL_NOTIFY_DELIVERY_REASONS).optional(),
  lastDeliveredAt: z.number().optional(),
});
export type TerminalNotifyDelivery = z.infer<typeof TerminalNotifyDeliverySchema>;

/**
 * What the asking pane's chrome shows, pushed to its project's views and
 * fetched on mount. Zero `pendingCount` and `readyCount` means the pane has
 * nothing pending and will not be typed into.
 */
export interface PaneNotifyState {
  terminalId: string;
  /** Terminals the pane is waiting to hear about. */
  pendingCount: number;
  /** Notices that fired and have not been delivered yet. */
  readyCount: number;
  delivery: TerminalNotifyDelivery;
  /** Increases with every change, so a late snapshot never overwrites a newer push. */
  revision: number;
}

/**
 * One plain, quotable line of text: control characters, bidirectional
 * overrides and zero-width characters out, runs of whitespace collapsed, and
 * double quotes swapped so a delivered line can quote it unambiguously.
 * Invisible direction controls would let a string read differently from what
 * it says, so they go rather than being kept.
 */
function toPlainLine(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
      .replace(/"/g, "'")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Reduce a caller's note to one plain line, capped. `undefined` when nothing is left. */
export function sanitizeNotifyNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const cleaned = toPlainLine(note).slice(0, NOTIFY_NOTE_MAX_CHARS).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Longest terminal id spelled out in a delivered line. */
const NOTICE_TERMINAL_ID_MAX_CHARS = 80;

/**
 * A terminal id as a delivered line spells it. Ids can be chosen by whoever
 * launched the panel, so one is reduced like a note and bounded rather than
 * trusted to be a short token.
 */
export function displayNoticeTerminalId(terminalId: string): string {
  const plain = toPlainLine(terminalId);
  if (plain.length === 0) return "(unnamed)";
  return plain.length > NOTICE_TERMINAL_ID_MAX_CHARS
    ? `${plain.slice(0, NOTICE_TERMINAL_ID_MAX_CHARS)}…`
    : plain;
}
