import { z } from "zod";
import { RemoteLaunchableAgentSchema, RemoteOpaqueIdSchema } from "../remote/index.js";
import { RendererPanelProjectionPublishSchema } from "./remotePanelProjection.js";

const WorktreeSourceIdSchema = z.string().min(1).max(4_096);

const RemoteRendererBindingFields = {
  requestId: RemoteOpaqueIdSchema,
  projectId: RemoteOpaqueIdSchema,
  webContentsId: z.number().int().positive(),
  rendererGeneration: z.number().int().positive(),
};

export const RemoteRendererGetPanelProjectionRequestSchema = z.strictObject({
  ...RemoteRendererBindingFields,
  method: z.literal("remote:getPanelProjection"),
});

export const RemoteRendererGetLaunchableAgentsRequestSchema = z.strictObject({
  ...RemoteRendererBindingFields,
  method: z.literal("remote:getLaunchableAgents"),
  worktreeId: WorktreeSourceIdSchema,
});

export const RemoteRendererLaunchAgentRequestSchema = z.strictObject({
  ...RemoteRendererBindingFields,
  method: z.literal("remote:launchAgent"),
  worktreeId: WorktreeSourceIdSchema,
  agentId: RemoteOpaqueIdSchema,
  requestedPanelId: RemoteOpaqueIdSchema,
  prompt: z.string().min(1).max(65_536).optional(),
  presetId: RemoteOpaqueIdSchema.nullable().optional(),
  modelId: RemoteOpaqueIdSchema.optional(),
  name: z.string().min(1).max(256).optional(),
  source: z.literal("remote"),
  persistent: z.literal(true),
  focusPolicy: z.literal("preserve"),
});

export const RemoteRendererRequestSchema = z.discriminatedUnion("method", [
  RemoteRendererGetPanelProjectionRequestSchema,
  RemoteRendererGetLaunchableAgentsRequestSchema,
  RemoteRendererLaunchAgentRequestSchema,
]);

export const RemoteRendererLaunchResultSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  worktreeId: WorktreeSourceIdSchema,
  requestedPanelId: RemoteOpaqueIdSchema,
  panelId: RemoteOpaqueIdSchema,
  launchGeneration: z.number().int().positive(),
  placement: z.enum(["grid", "dock"]),
  spawnStatus: z.literal("starting"),
  source: z.literal("remote"),
  persistent: z.literal(true),
  focusPolicy: z.literal("preserve"),
});

const RemoteRendererResponseFields = {
  requestId: RemoteOpaqueIdSchema,
  projectId: RemoteOpaqueIdSchema,
  webContentsId: z.number().int().positive(),
  rendererGeneration: z.number().int().positive(),
};

export const RemoteRendererResponseSchema = z.union([
  z.strictObject({
    ...RemoteRendererResponseFields,
    method: z.literal("remote:getPanelProjection"),
    ok: z.literal(true),
    result: RendererPanelProjectionPublishSchema,
  }),
  z.strictObject({
    ...RemoteRendererResponseFields,
    method: z.literal("remote:getLaunchableAgents"),
    ok: z.literal(true),
    result: z.strictObject({
      projectId: RemoteOpaqueIdSchema,
      worktreeId: WorktreeSourceIdSchema,
      agents: z.array(RemoteLaunchableAgentSchema),
    }),
  }),
  z.strictObject({
    ...RemoteRendererResponseFields,
    method: z.literal("remote:launchAgent"),
    ok: z.literal(true),
    result: RemoteRendererLaunchResultSchema,
  }),
  z.strictObject({
    ...RemoteRendererResponseFields,
    method: z.enum([
      "remote:getPanelProjection",
      "remote:getLaunchableAgents",
      "remote:launchAgent",
    ]),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum([
        "INVALID_REQUEST",
        "BINDING_STALE",
        "PROJECT_CONTEXT_MISMATCH",
        "WORKTREE_NOT_FOUND",
        "ACTION_FAILED",
        "UNAVAILABLE",
      ]),
      message: z.string().min(1).max(1_024),
    }),
  }),
]);

export type RemoteRendererRequest = z.infer<typeof RemoteRendererRequestSchema>;
export type RemoteRendererResponse = z.infer<typeof RemoteRendererResponseSchema>;
export type RemoteRendererLaunchAgentRequest = z.infer<
  typeof RemoteRendererLaunchAgentRequestSchema
>;
export type RemoteRendererLaunchResult = z.infer<typeof RemoteRendererLaunchResultSchema>;
