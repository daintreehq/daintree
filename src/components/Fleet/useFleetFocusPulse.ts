import { useEffect, useRef, useState } from "react";

const PULSE_DURATION_MS = 800;

/**
 * Pulse the fleet ribbon border briefly when the OS window regains focus
 * while broadcast is still armed. Protects against the "I left for Slack and
 * forgot I was in broadcast mode" mode-slip that makes live echo dangerous.
 *
 * Matches the `useReEntrySummary` pattern: `window.focus` + `document.hasFocus()`
 * guard. `document.visibilitychange` is unreliable for OS-level return in
 * Electron's WebContentsView — only `window.focus` fires on Cmd+Tab return.
 */
export function useFleetFocusPulse(armedCount: number): boolean {
  const [pulseEpoch, setPulseEpoch] = useState(0);
  const [pulsing, setPulsing] = useState(false);
  const wasAwayRef = useRef(false);
  const armedCountRef = useRef(armedCount);

  useEffect(() => {
    armedCountRef.current = armedCount;
  }, [armedCount]);

  useEffect(() => {
    const handleFocus = () => {
      if (!document.hasFocus()) return;
      if (!wasAwayRef.current) return;
      wasAwayRef.current = false;
      if (armedCountRef.current === 0) return;
      // Epoch bump restarts the pulse-duration timeout via the effect
      // below, so a second focus-return within 800ms gets a fresh pulse
      // instead of inheriting the remaining time from the first.
      setPulseEpoch((n) => n + 1);
    };

    const handleBlur = () => {
      wasAwayRef.current = true;
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  useEffect(() => {
    if (pulseEpoch === 0) return;
    setPulsing(true);
    const id = setTimeout(() => setPulsing(false), PULSE_DURATION_MS);
    return () => clearTimeout(id);
  }, [pulseEpoch]);

  return pulsing;
}
