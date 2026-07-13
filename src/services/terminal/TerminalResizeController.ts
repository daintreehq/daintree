import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { getEffectiveScrollbarWidth } from "@/config/xtermConfig";
import { logError, logWarn } from "@/utils/logger";
import type { ManagedTerminal } from "./types";
import type { TerminalOutputIngestService } from "./TerminalOutputIngestService";

const START_DEBOUNCING_THRESHOLD = 200;
const RESIZE_DEBOUNCE_MS = 100;
const RESIZE_LOCK_TTL_MS = 5000;
const SETTLED_RESIZE_DELAY_MS = 500;

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
 * fall back to fitAddon.fit().
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
 */
function colsForWidth(terminal: Terminal, widthPx: number, cellWidth: number): number {
  const availableWidth = toFitPx(widthPx) - getEffectiveScrollbarWidth(terminal.options);
  return Math.max(2, Math.floor(availableWidth / cellWidth));
}

/**
 * Rows a container of `heightPx` can hold. The scrollbar is never reserved
 * against height — FitAddon subtracts it from width alone.
 */
function rowsForHeight(heightPx: number, cellHeight: number): number {
  return Math.max(1, Math.floor(toFitPx(heightPx) / cellHeight));
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

export class TerminalResizeController {
  private resizeLocks = new Map<string, number>();
  private settledResizeTimers = new Map<string, number>();
  private deps: ResizeControllerDeps;

  constructor(deps: ResizeControllerDeps) {
    this.deps = deps;
  }

  lockResize(id: string, locked: boolean, customTtlMs?: number): void {
    if (locked) {
      const ttl = customTtlMs ?? RESIZE_LOCK_TTL_MS;
      this.resizeLocks.set(id, Date.now() + ttl);
    } else {
      this.resizeLocks.delete(id);
      const managed = this.deps.getInstance(id);
      if (managed && managed.pendingBackgroundResize) {
        const { width, height } = managed.pendingBackgroundResize;
        managed.pendingBackgroundResize = undefined;
        this.resizePtyOnly(id, width, height);
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
    if (rect.width < 50 || rect.height < 50) {
      return null;
    }

    try {
      managed.fitAddon.fit();
      const { cols, rows } = managed.terminal;
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
      return { cols, rows };
    } catch (error) {
      console.warn("Terminal fit failed:", error);
      return null;
    }
  }

  flushResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (managed.resizeJob !== undefined || managed.resizeDebounceTimer !== undefined) {
      this.clearResizeJob(managed);
      this.applyResize(id, managed.latestCols, managed.latestRows);
    }
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

    // Mirrors resizePtyOnly's guard: a non-finite box would otherwise poison the
    // pixel cache and deliver a garbage grid to the PTY.
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }

    const currentTier =
      managed.lastAppliedTier ?? managed.getRefreshTier?.() ?? TerminalRefreshTier.FOCUSED;
    // Defer the xterm reflow only when the terminal is genuinely hidden
    // (offscreen / content-visibility:hidden). A freshly prewarmed terminal
    // carries a stale lastAppliedTier === BACKGROUND — seeded by
    // prewarmTerminal — until XtermAdapter's applyRendererPolicy effect
    // promotes it, yet by then it may already be attached and visible.
    // Skipping terminal.resize() for a *visible* terminal strands xterm's grid
    // at the 80x24 open() default while the PTY runs at the real size. isVisible
    // is set synchronously by setVisible(true) during attach, before the first
    // fit, so it is a reliable discriminator here.
    const isBackgroundUnfocused =
      currentTier === TerminalRefreshTier.BACKGROUND && !managed.isFocused && !managed.isVisible;

    if (isRedundantResize(managed, width, height)) {
      return null;
    }

    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;

    if (isBackgroundUnfocused) {
      // Background-tier path: a ResizeObserver fired while the host element
      // is inside a content-visibility:hidden container. fitAddon.fit() would
      // read 0x0 from the DOM, so we compute cols/rows from cached cell
      // metrics instead. sendPtyResize() keeps the settled-strategy timer —
      // the renderer is live here, so coalescing drag bursts still applies.
      const dims = this.resizePtyFromCachedCellMetrics(managed, width, height, wasAtBottom);
      if (dims) {
        this.sendPtyResize(id, dims.cols, dims.rows);
      }
      return dims;
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

        managed.fitAddon.fit();
        const cols = managed.terminal.cols;
        const rows = managed.terminal.rows;
        managed.lastWidth = width;
        managed.lastHeight = height;
        managed.latestCols = cols;
        managed.latestRows = rows;
        managed.latestWasAtBottom = wasAtBottom;
        this.sendPtyResize(id, cols, rows);
        if (wasAtBottom && !managed.isUserScrolledBack) {
          managed.terminal.scrollToBottom();
        }
        return { cols, rows };
      }

      const cols = colsForWidth(managed.terminal, width, cellDims.width);
      const rows = rowsForHeight(height, cellDims.height);

      if (managed.terminal.cols === cols && managed.terminal.rows === rows) {
        return null;
      }

      managed.lastWidth = width;
      managed.lastHeight = height;
      managed.latestCols = cols;
      managed.latestRows = rows;
      managed.latestWasAtBottom = wasAtBottom;

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
   * PTY-only resize from explicit pixel dimensions — never reflows xterm.
   * Entry point for backgrounded project views (#10415), whose terminals may
   * still carry `isVisible === true` from before the view was detached and
   * would otherwise take the foreground path's xterm reflow while hidden.
   * Delivers the PTY resize directly instead of through `sendPtyResize` —
   * the settled-strategy timer would schedule a `terminal.resize()` in a
   * hidden (possibly frozen) renderer, and the burst it coalesces was
   * already debounced in Main. A pending settled timer is cleared since its
   * stale geometry is superseded. The deferred xterm reflow is reconciled
   * at wake via `applyDeferredResize`.
   */
  resizePtyOnly(id: string, width: number, height: number): { cols: number; rows: number } | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    const managed = this.deps.getInstance(id);
    if (!managed) return null;
    if (this.isResizeLocked(id)) {
      managed.pendingBackgroundResize = { width, height };
      return null;
    }
    if (isRedundantResize(managed, width, height)) {
      return null;
    }
    const buffer = managed.terminal.buffer.active;
    const wasAtBottom = buffer.viewportY >= buffer.baseY;
    const dims = this.resizePtyFromCachedCellMetrics(managed, width, height, wasAtBottom);
    if (dims) {
      this.clearSettledTimer(id);
      terminalClient.resize(id, dims.cols, dims.rows);
    }
    return dims;
  }

  // Computes cols/rows from cached cell metrics with no DOM reads and
  // deliberately skips terminal.resize() — paint is paused for these
  // terminals, so deferring the buffer reflow to wake time avoids work the
  // user never sees. Pure computation + state update; the caller delivers
  // the PTY resize so each path picks its own strategy handling.
  private resizePtyFromCachedCellMetrics(
    managed: ManagedTerminal,
    width: number,
    height: number,
    wasAtBottom: boolean
  ): { cols: number; rows: number } | null {
    const cellDims = getXtermCellDimensions(managed.terminal);
    if (!cellDims) {
      return null;
    }
    const cols = colsForWidth(managed.terminal, width, cellDims.width);
    const rows = rowsForHeight(height, cellDims.height);
    if (managed.latestCols === cols && managed.latestRows === rows) {
      managed.lastWidth = width;
      managed.lastHeight = height;
      return null;
    }
    managed.lastWidth = width;
    managed.lastHeight = height;
    managed.latestCols = cols;
    managed.latestRows = rows;
    managed.latestWasAtBottom = wasAtBottom;
    return { cols, rows };
  }

  resizeTerminal(managed: ManagedTerminal, cols: number, rows: number): void {
    managed.terminal.resize(cols, rows);
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
    this.clearSettledTimer(id);
    this.resizeTerminal(managed, targetCols, targetRows);
    terminalClient.resize(id, targetCols, targetRows);
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
   * @returns true once a fresh measurement landed (whether or not a resize was
   * needed); false when the box is not measurable yet (zero/occluded/transitional
   * layout) so the reveal sweep retries on a later frame.
   */
  reconcileGeometryFresh(id: string): boolean {
    const managed = this.deps.getInstance(id);
    if (!managed) return false;
    if (!managed.hostElement.checkVisibility()) return false;

    const rect = managed.hostElement.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) return false;

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
      cols = proposal.cols;
      rows = proposal.rows;
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
    if (
      (managed.terminal.cols !== cols || managed.terminal.rows !== rows) &&
      hasStreamingWrites(managed, Date.now())
    ) {
      return false;
    }

    managed.lastWidth = rect.width;
    managed.lastHeight = rect.height;
    managed.latestCols = cols;
    managed.latestRows = rows;

    // Cancel any pending settled (500ms) resize so this one-shot is the final
    // word, then apply atomically: resize xterm only when its grid actually
    // drifted, and always (re)assert the PTY size so the two agree.
    this.clearSettledTimer(id);
    if (managed.terminal.cols !== cols || managed.terminal.rows !== rows) {
      this.resizeTerminal(managed, cols, rows);
    }
    terminalClient.resize(id, cols, rows);
    return true;
  }

  applyResize(id: string, cols: number, rows: number): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    if (this.isResizeLocked(id)) {
      return;
    }

    const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);

    if (this.getResizeStrategy(managed) === "settled") {
      // For settled agents, defer xterm.js resize to fire atomically
      // with the PTY resize inside the settled timer callback.
      // This avoids a 500ms mismatch where xterm.js shows new dimensions
      // while the agent is still rendering at old dimensions.
      managed.latestCols = cols;
      managed.latestRows = rows;
      this.sendPtyResize(id, cols, rows);
    } else {
      this.resizeTerminal(managed, cols, rows);
      this.sendPtyResize(id, cols, rows);
    }

    if (!flushedHeldBytes) {
      this.deps.dataBuffer.resumeFlush(id);
    }

    if (managed.latestWasAtBottom && !managed.isUserScrolledBack) {
      managed.terminal.scrollToBottom();
    }
  }

  /**
   * Bounded pre-resize flush. Returns true when held ingest bytes were
   * flushed into xterm (they parse at the outgoing grid inside `resize()`'s
   * flushSync); false when the backlog exceeded
   * {@link RESIZE_FLUSH_SYNC_BUDGET_BYTES} and was left queued — the caller
   * must `resumeFlush` after the resize so the backlog drains watermarked at
   * the new grid. The reset only runs on the flush path: `resetForTerminal`
   * deletes the queue, so resetting a held backlog would drop output.
   */
  private flushHeldBytesBeforeResize(id: string): boolean {
    const queuedBytes = this.deps.dataBuffer.getQueuedBytes(id);
    if (exceedsResizeFlushSyncBudget(queuedBytes)) {
      logWarn(
        `[TerminalResizeController] ${id}: ${queuedBytes} held ingest bytes exceed the pre-resize flush budget — draining watermarked at the new grid instead`
      );
      return false;
    }
    this.deps.dataBuffer.flushForTerminal(id);
    this.deps.dataBuffer.resetForTerminal(id);
    return true;
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

    if (this.getResizeStrategy(managed) === "settled") {
      const existing = this.settledResizeTimers.get(id);
      if (existing !== undefined) clearTimeout(existing);

      const timer = globalThis.setTimeout(() => {
        this.settledResizeTimers.delete(id);

        const current = this.deps.getInstance(id);
        if (!current) {
          return;
        }

        this.resizeTerminal(current, cols, rows);
        terminalClient.resize(id, cols, rows);
      }, SETTLED_RESIZE_DELAY_MS) as unknown as number;
      this.settledResizeTimers.set(id, timer);
    } else {
      terminalClient.resize(id, cols, rows);
    }
  }

  forceImmediateResize(id: string): void {
    const managed = this.deps.getInstance(id);
    if (!managed) return;

    const cols = managed.latestCols;
    const rows = managed.latestRows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      return;
    }

    this.clearSettledTimer(id);
    terminalClient.resize(id, cols, rows);
  }

  clearSettledTimer(id: string): void {
    const timer = this.settledResizeTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.settledResizeTimers.delete(id);
    }
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
              const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);
              this.resizeTerminal(current, current.latestCols, current.latestRows);
              this.sendPtyResize(id, current.latestCols, current.latestRows);
              if (!flushedHeldBytes) {
                this.deps.dataBuffer.resumeFlush(id);
              }
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
          const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);
          this.resizeTerminal(current, current.latestCols, current.latestRows);
          this.sendPtyResize(id, current.latestCols, current.latestRows);
          if (!flushedHeldBytes) {
            this.deps.dataBuffer.resumeFlush(id);
          }
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
        const flushedHeldBytes = this.flushHeldBytesBeforeResize(id);
        this.resizeTerminal(current, cols, rows);
        this.sendPtyResize(id, cols, rows);
        if (!flushedHeldBytes) {
          this.deps.dataBuffer.resumeFlush(id);
        }
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
