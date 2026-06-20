import type { PanelLayoutStrategy } from "@shared/types";

// Type alias for backward compatibility
type TerminalLayoutStrategy = PanelLayoutStrategy;

/**
 * Absolute emergency minimum terminal width in pixels. A panel narrower than
 * this is barely usable — agent TUIs wrap and fragment badly. The automatic
 * grid never targets this width; it is only the lower bound for the two-pane
 * split (an intentional focused mode the user can resize) and the CSS
 * `minmax` floor that stops a column track collapsing entirely.
 *
 * The automatic grid targets a measured *readable* width instead — see
 * `READABLE_GRID_MIN_COLS` / `pxForCols`.
 */
export const MIN_TERMINAL_WIDTH_PX = 380;

/**
 * Minimum terminal height in pixels to prevent "pancake" terminals.
 * Terminals shorter than this make it hard to see enough context.
 */
export const MIN_TERMINAL_HEIGHT_PX = 200;

/**
 * @deprecated Superseded by the measured-readability model. The automatic
 * column count is no longer `floor(width / COMFORTABLE_PANEL_WIDTH_PX)` — it is
 * count-driven, gated by how many *measured* readable panels fit. Kept exported
 * only so legacy importers compile; do not use in new code.
 */
export const COMFORTABLE_PANEL_WIDTH_PX = 480;

/**
 * Comfortable panel height — the `gridAutoRows` minimum in non-scroll (quad)
 * mode. Enough for ~24-30 terminal rows plus the panel header. In scroll mode
 * rows are fixed-height (see `computeScrollRowHeight`) so a panel close never
 * resizes every sibling.
 */
export const COMFORTABLE_PANEL_HEIGHT_PX = 520;

/**
 * Hard upper bound on automatic columns. Subitizing and multiple-object
 * tracking both land at ~4 items; the size-driven grid never exceeds it, so a
 * very wide display tops out at a 4-column scan surface rather than sprawling
 * further. The explicit `fixed-columns` strategy is the escape hatch for more.
 */
export const AUTO_GRID_MAX_COLS = 4;

/**
 * Breakpoint hysteresis buffer. Once the grid widens to N columns it holds N
 * until the container narrows this far past the N-column width requirement, so
 * dragging the window across a boundary doesn't thrash the layout (Schmitt
 * trigger). Applied to *measured* panel width, not a fixed pixel band.
 */
export const GRID_HYSTERESIS_BUFFER_PX = 80;

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
/**
 * Dead-man TTL for the resize-suppression lock armed on a sidebar/assistant
 * width transition. Pegged to the 250ms sidebar transition. The assistant slide
 * (#10704) is asymmetric — 200ms enter / 120ms exit — so its longest leg (200ms)
 * is conservatively covered by this 250ms lock; no separate assistant TTL needed.
 */
export const SIDEBAR_TOGGLE_LOCK_MS = SIDEBAR_TRANSITION_MS;

// ---------------------------------------------------------------------------
// Measured-readability model
//
// A terminal panel is a text grid with chrome around it, not a card. Panel
// sizing is therefore derived from terminal character-cell geometry, not
// arbitrary pixel constants. The column count comes from a predictable,
// count-driven progression — but the grid refuses to make agent terminals
// unreadable to satisfy that progression. "Count-driven feel inside a measured
// readability envelope."
// ---------------------------------------------------------------------------

/** Column-width tiers, in terminal character columns. */
export const ABSOLUTE_MIN_COLS = 50; // emergency lower bound (two-pane split)
export const READABLE_GRID_MIN_COLS = 80; // default automatic-grid lower bound
export const COMPACT_GRID_MIN_COLS = 64; // automatic-grid lower bound, compact density
export const AGENT_WIDE_COLS = 120; // desirable when space allows
export const MAX_USEFUL_COLS = 160; // beyond this, lines are too long to scan

/** Row-height tiers, in terminal text rows. */
export const READABLE_MIN_ROWS = 24;
export const TARGET_GRID_ROWS = 32;
export const MAX_SCROLL_ROWS = 40;

/** Grid chrome geometry (pixels). */
export const GRID_GAP_PX = 4;
export const GRID_PADDING_PX = 8;
export const GRID_SCROLLBAR_PX = 14;
export const GRID_PEEK_PX = 96;

/**
 * Measured geometry of a single terminal panel, sourced from the live xterm
 * instance where possible (see the cell-metrics plumbing) and falling back to
 * `DEFAULT_TERMINAL_METRICS` before a measurement lands.
 */
export interface TerminalMetrics {
  /** Width of one monospace character cell, px. */
  cellWidth: number;
  /** Height of one text row, px. */
  cellHeight: number;
  /** Panel header bar height, px. */
  headerHeight: number;
  /** Total horizontal panel padding (both sides), px. */
  paddingX: number;
  /** Total vertical panel padding (top + bottom), px. */
  paddingY: number;
  /** Width allowance for the terminal's own (inner) scrollbar, px. */
  scrollbarWidth: number;
  /** Total horizontal border allowance, px. */
  borderX: number;
  /** Total vertical border allowance, px. */
  borderY: number;
}

/**
 * Conservative defaults for a ~14px monospace terminal font, used until a real
 * xterm measurement is threaded in. Slightly generous so the grid does not
 * promise more columns than the rendered panels can actually display readably.
 */
export const DEFAULT_TERMINAL_METRICS: TerminalMetrics = {
  cellWidth: 8.4,
  cellHeight: 18,
  headerHeight: 34,
  paddingX: 16,
  paddingY: 8,
  scrollbarWidth: 10,
  borderX: 2,
  borderY: 2,
};

/** Automatic-grid density. `comfortable` is the default; `compact` is opt-in. */
export type GridDensity = "comfortable" | "compact";

/** Pixel width a panel needs to render `cols` readable character columns. */
export function pxForCols(
  cols: number,
  metrics: TerminalMetrics = DEFAULT_TERMINAL_METRICS
): number {
  return Math.ceil(
    cols * metrics.cellWidth + metrics.paddingX + metrics.scrollbarWidth + metrics.borderX
  );
}

/** Pixel height a panel needs to render `rows` text rows plus its header. */
export function pxForRows(
  rows: number,
  metrics: TerminalMetrics = DEFAULT_TERMINAL_METRICS
): number {
  return Math.ceil(
    rows * metrics.cellHeight + metrics.headerHeight + metrics.paddingY + metrics.borderY
  );
}

/**
 * Greatest number of columns that fit `width`, given a per-panel minimum
 * width, accounting for grid padding and inter-panel gaps. Always >= 1.
 */
export function maxFeasibleCols(width: number, minPanelWidth: number): number {
  if (!(width > 0) || !(minPanelWidth > 0)) return 1;
  const effective = width - GRID_PADDING_PX;
  return Math.max(1, Math.floor((effective + GRID_GAP_PX) / (minPanelWidth + GRID_GAP_PX)));
}

/**
 * The automatic grid packs panels toward a *reasonably small* minimum so it
 * fits as many as possible on screen before it ever scrolls. These are the
 * floors panels shrink down to — not a comfortable target.
 *   - 60 columns: a terminal stays monitorable well below the 80-column
 *     "comfortable" width. 60 keeps agent output legible while letting a wide
 *     display carry 3-4 columns.
 *   - 16 rows: enough to watch an agent's recent activity. Small on purpose so
 *     a tall display packs several rows in before the grid has to scroll.
 */
export const GRID_MIN_PANEL_COLS = 60;
export const GRID_MIN_PANEL_ROWS = 16;

/**
 * Breakpoint hysteresis (Schmitt trigger). `target` is the freshly computed
 * width-feasible column count; `previous` is the last committed count.
 *
 * Smooths width-driven thrash near a column breakpoint: the wider previous
 * count is held until the container narrows `GRID_HYSTERESIS_BUFFER_PX` past
 * that count's feasibility boundary. The held count is always capped by
 * `countCeiling` — the current panel count's column ceiling — so it can never
 * leave empty columns or outlive a panel close that lowers the ceiling. A
 * panel *open* right at a width boundary may hold one extra column for a
 * render; that stays within the readability buffer and is intentional.
 */
export function applyHysteresis(
  target: number,
  previous: number | undefined,
  width: number | null,
  minPanelWidth: number,
  countCeiling: number
): number {
  if (!width || width <= 0 || previous === undefined) return target;
  if (previous <= target) return target;
  // Holding a wider count is only valid if the current panel count still
  // justifies it — otherwise a close would leave empty columns.
  const held = Math.min(previous, countCeiling);
  if (held <= target) return target;
  // Mirror `maxFeasibleCols`' nth-column boundary exactly — n panels plus
  // (n-1) gaps plus the grid padding — then hold `held` until the container
  // narrows the full buffer past it. Omitting the padding term silently
  // widened the effective buffer by `GRID_PADDING_PX`.
  const downgradeThreshold =
    held * minPanelWidth + (held - 1) * GRID_GAP_PX + GRID_PADDING_PX - GRID_HYSTERESIS_BUFFER_PX;
  return width >= downgradeThreshold ? held : target;
}

/**
 * The automatic grid's column count. Size-driven: as many columns as fit the
 * container at the small `GRID_MIN_PANEL_COLS` floor, capped at
 * `AUTO_GRID_MAX_COLS` and never more than the panel count.
 *
 * A wide display therefore carries 3-4 columns; a typical laptop 1-2. Panels
 * stretch to fill the column track when there is room and shrink toward the
 * floor as more open — the grid fits as much as it can across before it has
 * to add scrolling rows.
 *
 * `previousCols` enables width hysteresis (see `applyHysteresis`).
 * `width === null` (first paint) assumes the count-justified shape fits.
 */
export function computeAutomaticGridCols({
  count,
  width,
  previousCols,
  metrics = DEFAULT_TERMINAL_METRICS,
  density = "comfortable",
}: {
  count: number;
  width: number | null;
  previousCols?: number;
  metrics?: TerminalMetrics;
  density?: GridDensity;
}): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;

  // Compact density packs to a tighter floor; comfortable uses the standard one.
  const minCols = density === "compact" ? ABSOLUTE_MIN_COLS : GRID_MIN_PANEL_COLS;
  const minPanelWidth = pxForCols(minCols, metrics);

  // No empty columns, and never past the at-a-glance ceiling.
  const countCeiling = Math.min(count, AUTO_GRID_MAX_COLS);

  // Width gate: how many minimum-width panels fit across. First paint (no
  // measurement yet) assumes the count-justified shape fits.
  const feasible = width && width > 0 ? maxFeasibleCols(width, minPanelWidth) : countCeiling;

  const target = Math.min(countCeiling, feasible);
  return applyHysteresis(target, previousCols, width, minPanelWidth, countCeiling);
}

/**
 * Whether `rows` rows of panels overflow the visible grid height even at the
 * `GRID_MIN_PANEL_ROWS` floor. Until they do, the grid fits everything on
 * screen (rows stretch to fill); once they do, it scrolls. This is the only
 * thing that puts the grid into scroll mode — panel count never does.
 */
export function gridRowsOverflow(
  rows: number,
  containerHeight: number | null,
  metrics: TerminalMetrics = DEFAULT_TERMINAL_METRICS
): boolean {
  if (rows <= 1) return false;
  if (!containerHeight || containerHeight <= 0) return false;
  const minRow = pxForRows(GRID_MIN_PANEL_ROWS, metrics);
  const needed = rows * minRow + (rows - 1) * GRID_GAP_PX + GRID_PADDING_PX;
  return needed > containerHeight;
}

/**
 * Row height (px) for scroll mode. The grid only scrolls once even
 * minimum-height rows overflow the viewport, so scroll rows sit at — or just
 * above — the `GRID_MIN_PANEL_ROWS` floor: the rows that fit are divided
 * evenly so they fill the viewport with no wasted strip. The height depends
 * only on the viewport, never the panel count, so closing a panel in scroll
 * mode never resizes the survivors.
 */
export function computeScrollRowHeight(
  containerHeight: number | null,
  metrics: TerminalMetrics = DEFAULT_TERMINAL_METRICS
): number {
  const minRow = pxForRows(GRID_MIN_PANEL_ROWS, metrics);
  if (!containerHeight || containerHeight <= 0) return minRow;
  const usable = containerHeight - GRID_PADDING_PX;
  const visibleRows = Math.max(1, Math.floor((usable + GRID_GAP_PX) / (minRow + GRID_GAP_PX)));
  return Math.max(minRow, Math.floor((usable - (visibleRows - 1) * GRID_GAP_PX) / visibleRows));
}

/** Layout mode for a given panel count: 1 → single, 2 → split, 3+ → grid. */
export function getPanelLayoutMode(count: number): "single" | "split" | "grid" {
  if (count <= 1) return "single";
  if (count === 2) return "split";
  return "grid";
}

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

  const gap = GRID_GAP_PX;
  const padding = GRID_PADDING_PX;
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
 */
export function getMaxGridCapacity(width: number | null, height: number | null): number {
  const fit = getGridFitMetrics(width, height);
  if (!fit) return ABSOLUTE_MAX_GRID_TERMINALS;
  return fit.fitCount;
}

/**
 * Automatic-layout column count. Thin back-compat wrapper over
 * `computeAutomaticGridCols` — keeps the historical `(count, width,
 * previousCols)` signature for existing callers while the count-driven
 * readability model does the real work. Pass `opts` to thread measured
 * terminal metrics or a compact density.
 */
export function getAutoGridCols(
  count: number,
  width: number | null,
  previousCols?: number,
  opts?: { metrics?: TerminalMetrics; density?: GridDensity }
): number {
  if (count <= 1) return 1;
  return computeAutomaticGridCols({
    count,
    width,
    previousCols,
    metrics: opts?.metrics,
    density: opts?.density,
  });
}

/**
 * Single source of truth for grid column calculation across all layout
 * strategies. Enforces the 2-pane invariant (exactly 2 panes → 2 columns when
 * they fit side by side).
 *
 * Called only by `useContentGridContext.tsx` (rendering). `useGridNavigation`
 * reads the computed result through `gridLayoutSnapshot` rather than running
 * this function a second time — independent re-derivation drifted from the
 * rendered grid whenever maximize/restore, drag placeholder, or hysteresis
 * state were in flight (#8857).
 */
export function computeGridColumns(
  count: number,
  gridWidth: number | null,
  strategy: TerminalLayoutStrategy,
  value?: number,
  previousCols?: number,
  opts?: { metrics?: TerminalMetrics; density?: GridDensity }
): number {
  if (count === 0) return 1;

  // 2-pane invariant: a 2x1 layout for exactly 2 panes, never a 1x2 stack,
  // whenever the container can fit two absolute-minimum panes side by side.
  // (N=2 normally renders the dedicated split layout rather than the grid;
  // this keeps the grid path correct for the maximize/placeholder edge cases
  // that still route here.)
  if (count === 2) {
    const minTwoPaneWidth = pxForCols(ABSOLUTE_MIN_COLS, opts?.metrics) * 2 + GRID_GAP_PX;
    if (
      strategy !== "automatic" ||
      gridWidth === null ||
      gridWidth <= 0 ||
      gridWidth >= minTwoPaneWidth
    ) {
      return 2;
    }
  }

  switch (strategy) {
    case "automatic":
      return getAutoGridCols(count, gridWidth, previousCols, opts);
    case "fixed-rows": {
      const rows = Math.max(1, Math.min(value ?? 3, 10));
      return Math.ceil(count / rows);
    }
    case "fixed-columns":
      return Math.max(1, Math.min(value ?? 2, 10));
    default:
      return getAutoGridCols(count, gridWidth, previousCols, opts);
  }
}
