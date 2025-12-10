import { z } from "zod";

export const TerminalTypeSchema = z.enum([
  "shell",
  "claude",
  "gemini",
  "codex",
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "custom",
]);

export const AgentStateSchema = z.enum([
  "idle",
  "working",
  "running",
  "waiting",
  "completed",
  "failed",
]);

// @see shared/types/events.ts for the TypeScript interface definition.
export const EventContextSchema = z.object({
  worktreeId: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
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
]);

export const AgentSpawnedSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  terminalId: z.string().min(1),
  type: TerminalTypeSchema,
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
});

export const AgentStateChangedSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  state: AgentStateSchema,
  previousState: AgentStateSchema,
  timestamp: z.number().int().positive(),
  traceId: z.string().optional(),
  trigger: AgentStateChangeTriggerSchema,
  // Confidence in the state detection (0.0 = uncertain, 1.0 = certain)
  confidence: z.number().min(0).max(1),
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

export const AgentFailedSchema = EventContextSchema.extend({
  agentId: z.string().min(1),
  error: z.string().trim().min(1),
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
  AgentFailedSchema,
  AgentKilledSchema,
]);

export type EventContext = z.infer<typeof EventContextSchema>;
export type AgentSpawned = z.infer<typeof AgentSpawnedSchema>;
export type AgentStateChanged = z.infer<typeof AgentStateChangedSchema>;
export type AgentStateChangeTrigger = z.infer<typeof AgentStateChangeTriggerSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;
export type AgentCompleted = z.infer<typeof AgentCompletedSchema>;
export type AgentFailed = z.infer<typeof AgentFailedSchema>;
export type AgentKilled = z.infer<typeof AgentKilledSchema>;
export type AgentEventPayload = z.infer<typeof AgentEventPayloadSchema>;
