import type { ActionSource, ActionDanger } from "../actions.js";

/**
 * Outcome classification for a single audit record.
 *
 * - `success`: the action's `run()` resolved without throwing.
 * - `error`: the action's `run()` threw, the IPC dispatch rejected, or a
 *   file-decoration provider rejected/timed out.
 * - `disabled`: dispatch was rejected because the action's `isEnabled`
 *   predicate returned false.
 * - `restricted`: dispatch or IPC invoke was rejected (e.g. untrusted sender
 *   on `plugin:invoke`, action carries `danger: "restricted"`, or — once
 *   #9231 lands — a required capability grant was denied).
 */
export type PluginActionAuditResult = "success" | "error" | "disabled" | "restricted";

/**
 * What kind of plugin activity this record describes. Absent values default
 * to `"action-dispatch"` so records written before this field existed keep
 * rendering as action dispatches.
 *
 * - `action-dispatch`: a plugin-contributed action dispatched through
 *   `ActionService` (the original record type).
 * - `ipc-invoke`: a `plugin:invoke` IPC call from the renderer. Both success
 *   and failure (`error` / `restricted`) outcomes for a plugin's own
 *   registered handler are recorded at the dispatch boundary (#10517) so a
 *   benign-looking invoke can't run unobserved. Trust-check rejections at the
 *   raw `plugin:invoke` channel (untrusted sender) are also recorded here.
 * - `decoration-failure`: a file-decoration provider rejected or exceeded
 *   the per-provider timeout. Successful settles are never audited.
 */
export type PluginActionAuditRecordType = "action-dispatch" | "ipc-invoke" | "decoration-failure";

/** How a decoration-failure record failed. */
export type DecorationFailureMode = "timeout" | "rejected";

/**
 * Persisted audit record for a single plugin activity event. Written to a
 * ring buffer in the main process for three event types:
 *
 *   1. Plugin-contributed action dispatch through `ActionService`
 *      (`recordType === "action-dispatch"` — the original / default type).
 *   2. Raw `plugin:invoke` IPC failure or trust-check rejection
 *      (`recordType === "ipc-invoke"`).
 *   3. File-decoration provider rejection or timeout
 *      (`recordType === "decoration-failure"`).
 *
 * Privacy by default: `argsHash` is the SHA-256 hex digest of the redacted
 * args summary. Raw args are never persisted unless the developer explicitly
 * opts in via `developerMode.pluginAuditPlaintext`, in which case a redacted
 * plaintext summary is stored in `argsPlaintext`.
 *
 * `source` and `danger` only apply to action-dispatch records and are
 * absent on `ipc-invoke` and `decoration-failure` records.
 */
export interface PluginActionAuditRecord {
  /** Stable record id (UUID). */
  id: string;
  /** Wall-clock epoch millis the event was recorded. */
  ts: number;
  /** Contributing plugin id (`ActionDefinition.pluginId`). */
  pluginId: string;
  /**
   * For `action-dispatch`: the plugin-registered open-union `ActionId`.
   * For `ipc-invoke`: the IPC channel string passed to `plugin:invoke`.
   * For `decoration-failure`: the contribution id of the failing provider.
   */
  actionId: string;
  /**
   * What kind of plugin activity this record describes. Absent on records
   * written before this field existed; the viewer should treat absence as
   * `"action-dispatch"`.
   */
  recordType?: PluginActionAuditRecordType;
  /**
   * Dispatch source — only present on `action-dispatch` records.
   * (user, keybinding, menu, agent, context-menu).
   */
  source?: ActionSource;
  /**
   * Danger classification at dispatch time — only present on
   * `action-dispatch` records.
   */
  danger?: ActionDanger;
  /**
   * SHA-256 hex digest of the JSON-serialized (redacted) args summary.
   * Empty string when the event carried no args, hashing failed, or the
   * args were never validated (e.g. untrusted-sender rejection).
   */
  argsHash: string;
  /**
   * Redacted plaintext JSON of the args. Present only when
   * `developerMode.pluginAuditPlaintext` was enabled at record-write time.
   */
  argsPlaintext?: string;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  /** Event outcome classification. */
  result: PluginActionAuditResult;
  /**
   * Stable correlation id for the assistant turn this event belongs to.
   * Reserved — absent until a renderer-facing turn-id push mechanism exists.
   */
  turnId?: string;
  /**
   * IPC channel name — only present on `ipc-invoke` records. Lets the
   * viewer distinguish the channel string (e.g. `plugin:invoke`) from the
   * caller-supplied channel argument stored in `actionId`.
   */
  channel?: string;
  /**
   * For `decoration-failure` records: the failure mode. `timeout` means
   * the provider exceeded `DECORATION_PROVIDER_TIMEOUT_MS`; `rejected`
   * means the provider's promise rejected.
   */
  failureMode?: DecorationFailureMode;
  /**
   * For `decoration-failure` records: the decoration scope string the
   * provider was queried for (e.g. `"worktree-diff:/r"`).
   */
  scope?: string;
  /**
   * For `decoration-failure` records: the registered contribution id of
   * the failing provider, mirrored from `actionId` for clarity in the
   * viewer when multiple plugins contribute to the same scope.
   */
  contributionId?: string;
  /**
   * Human-readable failure message for `error` records. Mirrors the
   * `errorMessage` field on `ForgeAuditRecord`. Empty string on
   * `restricted` records where there's no underlying exception.
   */
  errorMessage?: string;
  /** Schema version for forward-compat. New records carry the current version. */
  schemaVersion: number;
}

/** Renderer-facing audit configuration snapshot. */
export interface PluginAuditConfig {
  enabled: boolean;
  maxRecords: number;
}

export const PLUGIN_AUDIT_SCHEMA_VERSION = 1;

/** Minimum, maximum, and default values for the configurable ring-buffer cap. */
export const PLUGIN_AUDIT_MIN_RECORDS = 50;
export const PLUGIN_AUDIT_MAX_RECORDS = 5000;
export const PLUGIN_AUDIT_DEFAULT_MAX_RECORDS = 500;
