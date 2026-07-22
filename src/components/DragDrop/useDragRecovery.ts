import { useCallback, useEffect, useRef } from "react";

/**
 * Grace period after the pointer leaves the host document before a live mouse
 * drag is force-canceled. Long enough to survive a brief edge overshoot with
 * the button held (no host events arrive from outside the window, so the
 * timer can't be defused there); short enough that a wedged drag self-heals
 * before it reads as broken.
 */
export const DRAG_RECOVERY_GRACE_MS = 500;

type LiveDragKind = "mouse" | "other";

/**
 * Watchdog for drags whose native end event never reaches the host document
 * (#11291). Electron webviews are OOPIFs: a mouseup landing in one is
 * invisible to every host-side listener, so dnd-kit's internal active lock is
 * never released and all future drags are silently ignored until reload.
 *
 * Recovery rides dnd-kit's own cancel path: its pointer sensors listen for
 * keydown with `code === "Escape"` on the document, and that DragCancel path
 * always resets the lock without entering `cancelDrop`. Two detectors, both
 * scoped to mouse-activated drags:
 * - `mousemove` with `buttons === 0` while a drag is live — proof positive
 *   the release happened where the host couldn't see it; recover immediately.
 * - `mouseout` with `relatedTarget === null` (pointer left the host document —
 *   into a webview or out of the window) arms a grace timer; a return with
 *   the button still held defuses it.
 *
 * Also stamps `data-dragging` on the root synchronously at drag start so the
 * `[data-dragging] webview { pointer-events: none }` shield is up before the
 * first frame — the activeId-keyed effect in DndProvider commits a frame
 * late, which is exactly the window that loses the mouseup.
 *
 * State lives in refs, not React state: the listeners and timer must read
 * live values, never a stale closure.
 */
export function useDragRecovery(): {
  beginDrag: (activatorEvent: Event | null | undefined) => void;
  finishDrag: () => void;
} {
  const liveDragRef = useRef<LiveDragKind | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current !== null) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const beginDrag = useCallback(
    (activatorEvent: Event | null | undefined) => {
      clearGraceTimer();
      liveDragRef.current = activatorEvent instanceof MouseEvent ? "mouse" : "other";
      // eslint-disable-next-line react-compiler/react-compiler -- the webview shield must be up before React commits; the activeId-keyed effect lands a frame late, which is exactly the gap that loses the mouseup (#11291)
      document.documentElement.dataset.dragging = "true";
    },
    [clearGraceTimer]
  );

  // Deliberately leaves data-dragging in place: useGlobalEscapeDispatcher
  // reads it mid-propagation to keep a drag-canceling Escape from also
  // popping the escape stack, so removal belongs to DndProvider's
  // activeId-keyed effect, which runs after the event finishes.
  const finishDrag = useCallback(() => {
    liveDragRef.current = null;
    clearGraceTimer();
  }, [clearGraceTimer]);

  useEffect(() => {
    // Leaves liveDragRef set: a successful cancel lands in finishDrag via
    // onDragCancel, and an unheard Escape must not block a later retry.
    // Dispatched on body, not document: capture-phase key handlers cast
    // event.target to HTMLElement (`.closest`), which a Document target
    // would break. It still bubbles to dnd-kit's document-level listener.
    const recover = () => {
      clearGraceTimer();
      if (liveDragRef.current !== "mouse") return;
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true })
      );
    };

    const handleMouseOut = (event: MouseEvent) => {
      if (liveDragRef.current !== "mouse" || event.relatedTarget !== null) return;
      if (graceTimerRef.current !== null) return;
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        recover();
      }, DRAG_RECOVERY_GRACE_MS);
    };

    const handleMouseMove = (event: MouseEvent) => {
      if (liveDragRef.current !== "mouse") return;
      if (event.buttons === 0) {
        recover();
      } else {
        clearGraceTimer();
      }
    };

    document.addEventListener("mouseout", handleMouseOut);
    document.addEventListener("mousemove", handleMouseMove);
    return () => {
      document.removeEventListener("mouseout", handleMouseOut);
      document.removeEventListener("mousemove", handleMouseMove);
      clearGraceTimer();
      liveDragRef.current = null;
      delete document.documentElement.dataset.dragging;
    };
  }, [clearGraceTimer]);

  return { beginDrag, finishDrag };
}
