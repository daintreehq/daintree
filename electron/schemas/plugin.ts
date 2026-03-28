import { z } from "zod";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const PanelContributionSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  name: z.string().min(1),
  iconId: z.string().min(1),
  color: z.string().min(1),
  hasPty: z.boolean().default(false),
  canRestart: z.boolean().default(false),
  canConvert: z.boolean().default(false),
  showInPalette: z.boolean().default(true),
});

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  version: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  main: z.string().optional(),
  renderer: z.string().optional(),
  contributes: z
    .object({
      panels: z.array(PanelContributionSchema).default([]),
    })
    .default({ panels: [] }),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PanelContribution = z.infer<typeof PanelContributionSchema>;
