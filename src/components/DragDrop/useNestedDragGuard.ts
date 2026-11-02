import { useCallback, useEffect, useRef } from "react";
import { DRAG_RECOVERY_GRACE_MS } from "./useDragRecovery";

/** Raises the `[data-dragging] webview` shield; false when something else already holds it. */
function raiseShield(): boolean {
  const root = document.documentElement;
  if (root.dataset.dragging === "true") return false;
  root.dataset.dragging = "true";
  return true;
}

function lowerShield(): void {
  delete document.documentElement.dataset.dragging;
}

/**
 * The webview shield and lost-release recovery for a drag that a `DndContext`
 * nested inside `DndProvider` owns, such as a pane's tab strip. The provider
 * never sees those drags, so without this a tab dragged down over a browser
 * pane's page and released there leaves the strip's sensor live: the guest
 * swallows the mouseup (#11291, `useDragRecovery`).
 *
 * Unlike `useDragRecovery`, which sits once on the provider, this lives on every
 * strip, so it listens only while its own drag is live and only ever lowers a
 * `data-dragging` flag it raised itself.
 */
export function useNestedDragGuard(): {
  beginDrag: (activatorEvent: Event | null | undefined) => void;
  finishDrag: () => void;
} {
  const disarmRef = useRef<(() => void) | null>(null);
  const ownsFlagRef = useRef(false);
  const lowerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = useCallback(() => {
    disarmRef.current?.();
    disarmRef.current = null;
  }, []);

  const cancelLower = useCallback(() => {
    if (lowerTimerRef.current !== null) {
      clearTimeout(lowerTimerRef.current);
      lowerTimerRef.current = null;
    }
  }, []);

  const lowerFlag = useCallback(() => {
    cancelLower();
    if (!ownsFlagRef.current) return;
    ownsFlagRef.current = false;
    lowerShield();
  }, [cancelLower]);

  const beginDrag = useCallback(
    (activatorEvent: Event | null | undefined) => {
      disarm();
      cancelLower();
      if (raiseShield()) ownsFlagRef.current = true;
      if (!(activatorEvent instanceof MouseEvent)) return;

      // dnd-kit's pointer sensors cancel on a document keydown with
      // code "Escape"; dispatched on body for the capture-phase handlers that
      // read `event.target` as an element.
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const clearGrace = () => {
        if (graceTimer !== null) clearTimeout(graceTimer);
        graceTimer = null;
      };
      const recover = () => {
        clearGrace();
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true })
        );
      };
      const handleMouseMove = (event: MouseEvent) => {
        if (event.buttons === 0) recover();
        else clearGrace();
      };
      const handleMouseOut = (event: MouseEvent) => {
        if (event.relatedTarget !== null || graceTimer !== null) return;
        graceTimer = setTimeout(recover, DRAG_RECOVERY_GRACE_MS);
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseout", handleMouseOut);
      disarmRef.current = () => {
        clearGrace();
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseout", handleMouseOut);
      };
    },
    [disarm, cancelLower]
  );

  // The flag comes down after the event that ended the drag has finished: the
  // global Escape dispatcher reads it on window, after dnd-kit's document
  // listener has cancelled, to keep that Escape from also popping the stack.
  const finishDrag = useCallback(() => {
    disarm();
    if (!ownsFlagRef.current || lowerTimerRef.current !== null) return;
    lowerTimerRef.current = setTimeout(lowerFlag, 0);
  }, [disarm, lowerFlag]);

  useEffect(
    () => () => {
      disarm();
      lowerFlag();
    },
    [disarm, lowerFlag]
  );

  return { beginDrag, finishDrag };
}
