import { z } from "zod";
import {
  RemoteOpaqueIdSchema,
  RemoteProjectSummarySchema,
  RemoteWorktreeSummarySchema,
} from "./projects.js";

export const RemoteAgentRunSchema = z.strictObject({
  panelId: RemoteOpaqueIdSchema,
  launchGeneration: z.number().int().nonnegative(),
  projectId: RemoteOpaqueIdSchema,
  worktreeId: RemoteOpaqueIdSchema,
  agentId: RemoteOpaqueIdSchema,
  displayName: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  state: z.enum([
    "starting",
    "working",
    "waiting",
    "completed",
    "exited",
    "restored",
    "unavailable",
  ]),
  connectionState: z.enum(["live", "starting", "restored", "exited", "unavailable"]),
  continuityState: z.enum(["starting", "live", "restored-screen", "exited", "unavailable"]),
  resumeState: z.enum(["resumable-by-cli", "not-resumable"]),
  waitingReason: z.string().min(1).max(512).optional(),
  stateSince: z.number().int().nonnegative().optional(),
  spawnedAt: z.number().int().nonnegative().optional(),
  spawnedRemotely: z.boolean(),
  resumable: z.boolean(),
});

export const RemoteProjectSnapshotSchema = z.strictObject({
  project: RemoteProjectSummarySchema,
  worktrees: z.array(RemoteWorktreeSummarySchema),
  agents: z.array(RemoteAgentRunSchema),
  revision: z.number().int().nonnegative(),
  projectionState: z.enum(["available", "loading", "evicted", "unavailable"]),
  degraded: z.boolean(),
  lastSuccessfulAt: z.number().int().nonnegative().nullable(),
});

export const RemoteLaunchableAgentsRequestSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  worktreeId: RemoteOpaqueIdSchema,
});

export const RemoteLaunchableAgentSchema = z.strictObject({
  agentId: RemoteOpaqueIdSchema,
  displayName: z.string().min(1).max(256),
  iconId: RemoteOpaqueIdSchema.optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  supportsPrompt: z.boolean(),
  modelIds: z.array(RemoteOpaqueIdSchema),
});

export const RemoteLaunchableAgentsSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  worktreeId: RemoteOpaqueIdSchema,
  agents: z.array(RemoteLaunchableAgentSchema),
});

export const RemoteLaunchAgentRequestSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  worktreeId: RemoteOpaqueIdSchema,
  agentId: RemoteOpaqueIdSchema,
  requestedPanelId: RemoteOpaqueIdSchema,
  idempotencyKey: RemoteOpaqueIdSchema,
  prompt: z.string().min(1).max(65_536).optional(),
  presetId: RemoteOpaqueIdSchema.nullable().optional(),
  modelId: RemoteOpaqueIdSchema.optional(),
  name: z.string().min(1).max(256).optional(),
});

export const RemoteLaunchAgentResultSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    idempotencyKey: RemoteOpaqueIdSchema,
    requestedPanelId: RemoteOpaqueIdSchema,
    panelId: RemoteOpaqueIdSchema,
    launchGeneration: z.number().int().positive(),
    projectId: RemoteOpaqueIdSchema,
    worktreeId: RemoteOpaqueIdSchema,
    agentId: RemoteOpaqueIdSchema,
    placement: z.enum(["grid", "dock"]),
    spawnStatus: z.literal("starting"),
    disposition: z.enum(["created", "existing"]),
  }),
  z.strictObject({
    idempotencyKey: RemoteOpaqueIdSchema,
    requestedPanelId: RemoteOpaqueIdSchema,
    disposition: z.literal("unknown"),
    resultCode: z.enum(["commit-in-progress", "internal-error", "unavailable"]),
  }),
]);

export const RemoteCloseAgentRequestSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  worktreeId: RemoteOpaqueIdSchema,
  panelId: RemoteOpaqueIdSchema,
  launchGeneration: z.number().int().positive(),
  idempotencyKey: RemoteOpaqueIdSchema,
});

export const RemoteCloseAgentResultSchema = z.discriminatedUnion("disposition", [
  z.strictObject({
    idempotencyKey: RemoteOpaqueIdSchema,
    panelId: RemoteOpaqueIdSchema,
    disposition: z.literal("closed"),
  }),
  z.strictObject({
    idempotencyKey: RemoteOpaqueIdSchema,
    panelId: RemoteOpaqueIdSchema,
    disposition: z.literal("unknown"),
    resultCode: z.enum(["commit-in-progress", "internal-error", "unavailable"]),
  }),
]);

export type RemoteAgentRun = z.infer<typeof RemoteAgentRunSchema>;
export type RemoteProjectSnapshot = z.infer<typeof RemoteProjectSnapshotSchema>;
export type RemoteLaunchableAgent = z.infer<typeof RemoteLaunchableAgentSchema>;
export type RemoteLaunchableAgents = z.infer<typeof RemoteLaunchableAgentsSchema>;
export type RemoteLaunchableAgentsRequest = z.infer<typeof RemoteLaunchableAgentsRequestSchema>;
export type RemoteLaunchAgentRequest = z.infer<typeof RemoteLaunchAgentRequestSchema>;
export type RemoteLaunchAgentResult = z.infer<typeof RemoteLaunchAgentResultSchema>;
export type RemoteCloseAgentRequest = z.infer<typeof RemoteCloseAgentRequestSchema>;
export type RemoteCloseAgentResult = z.infer<typeof RemoteCloseAgentResultSchema>;
