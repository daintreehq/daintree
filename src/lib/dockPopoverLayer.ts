import { useSyncExternalStore } from "react";

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
 * Publishing is `useDockPopoverLayerSync`'s job (one caller, in `AppLayout`);
 * everything else reads.
 */
let dockPopoverOpen = false;
const listeners = new Set<() => void>();

export function setDockPopoverOpen(next: boolean): void {
  if (next === dockPopoverOpen) return;
  dockPopoverOpen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDockPopoverOpen(): boolean {
  return dockPopoverOpen;
}

export function useDockPopoverOpen(): boolean {
  // Server snapshot returns the same getter: there is no SSR here, and a
  // constant `false` would only mask a mistake.
  return useSyncExternalStore(subscribe, getDockPopoverOpen, getDockPopoverOpen);
}

export function _resetForTests(): void {
  dockPopoverOpen = false;
  listeners.clear();
}
