import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether a dock popover is currently on screen, as a layering signal for
 * dialogs.
 *
 * A dock popover renders at tier 70, above the standard modal tier, so *any*
 * dialog that opens while one is up paints underneath it while still trapping
 * focus (#11505). The surfaces that can do this are not a list worth
 * maintaining — every terminal carries an artifact overlay, an input bar, a
 * context menu and a settings entry point, each reaching further dialogs, and
 * a dialog opened by some unrelated route is just as buried. So the decision
 * lives in `AppDialog` once, and every dialog inherits it.
 *
 * A module-level store rather than context: `AppDialog` is a `components/ui`
 * primitive and must not reach into the panel, worktree and help stores the
 * derivation needs, and its render sites have no single ancestor to hang a
 * provider on. Mirrors `dialogEscapeBackstop`'s shape. Per-view module state is
 * per-view state — each project view is its own V8 context with its own dock.
 *
 * Several popovers publish independently — the docked panel's and each status
 * pill's (#13081) — so each holds its own registration and the signal is up
 * while any of them is. A shared boolean would let one popover closing clear
 * another that is still on screen.
 */
const registrations = new Set<symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Marks a popover as on screen until the returned release is called. */
export function registerDockPopoverLayer(): () => void {
  const token = Symbol("dock-popover");
  registrations.add(token);
  if (registrations.size === 1) notify();
  return () => {
    if (!registrations.delete(token)) return;
    if (registrations.size === 0) notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDockPopoverOpen(): boolean {
  return registrations.size > 0;
}

export function useDockPopoverOpen(): boolean {
  // Server snapshot returns the same getter: there is no SSR here, and a
  // constant `false` would only mask a mistake.
  return useSyncExternalStore(subscribe, getDockPopoverOpen, getDockPopoverOpen);
}

/**
 * Holds a registration while `open`. Released on close and on unmount, so a
 * popover whose host goes away without closing never strands the signal.
 */
export function useDockPopoverLayer(open: boolean): void {
  useEffect(() => (open ? registerDockPopoverLayer() : undefined), [open]);
}

export function _resetForTests(): void {
  registrations.clear();
  listeners.clear();
}
