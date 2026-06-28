import type {
  PluginMcpConsentDecision,
  PluginMcpConsentReason,
  PluginMcpDangerTier,
} from "../pluginMcpConsent.js";

/**
 * Outcome classification for a single plugin-MCP `tools/call` interception.
 * Mirrors the vocabulary of the outbound MCP audit (`McpAuditResult`) but
 * scoped to the inbound (plugin→host) direction.
 *
 * - `success` — the consent gate approved and the dispatched call returned.
 * - `error` — the consent gate approved but the dispatched call failed.
 * - `rejected` — the user rejected the consent prompt.
 * - `denied` — the consent gate refused without prompting (cap exceeded,
 *   capability missing). The user never saw a dialog.
 * - `timeout` — reserved for a future deadline-bound prompt.
 */
export type PluginMcpAuditResult = "success" | "error" | "rejected" | "denied" | "timeout";

/**
 * Persisted audit record for a single plugin-MCP tool call. Written to a
 * ring buffer in the main process keyed under the `pluginMcpAudit` store
 * slice. **Never persists the raw tool arguments, the raw tool description,
 * or the raw input schema** — only fixed-size SHA-256 hex digests.
 *
 * The `tool_description_sha` and `arg_sha` columns are the issue's
 * forensic-linkage primitives: an operator can correlate "the tool that was
 * approved on 2026-05-28" with "the call that ran at 2026-06-04" without
 * either column leaking attacker-controlled prompt text into the store.
 */
export interface PluginMcpAuditRecord {
  /** Stable record id (UUID). */
  id: string;
  /** Wall-clock epoch millis the call was recorded. */
  ts: number;
  /** Contributing plugin id (`manifest.name`). */
  pluginId: string;
  /** Server id from `contributes.mcpServers[].id`. */
  serverId: string;
  /** Tool name as advertised by the server's `tools/list`. */
  toolName: string;
  /** Host-derived danger classification at call time. */
  dangerTier: PluginMcpDangerTier;
  /** SHA-256 hex of the raw description bytes the host received. */
  tool_description_sha: string;
  /** SHA-256 hex of the normalised `inputSchema` JSON. */
  input_schema_sha: string;
  /** SHA-256 hex of the normalised call arguments. Empty string if the call carried no args. */
  arg_sha: string;
  /** Wall-clock duration of the dispatched call in milliseconds (0 for denied/rejected). */
  durationMs: number;
  /** Dispatch outcome classification. */
  result: PluginMcpAuditResult;
  /** Why a consent prompt was raised, when one was. Absent for D0 + auto-approved pins. */
  consentReason?: PluginMcpConsentReason;
  /** User decision when a prompt was raised. */
  consentDecision?: PluginMcpConsentDecision;
  /** Stable error code on `result === "error" | "denied"`. */
  errorCode?: string;
  /** Schema version for forward-compat. New records carry the current version. */
  schemaVersion: number;
}

/** Renderer-facing audit configuration snapshot. */
export interface PluginMcpAuditConfig {
  enabled: boolean;
  maxRecords: number;
}

export const PLUGIN_MCP_AUDIT_SCHEMA_VERSION = 1;

/** Minimum, maximum, and default values for the configurable ring-buffer cap. */
export const PLUGIN_MCP_AUDIT_MIN_RECORDS = 50;
export const PLUGIN_MCP_AUDIT_MAX_RECORDS = 5000;
export const PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS = 500;

/** Stable error codes recorded on the audit row when consent is refused. */
export const PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED_CODE = "PLUGIN_MCP_CAPABILITY_CAP_EXCEEDED";
export const PLUGIN_MCP_USER_REJECTED_CODE = "PLUGIN_MCP_USER_REJECTED";
export const PLUGIN_MCP_CONSENT_TIMEOUT_CODE = "PLUGIN_MCP_CONSENT_TIMEOUT";
/** Recorded when a `tools/call` is throttled by the per-server rate limiter. */
export const PLUGIN_MCP_RATE_LIMITED_CODE = "PLUGIN_MCP_RATE_LIMITED";
