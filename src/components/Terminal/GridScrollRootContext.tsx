import { createContext, useContext } from "react";

/**
 * Exposes the panel grid's scroll container to descendants — primarily so
 * `TerminalPane` can root its `IntersectionObserver` at the grid (rather than
 * the viewport) when panels are mounted inside the scrollable grid. Panels
 * mounted outside the grid (dock, popout, two-pane split) read `null` and
 * fall back to the viewport root, which is the right default for those
 * surfaces.
 *
 * Held as the element itself (not a ref) so consumers can use it as a stable
 * dependency in effects — switching from `null` → element re-runs the
 * observer effect with the correct root, and the change must trigger that
 * recompute.
 */
export const GridScrollRootContext = createContext<HTMLElement | null>(null);

export function useGridScrollRoot(): HTMLElement | null {
  return useContext(GridScrollRootContext);
}
