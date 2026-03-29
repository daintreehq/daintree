import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronAvailable } from "../useElectron";
import { useTerminalStore } from "@/store/terminalStore";

const BREATHING_ROOM_MS = 500;
const FALLBACK_DELAY_MS = 180_000;

export interface DeferredNewsletterPromptState {
  visible: boolean;
  dismiss: (subscribed: boolean) => void;
}

export function useDeferredNewsletterPrompt(
  isStateLoaded: boolean,
  checklistVisible: boolean
): DeferredNewsletterPromptState {
  const [visible, setVisible] = useState(false);
  const eligibleRef = useRef(false);
  const firedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checklistVisibleRef = useRef(checklistVisible);

  // Keep ref in sync with prop
  useEffect(() => {
    checklistVisibleRef.current = checklistVisible;
  }, [checklistVisible]);

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    setVisible(true);
  }, []);

  const clearTimers = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const dismiss = useCallback((subscribed: boolean) => {
    void subscribed;
    setVisible(false);
    if (isElectronAvailable()) {
      void window.electron.onboarding.markNewsletterSeen();
    }
  }, []);

  // Hydrate onboarding state, determine eligibility, start fallback timer
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    if (!window.electron?.onboarding) return;

    window.electron.onboarding
      .get()
      .then((state) => {
        if (state.completed && !state.newsletterPromptSeen) {
          eligibleRef.current = true;

          // Start 3-minute absolute fallback
          fallbackTimerRef.current = setTimeout(() => {
            fire();
          }, FALLBACK_DELAY_MS);

          // Reconcile: agent already exists and checklist already gone
          const hasAgent = useTerminalStore.getState().terminals.some((t) => t.kind === "agent");
          if (hasAgent && !checklistVisibleRef.current) {
            timerRef.current = setTimeout(() => fire(), BREATHING_ROOM_MS);
          }
        }
      })
      .catch(console.error);

    return clearTimers;
  }, [isStateLoaded, fire, clearTimers]);

  // Subscribe to terminal store for agent launch detection
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (!eligibleRef.current || firedRef.current) return;
      const hasAgent = state.terminals.some((t) => t.kind === "agent");
      if (hasAgent && !checklistVisibleRef.current) {
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fire(), BREATHING_ROOM_MS);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isStateLoaded, fire]);

  // Watch for checklist dismissal: checklistVisible transitions true → false
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    if (checklistVisible) return; // Only act when checklist becomes invisible
    if (!eligibleRef.current || firedRef.current) return;

    const hasAgent = useTerminalStore.getState().terminals.some((t) => t.kind === "agent");
    if (hasAgent) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => fire(), BREATHING_ROOM_MS);
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [checklistVisible, isStateLoaded, fire]);

  return { visible, dismiss };
}
