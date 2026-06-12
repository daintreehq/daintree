import { UI_EXIT_DURATION } from "../lib/animationUtils";
import { prefersReducedMotion } from "../lib/appThemeViewTransition";
import { flushFinalCls } from "./layoutShiftMonitor";
import { flushPendingPerfMarks, startSteadyStatePerfFlush } from "./performance";

const SKELETON_ID = "startup-skeleton";

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => {
    ready: Promise<void>;
    finished: Promise<void>;
  };
};

let firstInteractiveNotified = false;
let viewPaintedNotified = false;

/**
 * Signal the main process that this view's React shell has committed its
 * first structural paint. Distinct from {@link notifyFirstInteractive}
 * because it fires *before* hydration so `ProjectViewManager` can swap
 * outgoing → incoming WebContentsView without waiting for full data load.
 * Idempotent across the V8 context lifetime.
 */
export function notifyViewPainted(): void {
  if (viewPaintedNotified) return;
  viewPaintedNotified = true;
  try {
    window.electron?.app?.notifyViewPainted?.().catch(() => {
      // Main may have already taken the timeout fallback path — safe to ignore
    });
  } catch {
    // Preload bridge may be unavailable in exotic test contexts — safe to ignore
  }
}

function notifyFirstInteractive(): void {
  // Snapshot cumulative CLS at the renderer-side first-interactive boundary
  // before the IPC roundtrip — this is the regression-relevant window. The
  // follow-up `flushPendingPerfMarks` is required because the only other
  // flush point (HYDRATE_COMPLETE in stateHydration/index.ts) clears the
  // buffer; without this drain `renderer_cls_final` and any post-hydration
  // marks would never reach the NDJSON. Both calls are idempotent.
  flushFinalCls();
  flushPendingPerfMarks();
  if (firstInteractiveNotified) return;
  firstInteractiveNotified = true;
  // From here on the buffer has no boundary flush left — keep steady-state
  // marks flowing into the NDJSON capture for the rest of the session.
  // No-op unless DAINTREE_PERF_CAPTURE is set; runs for the context lifetime.
  startSteadyStatePerfFlush();
  try {
    window.electron?.app?.notifyFirstInteractive?.().catch(() => {
      // Main process may already have drained the queue or fallback fired — safe to ignore
    });
  } catch {
    // Preload bridge may be unavailable in exotic test contexts — safe to ignore
  }
}

/**
 * Fade out and remove the startup skeleton overlay, and signal the main
 * process that the renderer is interactive so it can drain its deferred
 * service queue. Uses requestAnimationFrame to ensure React has painted
 * real content before both the fade and the signal fire, then prefers
 * the View Transitions API for a GPU-snapshot crossfade — falling back
 * to a plain CSS opacity transition under reduced-motion / performance
 * mode / older runtimes.
 */
export function removeStartupSkeleton(): void {
  const el = document.getElementById(SKELETON_ID);
  if (!el) {
    notifyFirstInteractive();
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      notifyFirstInteractive();
      el.setAttribute("aria-busy", "false");

      const doc = document as ViewTransitionDocument;
      const canViewTransition =
        typeof doc.startViewTransition === "function" &&
        doc.visibilityState === "visible" &&
        !prefersReducedMotion();

      if (canViewTransition) {
        const transition = doc.startViewTransition!(() => {
          el.remove();
        });
        // The shared `::view-transition-old(root)` / `::view-transition-new(root)`
        // rules in src/index.css set `animation: none` so the theme-reveal can
        // drive its own clip-path animation via WAAPI. We follow the same
        // pattern: fade the old root snapshot out over UI_EXIT_DURATION.
        transition.ready
          .then(() => {
            document.documentElement.animate(
              { opacity: [1, 0] },
              {
                duration: UI_EXIT_DURATION,
                easing: "ease-out",
                pseudoElement: "::view-transition-old(root)",
                fill: "forwards",
              }
            );
          })
          .catch(() => {
            // Transition aborted (e.g. another startViewTransition started)
            // — the callback already removed the skeleton, nothing else to do.
          });
        return;
      }

      el.classList.add("fade-out");
      setTimeout(() => {
        el.remove();
      }, UI_EXIT_DURATION);
    });
  });
}
