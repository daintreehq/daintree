import { z } from "zod";

export const CapabilityKindSchema = z.enum(["command", "skill", "plugin", "app"]);

// Shared by IPC and actions so result validation cannot discard invocation fields.
export const CapabilitySummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  scope: z.string(),
  agentId: z.string(),
  sourcePath: z.string().optional(),
  kind: CapabilityKindSchema,
  insertText: z.string(),
  trigger: z.enum(["/", "$", "@"]),
  aliases: z.array(z.string()).optional(),
});

export const CapabilityContextSchema = z.object({
  agentId: z.string().min(1).max(128),
  worktreePath: z.string().min(1).max(4096),
});

export const CapabilitySearchRequestSchema = CapabilityContextSchema.extend({
  query: z.string().max(256),
  kinds: z
    .array(CapabilityKindSchema)
    .max(4)
    .optional()
    .describe("Restrict results to these kinds, up to 4. Omit for all."),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().max(512).optional(),
  refresh: z.boolean().optional(),
}).strict();

export const CapabilityGetRequestSchema = CapabilityContextSchema.extend({
  id: z.string().min(1).max(256),
  catalogRevision: z.string().min(1).max(128).optional(),
  offset: z.number().int().min(0).max(262144).optional(),
  sourceRevision: z.string().min(1).max(128).optional(),
}).strict();

const catalogShape = {
  context: CapabilityContextSchema,
  catalogRevision: z.string(),
  coverage: z.enum(["partial", "unsupported"]),
  warnings: z.array(z.string()),
};

export const CapabilitySearchResultSchema = z.object({
  ...catalogShape,
  items: z.array(CapabilitySummarySchema),
  total: z.number().int(),
  nextCursor: z.string().optional(),
});

export const CapabilityGetResultSchema = z.object({
  ...catalogShape,
  capability: CapabilitySummarySchema,
  invocation: z.object({
    token: z.string(),
    channel: z.enum(["interactive-command", "prompt-reference"]),
    argumentHint: z.string().optional(),
    startupSupport: z.literal("unverified"),
    requiresTask: z.boolean(),
  }),
  sourceRevision: z.string(),
  instructions: z.string(),
  nextOffset: z.number().int().optional(),
  truncated: z.boolean(),
});

export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;
export type CapabilitySearchRequest = z.infer<typeof CapabilitySearchRequestSchema>;
export type CapabilityGetRequest = z.infer<typeof CapabilityGetRequestSchema>;
export type CapabilitySearchResult = z.infer<typeof CapabilitySearchResultSchema>;
export type CapabilityGetResult = z.infer<typeof CapabilityGetResultSchema>;

export const CapabilityTargetSchema = z.object({
  terminalId: z
    .string()
    .min(1)
    .optional()
    .describe("Existing agent terminal. Use this alone to resolve its agent and directory."),
  agentId: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Exact agent ID, required with an explicit worktree when no terminal is given."),
  worktreeId: z.string().min(1).optional(),
  worktreePath: z.string().min(1).max(4096).optional(),
});
export const CapabilitySearchActionSchema = CapabilitySearchRequestSchema.omit({
  agentId: true,
  worktreePath: true,
})
  .extend(CapabilityTargetSchema.shape)
  .strict();
export const CapabilityGetActionSchema = CapabilityGetRequestSchema.omit({
  agentId: true,
  worktreePath: true,
})
  .extend(CapabilityTargetSchema.shape)
  .strict();
