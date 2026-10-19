import { useEffect, useId } from "react";
import { useUIStore } from "@/store/uiStore";

/**
 * Register a named claim on the viewport while `active` is true. The store
 * tracks claims as an ordered LIFO stack keyed by stable IDs so
 * `overlayStack` can be read to see exactly which features currently own
 * the viewport and which is topmost.
 *
 * Usage:
 * ```tsx
 * function SettingsDialog({ isOpen }: Props) {
 *   useOverlayClaim("settings", isOpen);
 *   return <Dialog open={isOpen}>...</Dialog>;
 * }
 * ```
 *
 * The `id` must be stable across renders — either a hardcoded string or a
 * memoised value. Duplicate registrations of the same ID collapse to a single
 * claim; the claim is released on unmount or when `active` flips false.
 */
export function useOverlayClaim(id: string, active: boolean): void {
  const addOverlayClaim = useUIStore((state) => state.addOverlayClaim);
  const removeOverlayClaim = useUIStore((state) => state.removeOverlayClaim);

  useEffect(() => {
    if (!active) return;
    addOverlayClaim(id);
    return () => {
      removeOverlayClaim(id);
    };
  }, [id, active, addOverlayClaim, removeOverlayClaim]);
}

/**
 * Mirror the open claim count onto `<html data-overlay-claims>`. Claims live
 * only in this store, out of reach of the preload's diagnostics snapshot, and
 * a claim left open is one of the ways a view stops taking clicks. Subscribes
 * outside React so a claim change never re-renders the app root.
 */
export function useOverlayClaimCountMarker(): void {
  useEffect(() => {
    const root = document.documentElement;
    let written = 0;
    const apply = (count: number) => {
      if (count === written) return;
      written = count;
      if (count > 0) root.dataset.overlayClaims = String(count);
      else delete root.dataset.overlayClaims;
    };
    apply(useUIStore.getState().overlayStack.length);
    const unsubscribe = useUIStore.subscribe((state) => apply(state.overlayStack.length));
    return () => {
      unsubscribe();
      delete root.dataset.overlayClaims;
    };
  }, []);
}

/**
 * Backwards-compatible wrapper for callers that do not have a natural stable
 * ID (for example, generic dialog base components that may be rendered
 * multiple times). Each instance gets its own `useId()` so claims from two
 * simultaneous callers never collide.
 *
 * Prefer `useOverlayClaim(id, active)` with a descriptive ID whenever a
 * stable identifier is available — named claims make `overlayStack`
 * readable from the DevTools console.
 */
export function useOverlayState(isOpen: boolean): void {
  const id = useId();
  useOverlayClaim(id, isOpen);
}

/**
 * Returns `true` while the named overlay claim is registered. Returns a
 * primitive so Zustand only re-renders subscribers when this id's open
 * state actually flips.
 */
export function useOverlayOpen(id: string): boolean {
  return useUIStore((state) => state.overlayStack.includes(id));
}

/**
 * Returns the id of the topmost overlay claim, or `undefined` when no
 * overlay is open. Returns a primitive so subscribers only re-render when
 * the topmost id actually changes, not on unrelated stack mutations.
 */
export function useTopmostOverlay(): string | undefined {
  return useUIStore((state) => state.overlayStack.at(-1));
}
