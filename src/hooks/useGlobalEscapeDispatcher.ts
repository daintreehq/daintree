import { useEffect } from "react";
import { dispatchEscape, dispatchEscapeFallback } from "@/lib/escapeStack";
import { backstopAlreadyConsumedEscape } from "@/lib/dialogEscapeBackstop";
import { nestedLayerOwnsEscape } from "@/lib/pluginManagerEscape";

export function useGlobalEscapeDispatcher(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      // dnd-kit's pointer sensors cancel an in-flight drag on Escape without
      // calling preventDefault, so without this guard the same keypress would
      // also pop the escape stack (dismissing a toast, disarming fleet state,
      // …). DndProvider maintains the data-dragging flag for every drag;
      // keyboard drags preventDefault their cancel and never reach here.
      if (document.documentElement.dataset.dragging === "true") return;
      // The dialog-backstop on document-bubble may have already closed the
      // topmost dialog. With React 18's `useSyncExternalStore` flushing
      // synchronously inside event handlers, that close also unregisters
      // the dialog from the escape stack mid-event — so dispatching now
      // would walk one layer deeper and close the dialog underneath.
      if (backstopAlreadyConsumedEscape()) return;
      // A layer open inside the plugin manager owned this Escape, whether or
      // not it is still open by now.
      if (nestedLayerOwnsEscape(e)) return;
      if (dispatchEscape() || dispatchEscapeFallback(e)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
