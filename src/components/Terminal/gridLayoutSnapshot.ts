// Module-level snapshot of the current grid layout (column counts + item
// count). Two consumers read this imperatively rather than via React props:
//
// - `GridPanel.handleToggleMaximize` needs `gridCols`/`gridItemCount` at click
//   time; reactive props would churn `GridPanel`'s prop identity on every
//   sibling add/remove and defeat its `React.memo`.
// - `useGridNavigation` needs the *authoritative* `gridCols`/`fleetGridCols`
//   at render-memo time. Computing them independently drifted from
//   `useContentGridContext` whenever maximize/restore, drag placeholder, or
//   hysteresis state were in flight (#8857).
//
// A module-level singleton is safe here because there is exactly one content
// grid per renderer: each project gets its own `WebContentsView` with an
// independent V8 context (see `ProjectViewManager`), so this module — and its
// snapshot — is never shared across grids.

export interface GridLayoutSnapshot {
  gridCols: number;
  gridItemCount: number;
  fleetGridCols: number;
}

let snapshot: GridLayoutSnapshot = { gridCols: 1, gridItemCount: 0, fleetGridCols: 1 };
const listeners = new Set<() => void>();

export function setGridLayoutSnapshot(next: GridLayoutSnapshot): void {
  if (
    snapshot.gridCols === next.gridCols &&
    snapshot.gridItemCount === next.gridItemCount &&
    snapshot.fleetGridCols === next.fleetGridCols
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getGridLayoutSnapshot(): GridLayoutSnapshot {
  return snapshot;
}

// `useGridNavigation` subscribes via `useSyncExternalStore` so a column-count
// change driven by a pure resize (no store state change) still triggers a
// re-render of the navigation hook — otherwise the post-resize keypress would
// step through a stale row/column model.
export function subscribeGridLayoutSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
