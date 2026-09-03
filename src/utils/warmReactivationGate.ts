import { PERF_MARKS } from "@shared/perf/marks";
import { flushPendingPerfMarks } from "@/utils/performance";
import { markSwitch } from "./switchTrace";

/**
 * Renderer half of the warm-reactivation paint gate (#9679).
 *
 * When `ProjectViewManager` reactivates a warm cached `WebContentsView` it
 * re-attaches the view BENEATH the still-visible outgoing view and holds that
 * bridge until this renderer reports that its wake fan-out has finished.
 *
 * Fired unconditionally after every {@link wakeActiveWorktreeTerminals} pass:
 * main only holds a gate when it actually armed one for this view's warm switch,
 * so a signal with no pending gate is a harmless no-op. Unlike the one-shot
 * `notifyViewPainted` (cold start), this is re-fireable across reactivations.
 *
 * Deliberately NOT deferred to an animation frame. While the view sits behind
 * the bridge nothing it renders is drawn, and Chromium throttles an undrawn
 * view's frames to roughly two per second — so a double-rAF settle here cost
 * ~1 s per switch and, with the same wait in front of the wake, every warm
 * switch with terminal panes ran into the gate's 1.5 s hard timeout. The wake's
 * repair work is synchronous (`terminal.refresh` etc.), and the post-reveal
 * repaint pass (#10362) re-runs the paint at full frame rate once the view is
 * on top, so the gate can release as soon as the synchronous repair is done.
 */
export function notifyWarmReactivationComplete(): void {
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
}
