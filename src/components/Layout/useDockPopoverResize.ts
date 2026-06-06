import { useCallback, useEffect, useRef, useState } from "react";
import {
  useDockStore,
  POPOVER_DEFAULT_HEIGHT,
  POPOVER_MIN_HEIGHT,
  POPOVER_MAX_HEIGHT_RATIO,
} from "@/store/dockStore";

const RESIZE_STEP = 10;

/**
 * Clamp a candidate height to the same window the store uses. Applied during
 * the live drag so the popover never visually overshoots its bounds; the store
 * re-clamps on the committed write at mouseup.
 */
function clampHeight(height: number): number {
  const max = window.innerHeight * POPOVER_MAX_HEIGHT_RATIO;
  return Math.min(Math.max(height, POPOVER_MIN_HEIGHT), max);
}

export interface DockPopoverResizeHandleProps {
  role: "separator";
  "aria-orientation": "horizontal";
  "aria-label": string;
  "aria-valuenow": number;
  "aria-valuemin": number;
  "aria-valuemax": number;
  tabIndex: number;
  "data-testid": string;
  onMouseDown: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDoubleClick: () => void;
}

export interface UseDockPopoverResizeResult {
  /** Height (px) to apply to the popover container — live during a drag, store value otherwise. */
  height: number;
  isResizing: boolean;
  /** Spread onto the top-edge resize handle element. */
  handleProps: DockPopoverResizeHandleProps;
}

/**
 * Drives a top-edge drag-resize handle for the bottom-anchored dock popovers.
 * The dock sits at the bottom of the window and its popover opens upward, so
 * dragging the handle up (smaller clientY) grows the popover.
 *
 * Mirrors the Sidebar resize idiom: a `mousedown` captures the drag origin and
 * attaches document `mousemove`/`mouseup` listeners; the live height stays in
 * local state for fluid feedback and is committed to the store exactly once at
 * `mouseup` so the persistence IPC fires per-gesture, not per-frame.
 *
 * `onCommit` runs after each committed height change (drag end + keyboard) so the
 * caller can re-fit the affected terminal once the new height is settled.
 */
export function useDockPopoverResize(onCommit?: () => void): UseDockPopoverResizeResult {
  const popoverHeight = useDockStore((s) => s.popoverHeight);
  const setPopoverHeight = useDockStore((s) => s.setPopoverHeight);

  // Live height while dragging; null when idle (store value is the source of truth).
  const [draftHeight, setDraftHeight] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  // Mirrors `isResizing` synchronously so the unmount-only cleanup effect can
  // detect a mid-drag teardown without relying on stale closure state.
  const isResizingRef = useRef(false);

  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(popoverHeight);
  const draftHeightRef = useRef(popoverHeight);

  // Mirror onCommit so the empty-dep cleanup effect and listener effect can call
  // the latest callback without re-subscribing.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  });

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStartYRef.current = e.clientY;
      dragStartHeightRef.current = popoverHeight;
      draftHeightRef.current = popoverHeight;
      setDraftHeight(popoverHeight);
      isResizingRef.current = true;
      setIsResizing(true);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [popoverHeight]
  );

  // Attach document listeners for the duration of the drag. Resolved inside the
  // effect (not via React handlers on the strip) so the drag continues even when
  // the pointer leaves the thin handle.
  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent) => {
      const delta = dragStartYRef.current - e.clientY;
      const next = clampHeight(dragStartHeightRef.current + delta);
      draftHeightRef.current = next;
      setDraftHeight(next);
    };

    const onUp = () => {
      setPopoverHeight(draftHeightRef.current);
      setDraftHeight(null);
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onCommitRef.current?.();
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, setPopoverHeight]);

  // Unmount-mid-drag guard: if the popover closes (Escape / outside-click) while
  // a drag is live, `mouseup` never fires and the row-resize cursor + userSelect
  // lock would stay stuck for the rest of the session. Reset on teardown.
  useEffect(() => {
    return () => {
      if (isResizingRef.current) {
        isResizingRef.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPopoverHeight(popoverHeight + RESIZE_STEP);
        onCommitRef.current?.();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setPopoverHeight(popoverHeight - RESIZE_STEP);
        onCommitRef.current?.();
      }
    },
    [popoverHeight, setPopoverHeight]
  );

  const handleDoubleClick = useCallback(() => {
    setPopoverHeight(POPOVER_DEFAULT_HEIGHT);
    onCommitRef.current?.();
  }, [setPopoverHeight]);

  const height = draftHeight ?? popoverHeight;

  return {
    height,
    isResizing,
    handleProps: {
      role: "separator",
      "aria-orientation": "horizontal",
      "aria-label": "Resize panel",
      "aria-valuenow": Math.round(height),
      "aria-valuemin": POPOVER_MIN_HEIGHT,
      "aria-valuemax": Math.round(window.innerHeight * POPOVER_MAX_HEIGHT_RATIO),
      tabIndex: 0,
      "data-testid": "dock-popover-resize-handle",
      onMouseDown: startResizing,
      onKeyDown: handleKeyDown,
      onDoubleClick: handleDoubleClick,
    },
  };
}
