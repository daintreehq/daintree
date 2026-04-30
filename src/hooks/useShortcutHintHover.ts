import { useRef, useEffect } from "react";
import type React from "react";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { keybindingService } from "./useKeybinding";

const HOVER_DWELL_MS = 1500;

/**
 * Hook that fires a ShortcutHint after the user dwells on an element for
 * HOVER_DWELL_MS. Only triggers for actions at count 0 (pre-use discovery)
 * or at a milestone count, with one-shot gating per count level.
 *
 * Returns handlers to spread onto the target element's root node:
 *   const { onPointerEnter, onPointerLeave, onPointerDown } = useShortcutHintHover("nav.toggleSidebar");
 *   <button onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} onPointerDown={onPointerDown} />
 */
export function useShortcutHintHover(actionId: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayComboRef = useRef<string>("");
  // Ref-based callback to avoid stale closures in setTimeout without useEffectEvent.
  const fireDwellRef = useRef<(clientX: number, clientY: number) => void>(() => {});

  // Keep display combo updated without re-creating the timer callbacks.
  useEffect(() => {
    displayComboRef.current = keybindingService.getDisplayCombo(actionId);
    const unsub = keybindingService.subscribe(() => {
      displayComboRef.current = keybindingService.getDisplayCombo(actionId);
    });
    return unsub;
  }, [actionId]);

  // Keep the dwell callback fresh with the latest actionId closure.
  useEffect(() => {
    fireDwellRef.current = (clientX: number, clientY: number) => {
      const displayCombo = displayComboRef.current;
      if (!displayCombo) return;

      const store = shortcutHintStore;
      if (!store.getState().isHoverEligible(actionId)) return;

      const shown = store.getState().show(actionId, displayCombo, {
        x: clientX,
        y: clientY,
      });
      if (shown) {
        store.getState().markHoverShown(actionId);
      }
    };
  }, [actionId]);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearTimer();
  }, []);

  const onPointerEnter = (e: React.PointerEvent) => {
    if (timerRef.current) return;

    const displayCombo = displayComboRef.current;
    if (!displayCombo) return;
    if (!shortcutHintStore.getState().isHoverEligible(actionId)) return;

    const clientX = e.clientX;
    const clientY = e.clientY;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fireDwellRef.current(clientX, clientY);
    }, HOVER_DWELL_MS);
  };

  const onPointerLeave = () => {
    clearTimer();
  };

  const onPointerDown = () => {
    clearTimer();
  };

  return { onPointerEnter, onPointerLeave, onPointerDown };
}
