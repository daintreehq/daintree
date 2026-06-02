import path from "node:path";
import ipaddr from "ipaddr.js";
import * as semver from "semver";
import { z } from "zod";
import { BUILT_IN_PLUGIN_CAPABILITIES } from "../../shared/types/plugin.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";
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

export const PanelContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    iconId: z.string().min(1),
    color: z.string().min(1),
    hasPty: z.boolean().default(false),
    canRestart: z.boolean().default(false),
    canConvert: z.boolean().default(false),
    showInPalette: z.boolean().default(true),
  })
  .strict();

export const ToolbarButtonContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().min(1),
    iconId: z.string().min(1),
    actionId: z.string().min(1),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
  })
  .strict();

export const MenuItemContributionSchema = z
  .object({
    label: z.string().min(1),
    actionId: z.string().min(1),
    location: z.enum(["terminal", "file", "view", "help"]),
    accelerator: z.string().optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const KeybindingContributionSchema = z
  .object({
    actionId: z.string().min(1),
    combo: z.string().min(1),
    // Closed to the renderer's KeyScope union (src/services/keybindingUtils.ts).
    // An unknown scope would never match the active scope and silently produce an
    // inert binding, so reject it at the manifest gate instead. Defaults to
    // "global" in the renderer hook when omitted.
    scope: z
      .enum([
        "global",
        "terminal",
        "modal",
        "worktreeList",
        "portal",
        "worktreeGrid",
        "dev-preview",
      ])
      .optional(),
    description: z.string().min(1).optional(),
    when: z.string().min(1).optional(),
  })
  .strict();

export const ContextMenuContributionSchema = z
  .object({
    actionId: z.string().min(1),
    location: z.enum(["worktree", "terminal", "panel", "file"]),
    label: z.string().min(1),
    when: z.string().min(1).optional(),
  })
  .strict();

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
 * View contribution. A view renders into a `contributes.panels` entry with a
 * matching `id`; at plugin load (`PluginService.loadPlugin`) the panels loop
 * attaches the view's `componentPath` to that panel kind. A view with no
 * matching panel entry is ignored. `location: "panel"` sets
 * `showInPalette: true` so the view is spawnable from the panel palette;
 * `location: "sidebar"` registers silently with `showInPalette: false`,
 * reserving the kind for the future sidebar host. The `experimental_` prefix
 * on the contribution point signals that the shape may change before the
 * renderer host ships. See `docs/plugins/architecture.md`.
 */
export const ViewContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    componentPath: z.string().min(1),
    location: z.enum(["panel", "sidebar"]),
    iconId: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

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
const CredentialFieldSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    label: z.string().min(1),
    type: z.string().min(1),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .strict();

export const ForgeProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    matches: z.array(z.string().min(1)).min(1),
    capabilities: z.array(z.string().min(1)).optional(),
    credentialFields: z.array(CredentialFieldSchema).optional(),
    settingsScopeRef: z.string().min(1).optional(),
    viewRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();

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

/**
 * Detection patterns run against live PTY output for every terminal, so a
 * plugin-supplied pattern needs a tight contract — bounded length, a bounded
 * count, well-formedness, and no constructs prone to catastrophic backtracking.
 * RE2 (linear-time) is deliberately not added as a native dependency (#9560);
 * instead each pattern is validated structurally at manifest-parse time, which
 * is off the hot PTY path. A pattern that compiles but uses backreferences,
 * lookarounds, or nested quantifiers is rejected so a malicious manifest can't
 * stall the matcher.
 */
const MAX_DETECTION_PATTERN_LENGTH = 250;
const MAX_DETECTION_PATTERNS_PER_FIELD = 8;

/** Backreference, e.g. `\1`. */
const BACKREFERENCE_RE = /\\[1-9]/;
/** Lookahead/lookbehind: `(?=`, `(?!`, `(?<=`, `(?<!`. */
const LOOKAROUND_RE = /\(\?<?[=!]/;
/**
 * A group whose body contains a quantifier (`* + ? {`) or an alternation (`|`)
 * and that is itself quantified with an unbounded outer quantifier
 * (`* + {`). Catches the classic catastrophic-backtracking families
 * `(a+)+`, `(.*)*`, `(a?)+`, and quantified-alternation `(a|aa)+`. Outer `?`
 * is excluded because an optional group does not repeat unboundedly.
 */
const QUANTIFIED_COMPLEX_GROUP_RE = /\([^)]*[*+?{|][^)]*\)[*+{]/;
/**
 * Two nested quantified groups, e.g. `((a)*)*` — the inner group is closed and
 * quantified, then re-closed and quantified again. The single-group regex above
 * can't span the inner `)`, so this catches the nesting separately.
 */
const NESTED_QUANTIFIED_GROUP_RE = /\)[*+?][^(]*\)[*+{]/;

function hasCatastrophicBacktrackingRisk(pattern: string): boolean {
  return (
    BACKREFERENCE_RE.test(pattern) ||
    LOOKAROUND_RE.test(pattern) ||
    QUANTIFIED_COMPLEX_GROUP_RE.test(pattern) ||
    NESTED_QUANTIFIED_GROUP_RE.test(pattern)
  );
}

const BoundedDetectionPatternSchema = z
  .string()
  .min(1)
  .max(MAX_DETECTION_PATTERN_LENGTH, {
    message: `Detection pattern must be at most ${MAX_DETECTION_PATTERN_LENGTH} characters`,
  })
  .refine(
    (pattern) => {
      try {
        new RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Detection pattern is not a valid regular expression" }
  )
  .refine((pattern) => !hasCatastrophicBacktrackingRisk(pattern), {
    message:
      "Detection pattern may not use backreferences, lookarounds, quantified alternation, or nested quantifiers (catastrophic-backtracking risk)",
  });

const BoundedDetectionPatternArraySchema = z
  .array(BoundedDetectionPatternSchema)
  .max(MAX_DETECTION_PATTERNS_PER_FIELD, {
    message: `At most ${MAX_DETECTION_PATTERNS_PER_FIELD} detection patterns are allowed per field`,
  });

/**
 * Plugin-supplied output-detection config (#9560). Validated here but not yet
 * wired into the live matcher — the minimal tier launches plugin agents as
 * named, untracked terminals. Strict so an unrecognised field surfaces as a
 * manifest error rather than silently dropping.
 */
export const AgentDetectionContributionSchema = z
  .object({
    primaryPatterns: BoundedDetectionPatternArraySchema.optional(),
    fallbackPatterns: BoundedDetectionPatternArraySchema.optional(),
    promptPatterns: BoundedDetectionPatternArraySchema.optional(),
    bootCompletePatterns: BoundedDetectionPatternArraySchema.optional(),
    completionPatterns: BoundedDetectionPatternArraySchema.optional(),
    scanLineCount: z.number().int().min(1).max(50).optional(),
    debounceMs: z.number().int().min(500).max(30_000).optional(),
  })
  .strict();

/**
 * One `contributes.agents` entry (#9560). `id` and `command` use the shared
 * safe-id pattern (no shell metacharacters); a contribution whose `id` collides
 * with a built-in agent is rejected by the manifest-level `superRefine`. Strict
 * so unknown fields are rejected loudly. The `agent:register` capability is
 * required — also enforced at the manifest level so the message can reference
 * the whole contribution set.
 */
const RESERVED_AGENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

export const AgentContributionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_AGENT_IDS.has(id), {
        message: "Agent id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    name: z.string().min(1).max(100),
    command: z.string().min(1).max(256).regex(SAFE_ID_PATTERN),
    args: z
      .array(
        z
          .string()
          .max(256)
          .refine((arg) => !/[\r\n\0]/.test(arg), {
            message: "Args cannot contain control characters (\\r, \\n, \\0)",
          })
      )
      .max(20)
      .optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    iconId: z.string().min(1).max(64),
    supportsContextInjection: z.boolean().default(false),
    detection: AgentDetectionContributionSchema.optional(),
  })
  .strict();

export const PluginCapabilitySchema = z.enum(BUILT_IN_PLUGIN_CAPABILITIES);

/**
 * Hostnames that resolve to private/loopback/link-local space and must not
 * appear in a plugin's `scopes.network.allowedUrls`. Literal-string matches
 * only — DNS rebinding (a public hostname that resolves to RFC1918 at
 * request time) is out of scope for manifest-level validation. See #9247.
 */
// "0.0.0.0" is a Linux/Unix synonym for "any local interface" and routes to
// loopback on many platforms — it must be rejected alongside "localhost".
// Trailing-FQDN-dot variants (e.g. "localhost.") are normalized away before
// the literal check (see `normalizeHostname` below) so we only list bare forms.
const PRIVATE_LOOPBACK_HOSTNAME_LITERALS = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "0.0.0.0",
]);
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

function normalizeHostname(hostname: string): string {
  // WHATWG URL parsing preserves trailing FQDN dots (RFC 1034 §3.1): the host
  // "localhost." is structurally identical to "localhost" but would skip a
  // literal-set check. Strip the trailing dot before any classification.
  return hostname.replace(/\.$/, "").toLowerCase();
}

/**
 * Classify an IPv6 literal. `new URL("https://[::1]").hostname` is `"[::1]"`
 * — WHATWG retains the brackets — so strip them before parsing. Returns true
 * for loopback (::1), link-local (fe80::/10), unique-local (fc00::/7), and
 * IPv4-mapped addresses that unwrap to a blocked IPv4 (e.g. ::ffff:127.0.0.1).
 */
function isPrivateOrLoopbackIPv6(normalized: string): boolean {
  const literal =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (!ipaddr.IPv6.isValid(literal)) return false;
  const addr = ipaddr.IPv6.parse(literal);
  if (addr.isIPv4MappedAddress()) {
    return isPrivateOrLoopbackIPv4(addr.toIPv4Address().toString());
  }
  const range = addr.range();
  return range === "loopback" || range === "linkLocal" || range === "uniqueLocal";
}

function isPrivateOrLoopbackIPv4(value: string): boolean {
  return (
    IPV4_LOOPBACK_REGEX.test(value) ||
    IPV4_LINK_LOCAL_REGEX.test(value) ||
    IPV4_RFC1918_TEN_REGEX.test(value) ||
    IPV4_RFC1918_192_REGEX.test(value) ||
    IPV4_RFC1918_172_REGEX.test(value)
  );
}

export function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (PRIVATE_LOOPBACK_HOSTNAME_LITERALS.has(normalized)) return true;
  if (isPrivateOrLoopbackIPv4(normalized)) return true;
  if (isPrivateOrLoopbackIPv6(normalized)) return true;
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

/**
 * One `contributes.settings` field declaration (#9301). `type` is optional
 * (renders as a text field when omitted); the legacy `secret: true` flag is
 * normalized to `type: "secret"` by the transform so downstream consumers only
 * switch on `type`. A plain object (not `discriminatedUnion`) is used because
 * `type` is optional on the string/number/boolean branch. Strict so a misspelled
 * field key surfaces as a manifest error rather than silently dropping.
 */
export const SettingDefinitionSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["string", "number", "boolean", "enum", "json", "secret"]).optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    default: z.unknown().optional(),
    scope: z.enum(["user", "project"]).default("user"),
    options: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    secret: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const effectiveType = val.secret === true ? "secret" : (val.type ?? "string");
    if (effectiveType === "enum" && (!val.options || val.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Settings of type "enum" require a non-empty options array',
        path: ["options"],
      });
    }
    if (val.min !== undefined && val.max !== undefined && val.min > val.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Setting min cannot be greater than max",
        path: ["min"],
      });
    }
  })
  .transform((val) => {
    if (val.secret === true && val.type !== "secret") {
      return { ...val, type: "secret" as const };
    }
    return val;
  });

export function getPluginManifestSchema(isBuiltin: boolean) {
  return z
    .strictObject({
      name: z.string().min(1).max(64).regex(SCOPED_PLUGIN_NAME_PATTERN, {
        error: 'Plugin name must be in publisher.name format (e.g. "acme.linear-context")',
      }),
      version: z
        .string()
        .trim()
        .min(1)
        .refine((val) => semver.valid(val) !== null, {
          message: "version must be a valid semver (e.g. 1.2.3)",
        }),
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
          agents: z.array(AgentContributionSchema).default([]),
          settings: z.array(SettingDefinitionSchema).default([]),
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
          agents: [],
          settings: [],
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

      // `contributes.agents` registers a launchable agent CLI — gate it behind
      // the explicit `agent:register` capability so the contribution is
      // surfaced to the user at install time (#9560).
      const agents = manifest.contributes.agents;
      if (agents.length > 0 && !manifest.capabilities.includes("agent:register")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "agents"],
          message:
            'contributes.agents requires the "agent:register" capability to be declared in capabilities.',
          params: { errorCode: "agent_register_capability_required" },
        });
      }

      // Plugin agent IDs are additive for new IDs only — they may never shadow
      // or patch a built-in agent.
      agents.forEach((agent, index) => {
        if (isBuiltInAgentId(agent.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", "agents", index, "id"],
            message: `Plugin agent id "${agent.id}" collides with a built-in agent — plugin agents must use new IDs.`,
            params: { errorCode: "agent_id_reserved" },
          });
        }
      });
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
