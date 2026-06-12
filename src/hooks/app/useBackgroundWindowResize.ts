import { useEffect } from "react";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

/**
 * Background window-resize receiver (#10415).
 *
 * Main forwards debounced resize-end content bounds over
 * `project:background-resize` to cached (backgrounded) project views, whose
 * detached WebContentsViews otherwise never learn the window size changed.
 * The geometry math lives in `terminalInstanceService.applyBackgroundWindowResize`.
 * Subscribes unconditionally on mount — PTY resize is idempotent and needs no
 * hydration gate. The visibilitychange listener resets the scaling basis when
 * the view returns to the foreground, where real layout owns geometry again.
 */
export function useBackgroundWindowResize(): void {
  useEffect(() => {
    const unsubscribe = window.electron.project.onBackgroundResize((payload) => {
      if (!payload) return;
      terminalInstanceService.applyBackgroundWindowResize(payload.width, payload.height);
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        terminalInstanceService.resetBackgroundResizeBasis();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
}
