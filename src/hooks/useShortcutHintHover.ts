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
 * Keyboard parity (WCAG 1.4.13): focus shows the same hint immediately, with
 * no dwell delay — keyboard users expect content on focus without a wait.
 *
 * Returns handlers to spread onto the target element's root node:
 *   const { onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur } =
 *     useShortcutHintHover("nav.toggleSidebar");
 *   <button onPointerEnter={onPointerEnter} ... onFocus={onFocus} onBlur={onBlur} />
 */
export function useShortcutHintHover(actionId: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const displayComboRef = useRef<string>("");
  const triggerRef = useRef<Element | null>(null);
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

      // Suppress when a Radix tooltip is already teaching the same shortcut on
      // this trigger (data-state is merged onto the trigger child via asChild).
      const tooltipState = triggerRef.current?.getAttribute("data-state");
      if (tooltipState === "delayed-open" || tooltipState === "instant-open") return;

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
    triggerRef.current = null;
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
    triggerRef.current = e.currentTarget;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      fireDwellRef.current(clientX, clientY);
      triggerRef.current = null;
    }, HOVER_DWELL_MS);
  };

  const onPointerLeave = () => {
    clearTimer();
  };

  const onPointerDown = () => {
    clearTimer();
  };

  const onFocus = (e: React.FocusEvent) => {
    // Cancel any racing pointer dwell so it can't double-show after focus did.
    clearTimer();

    const displayCombo = displayComboRef.current;
    if (!displayCombo) return;

    const target = e.currentTarget;

    // Suppress when a Radix tooltip is already teaching the same shortcut on
    // this trigger (data-state is merged onto the trigger child via asChild).
    const tooltipState = target.getAttribute("data-state");
    if (tooltipState === "delayed-open" || tooltipState === "instant-open") return;

    const store = shortcutHintStore;
    if (!store.getState().isHoverEligible(actionId)) return;

    const rect = target.getBoundingClientRect();
    const shown = store.getState().show(actionId, displayCombo, {
      x: rect.left,
      y: rect.top,
    });
    if (shown) {
      store.getState().markHoverShown(actionId);
    }
  };

  const onBlur = () => {
    clearTimer();
    // Only clear the hint this element owns — a blur here must not dismiss a
    // hint another trigger raised (e.g. a pointer dwell on a different button).
    const store = shortcutHintStore;
    if (store.getState().activeHint?.actionId === actionId) {
      store.getState().hide();
    }
  };

  return { onPointerEnter, onPointerLeave, onPointerDown, onFocus, onBlur };
}
