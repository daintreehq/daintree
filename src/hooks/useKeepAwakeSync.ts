import { useEffect } from "react";
import { keepAwakeClient } from "@/clients/keepAwakeClient";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useKeepAwakeStore } from "@/store/keepAwakeStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";

/**
 * Reads main's keep-awake state into this view. A read that a newer push
 * overtook is dropped by the store's revision check, so it can run at any time —
 * on mount, when the page becomes visible, or from the Settings retry.
 */
export function loadKeepAwakeState(): Promise<void> {
  return keepAwakeClient.getState().then(
    (state) => {
      useKeepAwakeStore.getState().applyState(state);
    },
    (error: unknown) => {
      logWarn("[useKeepAwakeSync] Failed to read keep-awake state", { error });
      useKeepAwakeStore
        .getState()
        .setLoadError(formatErrorMessage(error, "Couldn't load keep-awake settings"));
    }
  );
}

/**
 * Keeps this view's keep-awake state in step with main and derives whether the
 * toolbar shows it (#12516).
 *
 * Main broadcasts every change to every view, cached ones included, so the push
 * alone keeps a view current; the read on mount covers a view created while the
 * assertion was already held. The push listener goes on first, so the read can
 * only ever be redundant, never a gap.
 *
 * The first state a view learns shows at once — it describes a hold already
 * under way. A later start waits out the Doherty gate, so an agent that flickers
 * through `working` doesn't flash the toolbar; a release hides it at once.
 */
export function useKeepAwakeSync(): void {
  useEffect(() => {
    let gateTimer: ReturnType<typeof setTimeout> | null = null;

    const clearGate = () => {
      if (gateTimer !== null) {
        clearTimeout(gateTimer);
        gateTimer = null;
      }
    };

    const offStore = useKeepAwakeStore.subscribe((next, prev) => {
      if (next.state === prev.state) return;
      const blocking = next.state?.isBlocking ?? false;

      if (!blocking) {
        clearGate();
        if (next.visible) next.setVisible(false);
        return;
      }
      if (next.visible || gateTimer !== null) return;
      if (prev.state === null) {
        next.setVisible(true);
        return;
      }
      gateTimer = setTimeout(() => {
        gateTimer = null;
        if (useKeepAwakeStore.getState().state?.isBlocking) {
          useKeepAwakeStore.getState().setVisible(true);
        }
      }, UI_DOHERTY_THRESHOLD);
    });

    // A state that landed while nothing was subscribed — a remount — is already
    // under way, so it shows without the gate.
    const initial = useKeepAwakeStore.getState();
    if (initial.state?.isBlocking && !initial.visible) initial.setVisible(true);

    const offPush = keepAwakeClient.onStateChanged((state) => {
      useKeepAwakeStore.getState().applyState(state);
    });
    void loadKeepAwakeState();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void loadKeepAwakeState();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearGate();
      offStore();
      offPush();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
