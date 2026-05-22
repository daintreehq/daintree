import type { PanelLayoutStrategy } from "@shared/types";

// Type alias for backward compatibility
type TerminalLayoutStrategy = PanelLayoutStrategy;

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
 * Hard upper limit retained for legacy callers that fall back to it when grid
 * dimensions are unknown. Layout no longer caps panels at this number — the
 * grid scrolls vertically once panels exceed what fits at the size floors.
 * The real safety ceiling now lives in `panelLimitStore` (hardware-adaptive).
 *
 * @deprecated New code should rely on `panelLimitStore.hardLimit` for blocking
 * panel creation and on `getGridFitMetrics` for layout fit math.
 */
export const ABSOLUTE_MAX_GRID_TERMINALS = 16;

export const GRID_TRANSITION_DURATION_MS = 200;

/**
 * Sidebar width transition duration. Mirrors the `duration-[var(--duration-250)]`
 * value applied in Sidebar.tsx. Used to gate PTY resize propagation so xterm
 * doesn't deliver mid-animation fractional dimensions to the host.
 */
export const SIDEBAR_TRANSITION_MS = 250;
export const SIDEBAR_TOGGLE_LOCK_MS = SIDEBAR_TRANSITION_MS;

export interface GridFitMetrics {
  /** Max columns that fit at MIN_TERMINAL_WIDTH_PX, given the container width. */
  maxCols: number;
  /** Max rows that fit at MIN_TERMINAL_HEIGHT_PX without scrolling. */
  maxRows: number;
  /** Panels that fit on screen at the size floors (maxCols × maxRows). */
  fitCount: number;
}

/**
 * Pure helper describing how many panels fit on screen at the readability
 * floors. Used by the scroll-aware grid layout for column targeting and by
 * the IntersectionObserver pre-warm to size the rootMargin.
 *
 * Returns `null` when grid dimensions are not yet known so callers can pick
 * sensible defaults instead of acting on bogus zero-derived metrics.
 */
export function getGridFitMetrics(
  width: number | null,
  height: number | null
): GridFitMetrics | null {
  if (!width || !height) return null;

  // Account for grid gap (4px between terminals) and padding (8px total)
  const gap = 4;
  const padding = 8;
  const effectiveWidth = width - padding;
  const effectiveHeight = height - padding;

  const maxCols = Math.max(1, Math.floor((effectiveWidth + gap) / (MIN_TERMINAL_WIDTH_PX + gap)));
  const maxRows = Math.max(1, Math.floor((effectiveHeight + gap) / (MIN_TERMINAL_HEIGHT_PX + gap)));
  return { maxCols, maxRows, fitCount: maxCols * maxRows };
}

/**
 * Number of panels that fit in the on-screen grid at the readability floors,
 * before the grid scrolls vertically. Falls back to ABSOLUTE_MAX_GRID_TERMINALS
 * when dimensions are not yet known.
 *
 * Historically used as a hard panel cap; now strictly a fit hint for layout
 * calculations and the scroll-pre-warm margin. Panel creation gates on
 * `panelLimitStore.hardLimit` instead.
 */
export function getMaxGridCapacity(width: number | null, height: number | null): number {
  const fit = getGridFitMetrics(width, height);
  if (!fit) return ABSOLUTE_MAX_GRID_TERMINALS;
  return fit.fitCount;
}

/**
 * Schmitt-trigger boundaries for breakpoint hysteresis. Each entry promotes
 * `from`→`to` columns once `count` reaches `widenAt`, and only relaxes back
 * to `from` once `count` drops to `narrowAt`. The buffer between the two
 * thresholds prevents single-panel toggles from re-flowing the grid.
 */
const HYSTERESIS_BANDS: ReadonlyArray<{
  from: number;
  to: number;
  widenAt: number;
  narrowAt: number;
}> = [
  { from: 2, to: 3, widenAt: 6, narrowAt: 4 },
  { from: 3, to: 4, widenAt: 12, narrowAt: 10 },
  { from: 4, to: 5, widenAt: 20, narrowAt: 17 },
  { from: 5, to: 6, widenAt: 30, narrowAt: 26 },
];

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
 * - 12+ terminals: scales toward a near-square layout up to `maxFeasibleCols`,
 *   so a 20-panel fleet on a wide screen widens to 5 columns instead of
 *   capping at 4 and producing 5 long scrolling rows.
 *
 * Breakpoint hysteresis: when `previousCols` is supplied (the column count from
 * the prior render), the function holds the wider count through a buffer zone
 * — e.g. once at 3 cols (count≥6), it stays at 3 down to count=5 and only
 * narrows back to 2 at count≤4. `maxFeasibleCols` still caps the result so a
 * narrowing viewport always overrides a sticky widen. Calling without
 * `previousCols` preserves the original symmetric behavior.
 */
export function getAutoGridCols(
  count: number,
  width: number | null,
  previousCols?: number
): number {
  if (count <= 1) return 1;

  // Calculate max feasible columns based on minimum terminal width
  // Handle non-positive transient widths during layout transitions
  const containerWidth = width && width > 0 ? width : 800; // Fallback for SSR/initial render and transition frames
  const maxFeasibleCols = Math.max(1, Math.floor(containerWidth / MIN_TERMINAL_WIDTH_PX));

  // Progressive column caps based on terminal count. The scrollable grid no
  // longer hard-caps at 4 columns: for large fleets we widen toward a
  // near-square layout (ceil(sqrt(count))) so vertical scrolling stays
  // shallow and rows stay scannable.
  let targetCols: number;
  if (count <= 5) {
    targetCols = 2;
  } else if (count <= 11) {
    targetCols = 3;
  } else {
    targetCols = Math.max(4, Math.ceil(Math.sqrt(count)));
  }

  // Apply hysteresis: walk every band whose `to` is at or below `previousCols`,
  // hold the highest one whose narrowAt has not yet been reached. Cascading
  // through intermediate bands matters when count drops several tiers at once
  // (e.g. previousCols=4 → count=5 should pass through 3 cols, not jump to 2).
  if (previousCols !== undefined) {
    let stickyCols = targetCols;
    for (const band of HYSTERESIS_BANDS) {
      if (previousCols >= band.to && count > band.narrowAt && band.to > stickyCols) {
        stickyCols = band.to;
      }
    }
    targetCols = stickyCols;
  }

  // Don't use more columns than we have terminals (no empty columns)
  targetCols = Math.min(targetCols, count);

  // Respect width constraints - never exceed what the viewport can fit.
  // This is an unconditional override: a viewport that can't fit the sticky
  // count must narrow regardless of hysteresis.
  return Math.min(maxFeasibleCols, targetCols);
}

/**
 * Single source of truth for grid column calculation across all layout strategies.
 * Enforces the 2-pane invariant: exactly 2 panes should ALWAYS be 2x1 layout.
 *
 * This function is used by both ContentGrid.tsx (for rendering) and
 * useGridNavigation.ts (for keyboard navigation) to ensure consistency.
 */
export function computeGridColumns(
  count: number,
  gridWidth: number | null,
  strategy: TerminalLayoutStrategy,
  value?: number,
  previousCols?: number
): number {
  if (count === 0) return 1;

  // 2-pane invariant: always use 2 columns for exactly 2 panes
  // This prevents the undesirable 1x2 (vertical stacking) layout
  if (count === 2) {
    return 2;
  }

  switch (strategy) {
    case "automatic":
      return getAutoGridCols(count, gridWidth, previousCols);
    case "fixed-rows": {
      const rows = Math.max(1, Math.min(value ?? 3, 10));
      return Math.ceil(count / rows);
    }
    case "fixed-columns":
      return Math.max(1, Math.min(value ?? 2, 10));
    default:
      return getAutoGridCols(count, gridWidth, previousCols);
  }
}
