import type { Terminal } from "@xterm/xterm";
import type { ManagedTerminal } from "./types";
import { logWarn } from "@/utils/logger";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";

type XtermRenderServicePause = {
  _isPaused?: boolean;
  /** xterm's own resume transition — see forceXtermRendererUnpause. */
  _handleIntersectionChange?: (entry: IntersectionObserverEntry) => void;
};

type XtermCoreRenderPause = {
  _renderService?: XtermRenderServicePause;
};

// Automatic renderer-unpause repairs allowed for one terminal before the
// breaker trips (#11800). xterm's `_isPaused` is written only by its own
// IntersectionObserver, so the repair forces the resume; if something re-pauses
// the pane every sweep, retrying forever just burns a full-grid repaint each
// time. Mirrors WATCHDOG_MAX_GEOMETRY_REPAIR_ATTEMPTS and
// TerminalWebGLManager's LOSS_THRESHOLD one-way-trip pattern.
export const MAX_RENDERER_UNPAUSE_ATTEMPTS = 3;

/**
 * Three-state read of xterm's private IntersectionObserver pause flag (same
 * `_core` escape hatch as `getXtermCellDimensions` / `isXtermRenderPaused`).
 * Returns `undefined` when the field is missing (API drift), which callers must
 * treat as "don't know" — unlike the watchdog's boolean read, which collapses
 * drift to not-paused so the rest of the chain keeps reconciling.
 */
export function readXtermRenderPaused(terminal: Terminal): boolean | undefined {
  try {
    const isPaused = (terminal as Terminal & { _core?: XtermCoreRenderPause })._core?._renderService
      ?._isPaused;
    return typeof isPaused === "boolean" ? isPaused : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sub-pixel padding jitter that forces a synchronous layout while keeping the
 * element in the layout tree (display:none would set isIntersecting=false and
 * pause the renderer instead).
 *
 * Does NOT resume a paused renderer, despite what #5085 assumed: the mutation
 * and its revert both happen in one task, while IntersectionObserver records
 * are computed in the per-frame "update the rendering" step that runs only
 * after the task and microtask queues drain — so the observer never sees
 * anything but the reverted state (#11800). Reveal and wake paths still call
 * it for the layout flush, alongside the real geometry changes that do drive
 * IO. To actually unpause, use {@link forceXtermRendererUnpause}.
 */
export function forceXtermReflow(element: HTMLElement): void {
  const prev = element.style.paddingTop;
  element.style.paddingTop = "0.01px";
  void element.offsetHeight;
  element.style.paddingTop = prev;
}

/**
 * Resume xterm's core RenderService after its IntersectionObserver paused it.
 *
 * In xterm 6 `_isPaused` is written in exactly one place — the observer
 * callback — and no public API resets it, so a pane whose observer never
 * redelivers (occluded reveal, long backgrounding) stays paused with every
 * `refreshRows` call short-circuiting. Clearing the flag and issuing a
 * full-range `refresh()` is precisely what xterm's own unpause path does
 * (`refreshRows(0, rows - 1)`), just driven manually.
 *
 * Fails closed on API drift: the flag must already read `true`, so a future
 * xterm that renames or drops it never gets a synthetic property written.
 * Returns whether the repair was ISSUED — not whether the pane visibly
 * recovered, which only a later observation can establish.
 */
export function forceXtermRendererUnpause(terminal: Terminal): boolean {
  let renderService: XtermRenderServicePause | undefined;
  try {
    renderService = (terminal as Terminal & { _core?: XtermCoreRenderPause })._core?._renderService;
    if (renderService?._isPaused !== true) return false;
    // Prefer driving xterm's OWN resume transition. Clearing the flag and
    // repainting is not equivalent: `_handleIntersectionChange` also notifies
    // the renderer of visibility, measures char dimensions if they were never
    // valid, and — the one that actually bites — flushes `_pausedResizeTask`,
    // the renderer resize queued when `resize()` ran while paused. That is
    // exactly the reveal case (geometry re-fit, then unpause), so skipping it
    // would repaint at the old surface size.
    const resume = renderService._handleIntersectionChange;
    if (typeof resume === "function") {
      resume.call(renderService, {
        isIntersecting: true,
        intersectionRatio: 1,
      } as IntersectionObserverEntry);
    } else {
      renderService._isPaused = false;
    }
    // Belt and braces: the handler only repaints when `_needsFullRefresh` was
    // set, and the fallback above repaints nothing at all.
    terminal.refresh(0, Math.max(0, terminal.rows - 1));
    return true;
  } catch (err) {
    // Leave the flag as we found it so the watchdog re-detects the pause and
    // retries under the attempt cap, rather than believing this pane recovered.
    // Read defensively — a throwing getter is how we got here in the first place.
    try {
      if (renderService?._isPaused === false) renderService._isPaused = true;
    } catch {
      // Nothing more to do; the breaker bounds the retries either way.
    }
    logWarn("forceXtermRendererUnpause failed", { error: err });
    return false;
  }
}

/**
 * Outcome of a bounded unpause attempt. `capped` means the breaker was already
 * latched (silent); `exhausted` means THIS call tripped it.
 */
export type RendererUnpauseOutcome = "issued" | "failed" | "exhausted" | "capped";

/**
 * The single bounded entry point for every AUTOMATIC renderer-unpause repair —
 * the watchdog sweep, the per-write path, the 3s heartbeat, and focus/visibility
 * recovery (#11800).
 *
 * Accounting lives here rather than in any one caller because a cap only bounds
 * the loop if every autonomous path goes through it. The reflow controller's
 * heartbeat runs at the watchdog's own 3s cadence and its write path at 250ms,
 * so an uncounted repair there would keep a pane that IO re-pauses in exactly
 * the full-grid repaint loop this cap exists to stop.
 */
export function attemptRendererUnpause(managed: ManagedTerminal): RendererUnpauseOutcome {
  // A fresh incarnation reusing this id starts clean — a previous instance's
  // give-up can't describe a renderer it never owned.
  if (managed.rendererUnpauseGeneration !== managed.attachGeneration) {
    resetRendererUnpauseBreaker(managed);
  }
  if (managed.rendererUnpauseGaveUp === true) return "capped";

  const attempts = managed.rendererUnpauseAttempts ?? 0;
  if (attempts >= MAX_RENDERER_UNPAUSE_ATTEMPTS) {
    managed.rendererUnpauseGaveUp = true;
    return "exhausted";
  }

  managed.rendererUnpauseAttempts = attempts + 1;
  managed.rendererUnpauseAttemptedAt = Date.now();
  // A `false` still consumed an attempt: a drifted or throwing primitive is
  // precisely the case that must not retry forever.
  return forceXtermRendererUnpause(managed.terminal) ? "issued" : "failed";
}

/**
 * Re-arm the breaker. Called on an observed unpause, on re-attach, when the
 * terminal instance is replaced (a new RenderService has its own pause state and
 * must not inherit a latch), and on an explicit user Redraw — the events that
 * genuinely change whether a repair could succeed. Deliberately NOT time-based:
 * a periodic re-arm would just restore the slow repaint loop.
 */
export function resetRendererUnpauseBreaker(managed: ManagedTerminal): void {
  managed.rendererUnpauseGeneration = managed.attachGeneration;
  managed.rendererUnpauseAttempts = 0;
  managed.rendererUnpauseGaveUp = false;
  managed.rendererUnpauseAttemptedAt = undefined;
}

// Throttle per-terminal repairs to bound repaint cost under write bursts while
// still recovering a paused renderer within one write cadence window.
const REFLOW_THROTTLE_MS = 250;

// Periodic heartbeat interval — low frequency is enough to recover a paused
// renderer that has no writes, without costing measurable CPU. Exported for the
// same reason as the watchdog's WATCHDOG_INTERVAL_MS: tests assert the
// one-sweep-per-interval invariant and must not hard-code the cadence.
export const REFLOW_HEARTBEAT_MS = 3000;

export interface ReflowControllerDeps {
  /**
   * Live iterator over all managed terminals — the heartbeat and
   * visibility/focus listeners sweep every instance and let
   * `maybeReflow()` apply its per-terminal eligibility guards.
   */
  getInstances: () => Iterable<ManagedTerminal>;
}

/**
 * Owns the three layered unpause-recovery triggers for visible terminals:
 *  1. Per-write via `maybeReflow()` (called from `onWriteParsedReflow`)
 *  2. 3 s heartbeat sweep — recovers a paused renderer with no writes
 *  3. Window focus / document visibilitychange — the moments a user is most
 *     likely to notice a blank terminal
 *
 * Co-locating all three preserves the trigger invariant from #5092: removing
 * any one path silently breaks recovery in some scenarios. The repair they
 * share used to be a padding jitter that could never unpause anything (#11800);
 * they now drive `forceXtermRendererUnpause` instead.
 */
export class TerminalReflowController {
  private deps: ReflowControllerDeps;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly offViewLifecycle: () => void;
  private readonly _onVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.sweep();
  };
  private readonly _onWindowFocus = (): void => {
    this.sweep();
  };

  constructor(deps: ReflowControllerDeps) {
    this.deps = deps;

    this.startHeartbeat();

    // App-level recovery: reflow visible terminals whenever the window
    // regains focus or the tab becomes visible. These are the moments a
    // user is most likely to notice a blank terminal.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", this._onWindowFocus);
    }

    // A cached view never fires visibilitychange, so the heartbeat's own
    // visibility check can't stop it and it would keep forcing layout on
    // terminals nobody can see (#11212). Stop the wakeups outright while
    // cached — `maybeReflow` stays gated regardless, but only stopping the
    // interval actually removes the idle wakeup.
    this.offViewLifecycle = subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") {
        this.stopHeartbeat();
        return;
      }
      this.startHeartbeat();
      // A renderer paused while the view was cached needs the same immediate
      // recovery visibilitychange gives a backgrounded window — waiting out
      // the remaining heartbeat would leave the pane blank for up to 3s at the
      // exact moment the user is looking at it.
      if (phase === "revealed") this.sweep();
    });
  }

  private sweep(): void {
    for (const managed of this.deps.getInstances()) {
      this.maybeReflow(managed);
    }
  }

  /**
   * Periodic heartbeat: recovers a terminal whose IntersectionObserver has
   * paused rendering, even while no new writes are arriving. The pause gate
   * lives in xterm's core RenderService, so WebGL and DOM renderers alike are
   * affected. Cheap (~1–5ms per visible terminal). Idempotent — a rearm while
   * already running keeps the existing timer rather than stacking a second.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) return;
    // Construction can happen INSIDE a cached window: the module seeds its state
    // from preload's latch, so there is no "cached" phase to stop a timer armed
    // in the constructor, and it would tick unopposed until the view returns.
    if (isProjectViewCached()) return;
    if (typeof setInterval !== "function") return;
    this.heartbeatTimer = setInterval(() => {
      // maybeReflow re-applies the full gate per terminal; this is the cheap
      // whole-sweep skip for a hidden window (visibilitychange sweeps on
      // regain).
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      this.sweep();
    }, REFLOW_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * Resume a paused renderer if this terminal is eligible — used by
   * onWriteParsed, the periodic heartbeat, and the visibility/focus recovery
   * paths. All guards live here so every caller stays consistent.
   *
   * Applies to agent terminals too: xterm 6's pause gate lives in the core
   * RenderService, so a WebGL-rendered terminal is just as susceptible as a
   * DOM one (and after a webglcontextlost it falls back to the DOM renderer
   * with no requeue). Skips: invisible/attaching terminals, alt-buffer (TUI)
   * sessions, terminals without a connected element, an occluded window, and
   * an open synchronized-output block. Throttled per terminal.
   */
  maybeReflow(managed: ManagedTerminal): void {
    // The decisive gate lives here rather than only on the heartbeat: the
    // per-write path (`onWriteParsedReflow` → `maybeReflowTerminal`) calls this
    // directly, so a streaming agent in a cached view would keep forcing layout
    // no matter what the interval does (#11212). A cached view's
    // visibilityState is permanently "visible", so this is the only check that
    // sees it — the document check below still covers window-level occlusion.
    if (isProjectViewCached()) return;
    if (!managed.isVisible) return;
    if (managed.isAttaching) return;
    if (managed.isAltBuffer) return;
    const element = managed.terminal.element;
    if (!element) return;
    // A transiently-detached element can't be unpaused by a reflow, and
    // stamping lastReflowAt here would throttle away the next legitimate
    // reflow once it's reattached.
    if (!element.isConnected) return;
    // xterm 6 buffers row refreshes and renders them atomically at ESU when
    // DEC mode 2026 (Synchronized Output) is active. Forcing an
    // IntersectionObserver jitter mid-block would interleave a paint with
    // the buffered range. Skip without stamping the throttle so we reflow
    // on the next tick after ESU.
    // The per-write path reaches this method directly, so the heartbeat's own
    // document check can't cover it: forcing a repaint while the window is
    // occluded paints nothing (rAF is suspended there) and the visibilitychange
    // sweep already recovers the moment it returns.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    if (managed.terminal.modes?.synchronizedOutputMode === true) return;
    // Only a readable `true` is actionable. The repair clears xterm's private
    // pause flag, so an unpaused renderer needs nothing and API drift
    // (`undefined`) leaves no flag to clear — falling through on drift, as the
    // reflow era did for #5092, would stamp the throttle for a guaranteed no-op.
    if (readXtermRenderPaused(managed.terminal) !== true) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - (managed.lastReflowAt ?? 0) < REFLOW_THROTTLE_MS) return;
    managed.lastReflowAt = now;

    // Shares the watchdog's cap: this path fires far more often (every write,
    // every 3s heartbeat, every focus), so leaving it uncounted would let a pane
    // that IO keeps re-pausing repaint forever no matter what the watchdog
    // decided (#11800).
    if (attemptRendererUnpause(managed) === "exhausted") {
      logWarn(
        "[TerminalReflowController] xterm renderer still paused after repeated unpause repairs — giving up (circuit breaker)",
        { id: managed.id, limit: MAX_RENDERER_UNPAUSE_ATTEMPTS }
      );
    }
  }

  dispose(): void {
    this.stopHeartbeat();
    this.offViewLifecycle();
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", this._onWindowFocus);
    }
  }
}
