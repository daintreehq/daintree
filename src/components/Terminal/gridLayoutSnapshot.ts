// Module-level snapshot of the current grid layout (column count + item
// count). `GridPanel.handleToggleMaximize` needs these two values only at
// click time — passing them as reactive props would churn `GridPanel`'s prop
// identity on every sibling add/remove and defeat its `React.memo`. Reading
// them imperatively from this snapshot keeps the props stable.
//
// A module-level singleton is safe here because there is exactly one content
// grid per renderer: each project gets its own `WebContentsView` with an
// independent V8 context (see `ProjectViewManager`), so this module — and its
// snapshot — is never shared across grids.

export interface GridLayoutSnapshot {
  gridCols: number;
  gridItemCount: number;
}

let snapshot: GridLayoutSnapshot = { gridCols: 1, gridItemCount: 0 };

export function setGridLayoutSnapshot(next: GridLayoutSnapshot): void {
  snapshot = next;
}

export function getGridLayoutSnapshot(): GridLayoutSnapshot {
  return snapshot;
}
