import type { ManagedTerminal } from "./types";
import { logWarn } from "@/utils/logger";

/**
 * Force a synchronous reflow that triggers xterm.js's IntersectionObserver
 * re-evaluation without pausing the renderer. Using display:none would set
 * isIntersecting=false, causing xterm to set _isPaused=true and halt rendering.
 * Sub-pixel padding jitter keeps the element in the layout tree throughout.
 */
export function forceXtermReflow(element: HTMLElement): void {
  const prev = element.style.paddingTop;
  element.style.paddingTop = "0.01px";
  void element.offsetHeight;
  element.style.paddingTop = prev;
}

// Throttle per-terminal reflows to bound layout cost under write bursts while
// still recovering a paused DOM renderer within one write cadence window.
const REFLOW_THROTTLE_MS = 250;

// Periodic heartbeat interval — low frequency is enough to recover a paused
// renderer that has no writes, without costing measurable CPU.
const REFLOW_HEARTBEAT_MS = 3000;

export interface ReflowControllerDeps {
  /**
   * Live iterator over all managed terminals — the heartbeat and
   * visibility/focus listeners sweep every instance and let
   * `maybeReflow()` apply its per-terminal eligibility guards.
   */
  getInstances: () => Iterable<ManagedTerminal>;
}

/**
 * Owns the three layered IO-unpause recovery paths for standard (DOM-renderer)
 * terminals:
 *  1. Per-write reflow via `maybeReflow()` (called from `onWriteParsedReflow`)
 *  2. 3 s heartbeat sweep — recovers a paused renderer with no writes
 *  3. Window focus / document visibilitychange — the moments a user is most
 *     likely to notice a blank terminal
 *
 * Co-locating all three layers preserves the recovery invariant from #5092:
 * removing any one path silently breaks recovery in some scenarios.
 */
export class TerminalReflowController {
  private deps: ReflowControllerDeps;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private readonly _onVisibilityChange = (): void => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    for (const managed of this.deps.getInstances()) {
      this.maybeReflow(managed);
    }
  };
  private readonly _onWindowFocus = (): void => {
    for (const managed of this.deps.getInstances()) {
      this.maybeReflow(managed);
    }
  };

  constructor(deps: ReflowControllerDeps) {
    this.deps = deps;

    // Periodic heartbeat: recovers a DOM-renderer terminal whose
    // IntersectionObserver has paused rendering, even while no new writes are
    // arriving. Cheap (~1–5ms per visible non-agent terminal). Skipped while
    // the document is hidden — _onVisibilityChange triggers a sweep on regain.
    if (typeof setInterval === "function") {
      this.heartbeatTimer = setInterval(() => {
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        for (const managed of this.deps.getInstances()) {
          this.maybeReflow(managed);
        }
      }, REFLOW_HEARTBEAT_MS);
    }

    // App-level recovery: reflow visible terminals whenever the window
    // regains focus or the tab becomes visible. These are the moments a
    // user is most likely to notice a blank terminal.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", this._onWindowFocus);
    }
  }

  /**
   * Force an IntersectionObserver reflow on a standard terminal if it's
   * eligible — used by onWriteParsed, the periodic heartbeat, and
   * visibility/focus recovery paths. All guards live here so every caller
   * stays consistent.
   *
   * Skips: agent terminals (WebGL, immune), hibernated/invisible/attaching
   * terminals, alt-buffer (TUI) sessions, and terminals without a rendered
   * element. Throttled per terminal.
   */
  maybeReflow(managed: ManagedTerminal): void {
    if (managed.runtimeAgentId) return;
    if (managed.isHibernated) return;
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
    if (managed.terminal.modes?.synchronizedOutputMode === true) return;

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - (managed.lastReflowAt ?? 0) < REFLOW_THROTTLE_MS) return;
    managed.lastReflowAt = now;

    try {
      forceXtermReflow(element);
    } catch (err) {
      logWarn("forceXtermReflow failed", { error: err });
    }
  }

  dispose(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("focus", this._onWindowFocus);
    }
  }
}
