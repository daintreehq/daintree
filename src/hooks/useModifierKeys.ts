import { useState, useEffect } from "react";

export interface ModifierState {
  meta: boolean;
  alt: boolean;
}

export function useModifierKeys(): ModifierState {
  const [modifiers, setModifiers] = useState<ModifierState>({ meta: false, alt: false });

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setModifiers((m) => (m.meta ? m : { ...m, meta: true }));
      }
      if (e.key === "Alt") {
        setModifiers((m) => (m.alt ? m : { ...m, alt: true }));
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") {
        setModifiers((m) => (!m.meta ? m : { ...m, meta: false }));
      }
      if (e.key === "Alt") {
        setModifiers((m) => (!m.alt ? m : { ...m, alt: false }));
      }
    };
    const blur = () => setModifiers({ meta: false, alt: false });

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return modifiers;
}
