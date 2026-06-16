import path from "node:path";
import ipaddr from "ipaddr.js";
import * as semver from "semver";
import { z } from "zod";
import { BUILT_IN_PLUGIN_CAPABILITIES, PLUGIN_CATEGORY_IDS } from "../../shared/types/plugin.js";
import { isBuiltInAgentId } from "../../shared/config/agentIds.js";
import {
  BUILT_IN_ACTION_IDS,
  DENY_PLUGIN_DISPATCH_ACTION_IDS,
} from "../../shared/config/actionIds.js";
import { KEY_ACTION_VALUES } from "../../shared/types/keymap.js";
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

export const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const SCOPED_PLUGIN_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The full set of built-in action ids a plugin contribution may reference:
// `BuiltInActionId = BuiltInKeyAction | BuiltInRuntimeActionId`
// (shared/types/actions.ts). `BUILT_IN_ACTION_IDS` covers only the runtime
// half — keybinding-driven ids (nav.*, tab.*, app.settings, layout.undo, …)
// live in `KEY_ACTION_VALUES` and are equally valid dispatch targets, so both
// must seed the allowlist or a legitimate keybinding contribution is rejected.
const BUILT_IN_ACTION_ID_SET: ReadonlySet<string> = new Set([
  ...BUILT_IN_ACTION_IDS,
  ...KEY_ACTION_VALUES,
]);

// Built-in actions a plugin contribution may never dispatch (terminal input
// injection, fleet command relays). The host refuses these at runtime, so a
// contribution wired to one is a dead button — reject it at parse time (#10580).
const DENY_PLUGIN_DISPATCH_SET: ReadonlySet<string> = new Set(DENY_PLUGIN_DISPATCH_ACTION_IDS);

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
    // `"panel"` removed (#10512) — no renderer surface consumed it, so a
    // contributed panel context-menu item was dead. Reject it at the manifest
    // gate so authors get a clear error instead of a silently-ignored item.
    location: z.enum(["worktree", "terminal", "file"]),
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
 * Validate a `componentPath` before it is resolved to a `plugin://` URL and
 * handed to the renderer host's `import()` (#9229). The `plugin://` protocol
 * handler at `electron/setup/protocols.ts` is the security boundary — it
 * rejects traversal at request time via realpath containment. This check is
 * the manifest gate: it rejects an absolute path, a Windows separator, an
 * embedded URL scheme/query/fragment, a NUL, or a `..` segment at parse time
 * so the failure is a loud manifest-validation error, not a silent 404 from
 * `import('plugin://...')` later. Accepts relative POSIX paths only — a
 * leading `./` is preserved (the URL builder normalizes it).
 */
function isSafePluginViewComponentPath(componentPath: string): boolean {
  if (componentPath.startsWith("/")) return false;
  if (componentPath.includes("\\")) return false;
  if (componentPath.includes("\0")) return false;
  // Reject embedded URL structure markers — `https://...` (`:`), `?query`, or
  // `#fragment` — to catch typos early and avoid polluting the V8 module cache
  // with duplicate query-string variants.
  if (componentPath.includes(":")) return false;
  if (componentPath.includes("?")) return false;
  if (componentPath.includes("#")) return false;
  // A bare current-dir / root path (`.`, `./`) resolves to no module file — a
  // 404 from the protocol handler — so reject it at the manifest gate.
  const normalized = componentPath.startsWith("./") ? componentPath.slice(2) : componentPath;
  if (normalized === "" || normalized === ".") return false;
  return !componentPath.split("/").includes("..");
}

/**
 * View contribution. A view renders into a `contributes.panels` entry with a
 * matching `id`; at plugin load (`PluginService.loadPlugin`) the panels loop
 * attaches the view's `componentPath` to that panel kind. A view with no
 * matching panel entry is ignored. Only `location: "panel"` is supported — it
 * sets `showInPalette: true` so the view is spawnable from the panel palette.
 * `"sidebar"` is rejected at the schema boundary: the sidebar host does not
 * exist yet, so accepting it would validate a manifest the runtime cannot
 * honor. Contributed via the stable `contributes.views` key (the pre-1.0
 * `experimental_views` name is still accepted as a deprecated alias). See
 * `docs/plugins/architecture.md`.
 */
export const ViewContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    componentPath: z.string().min(1).refine(isSafePluginViewComponentPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    location: z.literal("panel"),
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
 * One credential input rendered into the provider's settings form. `type` is a
 * free string (`"password"` masks the input; anything else renders plain
 * text). A provider may declare several fields, but only the primary value
 * reaches `validateToken` — see `ForgeProviderContribution.credentialFields`
 * in `shared/types/forge.ts` for the single-primary contract.
 */
const RESERVED_CREDENTIAL_FIELD_IDS = new Set(["__proto__", "constructor", "prototype"]);

const CredentialFieldSchema = z
  .object({
    // A field id keys the entered value into a plain record at save time; a
    // reserved key (`__proto__` etc.) would resolve to the object prototype
    // rather than a stored string and crash the primary-value pick. Reject up
    // front, mirroring AgentContributionSchema.
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(SAFE_ID_PATTERN)
      .refine((id) => !RESERVED_CREDENTIAL_FIELD_IDS.has(id), {
        message: "Credential field id cannot be a reserved key (__proto__, constructor, prototype)",
      }),
    label: z.string().min(1),
    type: z.string().min(1),
    placeholder: z.string().optional(),
    helpText: z.string().optional(),
  })
  .strict();

/**
 * `forgeProviders` manifest entry — wired: the registry populates Preferences
 * and remote-routing before any plugin code runs. See
 * `docs/architecture/forge-provider-abstraction.md`. Two fields are validated
 * for SHAPE only and carry no runtime authority (frozen at 1.0):
 *   - `capabilities` is informational; the host gates behavior on the runtime
 *     `ForgeProviderImpl` field presence, never on these strings.
 *   - `slots` values are opaque renderer view-ids checked for non-emptiness
 *     only; the main process can't verify them against the renderer registry,
 *     and an unresolved ref renders a neutral fallback (not a parse error).
 */
export const ForgeProviderContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    name: z.string().min(1),
    matches: z.array(z.string().min(1)).min(1),
    kind: z.enum(["local", "network"]).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    credentialFields: z.array(CredentialFieldSchema).optional(),
    settingsScopeRef: z.string().min(1).optional(),
    viewRefs: z.array(z.string().min(1)).optional(),
    slots: z
      .object({
        settingsTab: z.string().min(1).optional(),
        icon: z.string().min(1).optional(),
        statsDropdown: z.string().min(1).optional(),
        bulkCreateWorktreeDialog: z.string().min(1).optional(),
        issueSelector: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
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
 * One `contributes.agents` entry (#9560). `id` and `command` use the shared
 * safe-id pattern (no shell metacharacters); a contribution whose `id` collides
 * with a built-in agent is rejected by the manifest-level `superRefine`. Strict
 * so unknown fields are rejected loudly. The `agent:register` capability is
 * required — also enforced at the manifest level so the message can reference
 * the whole contribution set.
 */
const RESERVED_AGENT_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validate a `contributes.agents` `command` before it is registered and later
 * spawned by node-pty. Two shapes are allowed: a bare PATH-resolvable binary
 * name (no path separators — the original `SAFE_ID_PATTERN` behavior), or an
 * explicit plugin-relative POSIX path prefixed with `./` that resolves against
 * the plugin's install dir at registration time (`pluginAgentRegistry`). The
 * `./` prefix is required for relative paths so intent is unambiguous — a bare
 * `bin/agent.mjs` would be ambiguous with a PATH name. Rejects absolute paths,
 * Windows separators, NUL, and any `..` traversal segment so the failure is a
 * loud manifest error rather than a spawn-time ENOENT or an escape from the
 * plugin dir. node-pty resolves the command before switching cwd, so the
 * relative form is resolved to an absolute path at registration, not spawn.
 */
function isSafePluginAgentCommand(command: string): boolean {
  // Bare PATH-resolvable binary name (e.g. "claude", "node") — original behavior.
  if (SAFE_ID_PATTERN.test(command)) return true;
  // Otherwise only an explicit plugin-relative POSIX path is allowed.
  if (!command.startsWith("./")) return false;
  if (command.includes("\\")) return false;
  if (command.includes("\0")) return false;
  const normalized = command.slice(2);
  if (normalized === "" || normalized === ".") return false;
  // Reject empty (`//`), current-dir (`.`), and traversal (`..`) segments so the
  // registration-time resolve cannot escape the plugin dir or normalize oddly.
  return normalized
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * A single output-detection regex pattern (#10587). Compiled with `new RegExp`
 * by the pty-host activity monitor, so it must be a valid JS regex. Bounded to
 * 256 chars — the patterns run in the pty-host (a stall is observable, not a
 * web-server DoS vector), and the length cap plus the activity monitor's
 * bounded scan window keep catastrophic backtracking a contained risk without
 * pulling in a new linear-time regex dependency.
 */
const PluginDetectionPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (pattern) => {
      try {
        // Call form (not `new`) compiles and validates the pattern without a
        // constructed-but-unused instance — throws on a malformed regex.
        RegExp(pattern);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Detection pattern must be a valid regular expression" }
  );

/** A bounded array of detection regex patterns. Capped to keep a manifest from declaring an unbounded matcher set. */
const PluginDetectionPatternArraySchema = z.array(PluginDetectionPatternSchema).max(50);

/** Confidence weight in [0, 1] for a matched detection tier. */
const PluginDetectionConfidenceSchema = z.number().min(0).max(1);

/**
 * Optional output-pattern detection for a contributed agent (#10587). Mirrors
 * the host-internal `AgentDetectionConfig` (shared/config/agentRegistry.ts) so
 * a plugin agent can describe its working/waiting/completed states and join the
 * agent-state UI. Strict so a typo'd field is a loud manifest error. All
 * pattern arrays validate each entry as a compilable regex; numeric tuning
 * fields are bounded.
 */
export const AgentDetectionConfigSchema = z
  .object({
    // Required and non-empty, mirroring the host-internal `AgentDetectionConfig`
    // type (where `primaryPatterns` is non-optional): a detection block exists to
    // describe the working state, and an empty `primaryPatterns` makes
    // `buildPatternConfig` return undefined anyway. A "prompt/completion only"
    // agent without a working pattern is out of scope for the declared schema.
    primaryPatterns: PluginDetectionPatternArraySchema.min(1),
    fallbackPatterns: PluginDetectionPatternArraySchema.optional(),
    bootCompletePatterns: PluginDetectionPatternArraySchema.optional(),
    promptPatterns: PluginDetectionPatternArraySchema.optional(),
    promptHintPatterns: PluginDetectionPatternArraySchema.optional(),
    completionPatterns: PluginDetectionPatternArraySchema.optional(),
    scanLineCount: z.number().int().min(1).max(1000).optional(),
    promptScanLineCount: z.number().int().min(1).max(1000).optional(),
    debounceMs: z.number().int().min(0).max(600_000).optional(),
    promptFastPathMinQuietMs: z.number().int().min(0).max(600_000).optional(),
    primaryConfidence: PluginDetectionConfidenceSchema.optional(),
    fallbackConfidence: PluginDetectionConfidenceSchema.optional(),
    promptConfidence: PluginDetectionConfidenceSchema.optional(),
    completionConfidence: PluginDetectionConfidenceSchema.optional(),
    titleStatePatterns: z
      .object({
        working: z.array(z.string().min(1).max(256)).max(50),
        waiting: z.array(z.string().min(1).max(256)).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    command: z.string().min(1).max(256).refine(isSafePluginAgentCommand, {
      message:
        "command must be a bare PATH binary name or a plugin-relative path starting with ./ (no absolute path, backslash, NUL, or .. segments)",
    }),
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
    detection: AgentDetectionConfigSchema.optional(),
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
 * Shared per-entry validator body for manifest URL fields. Each entry must:
 *
 * - Parse as a `https:` URL (no `http:`, `file:`, custom schemes).
 * - Contain no `*` substring (wildcards are rejected so a tightly-bound
 *   declaration cannot smuggle a permissive value past the manifest gate).
 * - Carry no embedded credentials (no `https://user:pass@host`).
 * - Target a multi-label hostname (at least one `.` after parse). Single-label
 *   intranet hosts are rejected to keep URLs auditable from the manifest.
 * - Not target a private/loopback/link-local address (SSRF mitigation).
 *
 * `fieldLabel` names the offending field in error messages so the same
 * discipline can back both `scopes.network.allowedUrls` and `authors[].url`
 * without leaking a misleading field name into the other's validation errors.
 */
function refinePluginHttpsUrl(value: string, ctx: z.RefinementCtx, fieldLabel: string): void {
  if (value.includes("*")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Wildcard characters are not allowed in ${fieldLabel}: "${value}"`,
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
      message: `${fieldLabel} entry is not a valid URL: "${value}"`,
      params: { errorCode: "scope_url_invalid" },
    });
    return;
  }
  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must use https:// — got "${parsed.protocol}" in "${value}"`,
      params: { errorCode: "scope_url_not_https" },
    });
    return;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entries must not embed credentials: "${value}"`,
      params: { errorCode: "scope_url_has_credentials" },
    });
    return;
  }
  const hostname = parsed.hostname;
  if (isPrivateOrLoopbackHostname(hostname)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} entry targets a private or loopback address: "${value}"`,
      params: { errorCode: "scope_url_private_target" },
    });
    return;
  }
  if (hostname === "" || !hostname.includes(".")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${fieldLabel} hostnames must be multi-label (got "${hostname}" in "${value}")`,
      params: { errorCode: "scope_url_hostname_unqualified" },
    });
    return;
  }
}

/**
 * Per-entry validator for `scopes.network.allowedUrls`. See
 * {@link refinePluginHttpsUrl} for the enforced discipline.
 */
const PluginAllowedUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "scopes.network.allowedUrls");
});

/**
 * Per-entry validator for `authors[].url`. Author homepage links surface as
 * user-clickable buttons in the plugin detail pane, so they carry the same
 * https-only, no-credentials, no-private-host discipline as network scopes
 * (anti-phishing / SSRF) — only the error-message field name differs.
 */
const PluginAuthorUrlSchema = z.string().superRefine((value, ctx) => {
  refinePluginHttpsUrl(value, ctx, "authors[].url");
});

/**
 * A single attribution entry in the plugin manifest's `authors` array. `name`
 * is required; `url`, `email`, and `role` are optional. `strictObject` rejects
 * unknown keys so manifest typos surface loudly.
 */
export const PluginAuthorSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  url: PluginAuthorUrlSchema.optional(),
  email: z.email().optional(),
  role: z.string().trim().min(1).max(50).optional(),
});

/**
 * Matches a dynamic scope token (`${project}` / `${worktree}`) at the start of
 * an `allowedPaths` entry, with an optional `/sub/path` suffix. These expand at
 * call time against the live active project / worktree root (PluginService),
 * letting a plugin scope to "the active worktree" without a hardcoded path.
 */
const ALLOWED_PATH_TOKEN_RE = /^\$\{(?:project|worktree)\}(?:\/.*)?$/;

/**
 * Per-entry validator for `scopes.fs.allowedPaths`. Each entry must be either a
 * literal absolute path or a dynamic scope token (`${project}` / `${worktree}`,
 * optionally with a `/sub/path` suffix), with no `..` segment and no `*` glob —
 * the schema boundary is the load-bearing gate (#4593, #4702), so substring
 * `..` checks are insufficient (segment-by-segment rejection).
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
  const isToken = ALLOWED_PATH_TOKEN_RE.test(value);
  if (!isToken && !path.isAbsolute(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `scopes.fs.allowedPaths entries must be absolute paths or a "\${project}"/"\${worktree}" token: "${value}"`,
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

/**
 * `scopes.fs.allowedPaths` is enforced at runtime: the host-mediated
 * `host.fs` / `host.git` surface realpath-contains every path argument to these
 * roots (PluginService), rejecting traversal and symlink escapes. Entries may be
 * literal absolute paths or `${project}` / `${worktree}` tokens that expand at
 * call time against the live active project / worktree. Independently, every
 * plugin is always granted an implicit per-plugin data root
 * (`~/.daintree/plugin-data/{pluginId}/`) so `allowedPaths` is optional.
 */
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
    // Constrained to the shared safe-id grammar so a declared setting id can
    // always be referenced by a `${settings:id}` token — the MCP supervisor's
    // substitution gate (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) only
    // matches `[a-zA-Z0-9._-]+`, so an id outside that grammar could be declared
    // but never resolved at runtime.
    id: z.string().min(1).regex(SAFE_ID_PATTERN),
    type: z
      .enum(["string", "number", "boolean", "enum", "json", "secret", "path", "directory", "file"])
      .optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    default: z.unknown().optional(),
    scope: z.enum(["user", "project"]).default("user"),
    options: z.array(z.string().min(1)).min(1).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    // Advisory existence check for path/directory/file fields — the form flags a
    // stored path that no longer resolves; it does not gate saving.
    mustExist: z.boolean().optional(),
    // File-extension filter for type: "file" (no leading dot). Non-empty when present.
    extensions: z.array(z.string().min(1)).min(1).optional(),
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
    // `extensions` narrows the native file chooser — it is only meaningful for
    // `type: "file"`. Reject it on every other type at the manifest gate so a
    // misplaced filter surfaces loudly instead of silently doing nothing.
    if (val.extensions !== undefined && effectiveType !== "file") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Setting "extensions" is only valid for type "file"',
        path: ["extensions"],
      });
    }
  })
  .transform((val) => {
    if (val.secret === true && val.type !== "secret") {
      return { ...val, type: "secret" as const };
    }
    return val;
  });

/**
 * Per-array upper bounds for `contributes.*`. A crafted manifest with tens of
 * thousands of entries would otherwise exhaust the registration loops in
 * `PluginService.loadPlugin`. These caps are generous relative to any plausible
 * real plugin — they exist to reject pathological/adversarial manifests, not to
 * constrain legitimate authors. Exported so tests reference the values without
 * magic numbers. Keyed by the stable (canonical) contribution names — the
 * deprecated `experimental_*` aliases are normalized to these before the cap
 * check runs (see `normalizeDeprecatedContributionAliases`).
 */
export const MANIFEST_CONTRIBUTION_CAPS = {
  panels: 50,
  toolbarButtons: 100,
  menuItems: 200,
  keybindings: 200,
  contextMenus: 200,
  commands: 200,
  views: 50,
  mcpServers: 20,
  forgeProviders: 20,
  fileDecorationProviders: 50,
  agents: 50,
  settings: 200,
} as const;

/**
 * Upper bound on the top-level `authors` array. Attribution is metadata, not a
 * registration loop, so the cap is small — generous for any real plugin's
 * credits list while rejecting pathological manifests. Exported so tests
 * reference it without a magic number.
 */
export const MANIFEST_AUTHORS_CAP = 10;

/**
 * Deprecated `contributes` keys promoted to stable names in the 1.0 freeze.
 * Old manifests are still accepted (the value is migrated to the canonical key);
 * `PluginService` surfaces a deprecation warning when an alias is encountered.
 */
export const DEPRECATED_CONTRIBUTION_ALIASES = {
  experimental_views: "views",
  experimental_mcpServers: "mcpServers",
} as const;

/**
 * Normalizes deprecated `contributes` aliases to their canonical names before
 * strict validation, so the frozen schema never carries an `experimental_*`
 * field while old manifests keep parsing. The canonical key wins when both are
 * present; the deprecated key is always stripped so `strictObject` accepts it.
 */
function normalizeDeprecatedContributionAliases(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_CONTRIBUTION_ALIASES)) {
    if (!(deprecated in obj)) {
      continue;
    }
    next ??= { ...obj };
    // Canonical wins when present — an explicit `views: []` is canonical and is
    // NOT overwritten by a deprecated value. Only fall back to the deprecated
    // value when the canonical key is missing (`undefined`/`null`), so a manifest
    // mixing `views: null` with `experimental_views: [...]` recovers gracefully
    // instead of failing on the null.
    if (next[canonical] == null) {
      next[canonical] = next[deprecated];
    }
    delete next[deprecated];
  }
  return next ?? obj;
}

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
      tagline: z.string().trim().min(1).max(120).optional(),
      authors: z.array(PluginAuthorSchema).max(MANIFEST_AUTHORS_CAP).optional(),
      category: z.enum(PLUGIN_CATEGORY_IDS).optional(),
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
      contributes: z.preprocess(
        normalizeDeprecatedContributionAliases,
        z
          .strictObject({
            panels: z
              .array(PanelContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.panels)
              .default([]),
            toolbarButtons: z
              .array(ToolbarButtonContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.toolbarButtons)
              .default([]),
            menuItems: z
              .array(MenuItemContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.menuItems)
              .default([]),
            keybindings: z
              .array(KeybindingContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.keybindings)
              .default([]),
            contextMenus: z
              .array(ContextMenuContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.contextMenus)
              .default([]),
            commands: z
              .array(CommandContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.commands)
              .default([]),
            views: z
              .array(ViewContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.views)
              .default([]),
            mcpServers: z
              .array(McpServerContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.mcpServers)
              .default([]),
            forgeProviders: z
              .array(ForgeProviderContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.forgeProviders)
              .default([]),
            fileDecorationProviders: z
              .array(FileDecorationContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.fileDecorationProviders)
              .default([]),
            agents: z
              .array(AgentContributionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.agents)
              .default([]),
            settings: z
              .array(SettingDefinitionSchema)
              .max(MANIFEST_CONTRIBUTION_CAPS.settings)
              .default([]),
          })
          .default({
            panels: [],
            toolbarButtons: [],
            menuItems: [],
            keybindings: [],
            contextMenus: [],
            commands: [],
            views: [],
            mcpServers: [],
            forgeProviders: [],
            fileDecorationProviders: [],
            agents: [],
            settings: [],
          })
      ),
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

      // Every contributed `actionId` (toolbar buttons, menu items, keybindings,
      // context menus) must resolve to a real, dispatchable action at runtime,
      // else the contribution paints an inert button/binding that silently does
      // nothing when invoked (#10565, #10580). The resolution rules, in order:
      //
      //  1. A built-in flagged `denyPluginDispatch: true` is rejected outright —
      //     the host refuses plugin dispatch for it, so the button is dead even
      //     though the id exists (#10580). This precedes the allowlist check
      //     because these ids ARE in `BUILT_IN_ACTION_ID_SET`.
      //  2. Any other built-in action id resolves.
      //  3. An id in the plugin's own namespace is cross-checked against the
      //     declared `contributes.commands` (namespaced `{name}.{id}` at load).
      //     If commands are declared, an own-namespace id that matches none of
      //     them is a typo for a command that will never exist, so it is rejected
      //     (#10580). If NO commands are declared, the plugin registers actions
      //     imperatively via `host.registerAction` (invisible at parse time), so
      //     any own-namespace id is allowed — the imperative escape hatch.
      //  4. A reference into a foreign namespace can never resolve and is rejected.
      const ownNamespacePrefix = `${manifest.name}.`;
      const declaredCommandActionIds = new Set(
        manifest.contributes.commands.map((cmd) => `${manifest.name}.${cmd.id}`)
      );
      const actionIdContributions = [
        ["toolbarButtons", manifest.contributes.toolbarButtons],
        ["menuItems", manifest.contributes.menuItems],
        ["keybindings", manifest.contributes.keybindings],
        ["contextMenus", manifest.contributes.contextMenus],
      ] as const;
      for (const [arrayName, entries] of actionIdContributions) {
        entries.forEach((entry, index) => {
          const { actionId } = entry;
          const issuePath = ["contributes", arrayName, index, "actionId"] as const;

          if (DENY_PLUGIN_DISPATCH_SET.has(actionId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...issuePath],
              message: `Contributed actionId "${actionId}" is a built-in action closed to plugin dispatch — the host refuses it at runtime, so the contribution can never fire.`,
              params: { errorCode: "action_id_plugin_dispatch_denied" },
            });
            return;
          }

          if (BUILT_IN_ACTION_ID_SET.has(actionId)) {
            return;
          }

          if (actionId.startsWith(ownNamespacePrefix)) {
            // Cross-check own-namespace ids against declared commands only when
            // commands exist; an empty set means the plugin is fully imperative.
            if (declaredCommandActionIds.size > 0 && !declaredCommandActionIds.has(actionId)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...issuePath],
                message: `Contributed actionId "${actionId}" is in this plugin's "${manifest.name}" namespace but matches no entry in contributes.commands — likely a typo for a declared command.`,
                params: { errorCode: "action_id_undeclared_command" },
              });
            }
            return;
          }

          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...issuePath],
            message: `Contributed actionId "${actionId}" does not reference a built-in action or an action in this plugin's "${manifest.name}" namespace — it can never resolve.`,
            params: { errorCode: "action_id_unknown_namespace" },
          });
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
