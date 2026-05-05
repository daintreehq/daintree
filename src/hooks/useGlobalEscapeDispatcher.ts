import { useEffect } from "react";
import { dispatchEscape } from "@/lib/escapeStack";
import { backstopAlreadyConsumedEscape } from "@/lib/dialogEscapeBackstop";

export function useGlobalEscapeDispatcher(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      // The dialog-backstop on document-bubble may have already closed the
      // topmost dialog. With React 18's `useSyncExternalStore` flushing
      // synchronously inside event handlers, that close also unregisters
      // the dialog from the escape stack mid-event — so dispatching now
      // would walk one layer deeper and close the dialog underneath.
      if (backstopAlreadyConsumedEscape()) return;
      if (dispatchEscape()) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
