import { useEffect } from "react";
import { dispatchEscape } from "@/lib/escapeStack";

export function useGlobalEscapeDispatcher(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (dispatchEscape()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
