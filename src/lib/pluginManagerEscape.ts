import { OPEN_ESCAPE_LAYER_SELECTOR } from "@/lib/dialogEscapeBackstop";

/** Stamped on the plugin manager's root while it is open, and only then. */
export const PLUGIN_MANAGER_OPEN_ATTR = "data-plugin-manager-open";

// The Escape already found to belong to a nested layer, so the window-bubble
// dispatcher agrees with the capture-phase decision even after the layer has
// closed and no longer matches. Scoped to one event, never a boolean.
let ownedEscape: KeyboardEvent | null = null;

/**
 * Whether an Escape belongs to a layer open over the plugin manager rather
 * than to the manager. The manager sits on the escape stack, and the global
 * handlers pop the stack before a Radix popover, select or menu sees the key,
 * or before a plugin's drawer does, so without this the manager closed
 * underneath the layer the user was dismissing.
 *
 * A Radix layer counts wherever it is portalled, since it closes on Escape
 * whatever holds focus; one inside an inert subtree is behind the manager and
 * doesn't. A drawer handles Escape only from inside itself, so it counts only
 * when the key came from within it. Modal drawers carry `role="dialog"` and
 * would otherwise match the Radix selector with focus anywhere.
 */
export function nestedLayerOwnsEscape(event: KeyboardEvent): boolean {
  if (event === ownedEscape) return true;
  if (event.key !== "Escape" || typeof document === "undefined") return false;
  const root = document.querySelector(`[${PLUGIN_MANAGER_OPEN_ATTR}]`);
  if (!root) return false;
  const target = event.target instanceof Element ? event.target : null;
  const drawer = target?.closest('[data-drawer-panel][data-state="open"]') ?? null;
  const owned = (drawer !== null && root.contains(drawer)) || hasLiveEscapeLayer();
  if (owned) ownedEscape = event;
  return owned;
}

function hasLiveEscapeLayer(): boolean {
  for (const layer of document.querySelectorAll(OPEN_ESCAPE_LAYER_SELECTOR)) {
    if (layer.closest("[inert], [data-drawer-panel]") === null) return true;
  }
  return false;
}

export function _resetForTests(): void {
  ownedEscape = null;
}
