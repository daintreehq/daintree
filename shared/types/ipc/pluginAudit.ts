import type { ActionSource, ActionDanger } from "../actions.js";

/**
 * Outcome classification for a single plugin-contributed action dispatch.
 *
 * - `success`: the action's `run()` resolved without throwing.
 * - `error`: the action's `run()` threw or rejected.
 * - `disabled`: dispatch was rejected because the action's `isEnabled`
 *   predicate returned false.
 * - `restricted`: dispatch was rejected because the action is
 *   `danger: "restricted"`, or (once #9231 lands) a required capability
 *   grant was denied.
 *
 * Today only `success` is emitted — the renderer's `action:dispatched`
 * event fires post-success. The other variants are reserved so the record
 * shape is forward-compatible with failure/denial recording (a follow-up
 * partially gated on the #9231 capability gate).
 */
export type PluginActionAuditResult = "success" | "error" | "disabled" | "restricted";

/**
 * Persisted audit record for a single plugin-action dispatch. Written to a
 * ring buffer in the main process whenever an action contributed by a plugin
 * (`ActionDefinition.pluginId` set) is dispatched through `ActionService`.
 *
 * Privacy by default: `argsHash` is the SHA-256 hex digest of the dispatch
 * args, computed in the renderer before the record crosses IPC. Raw args are
 * never persisted unless the developer explicitly opts in via
 * `developerMode.pluginAuditPlaintext`, in which case a redacted plaintext
 * summary is stored in `argsPlaintext`.
 */
export interface PluginActionAuditRecord {
  /** Stable record id (UUID). */
  id: string;
  /** Wall-clock epoch millis the dispatch was recorded. */
  ts: number;
  /** Contributing plugin id (`ActionDefinition.pluginId`). */
  pluginId: string;
  /** Dispatched action id — a plugin-registered open-union `ActionId`. */
  actionId: string;
  /** Dispatch source (user, keybinding, menu, agent, context-menu). */
  source: ActionSource;
  /** Danger classification of the action at dispatch time. */
  danger: ActionDanger;
  /**
   * SHA-256 hex digest of the JSON-serialized (redacted) dispatch args.
   * Empty string when the dispatch carried no args or hashing failed.
   */
  argsHash: string;
  /**
   * Redacted plaintext JSON of the dispatch args. Present only when
   * `developerMode.pluginAuditPlaintext` was enabled at record-write time.
   */
  argsPlaintext?: string;
  /** Wall-clock duration of the `run()` call in milliseconds. */
  durationMs: number;
  /** Dispatch outcome classification. */
  result: PluginActionAuditResult;
  /**
   * Stable correlation id for the assistant turn this dispatch belongs to.
   * Reserved — absent until a renderer-facing turn-id push mechanism exists.
   */
  turnId?: string;
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
