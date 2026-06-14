import { auditRingStore } from "../persistence/auditRingStore.js";
import { store } from "../../store.js";
import { PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/pluginMcpAudit.js";
import { PluginMcpAuditService } from "./PluginMcpAuditService.js";
import { PluginMcpConsentService } from "./PluginMcpConsentService.js";
import { PluginMcpConsentStore } from "./PluginMcpConsentStore.js";
import { PluginMcpRateLimiter } from "./PluginMcpRateLimiter.js";

let auditInstance: PluginMcpAuditService | null = null;
let consentStoreInstance: PluginMcpConsentStore | null = null;
let consentServiceInstance: PluginMcpConsentService | null = null;
let rateLimiterInstance: PluginMcpRateLimiter | null = null;

/**
 * Plugin-MCP inbound audit log singleton. Config flags are wired to the
 * `pluginMcpAudit` electron-store slice (reading via `?? {}` defends against
 * forward-compat replays where an older schema version omits the slice); the
 * ring itself lives in the audit-logs store since migration023. The spread
 * merge keeps a legacy `pluginMcpAudit.auditLog` carryover intact for
 * installs where the migration deferred (audit-logs store not durable).
 */
export function getPluginMcpAuditService(): PluginMcpAuditService {
  if (!auditInstance) {
    auditInstance = new PluginMcpAuditService(
      (patch) => {
        const current = (store.get("pluginMcpAudit") ?? {}) as Record<string, unknown>;
        store.set("pluginMcpAudit", { ...current, ...patch });
      },
      () => (store.get("pluginMcpAudit") ?? {}) as Record<string, unknown>,
      {
        read: () => auditRingStore.readAll("pluginMcpAuditLog"),
        write: (records) =>
          auditRingStore.writeAll(
            "pluginMcpAuditLog",
            records,
            PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS
          ),
      }
    );
  }
  return auditInstance;
}

/**
 * Plugin-MCP TOFU consent pin store singleton. Wired to the
 * `pluginMcpConsent` electron-store slice.
 */
export function getPluginMcpConsentStore(): PluginMcpConsentStore {
  if (!consentStoreInstance) {
    consentStoreInstance = new PluginMcpConsentStore(
      (patch) => {
        const current = (store.get("pluginMcpConsent") ?? {}) as Record<string, unknown>;
        store.set("pluginMcpConsent", { ...current, ...patch });
      },
      () => (store.get("pluginMcpConsent") ?? {}) as Record<string, unknown>
    );
  }
  return consentStoreInstance;
}

/**
 * Plugin-MCP consent orchestrator singleton. Wraps the pin store and is the
 * supervisor's (#9233) entry point — `authorizeToolCall()` is called before
 * every `client.callTool()` and gates dispatch on the user's decision. Until
 * the supervisor lands the service has no callers; the singleton is
 * constructed lazily so an unused boot path doesn't allocate it.
 */
export function getPluginMcpConsentService(): PluginMcpConsentService {
  if (!consentServiceInstance) {
    consentServiceInstance = new PluginMcpConsentService(getPluginMcpConsentStore());
  }
  return consentServiceInstance;
}

/**
 * Plugin-MCP per-server `tools/call` rate limiter singleton. Throttles dispatch
 * before consent so a runaway model loop can't spam approval prompts or the
 * supervised subprocess. Constructed lazily — an install with no plugin-MCP
 * traffic never allocates it.
 */
export function getPluginMcpRateLimiter(): PluginMcpRateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new PluginMcpRateLimiter();
  }
  return rateLimiterInstance;
}

/** Test-only escape hatch — drops every singleton so the next call rebuilds them. */
export function _resetPluginMcpServicesForTest(): void {
  auditInstance?._resetForTest();
  consentStoreInstance?._resetForTest();
  rateLimiterInstance?._resetForTest();
  auditInstance = null;
  consentStoreInstance = null;
  consentServiceInstance = null;
  rateLimiterInstance = null;
}
