import { useCallback, useEffect, useRef } from "react";
import { dispatchDragCancelEscape } from "@/lib/dragCancelEscape";
import { DRAG_RECOVERY_GRACE_MS } from "./useDragRecovery";

// Strip drags in separate panes can overlap (one picked up by keyboard while
// another is dragged by mouse), so the shield they raise is held by count and
// comes down with the last of them, and never when DndProvider raised it.
let nestedHolds = 0;
let nestedRaisedShield = false;

function holdShield(): void {
  nestedHolds += 1;
  const root = document.documentElement;
  if (root.dataset.dragging === "true") return;
  root.dataset.dragging = "true";
  nestedRaisedShield = true;
}

function releaseShield(): void {
  nestedHolds = Math.max(0, nestedHolds - 1);
  if (nestedHolds > 0 || !nestedRaisedShield) return;
  nestedRaisedShield = false;
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
 * shield it holds.
 */
export function useNestedDragGuard(): {
  beginDrag: (activatorEvent: Event | null | undefined) => void;
  finishDrag: () => void;
} {
  const disarmRef = useRef<(() => void) | null>(null);
  const holdingRef = useRef(false);
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
    if (!holdingRef.current) return;
    holdingRef.current = false;
    releaseShield();
  }, [cancelLower]);

  const beginDrag = useCallback(
    (activatorEvent: Event | null | undefined) => {
      disarm();
      cancelLower();
      if (!holdingRef.current) {
        holdShield();
        holdingRef.current = true;
      }
      if (!(activatorEvent instanceof MouseEvent)) return;

      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const clearGrace = () => {
        if (graceTimer !== null) clearTimeout(graceTimer);
        graceTimer = null;
      };
      const recover = () => {
        clearGrace();
        dispatchDragCancelEscape();
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
    if (!holdingRef.current || lowerTimerRef.current !== null) return;
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
