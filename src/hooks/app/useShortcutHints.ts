import { useEffect } from "react";
import { isElectronAvailable } from "../useElectron";
import { shortcutHintStore } from "../../store/shortcutHintStore";

export function useShortcutHints(isStateLoaded: boolean) {
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const hints = window.electron?.shortcutHints;
    if (!hints) return;

    // Seed the one-shot hover gate BEFORE counts hydration flips `hydrated`,
    // which is what opens `isHoverEligible`. Loading these in parallel leaves a
    // window where counts win the race, the gate opens with an empty set, and a
    // hover re-shows an already-dismissed hint (and the late `hydrateHintedHover`
    // would then wipe that in-session mark). `markHoverShown` is unreachable
    // while `hydrated` is false, so sequencing closes the window entirely.
    hints
      .getHintedHover()
      .then((keys) => {
        shortcutHintStore.getState().hydrateHintedHover(keys);
      })
      .catch(() => {
        shortcutHintStore.getState().hydrateHintedHover([]);
      })
      .finally(() => {
        hints
          .getCounts()
          .then((counts) => {
            shortcutHintStore.getState().hydrateCounts(counts);
          })
          .catch(() => {
            shortcutHintStore.getState().hydrateCounts({});
          });
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
