import type { TerminalLayoutStrategy } from "@shared/types";

/**
 * Minimum terminal width in pixels for readability.
 * Terminals narrower than this become difficult to read due to line wrapping.
 */
export const MIN_TERMINAL_WIDTH_PX = 380;

/**
 * Minimum terminal height in pixels to prevent "pancake" terminals.
 * Terminals shorter than this make it hard to see enough context.
 */
export const MIN_TERMINAL_HEIGHT_PX = 200;

/**
 * Hard upper limit for grid terminals, regardless of screen size.
 * Even on very large screens, more than this becomes unmanageable.
 */
export const ABSOLUTE_MAX_GRID_TERMINALS = 16;

/**
 * Calculate the maximum number of terminals that can fit in the grid
 * while maintaining readable dimensions.
 *
 * Examples:
 * - 15" laptop (~1200x700 usable): 3 cols × 3 rows = 9 terminals
 * - 27" monitor (~1800x1000 usable): 4 cols × 5 rows = 16 terminals (capped)
 * - 32" monitor (~2200x1200 usable): 5 cols × 6 rows = 16 terminals (capped)
 *
 * @param width - Grid container width in pixels
 * @param height - Grid container height in pixels
 * @returns Maximum number of terminals that fit with readable dimensions
 */
export function getMaxGridCapacity(width: number | null, height: number | null): number {
  if (!width || !height) return ABSOLUTE_MAX_GRID_TERMINALS;

  // Account for grid gap (4px between terminals) and padding (8px total)
  const gap = 4;
  const padding = 8;
  const effectiveWidth = width - padding;
  const effectiveHeight = height - padding;

  // Calculate max columns and rows that fit with readable dimensions
  const maxCols = Math.max(1, Math.floor((effectiveWidth + gap) / (MIN_TERMINAL_WIDTH_PX + gap)));
  const maxRows = Math.max(1, Math.floor((effectiveHeight + gap) / (MIN_TERMINAL_HEIGHT_PX + gap)));

  // Calculate capacity based on readable grid size
  const capacity = maxCols * maxRows;

  // Apply absolute limits
  return Math.min(capacity, ABSOLUTE_MAX_GRID_TERMINALS);
}

/**
 * Pure function to calculate optimal grid columns for automatic layout.
 *
 * Design principles:
 * - Spatial permanence: column count based on viewport width, not terminal count
 * - Progressive density: allow more columns as fleet grows to prevent pancakes
 * - Readable terminals: respect minimum width, prevent both noodles and pancakes
 * - Predictable: same inputs always produce same outputs
 * - Fleet monitoring: optimize for scanning status across multiple agents
 *
 * Column progression (when width permits):
 * - 1 terminal: 1 column
 * - 2-5 terminals: 2 columns (stable for common use, max 3 rows)
 * - 6-11 terminals: 3 columns (prevents pancakes, max 4 rows)
 * - 12+ terminals: 4 columns (high density fleet, max 4 rows)
 */
export function getAutoGridCols(count: number, width: number | null): number {
  if (count <= 1) return 1;

  // Calculate max feasible columns based on minimum terminal width
  const containerWidth = width ?? 800; // Fallback for SSR/initial render
  const maxFeasibleCols = Math.max(1, Math.floor(containerWidth / MIN_TERMINAL_WIDTH_PX));

  // Progressive column caps based on terminal count
  // Goal: keep rows reasonable (2-4) to prevent pancake terminals
  let targetCols: number;
  if (count <= 5) {
    // 2-5 terminals: 2 columns (1-3 rows) - stable for common use
    targetCols = 2;
  } else if (count <= 11) {
    // 6-11 terminals: 3 columns (2-4 rows) - prevents pancakes
    targetCols = 3;
  } else {
    // 12-16 terminals: 4 columns (3-4 rows) - high density fleet
    targetCols = 4;
  }

  // Don't use more columns than we have terminals (no empty columns)
  targetCols = Math.min(targetCols, count);

  // Respect width constraints - never exceed what the viewport can fit
  return Math.min(maxFeasibleCols, targetCols);
}

/**
 * Single source of truth for grid column calculation across all layout strategies.
 * Enforces the 2-pane invariant: exactly 2 panes should ALWAYS be 2x1 layout.
 *
 * This function is used by both TerminalGrid.tsx (for rendering) and
 * useGridNavigation.ts (for keyboard navigation) to ensure consistency.
 */
export function computeGridColumns(
  count: number,
  gridWidth: number | null,
  strategy: TerminalLayoutStrategy,
  value?: number
): number {
  if (count === 0) return 1;

  // 2-pane invariant: always use 2 columns for exactly 2 panes
  // This prevents the undesirable 1x2 (vertical stacking) layout
  if (count === 2) {
    return 2;
  }

  switch (strategy) {
    case "automatic":
      return getAutoGridCols(count, gridWidth);
    case "fixed-rows": {
      const rows = Math.max(1, Math.min(value ?? 3, 10));
      return Math.ceil(count / rows);
    }
    case "fixed-columns":
      return Math.max(1, Math.min(value ?? 2, 10));
    default:
      return getAutoGridCols(count, gridWidth);
  }
}
