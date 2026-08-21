import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { normalizeTerminalGridDimension } from "@shared/types/terminal";
import { getEffectiveScrollbarWidth } from "@/config/xtermConfig";
import { logError, logWarn } from "@/utils/logger";
import type { ManagedTerminal, TerminalResyncOptions } from "./types";
import type { TerminalOutputIngestService } from "./TerminalOutputIngestService";

const START_DEBOUNCING_THRESHOLD = 200;
const RESIZE_DEBOUNCE_MS = 100;
const RESIZE_LOCK_TTL_MS = 5000;
const SETTLED_RESIZE_DELAY_MS = 500;

/**
 * Smallest a container may report on either axis before its pixel box stops
 * counting as layout at all.
 *
 * A box of a few pixels does not fail loudly — `colsForWidth` floors at 2 and
 * `rowsForHeight` at 1, matching FitAddon, so it succeeds at 2x1 and both grids
 * adopt it. A cached pane keeps parsing bytes through that, and xterm re-wraps
 * committed scrollback to two columns on the way; reflow cannot undo it when
 * real layout returns, so the history stays a vertical strip until it scrolls
 * away (#11900). `applyBackgroundWindowResize` produces exactly such a box by
 * scaling every pane's origin against the window content bounds Main forwards
 * on a resize, maximize or full-screen transition — one implausible bound
 * shrinks every cached pane at once.
 *
 * The value is the floor `fit`/`reconcileGeometryFresh` already applied to
 * measured rects — this makes the pixel entry points agree rather than
 * introducing a second policy. It bounds the box, not the grid the box becomes;
 * the column floor in `resizeGridFromCachedCellMetrics` covers that.
 */
export const MIN_VIABLE_RESIZE_PX = 50;

/**
 * FitAddon's own column floor, which `colsForWidth` reproduces. A width that
 * divides to exactly this produced no measurement — the floor absorbed it.
 */
const FIT_MIN_COLS = 2;

/**
 * Whether a pixel box is worth deriving a grid from. Finiteness is checked
 * explicitly because `Infinity >= MIN_VIABLE_RESIZE_PX` is true.
 */
function isViableResizeBox(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_VIABLE_RESIZE_PX &&
    height >= MIN_VIABLE_RESIZE_PX
  );
}

import { exceedsResizeFlushSyncBudget, RESIZE_FLUSH_SYNC_BUDGET_BYTES } from "./resizeFlushBudget";

export { RESIZE_FLUSH_SYNC_BUDGET_BYTES };

/** Narrow structural type for the private xterm.js internals we access. */
interface XtermCoreRenderDimensions {
  _renderService?: {
    dimensions?: {
      css?: {
        cell?: { width?: number; height?: number };
      };
    };
  };
}

/**
 * Returns the CSS pixel dimensions of a single terminal cell.
 *
 * xterm 6.0 has no public cell-dimension API (verified against installed
 * `@xterm/xterm` typings). The only available path is the private
 * `_core._renderService.dimensions.css.cell` property — the same approach
 * `@xterm/addon-fit` 0.11 uses in its `proposeDimensions()` method.
 *
 * Uses a narrow structural type instead of `any` and rejects non-finite,
 * zero, or negative values. Returns `null` on any failure so callers can
 * fall back to FitAddon's proposed dimensions.
 *
 * Upstream tracking: xtermjs/xterm.js#702 (no public API in 6.0).
 * Replace with a public API when one becomes available.
 */
export function getXtermCellDimensions(
  terminal: Terminal
): { width: number; height: number } | null {
  try {
    const core = (terminal as Terminal & { _core?: XtermCoreRenderDimensions })._core;
    const dimensions = core?._renderService?.dimensions?.css?.cell;
    if (
      dimensions &&
      typeof dimensions.width === "number" &&
      typeof dimensions.height === "number" &&
      Number.isFinite(dimensions.width) &&
      Number.isFinite(dimensions.height) &&
      dimensions.width > 0 &&
      dimensions.height > 0
    ) {
      return { width: dimensions.width, height: dimensions.height };
    }
  } catch {
    // Fall through to null — terminal may not be fully initialized
  }
  return null;
}

/** Narrow structural type for the private viewport scroll cache we invalidate. */
interface XtermCoreViewportSync {
  _renderService?: {
    dimensions?: {
      css?: {
        canvas?: { height?: number };
        cell?: { height?: number };
      };
    };
  };
  _viewport?: {
    _latestYDisp?: number;
    queueSync?: (ydisp?: number) => void;
  };
}

/**
 * Drop xterm's cached viewport scroll position so the queued sync re-reads the
 * buffer.
 *
 * `Viewport._sync` skips its corrective `setScrollPosition` whenever the ydisp
 * it is handed equals the cached `_latestYDisp` — and the resize path hands it
 * exactly that cached value, because `bufferService.onResize` calls
 * `queueSync()` with no argument. Once a real scroll has primed the cache to a
 * number, the comparison is identity-true and the DOM stays parked at the
 * pre-resize pixel offset while the buffer's ybase/ydisp have already advanced.
 * The viewport then sits rows above the bottom even though every logical flag
 * still reports "at bottom" (#11709).
 *
 * Clearing the cache makes the pending `_sync` fall through to its
 * `buffer.ydisp` default, which is the same self-healing path an un-primed
 * viewport already takes — and it is xterm's own idiom for an untrustworthy
 * cached position (`Viewport`'s `onBufferActivate` handler does this verbatim).
 *
 * Deliberately NOT an absolute `_core.scrollToBottom(true)`: that runs before
 * the scrollable element has adopted the post-resize dimensions, so its target
 * is clamped to `scrollHeight - height` a row short, and the synchronous scroll
 * event that follows reports a negative delta — which scrolls the terminal off
 * the bottom rather than pinning it there. `_sync` avoids that by setting the
 * dimensions before the position.
 *
 * Upstream tracking: no public API invalidates this cache on resize, and no
 * public path reaches `Viewport.scrollToLine(line, true)`. Drop this when one
 * exists.
 */
function invalidateXtermViewportScrollCache(terminal: Terminal): void {
  try {
    const core = (terminal as Terminal & { _core?: XtermCoreViewportSync })._core;
    const viewport = core?._viewport;
    if (typeof viewport?.queueSync !== "function") return;
    if (!rendererHasAdoptedRowCount(core, terminal.rows)) return;
    viewport._latestYDisp = undefined;
    viewport.queueSync();
  } catch {
    // Private shape absent or changed — the public pin above still stands.
  }
}

/**
 * Whether the renderer's canvas already describes `rows`.
 *
 * A paused renderer — a backgrounded or occluded pane — defers adopting a
 * resize to an idle task, so its canvas height still measures the OLD row
 * count. `_sync` divides that height into the scroll maximum it clamps
 * against, so forcing a sync against a stale one lands the target a row short,
 * and the scroll event that follows reports a negative delta: it would drag
 * the buffer back into scrollback and mark it user-scrolled, which is the
 * failure this whole helper exists to prevent.
 *
 * Skipping leaves a pane that was resized while paused with the same stale
 * cache it has on the unfixed build — no repair, but no new damage either, and
 * nothing re-pins it on reveal (`applyDeferredResize` early-returns once the
 * logical grid already matches, and the watchdog sees no divergence to fix).
 * Repairing that case needs a deferred retry this deliberately does not carry.
 *
 * Half a cell of tolerance separates "adopted" from "stale". Both renderers
 * keep the residue far below it: the DOM renderer derives `css.cell.height` by
 * dividing `css.canvas.height` by the row count, so the two agree exactly, and
 * the WebGL renderer's independent derivation differs only by the sub-pixel
 * rounding in its `Math.round(device / dpr)`. A stale canvas is at least one
 * whole row out.
 */
function rendererHasAdoptedRowCount(
  core: XtermCoreViewportSync | undefined,
  rows: number
): boolean {
  const css = core?._renderService?.dimensions?.css;
  const canvasHeight = css?.canvas?.height;
  const cellHeight = css?.cell?.height;
  if (
    typeof canvasHeight !== "number" ||
    typeof cellHeight !== "number" ||
    !Number.isFinite(canvasHeight) ||
    !Number.isFinite(cellHeight) ||
    cellHeight <= 0
  ) {
    return false;
  }
  return Math.abs(canvasHeight - rows * cellHeight) < cellHeight / 2;
}

/**
 * A container dimension as `FitAddon` sees it: whole CSS pixels, clamped at zero.
 *
 * FitAddon measures through `Math.max(0, parseInt(getComputedStyle(el).width, 10) || 0)`,
 * which TRUNCATES the fractional pixel a CSS grid or flex track almost always
 * produces (846.67px → 846). A ResizeObserver `contentRect` and
 * `getBoundingClientRect()` both report the un-truncated value, so dividing it
 * raw lands a column — or a row — past xterm's own fit on exactly the sizes our
 * layout generates. That is the same post-paint watchdog rewrap this fix exists
 * to remove, one column further out, so normalize to FitAddon's integer view
 * before dividing OR deduping (#11095).
 */
function toFitPx(px: number): number {
  return Number.isFinite(px) ? Math.max(0, Math.trunc(px)) : 0;
}

/**
 * Columns a container of `widthPx` can hold — the manual twin of
 * `FitAddon.proposeDimensions()`.
 *
 * The paths below deliberately compute cols/rows from cached cell metrics rather
 * than calling `proposeDimensions()`, which reads a DOM that may not reflect the
 * ResizeObserver dimensions yet. That is why FitAddon's arithmetic has to be
 * reproduced by hand: it reserves the scrollbar gutter, so a raw
 * `width / cellWidth` settles a couple of columns wider than xterm's own fit and
 * `TerminalReconciliationWatchdog` repairs the difference ~3s later — after the
 * pane has painted, which corrupts cursor-relative inline TUIs (#11095).
 *
 * `Math.max(2, …)` matches FitAddon's floor and absorbs a container narrower
 * than the gutter itself.
 *
 * Clamped here rather than only where the number is applied: a measurement is
 * copied into `latestCols`/`latestRows` AND handed to `resizeTerminal`, and a
 * value that only the latter clamps leaves the target cache describing a grid
 * xterm can never reach — every `terminal.cols === latestCols` convergence
 * check then fails forever (#11641).
 */
function colsForWidth(terminal: Terminal, widthPx: number, cellWidth: number): number {
  const availableWidth = toFitPx(widthPx) - getEffectiveScrollbarWidth(terminal.options);
  return Math.max(FIT_MIN_COLS, normalizeTerminalGridDimension(availableWidth / cellWidth));
}

/**
 * Rows a container of `heightPx` can hold. The scrollbar is never reserved
 * against height — FitAddon subtracts it from width alone. Clamped for the same
 * reason as {@link colsForWidth}.
 */
function rowsForHeight(heightPx: number, cellHeight: number): number {
  return normalizeTerminalGridDimension(toFitPx(heightPx) / cellHeight);
}

/** FitAddon's own measurement, clamped for the same reason {@link colsForWidth} is. */
function normalizeProposal(proposal: { cols: number; rows: number }): {
  cols: number;
  rows: number;
} {
  return {
    cols: normalizeTerminalGridDimension(proposal.cols),
    rows: normalizeTerminalGridDimension(proposal.rows),
  };
}

/**
 * True when a new pixel box cannot change the grid, so the resize is redundant.
 *
 * Deduping on FitAddon's whole-pixel view rather than a `< 1px` tolerance: a
 * sub-pixel jitter that stays inside one pixel genuinely cannot move the grid,
 * but one that CROSSES a pixel boundary can (846.9 → 847.1 shifts FitAddon's
 * truncated width by a pixel, which may cross a cell boundary). The old
 * tolerance swallowed exactly those, stranding xterm a column behind its
 * container until the watchdog repaired it after paint — "redundant" and
 * "stale" are not the same, and only the former is safe to drop (#7762, #11095).
 * Letting a boundary-crosser through is cheap: when the grid really is
 * unchanged, the cols/rows dedup downstream returns before anything mutates.
 */
function isRedundantResize(managed: ManagedTerminal, width: number, height: number): boolean {
  return (
    toFitPx(managed.lastWidth) === toFitPx(width) && toFitPx(managed.lastHeight) === toFitPx(height)
  );
}

export interface ResizeControllerDeps {
  getInstance: (id: string) => ManagedTerminal | undefined;
  dataBuffer: TerminalOutputIngestService;
}

/**
 * How long a main-buffer pane must be write-quiescent before the reveal-path
 * reconcile ({@link TerminalResizeController.reconcileGeometryFresh}) may apply
 * a grid-changing resize. A resize that lands while a main-buffer CLI is still
 * streaming re-wraps its committed scrollback under the app's cursor-relative
 * sticky-region repaint and duplicates/garbles the block (#10863).
 */
export const REVEAL_REWRAP_QUIESCENT_MS = 300;

/**
 * True while the pane is still streaming for re-wrap purposes (#10863). Either
 * signal means streaming: `lastWriteAt` is stamped only when a batch finishes
 * PARSING (the write-buffer callback), so recency alone misses a queued batch
 * that is still parsing — including a pane's very FIRST batch, where
 * `lastWriteAt` is unset entirely; `pendingWrites` covers exactly that
 * in-flight window. The reveal-path quiescence gate and the watchdog's
 * deferred-tick accounting must agree on this predicate, or a deferred
 * reconcile burns geometry-breaker attempts — share it, never inline it.
 */
export function hasStreamingWrites(managed: ManagedTerminal, now: number): boolean {
  return (
    (managed.pendingWrites ?? 0) > 0 ||
    now - (managed.lastWriteAt ?? 0) < REVEAL_REWRAP_QUIESCENT_MS
  );
}

interface SettledResizeRequest {
  timer: number;
  cols: number;
  rows: number;
}

/**
 * A grid derived from cached cell metrics, plus what the caller needs to decide
 * how much of it to commit. `null` from
 * {@link TerminalResizeController.resizeGridFromCachedCellMetrics} means the
 * metrics were unavailable and nothing was computed — it never means "no work",
 * which is what `converged` says.
 */
interface CachedMetricGrid {
  cols: number;
  rows: number;
  /** xterm already holds this grid, so there is no reflow to apply. */
  converged: boolean;
  /** The target cache pointed elsewhere before this call re-pointed it. */
  cacheWasStale: boolean;
}

export class TerminalResizeController {
  private resizeLocks = new Map<string, number>();
  private settledResizeRequests = new Map<string, SettledResizeRequest>();
  private deps: ResizeControllerDeps;

  constructor(deps: ResizeControllerDeps) {
    this.deps = deps;
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    if (locked) {
      const ttl = customTtlMs ?? RESIZE_LOCK_TTL_MS;
      this.resizeLocks.set(id, Date.now() + ttl);
      this.clearSettledTimer(id);
      const managed = this.deps.getInstance(id);
      if (managed) {
        this.clearResizeJob(managed);
      }
    } else {
      this.resizeLocks.delete(id);
      const managed = this.deps.getInstance(id);
      if (managed && managed.pendingBackgroundResize) {
        const { width, height } = managed.pendingBackgroundResize;
        managed.pendingBackgroundResize = undefined;
        this.applyBackgroundResize(id, width, height);
      }
    }
  }

  isResizeLocked(id: string): boolean {
    const expiry = this.resizeLocks.get(id);
    if (!expiry) return false;

    if (Date.now() > expiry) {
      this.resizeLocks.delete(id);
      return false;
    }
    return true;
  }

  fit(id: string): { cols: number; rows: number } | null {
    const managed = this.deps.getInstance(id);
    if (!managed) return null;
    if (this.isResizeLocked(id)) return null;

    if (!managed.hostElement.checkVisibility()) {
      return null;
    }

    const rect = managed.hostElement.getBoundingClientRect();
    if (!isViableResizeBox(rect.width, rect.height)) {
      return null;
    }

    try {
      const proposal = managed.fitAddon.proposeDimensions();
      if (!proposal || proposal.cols <= 1 || proposal.rows <= 1) {
        return null;
      }

      const { cols, rows } = normalizeProposal(proposal);
      const buffer = managed.terminal.buffer.active;
      const wasAtBottom = buffer.viewportY >= buffer.baseY;
      managed.lastWidth = rect.width;
      managed.lastHeight = rect.height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;
      this.clearResizeJob(managed);
      this.clearSettledTimer(id);
      this.applyResize(id, cols, rows);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  flushResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (this.isResizeLocked(id)) return;

    if (managed.resizeJob !== undefined || managed.resizeDebounceTimer !== undefined) {
      this.clearResizeJob(managed);
      this.applyResize(id, managed.latestCols, managed.latestRows);
    }

    const pending = this.takeSettledResize(id);
    if (pending) {
      this.commitSettledResize(id, pending);
    }
  }

  cancelPendingResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (managed) this.clearResizeJob(managed);
    this.clearSettledTimer(id);
  }

  resize(
    id: string,
    width: number,
    height: number,
    options: { immediate?: boolean } = {}
  ): { cols: number; rows: number } | null {
    const managed = this.deps.getInstance(id);
    if (!managed) return null;

    if (this.isResizeLocked(id)) {
      return null;
    }

    // Mirrors applyBackgroundResize's guard, ahead of tier routing, the dedup
    // check and every cache write so both branches below inherit it: a box that
    // is non-finite — or too small to be layout rather than a transient — would
    // otherwise poison the pixel cache and deliver a garbage grid to the PTY
    // (#11900).
    if (!isViableResizeBox(width, height)) {
      return null;
    }

    const currentTier =
      managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED;
    // Take the fallback-free, undeferred path only when the terminal is
    // genuinely hidden (offscreen / content-visibility:hidden). A freshly
    // prewarmed terminal carries a stale lastAppliedTier === BACKGROUND —
    // seeded by prewarmTerminal — until XtermAdapter's applyRendererPolicy
    // effect promotes it, yet by then it may already be attached and visible.
    // Routing a *visible* terminal down that branch would strand it whenever
    // cell metrics are briefly unavailable, since it has no proposeDimensions
    // fallback to recover with. isVisible is set synchronously by
    // setVisible(true) during attach, before the first fit, so it is a reliable
    // discriminator here.
    const isBackgroundUnfocused =
      currentTier === TerminalRefreshTier.BACKGROUND && !managed.isFocused && !managed.isVisible;

    if (isRedundantResize(managed, width, height)) {
      return null;
    }

    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;

    if (isBackgroundUnfocused) {
      // Background-tier path: a ResizeObserver fired while the host element is
      // inside a content-visibility:hidden container. Both paths derive the
      // grid from cached cell metrics first; what differs is the fallback and
      // the cadence. The measured path below falls back to
      // fitAddon.proposeDimensions() when metrics are missing — a DOM read that
      // returns 0x0 for a hidden box — and defers large-buffer work through
      // debounce/idle scheduling. This branch has neither: no fallback (a
      // missing metric bails), and no deferral. The commit itself is the
      // ordinary one: both grids move together, at the PTY cadence this path
      // already used.
      //
      // It did not always: this branch used to send the PTY resize alone and
      // leave xterm for wake reconciliation, on the theory that a paused pane
      // need not pay for a reflow the user cannot see (#7741). Visibility gates
      // paint, never writes — a hidden pane's xterm parses every byte — so the
      // app kept emitting cursor-addressed output sized for the new width into
      // a parser still holding the old grid, and nothing recovered those rows
      // (#11628). This is the same split #11447 closed for backgrounded views.
      const grid = this.resizeGridFromCachedCellMetrics(managed, width, height, wasAtBottom);
      if (!grid) return null;
      if (grid.converged) {
        // xterm is already on this grid, so nothing reflows — but the branch
        // that used to handle this case ran through `applyResize`, which
        // cancels older queued work on the way past. Returning early drops
        // that, so supersede explicitly or a debounce/idle/settled job holding
        // an older box fires later and drags BOTH grids to it (#11095). The
        // same send re-asserts the PTY when the cache ran ahead of the grid:
        // it was told that other target and nothing else here will correct it.
        if (grid.cacheWasStale || this.hasPendingResize(id)) {
          this.clearResizeJob(managed);
          this.sendPtyResize(id, grid.cols, grid.rows);
        }
        return null;
      }
      this.applyResize(id, grid.cols, grid.rows);
      return { cols: grid.cols, rows: grid.rows };
    }

    try {
      // Calculate cols/rows directly from the passed dimensions and cell metrics.
      // xterm.js 6's proposeDimensions() takes no arguments and reads from the DOM,
      // which may not reflect the ResizeObserver dimensions yet. Computing manually
      // avoids stale-DOM mismatches.
      const cellDims = getXtermCellDimensions(managed.terminal);

      if (!cellDims || cellDims.width === 0 || cellDims.height === 0) {
        // Check if fitAddon can produce valid dimensions before mutating state.
        // When the container is zero-sized (e.g. Ubuntu compositor hasn't committed
        // layout yet), proposeDimensions() returns undefined and fit() would be a
        // no-op. Updating lastWidth/lastHeight here would suppress the later
        // corrective resize via the dedup guard above.
        const proposal = managed.fitAddon.proposeDimensions?.();
        if (!proposal || proposal.cols <= 1 || proposal.rows <= 1) {
          return null;
        }

        const { cols, rows } = normalizeProposal(proposal);
        managed.lastWidth = width;
        managed.lastHeight = height;
        managed.latestCols = cols;
        managed.latestRows = rows;
        managed.latestWasAtBottom = wasAtBottom;
        this.clearResizeJob(managed);
        this.clearSettledTimer(id);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      const cols = colsForWidth(managed.terminal, width, cellDims.width);
      const rows = rowsForHeight(height, cellDims.height);

      if (managed.terminal.cols === cols && managed.terminal.rows === rows) {
        // The grid this box wants is the one xterm is already on, so there is no
        // reflow to do — but the caches and any queued job may still describe an
        // OLDER box. `latestCols`/`latestRows` are the deferred-resize target
        // (applyDeferredResize, forceImmediateResize and flushResize all read
        // them), and a debounced/idle job captured the geometry of the box that
        // armed it. A boundary reversal inside the debounce window
        // (672.1px → 671.9px → 672.1px) queues a 72-column resize and then lands
        // here with xterm correctly at 73: letting that job fire would drag xterm
        // AND the PTY down to 72 for a 73-column container — stranding exactly
        // the column the watchdog then repairs after paint (#11095). Re-point the
        // target at the truth, and supersede the stale job.
        managed.latestCols = cols;
        managed.latestRows = rows;
        if (this.hasPendingResize(id)) {
          this.clearResizeJob(managed);
          this.sendPtyResize(id, cols, rows);
        }
        return null;
      }

      managed.lastWidth = width;
      managed.lastHeight = height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;
      // A newer measured target owns geometry immediately, even when its own
      // debounce/idle work has not fired yet. Do not let an older settled timer
      // mutate xterm and the PTY in that gap.
      this.clearSettledTimer(id);

      const bufferLineCount = this.getBufferLineCount(id);

      if (options.immediate || managed.isFocused || bufferLineCount < START_DEBOUNCING_THRESHOLD) {
        this.clearResizeJob(managed);
        this.applyResize(id, cols, rows);
        return { cols, rows };
      }

      if (!managed.isVisible) {
        this.scheduleIdleResize(id, managed);
        return { cols, rows };
      }

      this.debounceResize(id, managed, cols, rows);

      return { cols, rows };
    } catch (error) {
      console.warn(`[TerminalResizeController] Resize failed for ${id}:`, error);
      return null;
    }
  }

  /**
   * Atomic xterm+PTY resize from explicit pixel dimensions. Entry point for
   * backgrounded project views (#10415), whose terminals may still carry
   * `isVisible === true` from before the view was detached. Delivers the PTY
   * resize directly instead of through `sendPtyResize` — the settled-strategy
   * timer would schedule a `terminal.resize()` in a hidden (possibly frozen)
   * renderer, and the burst it coalesces was already debounced in Main. A
   * pending settled timer is cleared since its stale geometry is superseded.
   *
   * Both grids move together (#11443). Resizing the PTY alone leaves the app
   * emitting cursor-addressed output sized for the new width while the parser
   * still holds the old grid, and the renderer keeps writing every byte while
   * the view is cached — so those sequences land on the wrong rows. Nothing
   * recovers them: reflow re-wraps text but cannot undo an erase applied to
   * the wrong line, and the wake-time re-assert of a size the PTY already has
   * dedupes in `TerminalProcess.resize`, so no corrective SIGWINCH ever
   * arrives. This is the same pair `applyDeferredResize` used to run at wake,
   * moved to the moment the geometry actually changes — identical work, off
   * the switch-back critical path, with no window where the grids disagree.
   */
  applyBackgroundResize(
    id: string,
    width: number,
    height: number
  ): { cols: number; rows: number } | null {
    // Above the instance lookup, the alt-buffer exclusion and the resize lock on
    // purpose. Rejecting further down would cancel queued foreground work and
    // overwrite a stashed viable box on the way to dropping this one, so a
    // transient near-zero bound would cost geometry even once it stopped
    // corrupting it (#11900).
    if (!isViableResizeBox(width, height)) {
      return null;
    }
    const managed = this.deps.getInstance(id);
    if (!managed) return null;
    // Choke point for the alt-screen exclusion: a live full-screen TUI paints an
    // absolutely-positioned frame that xterm never reflows, and racing its own
    // SIGWINCH redraw is the #10805/#10632 corruption. Leaving BOTH grids at the
    // stale size keeps them consistent until real layout returns on reattach.
    // Enforced here rather than only at the caller because a resize stashed in
    // `pendingBackgroundResize` while main-buffer is replayed by `lockResize`
    // long after the pane may have entered the alternate screen.
    if (managed.isAltBuffer) {
      managed.pendingBackgroundResize = undefined;
      return null;
    }
    if (this.isResizeLocked(id)) {
      managed.pendingBackgroundResize = { width, height };
      return null;
    }
    const hadPendingResize = this.hasPendingResize(id);
    this.cancelPendingResize(id);
    if (isRedundantResize(managed, width, height)) {
      // A foreground debounce/settled request updates the pixel and grid
      // caches before it commits. If backgrounding then supplies that same
      // box, cancelling the queued work must not discard the resize with it.
      // Commit the cached target rather than asserting it to the PTY alone:
      // `latestCols`/`latestRows` describe the target the cancelled job was
      // going to apply, NOT the grid xterm currently holds, so a bare
      // terminalClient.resize here reproduces the very split this path exists
      // to prevent (#11628). commitResize is a no-op for the xterm half when
      // the grid already matches, so the common case costs nothing.
      if (
        hadPendingResize &&
        Number.isInteger(managed.latestCols) &&
        Number.isInteger(managed.latestRows) &&
        managed.latestCols > 0 &&
        managed.latestRows > 0
      ) {
        this.commitResize(id, managed.latestCols, managed.latestRows);
      }
      return null;
    }
    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const grid = this.resizeGridFromCachedCellMetrics(managed, width, height, wasAtBottom);
    if (!grid) return null;
    if (grid.converged) {
      // Nothing to reflow, but a cache that ran ahead means the PTY was told a
      // different grid — panel spawn sizes it directly, before xterm has ever
      // been fit — and the pixel box is stamped processed on the way out of the
      // helper, so no later resize revisits it. Re-assert the truth to the PTY
      // alone: xterm is already correct, and routing through `sendPtyResize`
      // here would hand a settled-strategy agent's commit to a timer that
      // reflows a hidden, possibly frozen renderer — the delivery this path
      // exists to bypass. Queued work was already cancelled above.
      if (grid.cacheWasStale) {
        terminalClient.resize(id, grid.cols, grid.rows);
      }
      return null;
    }
    this.clearSettledTimer(id);
    // xterm first, then the PTY: the app must never receive SIGWINCH for a
    // grid the parser has not adopted yet.
    this.resizeTerminal(managed, grid.cols, grid.rows);
    terminalClient.resize(id, grid.cols, grid.rows);
    this.pinToBottomAfterResize(managed);
    return { cols: grid.cols, rows: grid.rows };
  }

  // Computes cols/rows from cached cell metrics with no DOM reads — a hidden or
  // detached view has no live layout to measure. Pure computation + state
  // update; the caller owns the commit policy, and the two callers differ in
  // more than timing. `applyBackgroundResize` refuses alt-screen panes, stashes
  // under a resize lock, and commits directly (its burst was already debounced
  // in Main); `resize`'s background-unfocused branch has no such exclusions and
  // goes through `applyResize` to keep the per-agent resize strategy the live
  // ResizeObserver path relies on. What they share is the invariant that
  // matters: whenever either applies a grid, xterm adopts it before the PTY.
  private resizeGridFromCachedCellMetrics(
    managed: ManagedTerminal,
    width: number,
    height: number,
    wasAtBottom: boolean
  ): CachedMetricGrid | null {
    // Both callers reject a sub-viable box earlier, where rejecting costs
    // nothing. Repeated here because this is where a box becomes a grid and
    // reaches the caches — the invariant belongs with the mutation, so a future
    // caller inherits it instead of re-deriving it (#11900).
    if (!isViableResizeBox(width, height)) {
      return null;
    }
    const cellDims = getXtermCellDimensions(managed.terminal);
    if (!cellDims) {
      return null;
    }
    const cols = colsForWidth(managed.terminal, width, cellDims.width);
    const rows = rowsForHeight(height, cellDims.height);
    // The pixel floor is necessary but not sufficient. It is a fixed count of
    // pixels, while the grid those pixels become also depends on the gutter and
    // the cell: at the largest supported font a box sitting exactly on that
    // floor still divides to FIT_MIN_COLS. Landing on the column floor means the
    // arithmetic bottomed out rather than measured a pane, and re-wrapping
    // committed scrollback that narrow is the damage #11900 is about — columns
    // are what reflow rewraps, so this is checked on cols alone.
    //
    // Only these cached-metric paths take it. They have no live layout to sanity
    // check against, and nothing is lost by declining: both grids stay where
    // they are, and the reveal-time `reconcileGeometryFresh` sizes the pane from
    // real bounds. A visible pane keeps its floor grid, which is the honest
    // answer when the container really is that narrow.
    if (cols <= FIT_MIN_COLS) {
      return null;
    }
    // Convergence is a claim about the grid xterm actually holds, never about
    // the target cache. `latestCols`/`latestRows` are written AHEAD of the
    // commit — by `applyResize`'s settled branch, by `sendPtyResize`, and by the
    // PTY-only sizing panel spawn does before xterm has ever been fit — so a box
    // that computes to the cached target proves nothing about the parser. Trust
    // it and a target stranded ahead of the grid (a settled timer dropped by
    // `lockResize`, a spawn-time PTY resize xterm never adopted) reads as
    // "already resolved": this returns null, stamps the pixel box as processed,
    // and `isRedundantResize` then skips that box for good — leaving xterm
    // narrower than the PTY until something forces a full re-measure (#11639).
    // Same distinction `isRedundantResize` and `resize`'s own dedup draw:
    // redundant and stale are not the same, and only redundant is safe to drop
    // (#7762, #11095).
    //
    // A serialized restore never converges. xterm is parked at the snapshot's
    // CAPTURE grid while the payload replays, so `terminal.cols` describes the
    // replay, not the pane; the box has to reach `resizeTerminal` to be recorded
    // into `pendingRestoreGeometry`, which is what the replay normalizes to when
    // it closes. Calling the capture grid "converged" drops the box on the floor
    // AND stamps it redundant — the very stranding above, one layer down
    // (#11552).
    const converged =
      !managed.isSerializedRestoreInProgress &&
      managed.terminal.cols === cols &&
      managed.terminal.rows === rows;
    // Whether the target the PTY was last told differs from the grid xterm
    // holds. Only meaningful alongside `converged`: there is no reflow to apply,
    // but the PTY is still sized for that other target, so a caller that just
    // returns leaves the two halves split.
    const cacheWasStale = managed.latestCols !== cols || managed.latestRows !== rows;

    managed.lastWidth = width;
    managed.lastHeight = height;
    // Re-point the target at the truth either way. Left alone, a stale
    // ahead-of-grid target is what `applyDeferredResize`, `forceImmediateResize`
    // and `TerminalRevealController` push to the PTY later (#11095).
    managed.latestCols = cols;
    managed.latestRows = rows;
    if (!converged) {
      managed.latestWasAtBottom = wasAtBottom;
    }
    return { cols, rows, converged, cacheWasStale };
  }

  /**
   * The single choke point for every renderer-side xterm resize — all five
   * internal callers (fit, deferred resync, fresh reconcile, commit) route
   * here, which is why the serialized-restore gate lives here and nowhere else.
   *
   * While a restore replays, xterm is deliberately parked at the snapshot's
   * capture width so the payload decodes correctly (#11552), and live output is
   * deferred for exactly the same window. Applying a resize now would be
   * undone by the normalization at the end of the replay; worse, the parked
   * width would look like the live grid to whatever ran next. Record the
   * intent instead — TerminalRestoreController drains it when it normalizes.
   * The PTY side is not gated: callers still send the real geometry, so the
   * agent keeps producing output sized for the grid the user can see.
   */
  resizeTerminal(managed: ManagedTerminal, cols: number, rows: number): void {
    // Normalize here and in `terminalClient.resize` with the same function, so
    // xterm and the PTY land on identical dimensions no matter which call site
    // or transport carried them. Clamping per-layer instead is what let the two
    // grids settle at different widths and never reconcile (#11641). Idempotent
    // for the internal callers — the measurement helpers above already clamp, so
    // this only bites geometry handed in from outside the controller.
    const normalizedCols = normalizeTerminalGridDimension(cols);
    const normalizedRows = normalizeTerminalGridDimension(rows);
    if (managed.isSerializedRestoreInProgress) {
      managed.pendingRestoreGeometry = { cols: normalizedCols, rows: normalizedRows };
      return;
    }
    managed.terminal.resize(normalizedCols, normalizedRows);
  }

  /**
   * Re-pin the viewport to the bottom after a resize-completion, mirroring the
   * auto-follow intent {@link commitResize} already enforces. A column-count
   * reflow mutates the buffer's ybase/ydisp deep inside xterm's `Buffer._reflow`
   * without ever firing `terminal.onScroll` (#11316), so the flags this checks
   * stay correct-but-stale and a bottom-following terminal can be left parked a
   * few rows above the bottom — and once off-bottom, new output stops
   * auto-following. Restore the bottom unless the user had deliberately scrolled
   * back. Guarded exactly like `commitResize` (`latestWasAtBottom &&
   * !isUserScrolledBack`); `scrollToBottom` sets ydisp=ybase synchronously, so
   * it is a no-op when already pinned.
   *
   * A ROW-count resize misses in the opposite way (#11709): xterm advances
   * ybase and ydisp together as lines spill into scrollback, so the buffer
   * stays logically pinned and that relative delta is zero, while the DOM keeps
   * its pre-resize scroll offset. The two calls repair different halves and
   * neither subsumes the other: the public one restores follow-bottom whenever
   * the buffer is genuinely off-bottom — a state the invalidation alone would
   * faithfully sync the DOM *to* — and the invalidation restores the DOM when
   * the buffer was pinned all along. The order matters: the public call can
   * emit an `onScroll` that re-primes the very cache being cleared.
   */
  private pinToBottomAfterResize(managed: ManagedTerminal): void {
    if (managed.latestWasAtBottom && !managed.isUserScrolledBack) {
      managed.terminal.scrollToBottom();
      invalidateXtermViewportScrollCache(managed.terminal);
    }
  }

  applyDeferredResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (this.isResizeLocked(id)) return;

    const currentCols = managed.terminal.cols;
    const currentRows = managed.terminal.rows;
    const targetCols = managed.latestCols;
    const targetRows = managed.latestRows;

    if (currentCols === targetCols && currentRows === targetRows) {
      return;
    }

    // #10863 backstop at the choke point: every OUT-OF-BAND deferred resync
    // funnels through here — setVisible, the renderer-policy foreground
    // promotion, and the wake paths — and a grid-changing resize under a
    // still-streaming main-buffer pane re-wraps committed scrollback beneath
    // the CLI's cursor-relative repaint (the assistant boot corruption).
    // Callers can't all be trusted to gate individually, so gate here: arm the
    // reveal-pending obligation and let the reconciliation watchdog run the
    // fresh atomic reconcile once the stream quiesces. The ResizeObserver-
    // driven resize/applyResize flow does not pass through this method and is
    // deliberately untouched (user-visible layout changes must keep flowing).
    if (!managed.isAltBuffer && hasStreamingWrites(managed, Date.now())) {
      managed.revealPendingRepair = true;
      managed.revealPendingGeneration = managed.attachGeneration;
      return;
    }

    // Wake-time atomic resync: bypass the settled-strategy 500ms debounce so
    // xterm and the PTY agree on geometry before the next refresh paints. The
    // settled debounce coalesces rapid drag-resize bursts — wake is a single
    // one-shot correction, splitting it across 500ms would leave xterm sized
    // for the new container while the PTY (and any in-flight agent output)
    // still wraps at the pre-background geometry.
    this.cancelPendingResize(id);
    this.resizeTerminal(managed, targetCols, targetRows);
    terminalClient.resize(id, targetCols, targetRows);
    this.pinToBottomAfterResize(managed);
  }

  /**
   * One-shot, lock-exempt geometry reconciliation for the project-switch reveal
   * path (the garbled-line-flow-on-return fix). Unlike {@link fit}:
   *  - It does NOT consult the resize lock — the reveal is the one legitimate
   *    resize moment during the project-switch suppression window — and it does
   *    NOT clear the shared lock, so ResizeObserver-storm damping survives for
   *    every other resize entry point.
   *  - It resizes xterm AND the PTY atomically in one synchronous step (never
   *    xterm-first-then-PTY), so it is safe for settled-strategy agents: no
   *    500ms split that would jitter Ink TUIs like the Gemini CLI.
   *
   * Unlike {@link applyDeferredResize} it measures FRESH cols/rows from the live
   * DOM box rather than trusting cached latestCols/latestRows — while the view
   * was backgrounded the container can change size without xterm reflowing (the
   * cached dims can equal the now-stale xterm grid), which applyDeferredResize's
   * cache==current early-return would miss.
   *
   * @param options `force: true` skips ONLY the streaming-quiescence gate below
   * (#11638) — the explicit user Redraw path. Every other guard here still
   * applies. Automatic callers must omit it.
   *
   * @returns true once a fresh measurement landed (whether or not a resize was
   * needed); false when the box is not measurable yet (zero/occluded/transitional
   * layout) so the reveal sweep retries on a later frame. The boolean is
   * measurability, NOT convergence — an alt-buffer pane reports true without
   * touching geometry at all, and a serialized restore parks the xterm resize,
   * so no caller may treat it as proof the grid now matches the container.
   */
  reconcileGeometryFresh(id: string, options: TerminalResyncOptions = {}): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    if (!managed.hostElement.checkVisibility()) return false;

    const rect = managed.hostElement.getBoundingClientRect();
    if (!isViableResizeBox(rect.width, rect.height)) return false;

    // Never reflow a live alt-screen TUI here. A full-screen app (OpenCode, and
    // any agent with blockAltScreen disabled) paints an absolutely-positioned
    // frame and emits only cursor-positioned deltas; an out-of-band xterm
    // resize/reflow at this point mangles that frame and races the app's own
    // SIGWINCH redraw — the "settled OpenCode goes weird on click / garbles
    // intermittently" corruption. This one-shot, lock-exempt reconcile was added
    // (#10632) to re-fit main-buffer scrollback that wrapped at the wrong column
    // after a project switch-back; it must not touch the alternate buffer. An
    // alt-screen pane's geometry is reconciled by the ResizeObserver-driven
    // applyResize path and the app's own redraw. Report success so the reveal
    // repaint doesn't treat this as "not paintable yet" and spin in a retry loop.
    if (managed.isAltBuffer) return true;

    // Prefer the fit addon's own DOM measurement so the grid matches exactly
    // what a manual Redraw's fit() would compute; fall back to cell-metric math
    // when the renderer hasn't published proposable dimensions yet.
    let cols: number;
    let rows: number;
    const proposal = managed.fitAddon.proposeDimensions?.();
    if (proposal && proposal.cols > 1 && proposal.rows > 1) {
      ({ cols, rows } = normalizeProposal(proposal));
    } else {
      const cellDims = getXtermCellDimensions(managed.terminal);
      if (!cellDims) return false;
      cols = colsForWidth(managed.terminal, rect.width, cellDims.width);
      rows = rowsForHeight(rect.height, cellDims.height);
    }

    // Never re-wrap a main-buffer pane out from under a CLI that is still
    // streaming (#10863). xterm's resize() reflows committed scrollback while
    // an Ink-style CLI repaints its sticky region with cursor-relative erase
    // math sized for the old grid — a reveal that lands mid-paint duplicates
    // or garbles the block it is painting. Report "not paintable yet" (before
    // touching the dim caches, so applyDeferredResize's cache==current check
    // stays truthful) and let the reveal sweep retry; the reconciliation
    // watchdog picks up a pane that outlasts the sweep at its first quiet
    // tick. A no-drift pass falls through: the PTY re-assert below is
    // dedupe-safe and never re-wraps.
    //
    // `force` (#11638) is the one exemption: an explicit user Redraw. A busy
    // agent repaints its status line several times a second and never opens the
    // 300ms window this gate waits for, so deferring an explicitly-requested
    // repair defers it forever — and the watchdog backstop tests the same
    // predicate, so nothing converges the pane either. The re-wrap hazard the
    // gate protects against is real but it is the AUTOMATIC case; a user who
    // pressed Redraw has already judged the pane broken and accepts a frame of
    // churn to fix it.
    if (
      !options.force &&
      (managed.terminal.cols !== cols || managed.terminal.rows !== rows) &&
      hasStreamingWrites(managed, Date.now())
    ) {
      return false;
    }

    managed.lastWidth = rect.width;
    managed.lastHeight = rect.height;
    managed.latestCols = cols;
    managed.latestRows = rows;

    // Cancel older queued geometry so this one-shot is the final word, then
    // apply atomically: resize xterm only when its grid actually drifted, and
    // always (re)assert the PTY size so the two agree.
    this.cancelPendingResize(id);
    // Drain held ingest bytes at the OUTGOING grid before re-wrapping, the same
    // invariant commitResize enforces at the other choke point. Bytes held by
    // ingest backpressure were emitted for the current grid; parsing them after
    // xterm adopts a new one lands their cursor moves and erases on the wrong
    // rows, which no later reflow can undo. The automatic callers never met
    // this hazard because the streaming gate above already turned them away —
    // a forced resync (#11638) runs precisely when a backlog is most likely,
    // so the flush has to be explicit here.
    let heldBytesFlushed = true;
    if (managed.terminal.cols !== cols || managed.terminal.rows !== rows) {
      heldBytesFlushed = this.flushHeldBytesBeforeResize(id);
      this.resizeTerminal(managed, cols, rows);
    }
    terminalClient.resize(id, cols, rows);
    // An over-budget backlog resumes only AFTER the resize, exactly as
    // commitResize orders it. Resuming first would drain it inline into xterm
    // and then let resize()'s synchronous flushSync keep consuming whatever
    // notifyWriteComplete appends behind it — one unyielding task that defeats
    // the sync-flush budget the over-budget branch exists to enforce.
    if (!heldBytesFlushed) {
      this.deps.dataBuffer.resumeFlush(id);
    }
    this.pinToBottomAfterResize(managed);
    return true;
  }

  applyResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (this.isResizeLocked(id)) {
      return;
    }
    this.cancelPendingResize(id);

    if (this.getResizeStrategy(managed) === "settled") {
      const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);
      if (!flushedHeldBytes) {
        // Keep ingest moving at the still-consistent outgoing grid while the
        // stable target coalesces. commitResize re-checks the queue immediately
        // before the paired xterm/PTY change.
        this.deps.dataBuffer.resumeFlush(id);
      }
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
    } else {
      this.clearSettledTimer(id);
      this.commitResize(id, cols, rows);
    }
  }

  private commitResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed || this.isResizeLocked(id)) return;

    const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);
    this.resizeTerminal(managed, cols, rows);
    terminalClient.resize(id, cols, rows);

    if (!flushedHeldBytes) {
      this.deps.dataBuffer.resumeFlush(id);
    }
    this.pinToBottomAfterResize(managed);
  }

  /**
   * Bounded pre-resize flush. Returns true when held ingest bytes were
   * flushed into xterm (they parse at the outgoing grid inside `resize()`'s
   * flushSync); false when the backlog exceeded
   * {@link RESIZE_FLUSH_SYNC_BUDGET_BYTES} and was left queued — the caller
   * chooses whether to resume it before or after the geometry commit. The reset
   * only runs on the flush path: `resetForTerminal` deletes the queue, so
   * resetting a held backlog would drop output.
   */
  private flushHeldBytesBeforeResize(id: string): boolean {
    const queuedBytes = this.deps.dataBuffer.getQueuedBytes(id);
    if (exceedsResizeFlushSyncBudget(queuedBytes)) {
      logWarn(
        `[TerminalResizeController] ${id}: ${queuedBytes} held ingest bytes exceed the pre-resize flush budget — leaving the backlog queued for watermarked draining`
      );
      return false;
    }
    this.deps.dataBuffer.flushForTerminal(id);
    this.deps.dataBuffer.resetForTerminal(id);
    return true;
  }

  /**
   * True while a resize is queued but not yet applied — a debounce timer, an
   * idle (postTask) job, or a settled-strategy timer. Each carries the geometry
   * of the box that armed it, so a later resize that supersedes them must know
   * they exist.
   */
  hasPendingResize(id: string): boolean {
    const managed = this.deps.getInstance(id);
    return (
      managed?.resizeJob !== undefined ||
      managed?.resizeDebounceTimer !== undefined ||
      this.settledResizeRequests.has(id)
    );
  }

  clearResizeJob(managed: ManagedTerminal): void {
    if (managed.resizeJob !== undefined) {
      managed.resizeJob.abort();
      managed.resizeJob = undefined;
    }
    if (managed.resizeDebounceTimer !== undefined) {
      clearTimeout(managed.resizeDebounceTimer);
      managed.resizeDebounceTimer = undefined;
    }
  }

  clearResizeLock(id: string): void {
    this.resizeLocks.delete(id);
  }

  sendPtyResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) {
      terminalClient.resize(id, cols, rows);
      return;
    }
    if (this.isResizeLocked(id)) return;
    this.cancelPendingResize(id);
    managed.latestCols = cols;
    managed.latestRows = rows;

    if (this.getResizeStrategy(managed) === "settled") {
      this.scheduleSettledResize(id, cols, rows);
    } else {
      this.clearSettledTimer(id);
      terminalClient.resize(id, cols, rows);
    }
  }

  private scheduleSettledResize(id: string, cols: number, rows: number): void {
    this.clearSettledTimer(id);
    const pending: SettledResizeRequest = { timer: 0, cols, rows };
    const timer = globalThis.setTimeout(() => {
      if (this.settledResizeRequests.get(id) !== pending) return;
      this.settledResizeRequests.delete(id);
      this.commitSettledResize(id, pending);
    }, SETTLED_RESIZE_DELAY_MS) as unknown as number;
    pending.timer = timer;
    this.settledResizeRequests.set(id, pending);
  }

  // Every settled request now describes a paired xterm+PTY move. The PTY-only
  // variant this used to branch on existed solely for hidden panes, and those
  // move both grids too since #11628 — leaving the flag in place would keep a
  // state that can no longer be constructed, and invite the split back.
  private commitSettledResize(id: string, pending: SettledResizeRequest): void {
    if (this.isResizeLocked(id)) return;
    this.commitResize(id, pending.cols, pending.rows);
  }

  private takeSettledResize(id: string): SettledResizeRequest | undefined {
    const pending = this.settledResizeRequests.get(id);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.settledResizeRequests.delete(id);
    return pending;
  }

  forceImmediateResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;
    if (this.isResizeLocked(id)) return;

    const cols = managed.latestCols;
    const rows = managed.latestRows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      return;
    }

    this.cancelPendingResize(id);
    terminalClient.resize(id, cols, rows);
  }

  clearSettledTimer(id: string): void {
    this.takeSettledResize(id);
  }

  private getResizeStrategy(managed: ManagedTerminal): "default" | "settled" {
    if (!managed.runtimeAgentId) return "default";
    const config = getEffectiveAgentConfig(managed.runtimeAgentId);
    return config?.capabilities?.resizeStrategy ?? "default";
  }

  private scheduleIdleResize(id: string, managed: ManagedTerminal): void {
    if (managed.resizeJob !== undefined || managed.resizeDebounceTimer !== undefined) return;

    if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
      const controller = new AbortController();
      managed.resizeJob = controller;
      void scheduler
        .postTask(
          () => {
            const current = this.deps.getInstance(id);
            if (current) {
              current.resizeJob = undefined;
              this.applyResize(id, current.latestCols, current.latestRows);
            }
          },
          { priority: "background", signal: controller.signal }
        )
        .catch((e: unknown) => {
          if (e instanceof Error && e.name === "AbortError") return;
          logError(`[TerminalResizeController] scheduleIdleResize failed for ${id}`, e);
        });
    } else {
      const timerId = setTimeout(() => {
        const current = this.deps.getInstance(id);
        if (current) {
          current.resizeDebounceTimer = undefined;
          this.applyResize(id, current.latestCols, current.latestRows);
        }
      }, 0) as unknown as number;
      managed.resizeDebounceTimer = timerId;
    }
  }

  private debounceResize(id: string, managed: ManagedTerminal, cols: number, rows: number): void {
    this.clearResizeJob(managed);

    const timeoutId = setTimeout(() => {
      const current = this.deps.getInstance(id);
      if (current) {
        current.resizeDebounceTimer = undefined;
        // Mirror the applyResize guard: if a new lock landed between the
        // debounce schedule and fire, a fresh layout transition is in flight
        // and we must not write mid-transition. The lock release path will
        // requeue via batchResize when it ends.
        if (this.isResizeLocked(id)) return;
        this.applyResize(id, cols, rows);
      }
    }, RESIZE_DEBOUNCE_MS) as unknown as number;
    managed.resizeDebounceTimer = timeoutId;
  }

  private getBufferLineCount(id: string): number {
    const managed = this.deps.getInstance(id);
    if (!managed) return 0;
    return managed.terminal.buffer.active.length;
  }
}
