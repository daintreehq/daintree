import { useEffect } from "react";
import { isMac } from "@/lib/platform";

const REVEAL_HOLD_MS = 1000;
const REVEAL_ATTR = "shortcutReveal";

function isPrimaryModifierKey(key: string): boolean {
  return isMac() ? key === "Meta" : key === "Control";
}

export function useHeldShortcutReveal(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let revealActive = false;

    const setReveal = () => {
      revealActive = true;
      document.documentElement.dataset[REVEAL_ATTR] = "true";
    };

    const clearReveal = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (revealActive) {
        revealActive = false;
        delete document.documentElement.dataset[REVEAL_ATTR];
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPrimaryModifierKey(e.key)) return;
      // Auto-repeat fires keydown at OS-level intervals; don't restart the timer.
      if (e.repeat) return;
      // Already-armed timer or active reveal: nothing to do.
      if (timer !== null || revealActive) return;
      timer = setTimeout(() => {
        timer = null;
        setReveal();
      }, REVEAL_HOLD_MS);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!isPrimaryModifierKey(e.key)) return;
      clearReveal();
    };

    // Window blur is the only reliable signal when the user Cmd+Tabs while the
    // modifier is held — the renderer never receives the corresponding keyup.
    const handleBlur = () => {
      clearReveal();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      clearReveal();
    };
  }, []);
}
