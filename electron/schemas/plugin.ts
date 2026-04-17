import * as semver from "semver";
import { z } from "zod";
import type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
} from "../../shared/types/plugin.js";

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

export const ToolbarButtonContributionSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  label: z.string().min(1),
  iconId: z.string().min(1),
  actionId: z.string().min(1),
  priority: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional(),
});

export const MenuItemContributionSchema = z.object({
  label: z.string().min(1),
  actionId: z.string().min(1),
  location: z.enum(["terminal", "file", "view", "help"]),
  accelerator: z.string().optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  version: z.string().min(1),
  displayName: z.string().optional(),
  description: z.string().optional(),
  main: z.string().optional(),
  renderer: z.string().optional(),
  engines: z
    .object({
      daintree: z
        .string()
        .trim()
        .min(1)
        .refine((val) => semver.validRange(val) !== null, {
          message: "engines.daintree must be a valid semver range",
        })
        .optional(),
    })
    .optional(),
  contributes: z
    .object({
      panels: z.array(PanelContributionSchema).default([]),
      toolbarButtons: z.array(ToolbarButtonContributionSchema).default([]),
      menuItems: z.array(MenuItemContributionSchema).default([]),
    })
    .default({ panels: [], toolbarButtons: [], menuItems: [] }),
});

export type { PluginManifest, PanelContribution, ToolbarButtonContribution, MenuItemContribution };
