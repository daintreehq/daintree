import * as semver from "semver";
import { z } from "zod";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "../../shared/types/plugin.js";
import type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  PluginCapability,
} from "../../shared/types/plugin.js";
import type {
  FileDecorationContribution,
  ForgeProviderContribution,
} from "../../shared/types/forge.js";

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
  when: z.string().min(1).optional(),
});

export const KeybindingContributionSchema = z.object({
  actionId: z.string().min(1),
  combo: z.string().min(1),
  when: z.string().min(1).optional(),
});

export const ContextMenuContributionSchema = z.object({
  actionId: z.string().min(1),
  location: z.enum(["worktree", "terminal", "panel", "file"]),
  label: z.string().min(1),
  when: z.string().min(1).optional(),
});

/**
 * `contributes.commands` manifest entry. The bare command `id` is namespaced
 * by `PluginService` at load time as `{pluginId}.{id}` so the descriptor key
 * matches the {@link PluginActionDescriptor.id} format used by the imperative
 * `host.registerAction` path. `danger: "restricted"` is rejected — plugins
 * may only contribute `"safe"` or `"confirm"` commands. Strict so an
 * unrecognised field surfaces as a manifest error instead of silently dropping
 * (e.g. a typo on `keywords` would otherwise vanish on a permissive schema).
 */
export const CommandContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    kind: z.enum(["command", "query"]),
    danger: z.enum(["safe", "confirm"]),
    keywords: z.array(z.string().min(1)).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * View contribution. `location: "panel"` entries are registered as spawnable
 * panel kinds at plugin load (`PluginService.loadPlugin`). `location: "sidebar"`
 * is schema-valid but skipped at runtime — the sidebar surface is not yet
 * implemented. The `experimental_` prefix on the contribution point signals
 * that the shape may change before the feature ships. See
 * `docs/plugins/architecture.md`.
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
 * Stdio-only MCP server contribution. Shape mirrors the Claude Desktop /
 * Cursor MCP server config. `url` is absent by design — HTTP/SSE transport
 * is rejected at the schema boundary. The MCP Authorization spec carves
 * stdio out of OAuth, and the official SDKs' HTTP transports have a
 * documented history of DNS-rebinding flaws (CVE-2025-66414,
 * CVE-2025-66416, CVE-2026-34742). Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently dropped.
 */
export const McpServerContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Reserved contribution point. Shape is validated but the runtime does not
 * yet act on these entries — `PluginService` logs a warning and skips them.
 * See `docs/architecture/forge-provider-abstraction.md`. `capabilities` is an
 * uninterpreted advisory list (informational only); the host gates behavior
 * on the runtime `ForgeProviderImpl` shape, not these strings.
 */
const CredentialFieldSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  label: z.string().min(1),
  type: z.string().min(1),
  placeholder: z.string().optional(),
  helpText: z.string().optional(),
});

export const ForgeProviderContributionSchema = z.object({
  id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
  name: z.string().min(1),
  matches: z.array(z.string().min(1)).min(1),
  capabilities: z.array(z.string().min(1)).optional(),
  credentialFields: z.array(CredentialFieldSchema).optional(),
  settingsScopeRef: z.string().min(1).optional(),
  viewRefs: z.array(z.string().min(1)).optional(),
});

/**
 * `fileDecorationProviders` manifest entry. Declares which scopes a plugin's
 * decoration provider handles so the host can route renderer pulls without
 * the plugin's code having run yet. Strict so unknown fields from plugin
 * authors are rejected loudly rather than silently ignored.
 */
export const FileDecorationContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    scopes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const PluginCapabilitySchema = z.enum(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * Validates the options passed to `host.showToast`. Both the main-process path
 * (plugin `activate` code) and any future renderer path (SDK React hooks over
 * IPC) converge on this schema. `priority` and `action` are intentionally
 * absent — plugins cannot set them, so the banned `priority:"low"` +
 * `type:"error"` combo is structurally impossible. Strict so unknown fields
 * from plugin authors are rejected loudly rather than silently dropped.
 */
export const PluginToastOptionsSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    type: z.enum(["info", "success", "warning", "error"]).default("info"),
    durationMs: z.number().int().positive().max(60_000).optional(),
  })
  .strict();

export function getPluginManifestSchema(isBuiltin: boolean) {
  return z
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
      capabilities: z.array(PluginCapabilitySchema).default([]),
      activationEvents: z.array(z.literal("onStartupFinished")).default([]),
      contributes: z
        .strictObject({
          panels: z.array(PanelContributionSchema).default([]),
          toolbarButtons: z.array(ToolbarButtonContributionSchema).default([]),
          menuItems: z.array(MenuItemContributionSchema).default([]),
          keybindings: z.array(KeybindingContributionSchema).default([]),
          contextMenus: z.array(ContextMenuContributionSchema).default([]),
          commands: z.array(CommandContributionSchema).default([]),
          experimental_views: z.array(ViewContributionSchema).default([]),
          experimental_mcpServers: z.array(McpServerContributionSchema).default([]),
          forgeProviders: z.array(ForgeProviderContributionSchema).default([]),
          fileDecorationProviders: z.array(FileDecorationContributionSchema).default([]),
        })
        .default({
          panels: [],
          toolbarButtons: [],
          menuItems: [],
          keybindings: [],
          contextMenus: [],
          commands: [],
          experimental_views: [],
          experimental_mcpServers: [],
          forgeProviders: [],
          fileDecorationProviders: [],
        }),
    })
    .superRefine((manifest, ctx) => {
      if (!isBuiltin && manifest.name.startsWith("daintree.")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: `Plugin name "${manifest.name}" uses the reserved "daintree.*" namespace, which is restricted to first-party plugins.`,
          params: { errorCode: "namespace_reserved" },
        });
      }
    });
}

export type {
  PluginManifest,
  PanelContribution,
  ToolbarButtonContribution,
  MenuItemContribution,
  ViewContribution,
  McpServerContribution,
  PluginCapability,
};
export type { ForgeProviderContribution, FileDecorationContribution };
