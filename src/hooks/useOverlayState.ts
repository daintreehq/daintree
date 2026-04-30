import { useEffect, useId } from "react";
import { useUIStore } from "@/store/uiStore";

/**
 * Register a named claim on the viewport while `active` is true. The store
 * tracks claims as a Set keyed by stable IDs so `overlayClaims` can be read
 * to see exactly which features currently own the viewport.
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
 * Backwards-compatible wrapper for callers that do not have a natural stable
 * ID (for example, generic dialog base components that may be rendered
 * multiple times). Each instance gets its own `useId()` so claims from two
 * simultaneous callers never collide.
 *
 * Prefer `useOverlayClaim(id, active)` with a descriptive ID whenever a
 * stable identifier is available — named claims make `overlayClaims`
 * readable from the DevTools console.
 */
export function useOverlayState(isOpen: boolean): void {
  const id = useId();
  useOverlayClaim(id, isOpen);
}
