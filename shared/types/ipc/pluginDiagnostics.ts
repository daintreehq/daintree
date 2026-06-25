import type { PluginActionAuditRecord } from "./pluginAudit.js";
import type { PluginInstallSource, PluginLoadError } from "../plugin.js";

/**
 * A single line from a plugin's in-memory log ring buffer, captured via
 * `host.logger.{info,warn,error}`. `message` already folds in any structured
 * `fields` passed to the logger and is capped at the per-line byte budget.
 * Stored already scrubbed: `recordPluginLog` runs `scrubSecrets` before the
 * line enters the buffer, since the buffer is itself an outbound boundary (it
 * feeds the shareable bug report via `buildReportIssueUrl`).
 */
export interface PluginDiagnosticsLogLine {
  /** Wall-clock epoch millis the line was logged. */
  ts: number;
  level: "info" | "warn" | "error";
  /** Rendered log text (message + serialized fields), capped per line. */
  message: string;
}

/**
 * A plugin-action audit record projected for diagnostics export. Drops the
 * privacy-sensitive `argsHash` and `argsPlaintext` fields — neither carries
 * meaning for a maintainer reading a bug report, and `argsPlaintext` could
 * surface redacted-but-still-sensitive payloads outside the audit viewer.
 */
export type PluginDiagnosticsAuditRecord = Omit<
  PluginActionAuditRecord,
  "argsHash" | "argsPlaintext"
>;

/**
 * Per-plugin diagnostics entry. Provenance fields mirror `LoadedPluginInfo`,
 * minus `originalUrl` — that field is documented "Never logged to console"
 * because an install URL can embed auth tokens in its query string, so it is
 * omitted at the type level (omission, not nulling, prevents accidental
 * serialization).
 */
export interface PluginDiagnosticsPluginEntry {
  pluginId: string;
  displayName: string;
  version: string;
  source: PluginInstallSource;
  installedAt: number;
  isBuiltin: boolean;
  devMode: boolean;
  disabled: boolean;
  archiveHash: string | null;
  loadError: PluginLoadError | null;
  logLines: PluginDiagnosticsLogLine[];
  auditRecords: PluginDiagnosticsAuditRecord[];
}

/**
 * Atomic snapshot of all loaded plugins' diagnostics, gathered in one pass via
 * `plugin:get-diagnostics-snapshot`. Consumed by the error-report builder to
 * append a plugin-diagnostics section. `plugins` is empty when no plugins are
 * loaded, in which case the report omits the section entirely.
 */
export interface PluginDiagnosticsSnapshot {
  plugins: PluginDiagnosticsPluginEntry[];
}
