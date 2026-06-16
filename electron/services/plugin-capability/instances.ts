import { store } from "../../store.js";
import { PluginCapabilityConsentService } from "./PluginCapabilityConsentService.js";
import { PluginCapabilityConsentStore } from "./PluginCapabilityConsentStore.js";

let consentStoreInstance: PluginCapabilityConsentStore | null = null;
let consentServiceInstance: PluginCapabilityConsentService | null = null;

/**
 * JIT plugin-capability grant store singleton. Wired to the
 * `pluginCapabilityConsent` electron-store slice (plaintext, matching the
 * `pluginMcpConsent` precedent — grants hold no secrets, only a `(pluginId,
 * capability)` pair and a timestamp).
 */
export function getPluginCapabilityConsentStore(): PluginCapabilityConsentStore {
  if (!consentStoreInstance) {
    consentStoreInstance = new PluginCapabilityConsentStore(
      (patch) => {
        const current = (store.get("pluginCapabilityConsent") ?? {}) as Record<string, unknown>;
        store.set("pluginCapabilityConsent", { ...current, ...patch });
      },
      () => (store.get("pluginCapabilityConsent") ?? {}) as Record<string, unknown>
    );
  }
  return consentStoreInstance;
}

/**
 * JIT plugin-capability consent orchestrator singleton. `PluginService` calls
 * `ensureAllowed()` at the top of each gated host API closure. Constructed
 * lazily so a boot path with no capability-gated plugin traffic never allocates
 * it.
 */
export function getPluginCapabilityConsentService(): PluginCapabilityConsentService {
  if (!consentServiceInstance) {
    consentServiceInstance = new PluginCapabilityConsentService(getPluginCapabilityConsentStore());
  }
  return consentServiceInstance;
}

/**
 * Test-only escape hatch — clears persisted grants then drops every singleton so
 * the next call rebuilds them. The persisted clear is what stops a grant pinned
 * in one test from rehydrating into the next via the shared electron-store.
 */
export function _resetPluginCapabilityServicesForTest(): void {
  // clear() flushes an empty grants array to the persisted slice; the flush
  // swallows any write error, so this is safe even in a sandboxed store.
  consentStoreInstance?.clear();
  consentStoreInstance?._resetForTest();
  consentServiceInstance?._resetForTest();
  consentStoreInstance = null;
  consentServiceInstance = null;
}
