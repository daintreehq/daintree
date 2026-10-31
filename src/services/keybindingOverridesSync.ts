import { keybindingService, type KeybindingService } from "@/services/KeybindingService";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

/** Services that were kept in sync before, and may have missed a save since. */
const attachedBefore = new WeakSet<KeybindingService>();

/**
 * Keeps this view's keyboard map on what this machine saved (#15579).
 * Overrides are device-owned, so every view on this machine hears a save,
 * a cached view and a view of another host included, and a cached view reads
 * them again when it comes back in case it was frozen while one went out.
 *
 * The first attach needs no read: `app:boot` is sent in the same synchronous
 * evaluation that reaches it, so no push Main sends after reading the boot
 * payload can be dispatched before the listener exists. One attached again
 * after a dispose reads, since saves made in between were never heard.
 */
export function initKeybindingOverridesSync(
  service: KeybindingService = keybindingService
): () => void {
  const bridge = typeof window === "undefined" ? undefined : window.electron?.keybinding;
  if (!bridge || typeof bridge.onOverridesChanged !== "function") return () => {};

  let disposed = false;
  const offChange = bridge.onOverridesChanged((snapshot) => {
    if (!disposed) service.receiveOverridesSnapshot(snapshot);
  });
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "active" && !disposed) void service.loadOverrides();
  });
  if (attachedBefore.has(service)) void service.loadOverrides();
  attachedBefore.add(service);

  return () => {
    disposed = true;
    offChange();
    offLifecycle();
  };
}
