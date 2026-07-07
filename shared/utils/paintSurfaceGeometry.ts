import type { SurfaceViewBounds } from "../types/paintFabricSurface.js";

// Geometry checks for view-backed paint surfaces (Phase 1V). A surface view
// owns a rectangular window region exclusively — Electron cannot pass input
// through overlapping transparent views, so overlap means stolen input, not
// blended pixels. Pure and shared: the SurfaceViewManager (main process)
// enforces disjointness at the window boundary, the placement layer
// (renderer) enforces band alignment at claim time.

export function boundsAreValid(bounds: SurfaceViewBounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

export function boundsIntersect(a: SurfaceViewBounds, b: SurfaceViewBounds): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// The bounding box of a set of pane rects: the band a surface view must own
// to paint those panes. Placement stays band-aligned — a terminal is only
// placeable on a view surface whose band contains its pane.
export function boundingBox(rects: SurfaceViewBounds[]): SurfaceViewBounds | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boundsContain(outer: SurfaceViewBounds, inner: SurfaceViewBounds): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

// Returns the ids of already-placed surfaces whose bounds the candidate would
// overlap. Empty result = the candidate may own its rectangle.
export function findBoundsConflicts(
  candidate: SurfaceViewBounds,
  placed: ReadonlyMap<string, SurfaceViewBounds>,
  excludeSurfaceId?: string
): string[] {
  const conflicts: string[] = [];
  for (const [surfaceId, bounds] of placed) {
    if (surfaceId === excludeSurfaceId) continue;
    if (boundsIntersect(candidate, bounds)) conflicts.push(surfaceId);
  }
  return conflicts;
}
