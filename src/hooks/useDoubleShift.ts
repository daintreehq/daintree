import { useEffect, useRef } from "react";
import { keybindingService } from "@/services/KeybindingService";

const DOUBLE_TAP_WINDOW_MS = 300;
const COOLDOWN_MS = 500;

/**
 * Two quick taps of Shift on its own. Fires wherever focus is, terminals and
 * text fields included: focus sits in a terminal's helper textarea nearly all
 * the time, so a gesture that skipped editable targets never fired at all, and
 * a bare Shift sends nothing to a PTY or an input, so nothing is taken from
 * them.
 *
 * A tap is a press of one Shift with nothing else down, released within the
 * tap window: holding Shift to think and letting go, tapping one Shift while
 * the other is held, a key already down when Shift went down, and a
 * Shift-click are all something else.
 */
export function useDoubleShift(callback: () => void, enabled: boolean = true): void {
  const callbackRef = useRef(callback);
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let lastTapAt = 0;
    let shiftDownAt = 0;
    let cleanPress = false;
    let cooldownUntil = 0;
    const shiftsDown = new Set<string>();
    const keysDown = new Set<string>();

    const breakSequence = () => {
      lastTapAt = 0;
      cleanPress = false;
    };
    const reset = () => {
      breakSequence();
      shiftsDown.clear();
      keysDown.clear();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") {
        if (e.repeat) return;
        const alone = shiftsDown.size === 0 && keysDown.size === 0;
        shiftsDown.add(e.code || "Shift");
        shiftDownAt = Date.now();
        cleanPress = alone && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing;
        if (!cleanPress) lastTapAt = 0;
        return;
      }
      // Any other key breaks the sequence: Shift+A is typing, not a tap.
      keysDown.add(e.code || e.key);
      breakSequence();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift") {
        keysDown.delete(e.code || e.key);
        return;
      }
      shiftsDown.delete(e.code || "Shift");
      const press = cleanPress && shiftsDown.size === 0;
      cleanPress = false;
      // Shift pressed into a shortcut recorder is part of a combo, and an IME
      // uses Shift to switch modes mid-composition.
      if (
        !press ||
        keybindingService.isCapturingShortcut() ||
        e.isComposing ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        lastTapAt = 0;
        return;
      }

      const now = Date.now();
      if (now - shiftDownAt > DOUBLE_TAP_WINDOW_MS || now < cooldownUntil) {
        lastTapAt = 0;
        return;
      }
      if (now - lastTapAt < DOUBLE_TAP_WINDOW_MS) {
        lastTapAt = 0;
        cooldownUntil = now + COOLDOWN_MS;
        callbackRef.current();
        return;
      }
      lastTapAt = now;
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("pointerdown", breakSequence, { capture: true });
    window.addEventListener("blur", reset);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("pointerdown", breakSequence, { capture: true });
      window.removeEventListener("blur", reset);
    };
  }, [enabled]);
}
