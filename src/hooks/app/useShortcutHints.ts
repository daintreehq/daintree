import { useEffect } from "react";
import { isElectronAvailable } from "../useElectron";
import { shortcutHintStore } from "../../store/shortcutHintStore";

export function useShortcutHints(isStateLoaded: boolean) {
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    window.electron?.shortcutHints
      ?.getCounts()
      .then((counts) => {
        shortcutHintStore.getState().hydrateCounts(counts);
      })
      .catch(() => {
        shortcutHintStore.getState().hydrateCounts({});
      });

    // TODO(0.9.0): Remove once the temporary Canopy onboarding migration is
    // deleted. This only exists to settle migrated first-run state.
    if (window.electron?.onboarding) {
      window.electron.onboarding
        .get()
        .then((state) => {
          if (state.completed && !state.firstRunToastSeen) {
            void window.electron.onboarding.markToastSeen();
          }
        })
        .catch(() => {});
    }
  }, [isStateLoaded]);

  // Track mouse position for hint placement
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      shortcutHintStore.getState().recordPointer(e.clientX, e.clientY);
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, []);
}
