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
 * Comfortable panel width — the size-driven denominator for the automatic
 * column count. A terminal needs ~624-672px for 80 columns and ~780-840px for
 * 100 columns at typical monospace sizes; rich agent TUIs render diffs and
 * tables best at 100-120 columns. ~720-800px gives a comfortable monitoring
 * width plus panel chrome. Pinned at the top of that range so a typical
 * 1080p/1440p grid lands on 2 columns (each panel ≥800px) and only a large
 * display reaches 3 — favoring fewer, larger panels over more, smaller ones.
 *
 * Tunable in one place against the app's actual terminal font size.
 */
export const COMFORTABLE_PANEL_WIDTH_PX = 800;

/**
 * Comfortable panel height — the `gridAutoRows` minimum. Enough for ~24-30
 * terminal rows plus the panel header. Rows stretch to fill spare vertical
 * room (`1fr`) but never shrink below this; once stacked rows exceed the
 * visible grid height, the container scrolls vertically (#8807).
 */
export const COMFORTABLE_PANEL_HEIGHT_PX = 520;

/**
 * Hard upper bound on automatic columns. A 4th column shrinks every panel and
 * pushes the fleet past what a person can scan at a glance: multiple-object
 * tracking and subitizing both cap around 4 items (dropping toward 3 under
 * load), control-room standards (EEMUA 201, ISO 11064-5) cap an operator at a
 * 2x2 quad, and dashboard convention puts the at-a-glance ceiling at 3 tiles
 * per row. Beyond 3 columns' worth of panels, add rows and scroll — don't
 * widen. The explicit `fixed-columns` strategy is the escape hatch for 4+.
 */
export const AUTO_GRID_MAX_COLS = 3;

/**
 * Breakpoint hysteresis buffer. Once the grid widens to N columns it holds N
 * until the container narrows this far past the N-column threshold, so dragging
 * the window across a boundary doesn't thrash the layout (Schmitt trigger).
 */
export const GRID_HYSTERESIS_BUFFER_PX = 80;

/**
 * Grid width assumed on the first paint, before the ResizeObserver reports a
 * real measurement. Sits in the 2-column band so the common case doesn't flash
 * from 1 → 2 columns on mount.
 */
const FALLBACK_GRID_WIDTH_PX = 1680;

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

/** Clamp a raw column count into the automatic layout's [1, AUTO_GRID_MAX_COLS] range. */
function clampAutoCols(cols: number): number {
  return Math.min(AUTO_GRID_MAX_COLS, Math.max(1, cols));
}

/**
 * Pure function to calculate optimal grid columns for automatic layout.
 *
 * Size-driven, not count-driven: the column count comes from how many
 * comfortably-sized panels fit the available container width, hard-capped at
 * `AUTO_GRID_MAX_COLS`. Panel count never adds a column — only width does.
 * Once panels exceed what fits at comfortable size, the grid scrolls
 * vertically (handled by `gridAutoRows` + the scroll container).
 *
 *   columns = clamp(1, floor(containerWidth / COMFORTABLE_PANEL_WIDTH_PX), 3)
 *
 * Design principles:
 * - Spatial permanence: column count tracks the container width, not the fleet
 *   size — hiding the sidebar/assistant widens the grid and adds a column for
 *   free, while opening more panels just adds scrollable rows.
 * - Comfortable panels: each column targets `COMFORTABLE_PANEL_WIDTH_PX`, not a
 *   minimum-readable floor. Favor fewer, larger panels over more, smaller ones.
 * - Predictable: same inputs always produce same outputs.
 *
 * Breakpoint hysteresis: when `previousCols` is supplied (the column count from
 * the prior render), the function holds the wider count until the container
 * narrows `GRID_HYSTERESIS_BUFFER_PX` past the N-column threshold, so dragging
 * the window across a boundary doesn't thrash the layout. Calling without
 * `previousCols` is pure width-driven with no stickiness.
 */
export function getAutoGridCols(
  count: number,
  width: number | null,
  previousCols?: number
): number {
  if (count <= 1) return 1;

  // Non-positive transient widths during layout transitions fall back to a
  // first-paint default in the 2-column band.
  const containerWidth = width && width > 0 ? width : FALLBACK_GRID_WIDTH_PX;

  // Size-driven target: how many comfortable panels fit, capped at the
  // at-a-glance ceiling.
  let targetCols = clampAutoCols(Math.floor(containerWidth / COMFORTABLE_PANEL_WIDTH_PX));

  // Hysteresis: once widened to N columns, hold N until the container narrows a
  // buffer past the N-column threshold (N * COMFORTABLE_PANEL_WIDTH_PX). Walk
  // highest → lowest so a sticky 3 isn't relaxed prematurely by the 2-column
  // check; the first band that still has room wins.
  if (previousCols !== undefined) {
    for (let cols = clampAutoCols(previousCols); cols > targetCols; cols--) {
      if (containerWidth >= cols * COMFORTABLE_PANEL_WIDTH_PX - GRID_HYSTERESIS_BUFFER_PX) {
        targetCols = cols;
        break;
      }
    }
  }

  // Never show more columns than panels (no empty columns).
  return Math.min(targetCols, count);
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

  // 2-pane invariant: prefer a 2x1 layout for exactly 2 panes, avoiding the
  // undesirable 1x2 (vertical stacking) layout. The explicit fixed strategies
  // keep this unconditionally (unchanged — they're a user opt-in). The
  // automatic strategy gates it on width: force 2 columns only when the
  // container can fit two readable panes side by side (≥ MIN_TERMINAL_WIDTH_PX
  // each). On a narrower window it falls through to the size-driven formula,
  // which stacks them into 1 column. `gridWidth === null` (first paint) keeps
  // the 2-column preference.
  if (
    count === 2 &&
    (strategy !== "automatic" || gridWidth === null || gridWidth >= MIN_TERMINAL_WIDTH_PX * 2)
  ) {
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
