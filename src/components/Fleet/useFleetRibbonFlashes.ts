import { useEffect, useRef } from "react";
import { useFleetArmingStore } from "@/store/fleetArmingStore";

export function useFleetRibbonFlashes(ribbonRef: React.RefObject<HTMLDivElement | null>): void {
  // Commit flash: bypass React's render cycle entirely. We subscribe to
  // `broadcastSignal` via the Zustand external API (not the React selector
  // hook) so the ribbon does not re-render on every fanned-out keystroke
  // — vital under heavy fleet input where the counter increments per char.
  // The CSS class toggle + forced reflow restarts the keyframe even when a
  // new commit arrives mid-flash.
  const commitFlashClearRef = useRef<number | null>(null);
  useEffect(() => {
    let lastObservedSignal = useFleetArmingStore.getState().broadcastSignal;
    const unsubscribe = useFleetArmingStore.subscribe((state) => {
      if (state.broadcastSignal === lastObservedSignal) return;
      lastObservedSignal = state.broadcastSignal;
      const node = ribbonRef.current;
      if (!node) return;
      if (commitFlashClearRef.current !== null) {
        window.clearTimeout(commitFlashClearRef.current);
      }
      node.classList.remove("animate-fleet-bar-commit-flash");
      // Force reflow so the keyframe restarts even if the class is re-
      // applied within its own animation window. `void` reads a layout
      // property to pin the style flush.
      void node.offsetWidth;
      node.classList.add("animate-fleet-bar-commit-flash");
      commitFlashClearRef.current = window.setTimeout(() => {
        node.classList.remove("animate-fleet-bar-commit-flash");
        commitFlashClearRef.current = null;
      }, 180);
    });
    return () => {
      unsubscribe();
      if (commitFlashClearRef.current !== null) {
        window.clearTimeout(commitFlashClearRef.current);
        commitFlashClearRef.current = null;
      }
    };
  }, []);

  // Window-refocus pulse: when the OS window regains focus while the fleet
  // is armed, breathe the bar's stripe so the user re-orients to the active
  // mode. Reads armedCount via getState to avoid a stale closure (#5087).
  // Track the timer in a ref so rapid focus events cancel any in-flight
  // removal — otherwise the first timer's removal would cut a second
  // pulse short mid-animation.
  const refocusPulseTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const handler = () => {
      if (useFleetArmingStore.getState().armedIds.size < 2) return;
      const node = ribbonRef.current;
      if (!node) return;
      if (refocusPulseTimerRef.current !== null) {
        window.clearTimeout(refocusPulseTimerRef.current);
      }
      node.classList.remove("animate-fleet-bar-refocus-pulse");
      void node.offsetWidth;
      node.classList.add("animate-fleet-bar-refocus-pulse");
      refocusPulseTimerRef.current = window.setTimeout(() => {
        node.classList.remove("animate-fleet-bar-refocus-pulse");
        refocusPulseTimerRef.current = null;
      }, 850);
    };
    window.addEventListener("focus", handler);
    return () => {
      window.removeEventListener("focus", handler);
      if (refocusPulseTimerRef.current !== null) {
        window.clearTimeout(refocusPulseTimerRef.current);
        refocusPulseTimerRef.current = null;
      }
    };
  }, []);
}
