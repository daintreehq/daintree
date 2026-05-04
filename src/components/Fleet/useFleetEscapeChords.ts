import { useEffect, useRef } from "react";
import { actionService } from "@/services/ActionService";
import type { FleetPendingActionSnapshot } from "@/store/fleetPendingActionStore";
import type { PendingFleetBroadcast } from "@/store/fleetBroadcastConfirmStore";

const DOUBLE_ESC_WINDOW_MS = 350;

export function useFleetEscapeChords(
  armedCount: number,
  exitFleet: () => void,
  pending: FleetPendingActionSnapshot | null,
  popoverOpen: boolean,
  pendingBroadcast: PendingFleetBroadcast | null
): void {
  const lastEscapeMsRef = useRef<number>(0);
  const lastBareEscapeMsRef = useRef<number>(0);
  const pendingExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitFleetRef = useRef(exitFleet);
  useEffect(() => {
    exitFleetRef.current = exitFleet;
  }, [exitFleet]);

  // Mirror modal state into a ref so the capture-phase handler (whose
  // effect only re-binds on armedCount change) can skip bare-Escape
  // double-tap detection when an Escape-stack handler should win instead
  // — pending confirm, popover, and pending broadcast all absorb bare
  // Escape via useEscapeStack and must not also start a double-tap timer.
  const bareEscapeBlockedRef = useRef(false);
  useEffect(() => {
    bareEscapeBlockedRef.current = pending !== null || popoverOpen || pendingBroadcast !== null;
  }, [pending, popoverOpen, pendingBroadcast]);

  useEffect(() => {
    const clearPendingExit = () => {
      if (pendingExitTimerRef.current !== null) {
        clearTimeout(pendingExitTimerRef.current);
        pendingExitTimerRef.current = null;
      }
    };

    if (armedCount === 0) {
      lastEscapeMsRef.current = 0;
      lastBareEscapeMsRef.current = 0;
      clearPendingExit();
      return;
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;

      // Bare Escape branch: detect a double-tap to dispatch fleet.interrupt
      // through batchDoubleEscape so every armed agent gets the
      // deterministically-timed double-Esc gesture (#5964). The first tap
      // passes through untouched so xterm still broadcasts a single raw
      // \x1b for menu/prompt dismissal across the armed set; the second
      // tap is consumed by the ribbon and translated into the action.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Held Escape auto-repeats at ~30 Hz on macOS / Windows, so the
        // first OS-generated repeat would satisfy the double-tap window
        // and misfire fleet.interrupt. Modifier-key chords don't repeat,
        // which is why the existing ⌘Esc branch can omit this guard.
        if (e.repeat) return;
        if (bareEscapeBlockedRef.current) {
          lastBareEscapeMsRef.current = 0;
          return;
        }
        // Bare double-Esc in a non-xterm editable input (composer, settings
        // textarea, recipe editor) belongs to that input — fleet.interrupt
        // would surprise the user who pressed Esc to dismiss the input.
        // The xterm helper textarea is a TEXTAREA but lives under .xterm,
        // so the closest() guard preserves terminal Esc handling.
        const rawTarget = e.target;
        const target =
          rawTarget && typeof (rawTarget as HTMLElement).closest === "function"
            ? (rawTarget as HTMLElement)
            : null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable) &&
          target.closest(".xterm") === null
        ) {
          lastBareEscapeMsRef.current = 0;
          return;
        }
        const nowBare = Date.now();
        const prevBare = lastBareEscapeMsRef.current;
        if (prevBare !== 0 && nowBare - prevBare <= DOUBLE_ESC_WINDOW_MS) {
          lastBareEscapeMsRef.current = 0;
          e.preventDefault();
          e.stopPropagation();
          void actionService.dispatch(
            "fleet.interrupt",
            { confirmed: true },
            { source: "keybinding" }
          );
          return;
        }
        lastBareEscapeMsRef.current = nowBare;
        return;
      }

      if (!e.metaKey && !e.ctrlKey) return;
      const now = Date.now();
      const prev = lastEscapeMsRef.current;

      if (prev !== 0 && now - prev <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeMsRef.current = 0;
        clearPendingExit();
        e.stopPropagation();
        e.preventDefault();
        void actionService.dispatch("fleet.interrupt", undefined, { source: "keybinding" });
        return;
      }

      lastEscapeMsRef.current = now;
      e.stopPropagation();
      e.preventDefault();
      clearPendingExit();
      pendingExitTimerRef.current = setTimeout(() => {
        pendingExitTimerRef.current = null;
        lastEscapeMsRef.current = 0;
        exitFleetRef.current();
      }, DOUBLE_ESC_WINDOW_MS);
    };

    const handleBlur = () => {
      lastEscapeMsRef.current = 0;
      lastBareEscapeMsRef.current = 0;
      clearPendingExit();
    };

    window.addEventListener("keydown", handler, true);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("blur", handleBlur);
      clearPendingExit();
    };
  }, [armedCount]);
}
