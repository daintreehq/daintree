import { logWarn } from "@/utils/logger";
import { PLUGIN_VIEW_RESYNC_EVENT } from "@shared/utils/pluginProjectPresence";

const listeners = new Set<() => void>();

/**
 * Called when a remote view's link came back and events from its host may
 * have been lost on the way: state kept from those events should be fetched
 * again. Never fires in a view on this machine.
 */
export function onHostResync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyHostResync(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      logWarn("[HostResync] A listener failed", { error });
    }
  }
  // Plugin views keep state from host pushes too, behind their own SDK copy.
  try {
    globalThis.dispatchEvent?.(new Event(PLUGIN_VIEW_RESYNC_EVENT));
  } catch (error) {
    logWarn("[HostResync] Telling plugin views failed", { error });
  }
}
