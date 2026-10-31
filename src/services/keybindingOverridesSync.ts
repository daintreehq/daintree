import { keybindingService, type KeybindingService } from "@/services/KeybindingService";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

/**
 * Keeps this view's keyboard map on what this machine saved (#15579).
 * Overrides are device-owned, so every view on this machine hears a change,
 * a cached view and a view of another host included, and a cached view reads
 * them again when it comes back in case it was frozen while one went out.
 *
 * The boot payload needs no read after it: `app:boot` is sent in the same
 * synchronous evaluation that reaches this subscription, so no push Main sends
 * after reading that payload can be dispatched before the listener exists.
 */
export function initKeybindingOverridesSync(
  service: KeybindingService = keybindingService
): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.keybinding;
  if (!bridge || typeof bridge.onOverridesChanged !== "function") return () => {};

  let disposed = false;
  const offChange = bridge.onOverridesChanged((overrides) => {
    if (!disposed) service.receiveOverridesPush(overrides);
  });
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "active" && !disposed) void service.loadOverrides();
  });

  return () => {
    disposed = true;
    offChange();
    offLifecycle();
  };
}
