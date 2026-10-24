import { useCallback, useEffect, useRef, useState } from "react";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import {
  HELP_PANEL_MIN_WIDTH,
  HELP_PANEL_MAX_WIDTH,
  HELP_PANEL_DEFAULT_WIDTH,
} from "@/store/helpPanelStore";

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

interface ResizeDrag {
  startX: number;
  startWidth: number;
  setWidth: (width: number) => void;
  // Every teardown, whether the drag ended or the panel unmounted mid-drag.
  onCleanup: () => void;
  // The drag itself ended, after teardown.
  onEnd: () => void;
}

// Outside the hook on purpose: the document listeners and body style overrides
// are event-time side effects, and inside a hook-returned callback the React
// Compiler can't tell they never run during render.
function beginResizeDrag({
  startX,
  startWidth,
  setWidth,
  onCleanup,
  onEnd,
}: ResizeDrag): () => void {
  const onMouseMove = (moveEvent: MouseEvent) => {
    const delta = startX - moveEvent.clientX;
    const newWidth = Math.min(
      Math.max(startWidth + delta, HELP_PANEL_MIN_WIDTH),
      HELP_PANEL_MAX_WIDTH
    );
    setWidth(newWidth);
  };

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;

  // Idempotent: removing absent listeners and reassigning styles is a no-op,
  // so unmount/blur/mouseup can all call this without double-restore hazards.
  const cleanup = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("blur", onWindowBlur);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
    onCleanup();
  };

  const endResize = () => {
    // Tear down listeners/styles before user callbacks so a throwing
    // onResizeEnd can't leak the global userSelect/cursor overrides.
    cleanup();
    onEnd();
  };

  const onMouseUp = () => endResize();
  // Drag interrupted (alt-tab, OS gesture) — restore everything; no commit
  // needed since width is applied live during the drag.
  const onWindowBlur = () => endResize();

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  window.addEventListener("blur", onWindowBlur);
  // Drop any live selection before the drag. userSelect:none below only
  // stops NEW drag-selections from forming; a selection that already exists
  // in the terminal still gets torn as the rows reflow, firing a document
  // `selectionchange` that makes xterm's AccessibilityManager recompute an
  // inverted (start >= end) range and throw "invalid range". Collapsing it
  // up front leaves nothing to tear (the collapse itself is handled by the
  // manager's isCollapsed early-return).
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
  // Suppress text selection during the drag. Without this, a fast drag
  // selects across the terminal rows while they reflow, and xterm's
  // AccessibilityManager throws "invalid range" on the torn selection.
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";

  return cleanup;
}

interface UseHelpPanelResizeOptions {
  width: number;
  setWidth: (width: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

export function useHelpPanelResize({
  width,
  setWidth,
  onResizeStart,
  onResizeEnd,
}: UseHelpPanelResizeOptions) {
  // Idempotent teardown for an in-flight resize drag. Stored in a ref so an
  // unmount (or window blur) mid-drag can run it and never leak the document
  // listeners or the body userSelect/cursor overrides. Mirrors TwoPaneSplitDivider.
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Resize via mouse drag
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      onResizeStart?.();
      setIsResizing(true);
      resizeCleanupRef.current = beginResizeDrag({
        startX: e.clientX,
        startWidth: width,
        setWidth,
        onCleanup: () => {
          resizeCleanupRef.current = null;
        },
        onEnd: () => {
          setIsResizing(false);
          onResizeEnd?.();
        },
      });
    },
    [width, setWidth, onResizeStart, onResizeEnd]
  );

  // Run any in-flight resize teardown if the panel unmounts mid-drag.
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  const handleResetWidth = useCallback(() => {
    setWidth(HELP_PANEL_DEFAULT_WIDTH);
  }, [setWidth]);

  const handleResizeKeyDown = useSplitterKeys({
    growKey: "ArrowLeft",
    value: width,
    min: HELP_PANEL_MIN_WIDTH,
    max: HELP_PANEL_MAX_WIDTH,
    step: RESIZE_STEP,
    largeStep: RESIZE_STEP_LARGE,
    onChange: setWidth,
    onReset: handleResetWidth,
  });

  return { isResizing, handleResizeStart, handleResizeKeyDown, handleResetWidth };
}
