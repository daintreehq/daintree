/**
 * Audit records for the plugin IPC surface. Two host paths that previously
 * failed silently now write here: the raw `plugin:invoke` `ipcMain.handle`
 * (every outcome — success, untrusted-sender rejection, and dispatch throw)
 * and per-provider failures in `plugin:file-decorations-get` (timeout and
 * rejection only — successful settles run at render-tree-change frequency
 * and are deliberately not recorded). Extends the audit-even-when-silenced
 * doctrine from #8442 to the plugin host.
 *
 * The shape mirrors `McpAuditRecord` structurally but is scoped to plugin
 * invocations rather than MCP tool dispatches. The `source: "plugin"`
 * discriminator narrows cleanly when the broader host-audit union from #9239
 * lands — records narrow on the field's presence, never on a sentinel value.
 */

export type PluginAuditResult = "success" | "error" | "rejected";

export type PluginAuditSeverity = "info" | "warning" | "error" | "critical";

/**
 * Error codes for the audited failure paths. `UNTRUSTED_SENDER` and
 * `DISPATCH_THREW` come from `plugin:invoke`; `TIMEOUT` and
 * `PROVIDER_REJECTED` from a file-decoration provider.
 */
export type PluginAuditErrorCode =
  | "UNTRUSTED_SENDER"
  | "DISPATCH_THREW"
  | "TIMEOUT"
  | "PROVIDER_REJECTED";

export const PLUGIN_AUDIT_SCHEMA_VERSION = 1;

export const PLUGIN_AUDIT_DEFAULT_MAX_RECORDS = 200;
export const PLUGIN_AUDIT_MIN_RECORDS = 50;
export const PLUGIN_AUDIT_MAX_RECORDS = 10000;

const SEVERITY_BY_RESULT: Record<PluginAuditResult, PluginAuditSeverity> = {
  success: "info",
  rejected: "error",
  error: "error",
};

const SEVERITY_BY_ERROR_CODE: Partial<Record<PluginAuditErrorCode, PluginAuditSeverity>> = {
  UNTRUSTED_SENDER: "error",
  // A handler that threw is a plugin-author bug surfacing through the host.
  DISPATCH_THREW: "critical",
  TIMEOUT: "warning",
  PROVIDER_REJECTED: "warning",
};

export function computePluginAuditSeverity(
  result: PluginAuditResult,
  errorCode?: string
): PluginAuditSeverity {
  if (errorCode !== undefined && errorCode in SEVERITY_BY_ERROR_CODE) {
    return SEVERITY_BY_ERROR_CODE[errorCode as PluginAuditErrorCode]!;
  }
  return SEVERITY_BY_RESULT[result];
}

export interface PluginAuditRecord {
  id: string;
  timestamp: number;
  /**
   * Discriminator for the forward-compatible host-audit union (#9239).
   * Always `"plugin"` for records written by this surface.
   */
  source: "plugin";
  /** Plugin that owns the invoked channel or the failing decoration provider. */
  pluginId: string;
  /**
   * IPC channel for `plugin:invoke` records; the synthetic
   * `"plugin:file-decorations-get"` channel for decoration-provider failures.
   */
  channel: string;
  /** Forge/decoration contribution id — set only on file-decoration records. */
  contributionId?: string;
  /** Scrubbed decoration scope — set only on file-decoration records. */
  scope?: string;
  /** Redacted, single-level summary of the call args (via `summarizeMcpArgs`). */
  argsSummary: string;
  result: PluginAuditResult;
  errorCode?: PluginAuditErrorCode;
  durationMs: number;
  /** Originating renderer's webContents id — set only on `plugin:invoke` records. */
  webContentsId?: number;
  severity: PluginAuditSeverity;
  /** Schema version for forward-compat. New records always carry the current version. */
  schemaVersion: number;
}
