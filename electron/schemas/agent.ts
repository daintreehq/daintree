import { z } from "zod";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";

/** Schema for a built-in agent identity (claude, gemini, codex, opencode, …). */
export const BuiltInAgentIdSchema = z.enum(BUILT_IN_AGENT_IDS);

export const AgentStateSchema = z.preprocess(
  (value) => (value === "running" ? "working" : value),
  z.enum(["idle", "working", "waiting", "directing", "completed", "exited"])
);

// @see shared/types/events.ts for the TypeScript interface definition.
export const EventContextSchema = z.object({
  worktreeId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  terminalId: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
});

export const AgentStateChangeTriggerSchema = z.enum([
  "input",
  "output",
  "heuristic",
  "ai-classification",
  "timeout",
  "exit",
  "activity",
  "title",
]);

export const AgentSpawnedSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  terminalId: z.string().min(1),
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
});

export const AgentStateChangedSchema = EventContextSchema.extend({
  // Optional: runtime-detected-only flows may emit state changes without a
  // persisted launch hint. Consumers should fall back to terminalId.
  agentId: z.string().min(1).optional(),
  state: AgentStateSchema,
  previousState: AgentStateSchema,
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
  trigger: AgentStateChangeTriggerSchema,
  // Confidence in the state detection (0.0 = uncertain, 1.0 = certain)
  confidence: z.number().min(0).max(1),
  // Working directory of the spawned terminal (used as the git target for
  // pre-agent snapshots; equal to the worktree path in the typical case).
  cwd: z.string().optional(),
  waitingReason: z.enum(["prompt", "question"]).optional(),
  sessionCost: z.number().nonnegative().optional(),
  sessionTokens: z.number().int().nonnegative().optional(),
  // Live temperature snapshot from AgentActivityTemperature — present only on
  // accepted transitions that flow through the activity detector. The resize
  // `suppressed` flag is intentionally NOT carried; it is a separate signal
  // (resize-observation suppression) that the event inspector already has
  // visibility into through other channels. Carrying it here would conflate
  // two distinct decisions in the timeline view.
  temperature: z.number().finite().optional(),
  heatAdded: z.number().nonnegative().optional(),
  changedChars: z.number().int().nonnegative().optional(),
});

/**
 * Discriminator for `agent:state-transition-dropped` events. Marks a transition
 * attempt that the AgentStateService rejected *before* it could land.
 *
 * - `no-op` — new state equalled previous state; nothing to emit.
 * - `hysteresis` — opposite-direction low-confidence transition within the
 *   high-confidence lock window.
 * - `stale-session` — external observer's `spawnedAt` token no longer matches
 *   the terminal's current session.
 * - `schema-invalid` — built payload failed Zod validation; the rejection
 *   prevents a malformed event from crossing IPC.
 */
export const AgentStateTransitionDropReasonSchema = z.enum([
  "no-op",
  "hysteresis",
  "stale-session",
  "schema-invalid",
]);

/**
 * Event payload for `agent:state-transition-dropped`. Records every transition
 * attempt the AgentStateService rejected (hysteresis, stale-session, schema
 * validation, or no-op) so user reports of false `working`/`waiting` can be
 * triaged from the diagnostics event inspector without losing the original
 * intent. Diagnostics tier only — never user-visible UI.
 */
export const AgentStateTransitionDroppedSchema = EventContextSchema.extend({
  /** Terminal ID the drop applies to. */
  terminalId: z.string().min(1),
  /** Optional agent identity for routing/grouping in the inspector. */
  agentId: z.string().min(1).optional(),
  /** Why the transition was dropped. */
  outcome: AgentStateTransitionDropReasonSchema,
  /** The state the terminal was in when the drop fired. */
  currentState: AgentStateSchema,
  /** The state we attempted to transition to (where known). */
  attemptedState: AgentStateSchema.optional(),
  /** What triggered the attempt (input/output/heuristic/etc.). */
  trigger: AgentStateChangeTriggerSchema.optional(),
  /** Confidence the attempt was made with (0.0–1.0). */
  confidence: z.number().min(0).max(1).optional(),
  /** CWD at the time of the drop, if known — useful for grep in the inspector. */
  cwd: z.string().optional(),
  /** Session token the attempt carried, for stale-session drops. */
  spawnedAt: z.number().int().positive().optional(),
  /** Live session token, for stale-session drops. */
  terminalSpawnedAt: z.number().int().positive().optional(),
  /** Human-readable explanation — typically the validation error text. */
  reason: z.string().optional(),
  /** Zod issue messages for `schema-invalid` drops (already flattened to strings). */
  validationErrors: z.array(z.string()).optional(),
  /** Trace ID for correlation with the related (possibly emitted) `agent:state-changed`. */
  traceId: z.string().optional(),
  timestamp: z.number().int().positive(),
});

export const AgentOutputSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  data: z.string().min(1),
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
});

export const AgentCompletedSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  exitCode: z.number().int(),
  duration: z.number().int().nonnegative(),
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
});

export const AgentKilledSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  reason: z.string().optional(),
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
});

export const AgentEventPayloadSchema = z.union([
  AgentSpawnedSchema,
  AgentStateChangedSchema,
  AgentOutputSchema,
  AgentCompletedSchema,
  AgentKilledSchema,
]);

export type EventContext = z.infer<typeof EventContextSchema>;
export type AgentSpawned = z.infer<typeof AgentSpawnedSchema>;
export type AgentStateChanged = z.infer<typeof AgentStateChangedSchema>;
export type AgentStateChangeTrigger = z.infer<typeof AgentStateChangeTriggerSchema>;
export type AgentStateTransitionDropReason = z.infer<typeof AgentStateTransitionDropReasonSchema>;
export type AgentStateTransitionDropped = z.infer<typeof AgentStateTransitionDroppedSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type AgentCompleted = z.infer<typeof AgentCompletedSchema>;
export type AgentKilled = z.infer<typeof AgentKilledSchema>;
export type AgentEventPayload = z.infer<typeof AgentEventPayloadSchema>;
