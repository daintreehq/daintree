import type { Terminal } from "@xterm/xterm";

/**
 * Pause and resume xterm's renderer for a cached project view (#12514).
 *
 * A cached view keeps parsing its terminals' output (the byte stream stays
 * live so reactivation needs no resync, #10811/#11220), but nothing can see
 * it, so every repaint is waste. xterm already has the right primitive:
 * `RenderService._isPaused`, set by its IntersectionObserver, makes every
 * render entry point record `_needsFullRefresh` and return while writes keep
 * mutating the buffer. The observer never fires for a cached view — Chromium
 * tracks occlusion per BrowserWindow, not per child view — so we drive the
 * same transition ourselves.
 *
 * Driving it once is not enough: the observer would lift the pause on its
 * next delivery, and a terminal opened while cached (background restore
 * parks whole projects this way) gets its first delivery after we pause it.
 * So the handler is wrapped: while suspended, real observations are recorded
 * but answered with "not intersecting", and resume replays the last real one
 * — a pane that genuinely scrolled out of view while cached stays paused.
 *
 * Pinned to @xterm/xterm 6.1.0-beta.300, where `_handleIntersectionChange` is
 * the only writer of `_isPaused` and the observer invokes it through `this` at
 * call time (RenderService `_registerIntersectionObserver`), so an instance
 * property shadows it. Every access fails closed: on API drift the terminal
 * simply keeps rendering, which is today's behaviour.
 */

// The two fields xterm's handler reads — all a synthetic observation needs.
type ObservedIntersection = Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">;

type RenderServiceLike = {
  _isPaused?: boolean;
  _handleIntersectionChange?: (entry: ObservedIntersection) => void;
};

interface SuspensionGuard {
  suspended: boolean;
  lastObserved: ObservedIntersection;
  original: (entry: ObservedIntersection) => void;
}

const NOT_INTERSECTING: ObservedIntersection = { isIntersecting: false, intersectionRatio: 0 };

const guards = new WeakMap<RenderServiceLike, SuspensionGuard>();

function getRenderService(terminal: Terminal): RenderServiceLike | undefined {
  try {
    return (terminal as Terminal & { _core?: { _renderService?: RenderServiceLike } })._core
      ?._renderService;
  } catch {
    return undefined;
  }
}

function installGuard(renderService: RenderServiceLike): SuspensionGuard | undefined {
  const existing = guards.get(renderService);
  if (existing) return existing;
  const original = renderService._handleIntersectionChange;
  if (typeof original !== "function") return undefined;

  const paused = renderService._isPaused === true;
  const guard: SuspensionGuard = {
    suspended: false,
    lastObserved: { isIntersecting: !paused, intersectionRatio: paused ? 0 : 1 },
    original,
  };
  renderService._handleIntersectionChange = (entry: ObservedIntersection) => {
    guard.lastObserved = {
      isIntersecting: entry.isIntersecting,
      intersectionRatio: entry.intersectionRatio,
    };
    original.call(renderService, guard.suspended ? NOT_INTERSECTING : entry);
  };
  guards.set(renderService, guard);
  return guard;
}

/**
 * Stop the terminal from painting until {@link resumeXtermRender}. Idempotent.
 * Returns whether the terminal is now suspended.
 */
export function suspendXtermRender(terminal: Terminal): boolean {
  try {
    const renderService = getRenderService(terminal);
    if (!renderService) return false;
    const guard = installGuard(renderService);
    if (!guard) return false;
    if (guard.suspended) return true;
    guard.suspended = true;
    guard.original.call(renderService, NOT_INTERSECTING);
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo {@link suspendXtermRender}: hand xterm the last real observation and,
 * when the pane is on screen, force a full repaint of the buffer that kept
 * updating while suspended. A no-op for a terminal that was never suspended,
 * so it never unpauses a pane xterm's own observer paused.
 */
export function resumeXtermRender(terminal: Terminal): void {
  try {
    const renderService = getRenderService(terminal);
    if (!renderService) return;
    const guard = guards.get(renderService);
    if (!guard?.suspended) return;
    guard.suspended = false;
    guard.original.call(renderService, guard.lastObserved);
    // The handler repaints only when a refresh was skipped while paused; the
    // explicit range covers the rest and coalesces with it in the debouncer.
    if (guard.lastObserved.isIntersecting) {
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    }
  } catch {
    // Fail open — the reconciliation watchdog repairs a pane left paused.
  }
}

export function isXtermRenderSuspended(terminal: Terminal): boolean {
  const renderService = getRenderService(terminal);
  return renderService ? guards.get(renderService)?.suspended === true : false;
}
