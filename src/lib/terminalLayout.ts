/**
 * Pure function to calculate optimal grid columns for automatic layout.
 *
 * Design principles:
 * - Rectangular grids: uniform column count per row, accept empty cells
 * - Vertical-first: preserve height for AI log streams
 * - Predictable: deterministic mapping from count to columns
 * - Responsive: single width breakpoint at N=3
 */
export function getAutoGridCols(count: number, width: number | null): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;

  // Width-responsive decision for 3 terminals
  if (count === 3) {
    const w = width ?? 0;
    return w >= 900 ? 3 : 2; // Favor columns: ~300px per terminal
  }

  // Deterministic rectangular layouts
  if (count <= 4) return 2; // 3-4 -> 2 columns (max 2x2)
  if (count <= 6) return 3; // 5-6 -> 3 columns (max 2x3)
  if (count <= 8) return 4; // 7-8 -> 4 columns (max 2x4)
  if (count === 9) return 3; // 9 -> 3x3 (pivot from wide to square)

  // 10+ terminals: 4 columns, rows grow
  return 4;
}
