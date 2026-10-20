import { useState, useEffect } from "react";

export interface ModifierState {
  meta: boolean;
  alt: boolean;
}

export function useModifierKeys(): ModifierState {
  const [modifiers, setModifiers] = useState<ModifierState>({ meta: false, alt: false });

  useEffect(() => {
    // Event flags carry the post-event state of every held key, so a release of
    // one of two overlapping modifiers (Cmd + Ctrl, left + right) keeps the flag.
    const sync = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const alt = e.altKey;
      setModifiers((m) => (m.meta === meta && m.alt === alt ? m : { meta, alt }));
    };
    const reset = () => setModifiers({ meta: false, alt: false });
    const visibility = () => {
      if (document.hidden) reset();
    };

    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return modifiers;
}
