import { useEffect, useRef } from "react";

const DOUBLE_TAP_WINDOW_MS = 300;
const COOLDOWN_MS = 500;

export function useDoubleShift(callback: () => void, enabled: boolean = true): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let lastShiftUpTime = 0;
    let shiftDownWithoutOtherKeys = false;
    let cooldownUntil = 0;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        // Only track if no other modifiers are held
        shiftDownWithoutOtherKeys = !e.metaKey && !e.ctrlKey && !e.altKey;
        return;
      }
      // Any other key pressed while Shift is down invalidates the sequence
      shiftDownWithoutOtherKeys = false;
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;

      if (!shiftDownWithoutOtherKeys) {
        shiftDownWithoutOtherKeys = false;
        return;
      }

      // Don't trigger if other modifiers are currently held
      if (e.metaKey || e.ctrlKey || e.altKey) {
        shiftDownWithoutOtherKeys = false;
        return;
      }

      // Skip if in editable context
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const isInTerminal = target.closest(".xterm") !== null;
      if (isEditable || isInTerminal) {
        shiftDownWithoutOtherKeys = false;
        return;
      }

      const now = Date.now();

      // Cooldown to prevent rapid retriggering
      if (now < cooldownUntil) {
        shiftDownWithoutOtherKeys = false;
        return;
      }

      if (now - lastShiftUpTime < DOUBLE_TAP_WINDOW_MS) {
        // Double-tap detected
        lastShiftUpTime = 0;
        cooldownUntil = now + COOLDOWN_MS;
        callbackRef.current();
      } else {
        lastShiftUpTime = now;
      }

      shiftDownWithoutOtherKeys = false;
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
  }, [enabled]);
}
