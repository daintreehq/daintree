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
      // Only the primary button drives a resize; right/middle-click should fall
      // through to the context menu rather than locking the row-resize cursor.
      if (e.button !== 0) return;
      e.preventDefault();
      dragStartYRef.current = e.clientY;
      dragStartHeightRef.current = popoverHeight;
      draftHeightRef.current = popoverHeight;
      setDraftHeight(popoverHeight);
      setIsResizing(true);
    },
    [popoverHeight]
  );

  // Own the drag for as long as `isResizing` holds. Document listeners (not React
  // handlers on the thin strip) keep the drag alive when the pointer leaves the
  // handle. The body cursor/userSelect lock lives here too — set on attach,
  // cleared on cleanup — so it is restored on every teardown path, including an
  // unmount mid-drag when the popover closes via Escape/outside-click before
  // `mouseup` ever fires.
  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent) => {
      const delta = dragStartYRef.current - e.clientY;
      const next = clampHeight(dragStartHeightRef.current + delta);
      draftHeightRef.current = next;
      setDraftHeight(next);
    };

    const onUp = () => {
      const moved = draftHeightRef.current !== dragStartHeightRef.current;
      setDraftHeight(null);
      setIsResizing(false);
      // A click without drag (or a drag that nets back to the start height)
      // shouldn't fire a persistence write or a terminal re-fit.
      if (moved) {
        setPopoverHeight(draftHeightRef.current);
        onCommitRef.current?.();
      }
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setPopoverHeight]);

  const commit = useCallback(
    (next: number) => {
      const clamped = clampHeight(next);
      // No-op at the clamp boundary — don't churn the persistence IPC or re-fit.
      if (clamped === popoverHeight) return;
      setPopoverHeight(clamped);
      onCommitRef.current?.();
    },
    [popoverHeight, setPopoverHeight]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        commit(popoverHeight + RESIZE_STEP);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        commit(popoverHeight - RESIZE_STEP);
      }
    },
    [popoverHeight, commit]
  );

  const handleDoubleClick = useCallback(() => {
    commit(POPOVER_DEFAULT_HEIGHT);
  }, [commit]);

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
