import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronAvailable } from "../useElectron";
import { useTerminalStore } from "@/store/terminalStore";

const PROMPT_DELAY_MS = 2500;

export interface DeferredNewsletterPromptState {
  visible: boolean;
  dismiss: (subscribed: boolean) => void;
}

export function useDeferredNewsletterPrompt(isStateLoaded: boolean): DeferredNewsletterPromptState {
  const [visible, setVisible] = useState(false);
  const eligibleRef = useRef(false);
  const firedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback((subscribed: boolean) => {
    void subscribed;
    setVisible(false);
    if (isElectronAvailable()) {
      void window.electron.onboarding.markNewsletterSeen();
    }
  }, []);

  // Hydrate onboarding state and determine eligibility
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    if (!window.electron?.onboarding) return;

    window.electron.onboarding
      .get()
      .then((state) => {
        if (state.completed && !state.newsletterPromptSeen) {
          eligibleRef.current = true;
          // Reconcile: check if an agent terminal already exists
          const hasAgent = useTerminalStore.getState().terminals.some((t) => t.kind === "agent");
          if (hasAgent && !firedRef.current) {
            firedRef.current = true;
            timerRef.current = setTimeout(() => setVisible(true), PROMPT_DELAY_MS);
          }
        }
      })
      .catch(console.error);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isStateLoaded]);

  // Subscribe to terminal store for agent launch detection
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (!eligibleRef.current || firedRef.current) return;
      const hasAgent = state.terminals.some((t) => t.kind === "agent");
      if (hasAgent) {
        firedRef.current = true;
        unsubscribe();
        timerRef.current = setTimeout(() => setVisible(true), PROMPT_DELAY_MS);
      }
    });

    return () => {
      unsubscribe();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isStateLoaded]);

  return { visible, dismiss };
}
