/**
 * Process-wide signal for whether this project view is currently cached —
 * backgrounded by `ProjectViewManager` but kept alive for a fast switch back.
 *
 * `document.visibilityState` cannot answer this. Caching a view is
 * `removeChildView` + `setVisible(false)` (see
 * `ProjectViewLifecycleController.deactivateEntry`), and neither flips page
 * visibility for a child `WebContentsView` — Chromium tracks occlusion at the
 * `BrowserWindow` level, so a cached view reports `"visible"` forever and its
 * `requestAnimationFrame` callbacks keep firing at the full rate. Every gate
 * written as `document.visibilityState !== "visible"` is therefore dead code
 * for a cached view, which is how a hidden project ended up at 4.5% CPU and
 * 3300 idle wakeups/sec (#11212).
 *
 * The CPU throttle main applies alongside the cache
 * (`Emulation.setCPUThrottlingRate`) slows each callback but does not reduce
 * how often they fire; only a `Page.setWebLifecycleState` freeze does, and
 * that is deliberately skipped while the cached project has a live agent —
 * exactly the case that costs the most. So the renderer has to demote its own
 * periodic work, and main's explicit lifecycle IPC is the only signal that
 * reliably tracks it.
 *
 * Single renderer = single view. Module-level state is safe — each project
 * view is a distinct WebContentsView with its own V8 context (see
 * `ProjectViewManager`), so there is exactly one view per module scope. This
 * mirrors `layoutTransitionLock`.
 *
 * Consumers must AND this with the visibility check they already have rather
 * than replacing it: minimizing the window still legitimately flips
 * `document.visibilityState`, and that suppression is independent of caching.
 */

/**
 * - `cached` — main has detached and hidden this view. Periodic/rAF work
 *   should stop; nothing can observe this view until it comes back.
 * - `active` — main has re-attached the view, but it may still sit behind the
 *   anti-flash bridge where Chromium culls paints. Timers may rearm.
 * - `revealed` — the view is the presenting foreground surface. Deferred
 *   catch-up work should run now.
 */
export type ProjectViewLifecyclePhase = "cached" | "active" | "revealed";

let cached = false;
let armed = false;
let disarm: (() => void) | undefined;
const listeners = new Set<(phase: ProjectViewLifecyclePhase) => void>();

function emit(phase: ProjectViewLifecyclePhase): void {
  // Snapshot — a callback may unsubscribe during iteration.
  for (const listener of Array.from(listeners)) {
    try {
      listener(phase);
    } catch {
      // Swallow per-listener errors so one bad subscriber can't block others.
    }
  }
}

/**
 * Attach to main's lifecycle broadcasts once, on first use. Arming lazily (and
 * from the query as well as the subscribe) keeps this module free of
 * import-time side effects while making a query-only consumer impossible to
 * get wrong — an unarmed module would answer "not cached" forever.
 *
 * Seeds from preload's latch rather than assuming false. The signals are
 * non-replaying edges and a cold switch is released at the pre-React skeleton,
 * so a switch storm can cache this view before this module ever evaluates;
 * preload has been tracking since before any page script ran, and is the only
 * thing that can answer for the window we missed. Absent the bridge (or an
 * older preload), false is the safe default — the un-demoted answer.
 */
function ensureArmed(): void {
  if (armed) return;
  armed = true;

  // `TerminalInstanceService` constructs its controllers at module scope, so
  // importing anything downstream of it runs this in node-like suites where
  // `window` is not merely empty but undeclared — a bare read is a
  // ReferenceError, not something `?.` can catch. No window, no view lifecycle;
  // not-cached is the right answer.
  if (typeof window === "undefined") return;

  const app = window.electron?.app;
  if (!app) return;

  cached = app.isViewCached?.() ?? false;

  const offCached = app.onViewCached?.(() => {
    if (cached) return;
    cached = true;
    emit("cached");
  });
  // Fires on every reactivation, before the bridge is torn down. This — not
  // `revealed` — is what clears the cached flag: main only sends `revealed`
  // when the view is still the active project by the time the swap completes
  // (`ProjectViewSwitchController`), so a switch superseded mid-flight would
  // leave a reactivated view demoted forever if `revealed` owned the clear.
  const offWarmActivated = app.onViewWarmActivated?.(() => {
    cached = false;
    emit("active");
  });
  const offRevealed = app.onViewRevealed?.(() => {
    // Defensive: `revealed` implies the view is foreground, so it must never
    // leave a stale cached flag behind even if `warm-activated` was missed.
    cached = false;
    emit("revealed");
  });

  disarm = () => {
    offCached?.();
    offWarmActivated?.();
    offRevealed?.();
  };
}

/** Whether main has this project view cached (detached + hidden). */
export function isProjectViewCached(): boolean {
  ensureArmed();
  return cached;
}

/**
 * Subscribe to view lifecycle transitions. Returns an unsubscribe. Listeners
 * fire after the cached flag is updated, so a handler can read
 * `isProjectViewCached()` and see the new state.
 */
export function subscribeProjectViewLifecycle(
  listener: (phase: ProjectViewLifecyclePhase) => void
): () => void {
  ensureArmed();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function __resetProjectViewCacheStateForTests(): void {
  disarm?.();
  disarm = undefined;
  armed = false;
  cached = false;
  listeners.clear();
}
