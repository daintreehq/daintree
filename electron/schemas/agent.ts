// zod/mini keeps the pty-host and workspace-host bundles free of full zod
// (~322KB): schemas here use the functional API (z.extend, z.optional,
// .check(z.*)) instead of chained methods, which mini does not ship.
import { z } from "zod/mini";
import { BUILT_IN_AGENT_IDS } from "../../shared/config/agentIds.js";

/** Schema for a built-in agent identity (claude, gemini, codex, opencode, …). */
export const BuiltInAgentIdSchema = z.enum(BUILT_IN_AGENT_IDS);

export const AgentStateSchema = z.pipe(
  z.transform((value) => (value === "running" ? "working" : value)),
  z.enum(["idle", "working", "waiting", "directing", "completed", "exited"])
);

const optionalNonEmptyString = z.optional(z.string().check(z.minLength(1)));
const positiveInt = z.int().check(z.positive());
const nonNegativeInt = z.int().check(z.nonnegative());

// @see shared/types/events.ts for the TypeScript interface definition.
export const EventContextSchema = z.object({
  worktreeId: z.optional(z.string()),
  agentId: z.optional(z.string()),
  runId: z.optional(z.string()),
  terminalId: z.optional(z.string()),
  issueNumber: z.optional(positiveInt),
  prNumber: z.optional(positiveInt),
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

export const AgentSpawnedSchema = z.extend(EventContextSchema, {
  agentId: z.string().check(z.minLength(1)),
  terminalId: z.string().check(z.minLength(1)),
  timestamp: positiveInt,
  traceId: z.optional(z.string()),
});

export const AgentStateChangedSchema = z.extend(EventContextSchema, {
  // Optional: runtime-detected-only flows may emit state changes without a
  // persisted launch hint. Consumers should fall back to terminalId.
  agentId: optionalNonEmptyString,
  state: AgentStateSchema,
  previousState: AgentStateSchema,
  timestamp: positiveInt,
  traceId: z.optional(z.string()),
  trigger: AgentStateChangeTriggerSchema,
  // Confidence in the state detection (0.0 = uncertain, 1.0 = certain)
  confidence: z.number().check(z.gte(0), z.lte(1)),
  // Working directory of the spawned terminal (equal to the worktree path in
  // the typical case).
  cwd: z.optional(z.string()),
  waitingReason: z.optional(z.enum(["prompt", "question", "approval", "error"])),
  sessionCost: z.optional(z.number().check(z.nonnegative())),
  sessionTokens: z.optional(nonNegativeInt),
  // Process exit metadata — present only on "completed"/"exited" transitions
  // driven by the PTY exit event. `exitCode` is the numeric process exit code
  // (null when the process was terminated by a signal with no numeric code);
  // `exitSignal` is the raw OS signal number from node-pty (no 128+signum
  // POSIX heuristic — that emits garbage on Windows, lesson #7028). Both let an
  // MCP supervisor tell a clean finish from a failure without scraping output.
  exitCode: z.optional(z.nullable(z.int())),
  exitSignal: z.optional(nonNegativeInt),
  // Live temperature snapshot from AgentActivityTemperature — present only on
  // accepted transitions that flow through the activity detector. The resize
  // `suppressed` flag is intentionally NOT carried; it is a separate signal
  // (resize-observation suppression) that the event inspector already has
  // visibility into through other channels. Carrying it here would conflate
  // two distinct decisions in the timeline view. zod v4's z.number() already
  // rejects NaN and ±Infinity, so no explicit finiteness check is needed.
  temperature: z.optional(z.number()),
  heatAdded: z.optional(z.number().check(z.nonnegative())),
  changedChars: z.optional(nonNegativeInt),
  // Parsed test/lint/build result captured at this transition (issue #10682).
  // Best-effort, not authoritative — see `TerminalCheckResult`. Present only on
  // settling transitions where a NEW recognized check summary was detected.
  lastCheckResult: z.optional(
    z.object({
      command: z.nullable(z.string()),
      passed: z.boolean(),
      ranAt: positiveInt,
      failureSummary: z.nullable(z.string()),
      truncated: z.boolean(),
    })
  ),
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
export const AgentStateTransitionDroppedSchema = z.extend(EventContextSchema, {
  /** Terminal ID the drop applies to. */
  terminalId: z.string().check(z.minLength(1)),
  /** Optional agent identity for routing/grouping in the inspector. */
  agentId: optionalNonEmptyString,
  /** Why the transition was dropped. */
  outcome: AgentStateTransitionDropReasonSchema,
  /** The state the terminal was in when the drop fired. */
  currentState: AgentStateSchema,
  /** The state we attempted to transition to (where known). */
  attemptedState: z.optional(AgentStateSchema),
  /** What triggered the attempt (input/output/heuristic/etc.). */
  trigger: z.optional(AgentStateChangeTriggerSchema),
  /** Confidence the attempt was made with (0.0–1.0). */
  confidence: z.optional(z.number().check(z.gte(0), z.lte(1))),
  /** CWD at the time of the drop, if known — useful for grep in the inspector. */
  cwd: z.optional(z.string()),
  /** Session token the attempt carried, for stale-session drops. */
  spawnedAt: z.optional(positiveInt),
  /** Live session token, for stale-session drops. */
  terminalSpawnedAt: z.optional(positiveInt),
  /** Human-readable explanation — typically the validation error text. */
  reason: z.optional(z.string()),
  /** Zod issue messages for `schema-invalid` drops (already flattened to strings). */
  validationErrors: z.optional(z.array(z.string())),
  /** Trace ID for correlation with the related (possibly emitted) `agent:state-changed`. */
  traceId: z.optional(z.string()),
  timestamp: positiveInt,
});

export const AgentOutputSchema = z.extend(EventContextSchema, {
  agentId: z.string().check(z.minLength(1)),
  data: z.string().check(z.minLength(1)),
  timestamp: positiveInt,
  traceId: z.optional(z.string()),
});

export const AgentCompletedSchema = z.extend(EventContextSchema, {
  agentId: z.string().check(z.minLength(1)),
  exitCode: z.int(),
  duration: nonNegativeInt,
  timestamp: positiveInt,
  traceId: z.optional(z.string()),
});

export const AgentKilledSchema = z.extend(EventContextSchema, {
  agentId: z.string().check(z.minLength(1)),
  reason: z.optional(z.string()),
  timestamp: positiveInt,
  traceId: z.optional(z.string()),
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
