import * as semver from "semver";
import { z } from "zod";
import { BUILT_IN_PLUGIN_PERMISSIONS } from "../../shared/types/plugin.js";
import type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  PluginPermission,
} from "../../shared/types/plugin.js";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const SCOPED_PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * Reserved contribution point. Shape is validated but the runtime does not
 * yet act on these entries — `PluginService` logs a warning and skips them.
 * See `docs/architecture/plugin-views-and-mcp-servers.md`.
 */
export const ViewContributionSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  name: z.string().min(1),
  componentPath: z.string().min(1),
  location: z.enum(["panel", "sidebar"]),
  iconId: z.string().min(1).optional(),
  description: z.string().optional(),
});

/**
 * Reserved contribution point. Shape mirrors the Claude Desktop / Cursor
 * MCP server config (stdio transport only). `url` is intentionally absent —
 * remote MCP servers are a separate future concern.
 */
export const McpServerContributionSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const PluginPermissionSchema = z.enum(BUILT_IN_PLUGIN_PERMISSIONS);

export const PluginManifestSchema = z
  .strictObject({
    name: z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN, {
      error: 'Plugin name must be in publisher.name format (e.g. "acme.linear-context")',
    }),
    version: z.string().min(1),
    displayName: z.string().optional(),
    description: z.string().optional(),
    main: z.string().optional(),
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
    permissions: z.array(PluginPermissionSchema).default([]),
    contributes: z
      .object({
        panels: z.array(PanelContributionSchema).default([]),
        toolbarButtons: z.array(ToolbarButtonContributionSchema).default([]),
        menuItems: z.array(MenuItemContributionSchema).default([]),
        views: z.array(ViewContributionSchema).default([]),
        mcpServers: z.array(McpServerContributionSchema).default([]),
      })
      .default({
        panels: [],
        toolbarButtons: [],
        menuItems: [],
        views: [],
        mcpServers: [],
      }),
  })
  .strict();

export type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  PluginPermission,
};
