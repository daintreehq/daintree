import type { PluginCapability } from "./plugin.js";

/**
 * Danger tier for a plugin-initiated MCP tool call. Mirrors the D0–D3 audit
 * vocabulary documented in CLAUDE.md ("Destructive Action Tiers") and
 * `docs/architecture/destructive-action-safeguards.md`, but classified
 * specifically by the host from the tool's MCP `ToolAnnotations` and the
 * contributing plugin's manifest `capabilities`. The plugin's MCP server
 * cannot self-declare this — annotations are a hint, the host decides.
 *
 * - `D0` — read-only; no consent dialog. The audit log still records the call.
 * - `D1` — local irreversible; one-shot `ConfirmDialog` with verb-noun button.
 * - `D2` — shared-state mutation; `ConfirmDialog` + redacted args preview.
 * - `D3` — catastrophic; reserved. Plugin-MCP cannot reach D3 today (the
 *   `BUILT_IN_PLUGIN_CAPABILITIES` set has no capability gate that promotes
 *   to D3), but the tier is in the union so future capability additions can
 *   slot in without a schema migration.
 */
export type PluginMcpDangerTier = "D0" | "D1" | "D2" | "D3";

/**
 * Pin-store identity for a single plugin-contributed MCP tool. Stable across
 * tool description / schema mutations — the fingerprint changes, the identity
 * does not. Used as the lookup key in `PluginMcpConsentStore`.
 */
export interface PluginMcpToolIdentity {
  /** Contributing plugin id (`manifest.name`). */
  pluginId: string;
  /** Server id from `contributes.mcpServers[].id`. */
  serverId: string;
  /** Tool name as advertised by the server's `tools/list`. */
  toolName: string;
}

/**
 * Cryptographic fingerprint of an MCP tool's exposed surface. Both hashes are
 * SHA-256 hex digests computed by `sha256Hex` (UTF-8 input).
 *
 * - `rawHash` is over the **raw** description bytes the host received — pre
 *   any ANSI/Markdown stripping. It defends against rug-pull payloads hidden
 *   in invisible Unicode, zero-width spaces, or HTML-like sentinel tags
 *   (OWASP MCP03). A change here re-prompts unconditionally — the displayed
 *   description may look identical, but the underlying bytes mutated and the
 *   user must re-approve.
 * - `displayHash` is over the stripped-for-display string. Recorded for
 *   diagnostics — the consent store does not currently key re-prompt decisions
 *   on it. A pure cosmetic edit (whitespace, trailing period) still changes
 *   `rawHash` and re-prompts; that asymmetry is intentional.
 * - `schemaHash` is over the JSON-stringified `inputSchema` with keys sorted
 *   lexicographically (via `stableArgsSha256`'s normaliser). A schema mutation
 *   changes the call surface — re-prompt is mandatory.
 * - `annotationHash` is over the three tier-influencing `ToolAnnotations`
 *   hints (`readOnlyHint`, `destructiveHint`, `openWorldHint`), null-normalised
 *   and key-sorted. A server flipping `readOnlyHint: true` → `destructiveHint:
 *   true` raises the danger tier without touching the description or schema;
 *   folding the triple into the fingerprint forces re-consent on that flip.
 *   Only the three tier-relevant fields are hashed — future SDK annotation
 *   fields must not produce spurious re-prompts. The empty string is a legacy
 *   sentinel (see `PluginMcpConsentStore.normalizeRecord`): records pinned
 *   before this field existed carry `""`, which never matches a real 64-char
 *   digest and therefore re-prompts on the next lookup.
 */
export interface PluginMcpToolFingerprint {
  rawHash: string;
  displayHash: string;
  schemaHash: string;
  annotationHash: string;
}

/**
 * Persisted TOFU consent record. Keyed in the store by the JSON-encoded
 * `[pluginId, serverId, toolName]` tuple (see `PluginMcpConsentStore.makeKey`).
 * JSON encoding is deliberate — a `::`-joined string would let identities with
 * embedded separators collide and inherit another plugin's consent pin.
 */
export interface PluginMcpConsentRecord {
  pluginId: string;
  serverId: string;
  toolName: string;
  fingerprint: PluginMcpToolFingerprint;
  /** Wall-clock epoch millis the pin was minted. */
  approvedAt: number;
}

/**
 * Outcome of a {@link PluginMcpConsentStore.lookup}. Drives the consent
 * service's prompt-or-not branch.
 *
 * - `approved` — fingerprint matches a pinned record; dispatch without prompt.
 * - `first-use` — no pin exists; prompt with the "first time" framing.
 * - `raw-changed` — pin exists but the raw description bytes mutated. Treat as
 *   a potential rug-pull and prompt with the "this tool changed" framing
 *   regardless of whether the displayed text looks the same.
 * - `schema-changed` — pin exists, raw matches, but the input schema mutated.
 *   The call surface changed — re-prompt.
 * - `annotation-changed` — pin exists, raw and schema match, but the
 *   tier-influencing annotation hints (`readOnlyHint` / `destructiveHint` /
 *   `openWorldHint`) mutated. The advertised danger surface changed — re-prompt.
 *   Also fires for legacy pins minted before `annotationHash` existed (their
 *   `""` sentinel never matches a real digest).
 * - `revoked` — the user explicitly revoked this pin; prompt with the
 *   "previously revoked" framing.
 */
export type PluginMcpConsentLookup =
  | { kind: "approved"; pin: PluginMcpConsentRecord }
  | { kind: "first-use" }
  | { kind: "raw-changed"; previousPin: PluginMcpConsentRecord }
  | { kind: "schema-changed"; previousPin: PluginMcpConsentRecord }
  | { kind: "annotation-changed"; previousPin: PluginMcpConsentRecord }
  | { kind: "revoked" };

/**
 * User decision returned by the consent dialog and consumed by the dispatch
 * chain. `rejected` aborts the tool call; `approved-once` runs without
 * pinning; `approved-and-pin` runs and writes the fingerprint into the TOFU
 * store. `timeout` is reserved for a future deadline-bound prompt — today the
 * dialog stays open until the user decides.
 */
export type PluginMcpConsentDecision =
  | "approved-once"
  | "approved-and-pin"
  | "rejected"
  | "timeout";

/**
 * Reason a consent prompt was raised. Surfaces to the dialog title/copy and
 * is recorded on the audit row so the operator can distinguish "first time"
 * from "this tool changed" approvals.
 */
export type PluginMcpConsentReason =
  | "first-use"
  | "raw-changed"
  | "schema-changed"
  | "annotation-changed"
  | "revoked"
  | "explicit-confirm";

/**
 * Display-safe consent prompt pushed from main to the renderer over the typed
 * event bus (`plugin-mcp:consent-request`) when a `tools/call` requires user
 * approval. Every field is renderer-safe: `descriptionDisplay` is ANSI/OSC
 * stripped and `argsSummary` is pre-redacted in main — raw description bytes,
 * raw args, and the input schema never cross this boundary. The renderer
 * enqueues it into the consent dialog FIFO and replies via
 * `plugin-mcp:resolve-consent`, correlated by `requestId`.
 */
export interface PluginMcpConsentRequestEvent {
  /** Correlation id for the matching `plugin-mcp:resolve-consent` reply. */
  requestId: string;
  pluginId: string;
  serverId: string;
  toolName: string;
  /** Human-readable plugin display name (manifest `displayName ?? name`). */
  pluginDisplayName: string;
  /** Tool description, ANSI/OSC stripped, ready to render verbatim. */
  descriptionDisplay: string;
  /** Sanitised, single-level args preview for D2+ tiers. Empty when no args. */
  argsSummary: string;
  dangerTier: PluginMcpDangerTier;
  /** Plugin's manifest `capabilities[]` list — surfaced for transparency. */
  declaredCapabilities: readonly PluginCapability[];
  reason: PluginMcpConsentReason;
}

export const PLUGIN_MCP_CONSENT_SCHEMA_VERSION = 1;
