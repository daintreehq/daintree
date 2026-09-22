import { z } from "zod";

/**
 * Terminal watches (#12491): a pane asks Daintree to wake it when terminals it
 * supervises change, instead of spending a model turn every few minutes to
 * find out that nothing did.
 *
 * The wake is one fixed, server-authored line submitted to the watching pane's
 * own prompt. It is a pointer only; what was observed is read back through
 * `terminal.getWatchEvents`, as data. Watches live in main, belong to the pane,
 * and go when it exits.
 */

/** Watches one pane may hold at once. */
export const MAX_WATCHES_PER_PANE = 8;
/** Distinct terminals one pane may watch across all of its watches. */
export const MAX_WATCHED_TERMINALS_PER_PANE = 32;
export const DEFAULT_WATCH_MAX_DELIVERIES = 25;
export const MAX_WATCH_MAX_DELIVERIES = 100;
/** Observations held per pane; the oldest go first, and are counted. */
export const MAX_PENDING_WATCH_EVENTS = 200;
/** Minimum spacing between two wakes of one pane. */
export const MIN_WAKE_INTERVAL_MS = 30_000;
/**
 * How long observations gather before a wake is attempted. Fixed from the
 * first observation of a batch and never extended, so a busy fleet cannot
 * postpone its own wake indefinitely.
 */
export const WAKE_COALESCE_MS = 2_000;
/** How long the watching pane must have been settled before it is woken. */
export const WAKE_SETTLE_GRACE_MS = 1_500;

export const TERMINAL_WATCH_CONDITIONS = ["state", "handback", "exit", "untracked"] as const;
export type TerminalWatchCondition = (typeof TERMINAL_WATCH_CONDITIONS)[number];

export const TERMINAL_WATCH_EVENT_KINDS = [...TERMINAL_WATCH_CONDITIONS, "stopped"] as const;
export type TerminalWatchEventKind = (typeof TERMINAL_WATCH_EVENT_KINDS)[number];

export const TERMINAL_WATCH_STOP_REASONS = ["max-deliveries", "targets-gone"] as const;
export type TerminalWatchStopReason = (typeof TERMINAL_WATCH_STOP_REASONS)[number];

/**
 * Where a pane's wake stands.
 *
 * - `idle` — nothing waiting to be delivered.
 * - `scheduled` — observations are gathering; a wake will be attempted shortly.
 * - `held` — the pane is working, being typed into, or inside the minimum
 *   interval; the wake goes out once that passes.
 * - `blocked` — the pane is at an approval, a question or an error, or has no
 *   agent at a prompt. Nothing is typed until it changes.
 * - `outstanding` — a wake went out and has not been read yet. No second one is
 *   sent meanwhile.
 * - `failed` — a wake could not be confirmed written. It is never retried; the
 *   next read of the observations re-arms delivery.
 */
export const TERMINAL_WATCH_DELIVERY_STATUSES = [
  "idle",
  "scheduled",
  "held",
  "blocked",
  "outstanding",
  "failed",
] as const;
export type TerminalWatchDeliveryStatus = (typeof TERMINAL_WATCH_DELIVERY_STATUSES)[number];

export const TERMINAL_WATCH_DELIVERY_REASONS = [
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
export type TerminalWatchDeliveryReason = (typeof TERMINAL_WATCH_DELIVERY_REASONS)[number];

const AGENT_STATE_VALUES = [
  "idle",
  "working",
  "waiting",
  "directing",
  "completed",
  "exited",
] as const;
const WAITING_REASON_VALUES = ["prompt", "question", "approval", "error"] as const;

const WatchIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("A watch id returned by the watch capability.");

export const TerminalWatchArgsSchema = z.object({
  terminalIds: z
    .array(z.string().min(1).max(512))
    .min(1)
    .max(MAX_WATCHED_TERMINALS_PER_PANE)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "terminalIds must not repeat an id",
    })
    .describe(
      "Panel ids from the terminal-listing capability, in your project and not your own. At most 32 distinct across this pane's watches."
    ),
  conditions: z
    .array(z.enum(TERMINAL_WATCH_CONDITIONS))
    .min(1)
    .optional()
    .describe(
      "What to report: `state` (agent state changed), `handback`, `exit` (process exited), `untracked` (closed). Defaults to all four."
    ),
  maxDeliveries: z
    .number()
    .int()
    .min(1)
    .max(MAX_WATCH_MAX_DELIVERIES)
    .optional()
    .describe("Stop the watch after this many wakes, 1 to 100. Defaults to 25."),
});
export type TerminalWatchArgs = z.infer<typeof TerminalWatchArgsSchema>;

export const TerminalListWatchesArgsSchema = z.object({});

export const TerminalGetWatchEventsArgsSchema = z.object({
  watchId: WatchIdSchema.optional().describe(
    "Only this watch's observations. Omit for every watch this pane holds."
  ),
  clear: z
    .boolean()
    .optional()
    .describe(
      "Remove what is returned. Defaults to true. With false the observations stay for a later read, but they never cause another wake."
    ),
});
export type TerminalGetWatchEventsArgs = z.infer<typeof TerminalGetWatchEventsArgsSchema>;

export const TerminalCancelWatchArgsSchema = z.object({
  watchId: WatchIdSchema,
});
export type TerminalCancelWatchArgs = z.infer<typeof TerminalCancelWatchArgsSchema>;

export const TerminalWatchEventSchema = z.object({
  seq: z.number().int(),
  watchId: z.string(),
  kind: z.enum(TERMINAL_WATCH_EVENT_KINDS),
  at: z.number().describe("Epoch ms."),
  terminalId: z.string().optional(),
  state: z.enum(AGENT_STATE_VALUES).optional(),
  previousState: z.enum(AGENT_STATE_VALUES).optional(),
  waitingReason: z.enum(WAITING_REASON_VALUES).optional(),
  trigger: z.string().optional(),
  confidence: z.number().optional().describe("Detector confidence, 0 to 1."),
  exitCode: z.number().optional(),
  stopReason: z.enum(TERMINAL_WATCH_STOP_REASONS).optional(),
});
export type TerminalWatchEvent = z.infer<typeof TerminalWatchEventSchema>;

export const TerminalWatchSummarySchema = z.object({
  watchId: z.string(),
  terminalIds: z.array(z.string()).describe("Still watched; exited and closed ones drop out."),
  conditions: z.array(z.enum(TERMINAL_WATCH_CONDITIONS)),
  deliveries: z.number().int(),
  maxDeliveries: z.number().int(),
  status: z.enum(["active", "stopped"]),
  stopReason: z.enum(TERMINAL_WATCH_STOP_REASONS).optional(),
  createdAt: z.number(),
});
export type TerminalWatchSummary = z.infer<typeof TerminalWatchSummarySchema>;

export const TerminalWatchDeliverySchema = z.object({
  status: z.enum(TERMINAL_WATCH_DELIVERY_STATUSES),
  reason: z.enum(TERMINAL_WATCH_DELIVERY_REASONS).optional(),
  lastDeliveredAt: z.number().optional(),
});
export type TerminalWatchDelivery = z.infer<typeof TerminalWatchDeliverySchema>;

export const TerminalWatchResultSchema = z.object({
  watchId: z.string(),
  terminalIds: z.array(z.string()),
  conditions: z.array(z.enum(TERMINAL_WATCH_CONDITIONS)),
  maxDeliveries: z.number().int(),
});
export type TerminalWatchResult = z.infer<typeof TerminalWatchResultSchema>;

export const TerminalListWatchesResultSchema = z.object({
  watches: z.array(TerminalWatchSummarySchema),
  pendingEvents: z.number().int(),
  delivery: TerminalWatchDeliverySchema,
});
export type TerminalListWatchesResult = z.infer<typeof TerminalListWatchesResultSchema>;

export const TerminalGetWatchEventsResultSchema = z.object({
  events: z.array(TerminalWatchEventSchema),
  droppedEvents: z.number().int().describe("Discarded unread: at most 200 are held."),
  remainingEvents: z.number().int(),
});
export type TerminalGetWatchEventsResult = z.infer<typeof TerminalGetWatchEventsResultSchema>;

export const TerminalCancelWatchResultSchema = z.object({
  watchId: z.string(),
  cancelled: z.boolean(),
});
export type TerminalCancelWatchResult = z.infer<typeof TerminalCancelWatchResultSchema>;

/**
 * What the watching pane's chrome shows (#12491), pushed to its project's
 * views and fetched on mount. `watchCount: 0` means the pane holds no watches
 * and may not be woken.
 */
export interface PaneWatchState {
  terminalId: string;
  watchCount: number;
  watchedTerminalCount: number;
  pendingEvents: number;
  delivery: TerminalWatchDelivery;
  /** Increases with every change, so a late snapshot never overwrites a newer push. */
  revision: number;
}
