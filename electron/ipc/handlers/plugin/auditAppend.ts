import {
  type PluginActionAuditService,
  getPluginActionAuditService,
} from "../../../services/PluginActionAuditService.js";

/**
 * Append an audit record without ever surfacing an audit failure to the
 * caller. Mirrors `forgeAuditService.safeAppend` — a throw from `append()`
 * (corrupt store, disk error) must never swallow the handler's return value
 * or replace the original error. Audit is strictly a side channel; the
 * `#8442` doctrine is that the record is best-effort, not load-bearing.
 */
export function safeAppend(input: Parameters<PluginActionAuditService["append"]>[0]): void {
  try {
    getPluginActionAuditService().append(input);
  } catch (err) {
    console.error("[PluginAudit] Failed to append audit record:", err);
  }
}

/**
 * Cap on attacker-controlled URL strings before they're embedded into an
 * audit `errorMessage`. The origin and path prefix are forensically useful;
 * the rest is log pollution and a vector for stuffing secret-like values
 * into the persistent ring buffer.
 */
export const UNTRUSTED_URL_MAX_CHARS = 200;
