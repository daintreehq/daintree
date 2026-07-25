import { useEffect } from "react";
import { subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

/**
 * Background window-resize receiver (#10415).
 *
 * Main forwards debounced resize-end content bounds over
 * `project:background-resize` to cached (backgrounded) project views, whose
 * detached WebContentsViews otherwise never learn the window size changed.
 * The geometry math lives in `terminalInstanceService.applyBackgroundWindowResize`.
 * Subscribes unconditionally on mount — PTY resize is idempotent and needs no
 * hydration gate.
 *
 * Two independent signals return the view to live layout, and each has to
 * reset the scaling basis (#11443). `visibilitychange` covers a real window
 * minimize/restore; it never fires for a cached child WebContentsView, so the
 * project-view lifecycle covers the switch-back. `active` (warm-activated),
 * not `revealed`, is the one that must clear it — a switch superseded
 * mid-flight only ever gets warm-activated — with `revealed` kept as a
 * defensive backstop. Resetting twice is harmless; the basis is re-snapshotted
 * from the live viewport on the next background session.
 */
export function useBackgroundWindowResize(): void {
  useEffect(() => {
    const unsubscribe = window.electron.project.onBackgroundResize((payload) => {
      if (!payload) return;
      terminalInstanceService.applyBackgroundWindowResize(payload.width, payload.height);
    });
    const unsubscribeLifecycle = subscribeProjectViewLifecycle((phase) => {
      if (phase === "cached") return;
      terminalInstanceService.resetBackgroundResizeBasis();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        terminalInstanceService.resetBackgroundResizeBasis();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      unsubscribeLifecycle();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
