import { z } from "zod";

const RendererAgentPanelSchema = z.strictObject({
  panelId: z.string().min(1).max(128),
  worktreeSourceId: z.string().min(1).max(4_096),
  agentId: z.string().min(1).max(128),
  launchGeneration: z.number().int().nonnegative().optional(),
  placement: z.enum(["grid", "dock"]).optional(),
  displayName: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  spawnedAt: z.number().int().nonnegative().optional(),
  spawnedRemotely: z.boolean(),
  resumable: z.boolean(),
  connectionState: z.enum(["live", "starting", "restored", "exited"]).optional(),
});

export const RendererPanelProjectionPublishSchema = z.strictObject({
  projectId: z.string().min(1).max(128),
  status: z.enum(["loading", "available"]),
  panels: z.array(RendererAgentPanelSchema).max(1_000),
});

export type RendererPanelProjectionPublish = z.infer<typeof RendererPanelProjectionPublishSchema>;
