import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function AllClearOverlay() {
  const [visible, setVisible] = useState(false);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const cleanup = window.electron.terminal.onAllAgentsClear((data) => {
      // `shouldFlash` is computed main-process-side, from the single
      // freshest copy of settings (flashEnabled, the master enabled toggle,
      // and the same suppression chain as the sound — quiet hours, session
      // mute, OS DND). See AgentNotificationService.checkAllClear (#12185).
      // Recomputing this from a per-project-view renderer store would go
      // stale the moment a second open view's settings changed elsewhere.
      if (!data.shouldFlash) return;

      // These three remain renderer-only concerns — CSS media queries and
      // DOM attributes the main process has no way to observe.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      if (document.body.getAttribute("data-reduce-animations") === "true") return;
      if (document.body.getAttribute("data-performance-mode") === "true") return;

      setVisible(true);
    });
    return cleanup;
  }, []);

  const handleAnimationEnd = useCallback((event: React.AnimationEvent) => {
    if (event.animationName === "all-clear-flash") {
      setVisible(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    safetyTimerRef.current = setTimeout(() => setVisible(false), 500);
    return () => {
      if (safetyTimerRef.current !== null) clearTimeout(safetyTimerRef.current);
    };
  }, [visible]);

  if (!visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 pointer-events-none z-[200] animate-all-clear-flash bg-status-success"
      aria-hidden="true"
      onAnimationEnd={handleAnimationEnd}
    />,
    document.body
  );
}
