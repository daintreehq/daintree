import path from "node:path";
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
 * Reserved contribution point. Shape is validated but the runtime does not
 * yet act on these entries — `PluginService` logs a warning and skips them.
 * The `experimental_` prefix signals that the shape may change before the
 * feature ships. See `docs/plugins/architecture.md`.
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
 * Hostnames that resolve to private/loopback/link-local space and must not
 * appear in a plugin's `scopes.network.allowedUrls`. Literal-string matches
 * only — DNS rebinding (a public hostname that resolves to RFC1918 at
 * request time) is out of scope for manifest-level validation. See #9247.
 */
const PRIVATE_LOOPBACK_HOSTNAME_LITERALS = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
/** IPv4 loopback (127.0.0.0/8). */
const IPV4_LOOPBACK_REGEX = /^127\./;
/** IPv4 link-local (169.254.0.0/16). Catches the AWS metadata endpoint. */
const IPV4_LINK_LOCAL_REGEX = /^169\.254\./;
/** IPv4 RFC1918 10.0.0.0/8. */
const IPV4_RFC1918_TEN_REGEX = /^10\./;
/** IPv4 RFC1918 192.168.0.0/16. */
const IPV4_RFC1918_192_REGEX = /^192\.168\./;
/** IPv4 RFC1918 172.16.0.0/12 (172.16.* through 172.31.*). */
const IPV4_RFC1918_172_REGEX = /^172\.(1[6-9]|2\d|3[0-1])\./;
/** IPv6 literal loopback (::1) — `new URL()` returns hostname stripped of brackets. */
const IPV6_LOOPBACK_REGEX = /^\[?::1\]?$/;

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (PRIVATE_LOOPBACK_HOSTNAME_LITERALS.has(lower)) return true;
  if (IPV4_LOOPBACK_REGEX.test(lower)) return true;
  if (IPV4_LINK_LOCAL_REGEX.test(lower)) return true;
  if (IPV4_RFC1918_TEN_REGEX.test(lower)) return true;
  if (IPV4_RFC1918_192_REGEX.test(lower)) return true;
  if (IPV4_RFC1918_172_REGEX.test(lower)) return true;
  if (IPV6_LOOPBACK_REGEX.test(lower)) return true;
  return false;
}

/**
 * Per-entry validator for `scopes.network.allowedUrls`. Each entry must:
 *
 * - Parse as a `https:` URL (no `http:`, `file:`, custom schemes).
 * - Contain no `*` substring (wildcards are rejected so a tightly-bound
 *   declaration cannot smuggle a permissive value past the manifest gate).
 * - Carry no embedded credentials (no `https://user:pass@host`).
 * - Target a multi-label hostname (at least one `.` after parse). Single-label
 *   intranet hosts are rejected to keep allowlists auditable from the manifest.
 * - Not target a private/loopback/link-local address (SSRF mitigation).
 */
const PluginAllowedUrlSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in scopes.network.allowedUrls: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.network.allowedUrls entry is not a valid URL: "${value}"`,
      params: { errorCode: "scope_url_invalid" },
    });
    return;
  }
  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.network.allowedUrls entries must use https:// — got "${parsed.protocol}" in "${value}"`,
      params: { errorCode: "scope_url_not_https" },
    });
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.network.allowedUrls entries must not embed credentials: "${value}"`,
      params: { errorCode: "scope_url_has_credentials" },
    });
    return;
  }
  const hostname = parsed.hostname;
  if (isPrivateOrLoopbackHostname(hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.network.allowedUrls entry targets a private or loopback address: "${value}"`,
      params: { errorCode: "scope_url_private_target" },
    });
    return;
  }
  if (hostname === "" || !hostname.includes(".")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.network.allowedUrls hostnames must be multi-label (got "${hostname}" in "${value}")`,
      params: { errorCode: "scope_url_hostname_unqualified" },
    });
    return;
  }
});

/**
 * Per-entry validator for `scopes.fs.allowedPaths`. Each entry must be a
 * literal absolute path with no `..` segment and no `*` glob — the schema
 * boundary is the load-bearing gate (#4593, #4702), so substring `..` checks
 * are insufficient (segment-by-segment rejection).
 */
const PluginAllowedPathSchema = z.string().superRefine((value, ctx) => {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in scopes.fs.allowedPaths: "${value}"`,
      params: { errorCode: "scope_wildcard_rejected" },
    });
    return;
  }
  if (!path.isAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must be absolute paths: "${value}"`,
      params: { errorCode: "scope_path_relative" },
    });
    return;
  }
  const segments = value.split(/[\\/]/);
  if (segments.some((seg) => seg === "..")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must not contain ".." segments: "${value}"`,
      params: { errorCode: "scope_path_traversal" },
    });
    return;
  }
});

export const PluginNetworkScopeSchema = z
  .object({
    allowedUrls: z.array(PluginAllowedUrlSchema).min(1),
  })
  .strict();

export const PluginFsScopeSchema = z
  .object({
    allowedPaths: z.array(PluginAllowedPathSchema).min(1),
  })
  .strict();

/**
 * Top-level `scopes` field on `PluginManifest`. Strict so a misspelled scope
 * bucket (e.g. `networking` instead of `network`) surfaces as a manifest error
 * rather than silently failing to attenuate the compound-capability lattice.
 */
export const PluginManifestScopesSchema = z
  .object({
    network: PluginNetworkScopeSchema.optional(),
    fs: PluginFsScopeSchema.optional(),
  })
  .strict();

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
      scopes: PluginManifestScopesSchema.optional(),
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
