import { Terminal } from "@xterm/xterm";
import { isLinux } from "@/lib/platform";
import { terminalClient } from "@/clients";
import { logError, logWarn } from "@/utils/logger";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isUselessTitle, normalizeObservedTitle } from "@shared/utils/isUselessTitle";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ManagedTerminal } from "./types";
import { isNonKeyboardInput } from "./inputUtils";
import { installLinuxPrimarySelectionListeners } from "./primarySelection";
import { writeTerminalInputOrFleet } from "./fleetInputRouter";
import { getXtermCellDimensions } from "./TerminalResizeController";
import { MouseWheelClassifier } from "./mouseWheelClassifier";
import { getTerminalMetrics } from "@/config/xtermConfig";

// Debounce: coalesce a burst of OSC 0/2 title changes from agent shells
// (which can emit many per second) into a single panel-store / main-process
// update.
const OBSERVED_TITLE_DEBOUNCE_MS = 150;

// Hysteresis: a "waiting" title must persist this long before we report it.
// Working titles fire immediately; the asymmetric debounce prevents flicker
// when an agent briefly idles mid-task.
const WAITING_TITLE_HYSTERESIS_MS = 250;

// ─────────────────────────────────────────────────────────────────────────────
// Wheel forwarding for full-screen mouse-reporting TUIs (grok, lazygit, btop).
//
// xterm-audit (beta.288): xterm's own scroll fixes #5391 (partial wheel
// tracking), #5037 (smooth scroll ≤ once/frame) and #5437 (alt-buffer page-
// scroll guard) are ALL present. We still override xterm's wheel handling for
// the alt-screen mouse-reporting case on purpose: `MouseService._consumeWheelEvent`
// multiplies likely-trackpad deltas by 0.3 then floors, so a small gesture
// computes `lines === 0` and sends NO report (scrolling feels dead). We
// intercept the physical wheel, normalize it ourselves (lossless accumulator,
// below), and re-dispatch synthetic `deltaMode:1` events — deltaMode 1 routes
// through xterm's encoder with NO 0.3×/partial-scroll math, so each synthetic
// event maps to exactly one SGR mouse report. `attachCustomWheelEventHandler`
// (already wired below) is the supported suppression hook. smoothScrollDuration
// is globally 0 (xtermConfig.ts) and never runs on this synthetic-report path
// regardless. Do NOT "delete this as redundant with #5391" — the override is
// deliberate.
// ─────────────────────────────────────────────────────────────────────────────

// Fallback CSS px-per-line when the rendered cell height is unavailable (pre
// first-render). The live basis is the actual rendered cell height
// (getXtermCellDimensions → getTerminalMetrics(fontSize) → this), matching the
// quantity xterm itself normalizes against (cell height / dpr). One rendered
// text-row of pixel travel ⇒ one line report: a ~120px macOS mouse detent ⇒
// ~6 lines at a 14px font. Pixel-mode only — line/page events carry the OS step.
const WHEEL_FALLBACK_PIXELS_PER_LINE = 20;
const DEFAULT_FONT_SIZE_PX = 14;

// Max synthetic line-reports flushed per animation frame for a mouse-reporting
// TUI — the SEND-RATE lever (NOT a render-FPS lever). Each report is an
// independent PTY round-trip: the app redraws its whole scroll region and ships
// a full frame back through IPC, so dispatching a whole gesture at once floods
// the pipe with redraws the user never sees (the renderer paints once per
// frame). We drain at most this many lines per frame. Split by input device:
// a physical wheel's discrete detents stay crisp at a higher cap, while a
// trackpad/Magic-Mouse momentum stream (dozens of events/sec — the actual
// symptom-A flood) is paced gentler. Keep ≤ ~10: above that the IPC redraw
// return saturates the renderer, which IS the flood we are avoiding.
const WHEEL_MAX_LINES_PER_FRAME_WHEEL = 8;
const WHEEL_MAX_LINES_PER_FRAME_TRACKPAD = 4;

// Ceiling on the un-drained backlog, in screenfuls. The proportional normalizer
// already bounds pending to the distance physically scrolled, so this only
// catches a pathological long momentum tail — it caps how far the view can keep
// coasting after the gesture ends, so pacing never resurrects the disconnected-
// overscroll feel the proportional rewrite removed.
const WHEEL_MAX_PENDING_SCREENFULS = 3;

// A physical-wheel gap longer than this ends the gesture: a paused-then-resumed
// scroll re-detects the device (classifier reset) and drops any un-drained coast,
// instead of letting the previous gesture bias the cap or keep scrolling. Trackpad
// momentum events arrive ~every 8-16ms, so 120ms cannot chop a continuous gesture;
// it only fires after a real pause. Sub-line carry is preserved across the gap so
// slow continuous scrolling still accumulates. Don't drop below ~80ms.
const WHEEL_STALE_GAP_MS = 120;

/**
 * Resolve the CSS px-per-line basis from the live rendered cell height, falling
 * back to the font-metric estimate and finally a fixed default. This is the
 * "intent unit" for a mouse-reporting TUI: the app scrolls its own region, so
 * px-per-line is one visible text-row of travel ⇒ one report, not a viewport
 * distance. Cheap (one private-field read); fine to call per gesture.
 */
function resolveWheelPixelsPerLine(terminal: Terminal): number {
  const measured = getXtermCellDimensions(terminal)?.height;
  if (typeof measured === "number" && measured > 0) return measured;
  const fontSize =
    typeof terminal.options.fontSize === "number"
      ? terminal.options.fontSize
      : DEFAULT_FONT_SIZE_PX;
  return getTerminalMetrics(fontSize).cellHeight;
}

// The synthetic wheel events the normalizer re-dispatches are tracked here so
// its own capture-phase listener skips them instead of recursing. A WeakSet
// (rather than `isTrusted`) keeps the behavior unit-testable — dispatched test
// events are untrusted too — and lets the events be GC'd after handling.
const amplifiedWheelEvents = new WeakSet<WheelEvent>();

/**
 * Convert a physical wheel event into a signed whole-line count for a TUI that
 * captures the mouse. The goal is the "standard" feel — a notch scrolls a line
 * or two — while never *dropping* a scroll, which is the actual complaint with
 * xterm's own handling: its `MouseService._consumeWheelEvent` multiplies likely
 * trackpad deltas by 0.3, so small movements fall below the one-line threshold,
 * compute `lines === 0`, and send no report at all (scrolling feels dead).
 *
 * Pixel-mode deltas (macOS mice/trackpads, and precision touchpads on any OS)
 * accumulate as pixels in `carry` and are converted to lines at a fixed
 * px-per-line budget, so the line count is proportional to the gesture distance:
 * a single detent scrolls a few lines, coalesced detents and momentum scroll
 * proportionally more (never collapsed to one notch), and sub-line motion adds
 * up across events instead of being damped to nothing. Line-mode and page-mode
 * events already carry an OS step and pass through unchanged.
 *
 * `pixelsPerLine` is the CSS px-per-line basis for pixel-mode events (the live
 * rendered cell height; see `resolveWheelPixelsPerLine`). Defaults to the fixed
 * fallback so callers/tests that don't need the live basis stay simple.
 */
export function wheelEventToLineCount(
  ev: WheelEvent,
  rows: number,
  carry: { partial: number },
  pixelsPerLine: number = WHEEL_FALLBACK_PIXELS_PER_LINE
): number {
  if (ev.deltaY === 0) return 0;
  const clamp = (n: number): number => Math.max(-rows, Math.min(rows, n));

  if (ev.deltaMode === 1 /* DOM_DELTA_LINE */) {
    // Already in lines (typically ±1 or ±3 per the OS wheel setting).
    return clamp(Math.round(ev.deltaY));
  }
  if (ev.deltaMode === 2 /* DOM_DELTA_PAGE */) {
    return (ev.deltaY > 0 ? 1 : -1) * rows;
  }
  // Pixel mode (macOS mouse + trackpad; also precision touchpads on any OS).
  // `carry.partial` accumulates raw pixels and we divide ONCE by the live
  // px-per-line basis (rendered cell height), so the count is proportional to
  // the gesture (coalesced detents and momentum both scroll their true distance)
  // and sub-line motion is never discarded. Accumulating pixels rather than
  // pre-divided line fractions keeps exact multiples exact: ten 2px events sum to
  // 20px = one line at a 20px basis, whereas summing ten `2/20` fractions lands
  // at 0.9999999999999999 and silently drops the line.
  //
  // Drop a stale opposite-direction remainder so a reversal registers right away
  // instead of first having to cancel unreported forward motion — that would be
  // a dead zone where a genuine reverse scroll does nothing.
  if (carry.partial !== 0 && Math.sign(ev.deltaY) !== Math.sign(carry.partial)) {
    carry.partial = 0;
  }
  const basis = pixelsPerLine > 0 ? pixelsPerLine : WHEEL_FALLBACK_PIXELS_PER_LINE;
  carry.partial += ev.deltaY;
  const whole = Math.trunc(carry.partial / basis);
  carry.partial -= whole * basis;
  return clamp(whole);
}

/**
 * Snap xterm DOM-renderer row heights to integer pixels that sum exactly to the
 * canvas height, eliminating HiDPI "zebra" banding (#10768).
 *
 * At fractional device-pixel-ratios xterm's DOM renderer stamps every row with
 * `css.canvas.height / rows` — a fractional CSS px height (DomRenderer
 * `_updateDimensions`). Chromium then snaps adjacent row boundaries to device
 * pixels inconsistently and the near-black terminal background bleeds through
 * the seams as horizontal stripes. The WebGL renderer has no such seam, so the
 * caller gates this on `!isWebGLActive(id)` — it only runs for DOM panes.
 *
 * Rows stack in normal flow, so the snapped heights MUST sum to the original
 * canvas height; otherwise the rows drift past (or short of) the fixed-height
 * screen element. A Bresenham distribution gives each row `base` or `base + 1`
 * px spread evenly, summing exactly to the canvas height: coinciding integer
 * boundaries snap to the same device pixel (no seam) with zero cumulative
 * drift. The reconciliation watchdog reads container `getBoundingClientRect`,
 * not row inline styles, so this does not perturb it.
 *
 * Idempotent: xterm only re-stamps fractional heights from `_updateDimensions`
 * (resize / DPR / font / option change), each followed by a render; once
 * snapped the first row reads as an integer and this early-returns. Cheap on
 * the steady-state render path — one inline-style read, no layout flush.
 */
function snapDomRowHeightsToIntegerPixels(terminal: Terminal): void {
  const rowContainer = terminal.element?.querySelector(".xterm-rows");
  if (!rowContainer) return;
  const rowEls = rowContainer.children;
  const count = rowEls.length;
  if (count === 0) return;

  const cellHeight = parseFloat((rowEls[0] as HTMLElement).style.height);
  // Nothing stamped yet, a zero-size grid, or already integer — leave it.
  if (!Number.isFinite(cellHeight) || cellHeight <= 0 || Number.isInteger(cellHeight)) {
    return;
  }

  // cellHeight === css.canvas.height / count, so cellHeight * count recovers the
  // integer canvas height the rows must sum back to.
  const target = Math.round(cellHeight * count);
  const base = Math.floor(target / count);
  const extra = target - base * count; // count of rows that get one extra pixel

  // Midpoint-start Bresenham so the `extra` taller rows are spread evenly across
  // the viewport rather than bunched at the bottom; the sum is unchanged
  // (exactly `extra` rows receive base+1 regardless of the start offset).
  let acc = Math.floor(count / 2);
  for (let i = 0; i < count; i++) {
    acc += extra;
    let h = base;
    if (acc >= count) {
      acc -= count;
      h = base + 1;
    }
    const px = `${h}px`;
    const row = rowEls[i] as HTMLElement;
    row.style.height = px;
    row.style.lineHeight = px;
  }
}

/**
 * Callback surface needed by `installTerminalBoundListeners`. The create path
 * (`TerminalInstanceService.getOrCreate()`) satisfies this interface so adding
 * a new terminal-bound listener is a one-edit operation.
 */
export interface TerminalListenerInstallDeps {
  // Buffer / scroll / selection scrollback
  onBufferModeChange: (id: string, isAltBuffer: boolean) => void;
  /**
   * Whether the terminal is currently on the WebGL renderer. Gates the DOM
   * integer row-height snap (#10768) so it only runs for DOM-rendered panes.
   * Routed through deps to keep this module import-cycle-free relative to
   * `TerminalWebGLManager` (same pattern as the reconciliation watchdog).
   */
  isWebGLActive: (id: string) => boolean;
  notifyParsed: (id: string) => void;
  scrollToBottomSafe: (managed: ManagedTerminal) => void;
  updateScrollState: (id: string, isScrolledBack: boolean) => void;
  clearUnseen: (id: string, fromUser: boolean) => void;
  onWriteParsedReflow?: (managed: ManagedTerminal) => void;

  // Selection cache
  setCachedSelection: (id: string, selection: string) => void;
  deleteCachedSelection: (id: string) => void;

  // Linux primary selection (middle-click paste / copy-on-select)
  getCachedSelection: (id: string) => string | undefined;
  getBracketedPasteMode: (id: string) => boolean;
  isDisposed: (id: string) => boolean;
  isInputLocked: (id: string) => boolean;
  notifyUserInput: (id: string) => void;

  // Input
  clearDirectingState: (id: string, trigger?: string) => void;
  onUserInput: (id: string, data: string) => void;
  /**
   * Fired when a wheel scroll is actively forwarded to a mouse-reporting TUI.
   * Lets the host boost the renderer tier and hold the resource profile off
   * efficiency so an active scroll stays responsive (symptom B).
   */
  onActiveWheel: (id: string) => void;
  onEnterPressed: (id: string) => void;

  // Panel store side effects (routed through deps to keep this module
  // import-cycle-free relative to the renderer store).
  updateLastObservedTitle: (id: string, title: string) => void;
  /** Fired when xterm gains focus (helper textarea or any host descendant). */
  notifyXtermFocused: () => void;
}

/**
 * Installs every terminal-bound listener on a fresh `Terminal` and pushes its
 * cleanup lambda into `managed.listeners`. The listener order, `setTimeout`
 * cleanup, and behaviour must remain identical across the create and wake
 * paths — drift between them previously meant Linux primary selection,
 * observed-title forwarding, and fleet input broadcast all silently broke
 * after the first hibernate/wake cycle (#6660).
 *
 * `lastReportedTitleState` is a function-local closure so each call starts
 * with a fresh zero state. Storing it on `managed` would make a post-wake
 * report inherit the previous session's state and silently drop the first
 * title transition.
 */
export function installTerminalBoundListeners(
  terminal: Terminal,
  managed: ManagedTerminal,
  id: string,
  deps: TerminalListenerInstallDeps
): void {
  const hostElement = managed.hostElement;
  const initialIsAltBuffer = terminal.buffer.active.type === "alternate";
  managed.isAltBuffer = initialIsAltBuffer;

  const bufferDisposable = terminal.buffer.onBufferChange(() => {
    const newIsAltBuffer = terminal.buffer.active.type === "alternate";
    if (newIsAltBuffer !== managed.isAltBuffer) {
      managed.isAltBuffer = newIsAltBuffer;
      deps.onBufferModeChange(id, newIsAltBuffer);
    }
  });
  managed.listeners.push(() => bufferDisposable.dispose());

  if (initialIsAltBuffer) {
    deps.onBufferModeChange(id, true);
  }

  // DOM-renderer zebra-banding fix (#10768): after each render on a DOM-rendered
  // pane, snap fractional row heights to integer pixels. onRender (not onResize)
  // is the trigger because it also fires when a pane swaps WebGL→DOM on a fleet
  // mode flip and on DPR changes that re-stamp heights without a cols/rows
  // resize. The snap is idempotent and bails immediately for WebGL panes.
  const renderDisposable = terminal.onRender(() => {
    if (deps.isWebGLActive(id)) return;
    snapDomRowHeightsToIntegerPixels(terminal);
  });
  managed.listeners.push(() => renderDisposable.dispose());

  // Suppress xterm's wheel→arrow-key translation for agent terminals that
  // are in the alt-screen buffer with no mouse tracking active. Without
  // this, scrolling in Copilot/Crush/opencode (Ink-based TUIs using
  // CSI ?1049h) sends Up/Down arrow sequences to the agent — visibly
  // navigating its command history instead of revealing prior output.
  // Returning `false` skips the synthetic arrow sequences but leaves the
  // native WheelEvent intact so xterm's viewport still scrolls. Plain
  // shells (vim, tmux, htop) keep their default behavior because they
  // have no `runtimeAgentId`; mouse-reporting TUIs are passed through so
  // wheel-as-mouse-event still works.
  terminal.attachCustomWheelEventHandler(() => {
    if (
      managed.runtimeAgentId &&
      managed.isAltBuffer &&
      terminal.modes.mouseTrackingMode === "none"
    ) {
      return false;
    }
    return true;
  });

  // Reliable wheel forwarding for TUIs that capture the mouse and draw their own
  // scroll region (e.g. the grok CLI, lazygit, btop). See the wheel-audit block
  // at the top of this file for why we override xterm here and re-dispatch
  // synthetic deltaMode:1 events. Gated on the alt buffer + active mouse tracking
  // so plain shells and the wheel→arrow case above are untouched; modified wheels
  // (ctrl-zoom etc.) pass through unchanged.
  const wheelCarry = { partial: 0 };
  // Per-terminal device classifier (trackpad vs physical wheel). Drives only the
  // per-frame send-rate cap — trackpad momentum is the gesture that floods.
  const wheelClassifier = new MouseWheelClassifier();
  // Latest device verdict, updated on each physical event and read by the flush
  // (which runs a frame later, so it must read the closure, not recompute).
  let wheelMaxLinesPerFrame = WHEEL_MAX_LINES_PER_FRAME_TRACKPAD;
  // Wall-clock of the last accepted physical wheel, for the stale-gesture gap.
  let lastPhysicalWheelAt = 0;
  // Whole-line backlog awaiting dispatch, signed (down positive). Filled
  // synchronously from each physical wheel event, drained per animation frame so
  // a momentum flood paces to the TUI's redraw rate instead of round-tripping
  // every line at once.
  let pendingWheelLines = 0;
  let wheelFlushRaf: number | undefined;
  // Coords of the most recent physical wheel — synthetic reports inherit them so
  // xterm encodes the mouse report at the cursor's actual cell.
  let lastWheelClientX = 0;
  let lastWheelClientY = 0;

  const flushWheelLines = () => {
    wheelFlushRaf = undefined;
    if (pendingWheelLines === 0) return;
    const target = terminal.element;
    // A multi-frame drain can outlive the mouse-reporting context: the TUI may
    // leave the alt screen or disable mouse tracking before the backlog empties.
    // Re-check the same gate as onWheelNormalize and drop the rest if it no longer
    // holds — otherwise queued synthetic wheels leak into xterm's arrow-key
    // fallback (non-agent alt-buffer) or normal-buffer viewport scroll once the
    // app no longer owns the wheel.
    const mode = terminal.modes.mouseTrackingMode;
    const appReportsWheel = mode === "vt200" || mode === "drag" || mode === "any";
    if (!target || !managed.isAltBuffer || !appReportsWheel) {
      pendingWheelLines = 0;
      return;
    }
    // Re-clamp against the CURRENT row count: a resize that shrank the viewport
    // mid-drain would otherwise leave a backlog of many more screenfuls than the
    // cap intends, coasting far past the gesture.
    const maxPending = terminal.rows * WHEEL_MAX_PENDING_SCREENFULS;
    if (pendingWheelLines > maxPending) pendingWheelLines = maxPending;
    else if (pendingWheelLines < -maxPending) pendingWheelLines = -maxPending;

    const step = pendingWheelLines > 0 ? 1 : -1;
    // Fixed per-frame cap (no `elapsed`/timestamp multiply) so a late frame can
    // never "catch up" by dispatching a larger burst — that would reintroduce
    // the flood under main-thread jank. Device-aware: gentler for trackpads.
    const emit = Math.min(Math.abs(pendingWheelLines), wheelMaxLinesPerFrame);
    pendingWheelLines -= step * emit;
    for (let i = 0; i < emit; i++) {
      const synthetic = new WheelEvent("wheel", {
        deltaY: step,
        deltaMode: 1 /* DOM_DELTA_LINE — one report each, no partial-scroll carry */,
        clientX: lastWheelClientX,
        clientY: lastWheelClientY,
        bubbles: true,
        cancelable: true,
      });
      amplifiedWheelEvents.add(synthetic);
      target.dispatchEvent(synthetic);
    }
    // Drain the remaining backlog on the next frame so a large gesture keeps
    // moving without dispatching it all in one burst.
    if (pendingWheelLines !== 0) {
      wheelFlushRaf = requestAnimationFrame(flushWheelLines);
    }
  };

  const onWheelNormalize = (ev: WheelEvent) => {
    if (amplifiedWheelEvents.has(ev)) return;
    // Only take over for mouse modes that actually report wheel events: VT200
    // (?1000), DRAG (?1002), ANY (?1003). X10 (?9, click-only) explicitly drops
    // wheel reports in xterm's protocol — taking it over would route our
    // synthetic wheels through xterm's passive alt-buffer path and emit ARROW
    // keys to an app that never asked for the wheel. Leave x10 and none alone.
    const mode = terminal.modes.mouseTrackingMode;
    const appReportsWheel = mode === "vt200" || mode === "drag" || mode === "any";
    if (
      !managed.isAltBuffer ||
      !appReportsWheel ||
      ev.ctrlKey ||
      ev.altKey ||
      ev.metaKey ||
      ev.shiftKey
    ) {
      return;
    }
    const target = terminal.element;
    if (!target) return;

    // Take over: stop xterm's (lossy) handling, replace with paced line reports.
    ev.preventDefault();
    ev.stopImmediatePropagation();

    // Stale-gesture gap: a long pause since the last physical event ends the
    // gesture. Treat the resumed scroll as fresh — forget the previous device so
    // its rolling history can't bias the new cap, and drop any coast the rAF
    // hasn't drained yet (e.g. while the main thread was janked). MUST run before
    // classify/accumulate below. Sub-line carry is deliberately PRESERVED: a
    // genuinely slow continuous scroll (hi-res wheel emitting sub-line pixel
    // deltas >120ms apart) must still accumulate, not be reset to nothing.
    const now = Date.now();
    if (now - lastPhysicalWheelAt > WHEEL_STALE_GAP_MS) {
      wheelClassifier.reset();
      pendingWheelLines = 0;
    }
    lastPhysicalWheelAt = now;

    // Classify the device from the raw deltas and pick the per-frame send-rate
    // cap accordingly (physical wheel = crisper, trackpad = gentler flood pacing).
    wheelClassifier.accept(ev.timeStamp, ev.deltaX, ev.deltaY);
    wheelMaxLinesPerFrame = wheelClassifier.isPhysicalMouseWheel()
      ? WHEEL_MAX_LINES_PER_FRAME_WHEEL
      : WHEEL_MAX_LINES_PER_FRAME_TRACKPAD;

    // A direction change drops the stale opposite-direction backlog so the
    // reversal scrolls the new way immediately rather than first coasting out
    // un-dispatched travel. Keyed on the raw deltaY sign, NOT the whole-line
    // `lines` below — the first reversal event from a trackpad is usually
    // sub-line (lines === 0), and gating the drop on `lines` would let the stale
    // backlog keep scrolling the old way until the reversal accumulated a whole
    // line. Mirrors the carry reset inside wheelEventToLineCount.
    if (
      ev.deltaY !== 0 &&
      pendingWheelLines !== 0 &&
      Math.sign(ev.deltaY) !== Math.sign(pendingWheelLines)
    ) {
      pendingWheelLines = 0;
    }

    const lines = wheelEventToLineCount(
      ev,
      terminal.rows,
      wheelCarry,
      resolveWheelPixelsPerLine(terminal)
    );
    if (lines === 0) return;

    // A real scroll is being forwarded to the TUI — keep the pane fast: boost the
    // renderer tier and hold the resource profile off efficiency for the gesture.
    deps.onActiveWheel(id);

    pendingWheelLines += lines;
    // Clamp the backlog so a long momentum tail can't queue an unbounded coast.
    const maxPending = terminal.rows * WHEEL_MAX_PENDING_SCREENFULS;
    if (pendingWheelLines > maxPending) pendingWheelLines = maxPending;
    else if (pendingWheelLines < -maxPending) pendingWheelLines = -maxPending;

    lastWheelClientX = ev.clientX;
    lastWheelClientY = ev.clientY;

    if (wheelFlushRaf === undefined) {
      wheelFlushRaf = requestAnimationFrame(flushWheelLines);
    }
  };
  hostElement.addEventListener("wheel", onWheelNormalize, { capture: true, passive: false });
  managed.listeners.push(() => {
    hostElement.removeEventListener("wheel", onWheelNormalize, { capture: true });
    if (wheelFlushRaf !== undefined) {
      cancelAnimationFrame(wheelFlushRaf);
      wheelFlushRaf = undefined;
    }
    pendingWheelLines = 0;
  });

  const oscDisposable = terminal.parser.registerOscHandler(11, () => {
    if (managed.isAltBuffer) {
      for (const callback of managed.altBufferListeners) {
        try {
          callback(true);
        } catch (err) {
          logError("Alt buffer callback error", err);
        }
      }
    }
    return false;
  });
  managed.listeners.push(() => oscDisposable.dispose());

  const writeParsedDisposable = terminal.onWriteParsed(() => {
    deps.notifyParsed(id);
    if (!managed.isUserScrolledBack && !managed.isAltBuffer) {
      if (!managed.terminal.hasSelection()) {
        deps.scrollToBottomSafe(managed);
      } else {
        managed.isUserScrolledBack = true;
        deps.updateScrollState(id, true);
      }
    }
    deps.onWriteParsedReflow?.(managed);
  });
  managed.listeners.push(() => writeParsedDisposable.dispose());

  const scrollDisposable = terminal.onScroll(() => {
    const buffer = terminal.buffer.active;
    const isAtBottom = buffer.viewportY >= buffer.baseY;
    managed.latestWasAtBottom = isAtBottom;

    managed._userScrollIntent = false;
    if (managed._suppressScrollTracking) return;

    if (isAtBottom) {
      managed.isUserScrolledBack = false;
      deps.clearUnseen(id, false);
    } else {
      managed.isUserScrolledBack = true;
      deps.updateScrollState(id, true);
    }
  });
  managed.listeners.push(() => scrollDisposable.dispose());

  const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]);
  const onWheel = () => {
    managed._userScrollIntent = true;
    managed.lastWheelAt = Date.now();
  };
  const onKeydownScroll = (e: KeyboardEvent) => {
    if (SCROLL_KEYS.has(e.key)) managed._userScrollIntent = true;
  };
  hostElement.addEventListener("wheel", onWheel, { passive: true });
  hostElement.addEventListener("keydown", onKeydownScroll);
  managed.listeners.push(() => {
    hostElement.removeEventListener("wheel", onWheel);
    hostElement.removeEventListener("keydown", onKeydownScroll);
  });

  // Track xterm focus so the session-wide preferred focus target stays in
  // sync with what the user is actually using. xterm 6 has no high-level
  // onFocusChange API; the helper textarea is created lazily during
  // `terminal.open()` and may be re-created across hibernation. Listening
  // on `hostElement` (which is reused across the wake/unhibernate path)
  // captures focus events bubbling from any descendant — robust to the
  // helper textarea being recreated.
  const onHostFocusIn = () => {
    deps.notifyXtermFocused();
  };
  hostElement.addEventListener("focusin", onHostFocusIn);
  managed.listeners.push(() => {
    hostElement.removeEventListener("focusin", onHostFocusIn);
  });

  const selectionDisposable = terminal.onSelectionChange(() => {
    const sel = terminal.getSelection();
    if (sel) {
      deps.setCachedSelection(id, sel);
    } else {
      deps.deleteCachedSelection(id);
    }
  });
  managed.listeners.push(() => selectionDisposable.dispose());

  if (isLinux()) {
    const removePrimaryListeners = installLinuxPrimarySelectionListeners({
      hostElement,
      terminalId: id,
      getCachedSelection: () => deps.getCachedSelection(id),
      getBracketedPasteMode: () => deps.getBracketedPasteMode(id),
      isDisposed: () => deps.isDisposed(id),
      isInputLocked: () => deps.isInputLocked(id),
      writeToPty: (termId, data) => terminalClient.write(termId, data),
      notifyUserInput: (termId) => deps.notifyUserInput(termId),
      writeSelection: (text) => window.electron.clipboard.writeSelection(text),
      readSelection: () => window.electron.clipboard.readSelection(),
    });
    managed.listeners.push(removePrimaryListeners);
  }

  if (typeof terminal.onTitleChange === "function") {
    const observedTitleDisposable = terminal.onTitleChange((title: string) => {
      if (!managed.runtimeAgentId) return;
      const normalized = normalizeObservedTitle(title);
      if (!normalized || isUselessTitle(normalized)) return;
      if (normalized === managed.lastObservedTitleSent) return;
      managed.pendingObservedTitle = normalized;
      if (managed.observedTitleTimer !== undefined) {
        clearTimeout(managed.observedTitleTimer);
      }
      managed.observedTitleTimer = window.setTimeout(() => {
        managed.observedTitleTimer = undefined;
        const pending = managed.pendingObservedTitle;
        managed.pendingObservedTitle = undefined;
        if (!managed.runtimeAgentId) return;
        if (!pending || pending === managed.lastObservedTitleSent) return;
        managed.lastObservedTitleSent = pending;
        try {
          window.electron.terminal.updateObservedTitle(id, pending);
        } catch (err) {
          logWarn("[TerminalInstanceService] updateObservedTitle failed", {
            error: formatErrorMessage(err, "Failed to update observed title"),
          });
        }
        try {
          deps.updateLastObservedTitle(id, pending);
        } catch (err) {
          logWarn("[TerminalInstanceService] panel store title update failed", {
            error: formatErrorMessage(err, "Failed to update panel store observed title"),
          });
        }
      }, OBSERVED_TITLE_DEBOUNCE_MS);
    });
    managed.listeners.push(() => {
      observedTitleDisposable.dispose();
      if (managed.observedTitleTimer !== undefined) {
        clearTimeout(managed.observedTitleTimer);
        managed.observedTitleTimer = undefined;
        managed.pendingObservedTitle = undefined;
      }
    });

    let lastReportedTitleState: "working" | "waiting" | undefined;
    const titleDisposable = terminal.onTitleChange((title: string) => {
      const agentId = managed.runtimeAgentId;
      const titlePatterns = agentId
        ? getEffectiveAgentConfig(agentId)?.detection?.titleStatePatterns
        : undefined;
      if (!titlePatterns) return;

      let matched: "working" | "waiting" | undefined;
      for (const pattern of titlePatterns.working) {
        if (title.includes(pattern)) {
          matched = "working";
          break;
        }
      }
      if (!matched) {
        for (const pattern of titlePatterns.waiting) {
          if (title.includes(pattern)) {
            matched = "waiting";
            break;
          }
        }
      }
      if (!matched) {
        if (managed.titleReportTimer !== undefined) {
          clearTimeout(managed.titleReportTimer);
          managed.titleReportTimer = undefined;
          managed.pendingTitleState = undefined;
        }
        return;
      }

      if (matched === "working") {
        if (managed.titleReportTimer !== undefined) {
          clearTimeout(managed.titleReportTimer);
          managed.titleReportTimer = undefined;
          managed.pendingTitleState = undefined;
        }
        if (lastReportedTitleState !== "working") {
          lastReportedTitleState = "working";
          window.electron.terminal.reportTitleState(id, "working");
        }
      } else {
        managed.pendingTitleState = "waiting";
        if (managed.titleReportTimer !== undefined) {
          clearTimeout(managed.titleReportTimer);
        }
        managed.titleReportTimer = window.setTimeout(() => {
          managed.titleReportTimer = undefined;
          if (managed.pendingTitleState === "waiting") {
            managed.pendingTitleState = undefined;
            if (lastReportedTitleState !== "waiting") {
              lastReportedTitleState = "waiting";
              window.electron.terminal.reportTitleState(id, "waiting");
            }
          }
        }, WAITING_TITLE_HYSTERESIS_MS);
      }
    });
    managed.listeners.push(() => {
      titleDisposable.dispose();
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
        managed.titleReportTimer = undefined;
        managed.pendingTitleState = undefined;
      }
    });
  } else {
    managed.listeners.push(() => {
      if (managed.titleReportTimer !== undefined) {
        clearTimeout(managed.titleReportTimer);
        managed.titleReportTimer = undefined;
        managed.pendingTitleState = undefined;
      }
    });
  }

  const inputDisposable = terminal.onData((data) => {
    if (managed.isInputLocked) return;
    if (isNonKeyboardInput(data)) {
      if (data === "\x1b") {
        deps.clearDirectingState(id, "escape-key");
      }
    } else {
      deps.onUserInput(id, data);
    }
    writeTerminalInputOrFleet(id, data);
    if (managed.onInput) {
      managed.onInput(data);
    }
  });
  managed.listeners.push(() => inputDisposable.dispose());

  if (typeof terminal.onKey === "function") {
    const keyDisposable = terminal.onKey(({ domEvent }) => {
      if (
        !managed.isInputLocked &&
        domEvent.key === "Enter" &&
        !domEvent.isComposing &&
        !domEvent.shiftKey &&
        !domEvent.ctrlKey &&
        !domEvent.altKey &&
        !domEvent.metaKey
      ) {
        deps.onEnterPressed(id);
      }
    });
    managed.listeners.push(() => keyDisposable.dispose());
  }
}
