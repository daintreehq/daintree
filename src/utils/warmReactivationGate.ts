import { PERF_MARKS } from "@shared/perf/marks";
import { flushPendingPerfMarks } from "@/utils/performance";
import { markSwitch } from "./switchTrace";

/**
 * Renderer half of the warm-reactivation paint gate (#9679).
 *
 * When `ProjectViewManager` reactivates a warm cached `WebContentsView`, it
 * covers the incoming view with an opaque background color before `addChildView`
 * so Chromium's compositor can't flash the stale pre-freeze WebGL surface. The
 * cover is held until this renderer signals that its wake fan-out has finished
 * and a clean post-atlas-repair frame has painted.
 *
 * Fired unconditionally after every {@link wakeActiveWorktreeTerminals} pass:
 * main only holds a gate when it actually armed one for this view's warm switch,
 * so a signal with no pending gate is a harmless no-op. Unlike the one-shot
 * `notifyViewPainted` (cold start), this is re-fireable across reactivations.
 *
 * The double `requestAnimationFrame` mirrors `removeStartupSkeleton`: the first
 * rAF lands after the wake's synchronous `terminal.refresh()` work commits, the
 * second guarantees the compositor has produced one frame reflecting the
 * repaired atlas before main drops the cover.
 */
export function notifyWarmReactivationComplete(): void {
  const fire = (): void => {
    markSwitch(PERF_MARKS.PROJECT_SWITCH_WARM_PAINT_SIGNALLED);
    flushPendingPerfMarks();
    try {
      window.electron?.app?.notifyWarmViewPainted?.().catch(() => {
        // Main may have already released the gate via its timeout fallback —
        // safe to ignore.
      });
    } catch {
      // Preload bridge may be unavailable in exotic test contexts — safe to ignore.
    }
  };

  if (typeof requestAnimationFrame !== "function") {
    fire();
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(fire);
  });
}
