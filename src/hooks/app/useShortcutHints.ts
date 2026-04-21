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
