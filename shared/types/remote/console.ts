import { z as schema } from "zod";
import { RemoteOpaqueIdSchema as remoteOpaqueIdSchema } from "./projects.js";

const RemoteConsoleTargetSchema = schema.strictObject({
  projectId: remoteOpaqueIdSchema,
  worktreeId: remoteOpaqueIdSchema,
  panelId: remoteOpaqueIdSchema,
  launchGeneration: schema.number().int().nonnegative(),
});

export const RemoteConsoleSubscribeRequestSchema = RemoteConsoleTargetSchema.extend({
  afterSeq: schema.number().int().nonnegative().optional(),
}).strict();

export const RemoteConsoleUnsubscribeRequestSchema = schema.strictObject({
  streamId: remoteOpaqueIdSchema,
});

export const RemoteConsoleChunkSchema = schema.strictObject({
  seq: schema.number().int().nonnegative(),
  data: schema.string(),
  encoding: schema.literal("base64"),
  bytes: schema
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024),
});

export const RemoteConsoleSnapshotSchema = RemoteConsoleTargetSchema.extend({
  streamId: remoteOpaqueIdSchema,
  mode: schema.enum(["snapshot", "resume", "resync"]),
  throughSeq: schema.number().int().nonnegative(),
  snapshot: schema
    .strictObject({
      data: schema.string(),
      cols: schema.number().int().positive(),
      rows: schema.number().int().positive(),
    })
    .nullable(),
  chunks: schema.array(RemoteConsoleChunkSchema),
})
  .strict()
  .superRefine((value, context) => {
    if ((value.mode === "snapshot") !== (value.snapshot !== null)) {
      context.addIssue({
        code: "custom",
        path: ["snapshot"],
        message: "Snapshot data must be present only for snapshot mode",
      });
    }
    if (value.mode === "resync" && value.chunks.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["chunks"],
        message: "Resync responses cannot contain output chunks",
      });
    }
  });

export const RemoteConsoleOutputSchema = schema.strictObject({
  streamId: remoteOpaqueIdSchema,
  panelId: remoteOpaqueIdSchema,
  launchGeneration: schema.number().int().nonnegative(),
  seq: schema.number().int().nonnegative(),
  data: schema.string(),
  encoding: schema.literal("base64"),
  bytes: schema
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024),
});

export const RemoteConsoleResyncRequiredSchema = schema.strictObject({
  streamId: remoteOpaqueIdSchema,
  reason: schema.enum(["gap", "generation-changed", "queue-overflow", "host-restarted"]),
});

export const RemoteSubmitPromptRequestSchema = RemoteConsoleTargetSchema.extend({
  idempotencyKey: remoteOpaqueIdSchema,
  text: schema.string().min(1).max(65_536),
}).strict();

export const RemotePromptResultSchema = schema.strictObject({
  idempotencyKey: remoteOpaqueIdSchema,
  disposition: schema.enum(["committed", "rejected", "unknown"]),
  resultCode: schema
    .enum([
      "queued",
      "invalid-target",
      "unauthorized",
      "unavailable",
      "stale-generation",
      "not-live",
      "revoked",
      "capability-denied",
      "internal-error",
      "commit-in-progress",
      "rate-limited",
    ])
    .optional(),
});

export const RemoteRequestStatusRequestSchema = schema.strictObject({
  idempotencyKey: remoteOpaqueIdSchema,
});

export const RemoteRequestStatusSchema = schema.strictObject({
  idempotencyKey: remoteOpaqueIdSchema,
  disposition: schema.enum(["committed", "rejected", "unknown", "not-found"]),
  createdResourceId: remoteOpaqueIdSchema.optional(),
  resultCode: schema
    .enum([
      "queued",
      "created",
      "invalid-target",
      "unauthorized",
      "unavailable",
      "stale-generation",
      "not-live",
      "revoked",
      "capability-denied",
      "cancelled",
      "internal-error",
      "commit-in-progress",
      "rate-limited",
    ])
    .optional(),
});

export type RemoteConsoleSnapshot = schema.infer<typeof RemoteConsoleSnapshotSchema>;
export type RemoteConsoleOutput = schema.infer<typeof RemoteConsoleOutputSchema>;
export type RemoteConsoleSubscribeRequest = schema.infer<
  typeof RemoteConsoleSubscribeRequestSchema
>;
export type RemoteSubmitPromptRequest = schema.infer<typeof RemoteSubmitPromptRequestSchema>;
export type RemotePromptResult = schema.infer<typeof RemotePromptResultSchema>;
