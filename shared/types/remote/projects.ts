import { z } from "zod";

export const REMOTE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const RemoteOpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(REMOTE_OPAQUE_ID_PATTERN, "Expected an opaque identifier");

export const RemoteProjectIconSchema = z.strictObject({
  kind: z.enum(["emoji", "sanitized-svg"]),
  value: z.string().min(1).max(16_384),
});

export const RemoteProjectAttentionSchema = z.strictObject({
  waiting: z.number().int().nonnegative(),
  working: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
});

export const RemoteProjectSummarySchema = z.strictObject({
  id: RemoteOpaqueIdSchema,
  name: z.string().min(1).max(256),
  icon: RemoteProjectIconSchema.optional(),
  status: z.enum(["active", "background", "closed", "missing"]),
  attention: RemoteProjectAttentionSchema,
  order: z.number().int().nonnegative(),
});

export const RemoteWorktreeSummarySchema = z.strictObject({
  id: RemoteOpaqueIdSchema,
  name: z.string().min(1).max(256),
  branch: z.string().min(1).max(512).optional(),
  isMain: z.boolean(),
  isCurrent: z.boolean(),
  availability: z.enum(["available", "loading", "missing", "unknown"]),
});

export const RemoteProjectsSnapshotSchema = z.strictObject({
  projects: z.array(RemoteProjectSummarySchema),
  revision: z.number().int().nonnegative(),
  degraded: z.boolean(),
  lastSuccessfulAt: z.number().int().nonnegative().nullable(),
});

export const RemoteProjectsUpdatedSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  upserted: z.array(RemoteProjectSummarySchema),
  removedIds: z.array(RemoteOpaqueIdSchema),
  resyncRequired: z.boolean(),
  degraded: z.boolean(),
  lastSuccessfulAt: z.number().int().nonnegative().nullable(),
});

export const RemoteProjectOpenRequestSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
});

export const RemoteProjectUpdatedSchema = z.strictObject({
  projectId: RemoteOpaqueIdSchema,
  baseRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});

export type RemoteOpaqueId = z.infer<typeof RemoteOpaqueIdSchema>;
export type RemoteProjectSummary = z.infer<typeof RemoteProjectSummarySchema>;
export type RemoteWorktreeSummary = z.infer<typeof RemoteWorktreeSummarySchema>;
export type RemoteProjectsSnapshot = z.infer<typeof RemoteProjectsSnapshotSchema>;
export type RemoteProjectsUpdated = z.infer<typeof RemoteProjectsUpdatedSchema>;
