import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { Columns2, PanelLeftOpen, PanelRightOpen, Ruler } from "lucide-react";
import { ResizeHandle, RESIZE_HANDLE_INLINE_TRACK_PX } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";

interface TwoPaneSplitDividerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  // Called with the ratio when a key sets it, so the committed value is the
  // one just computed rather than one still pending in the parent's state.
  onRatioCommit: (ratio?: number) => void;
  onDoubleClick: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
  minRatio?: number;
  maxRatio?: number;
}

const DIVIDER_WIDTH_PX = RESIZE_HANDLE_INLINE_TRACK_PX;
const KEYBOARD_STEP = 0.02;
const KEYBOARD_COARSE_STEP = 0.1;

function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

export function TwoPaneSplitDivider({
  containerRef,
  ratio,
  onRatioChange,
  onRatioCommit,
  onDoubleClick,
  onDragStateChange,
  minRatio = 0.2,
  maxRatio = 0.8,
}: TwoPaneSplitDividerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dividerRef = useRef<HTMLDivElement>(null);
  const cleanupFnRef = useRef<(() => void) | null>(null);

  // Notify parent of drag state changes
  useEffect(() => {
    onDragStateChange?.(isDragging);
  }, [isDragging, onDragStateChange]);

  // Cache drag state in refs to avoid callback recreation during drag
  const dragStateRef = useRef({
    containerRect: null as DOMRect | null,
    minRatio,
    maxRatio,
    onRatioChange,
    onRatioCommit,
  });

  // Update refs when props change (but not during drag)
  useEffect(() => {
    if (!isDragging) {
      dragStateRef.current.minRatio = minRatio;
      dragStateRef.current.maxRatio = maxRatio;
    }
    dragStateRef.current.onRatioChange = onRatioChange;
    dragStateRef.current.onRatioCommit = onRatioCommit;
  }, [isDragging, minRatio, maxRatio, onRatioChange, onRatioCommit]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Don't stopPropagation - allow double-click to work

      // Cache container rect at drag start to avoid layout thrashing
      if (containerRef.current) {
        dragStateRef.current.containerRect = containerRef.current.getBoundingClientRect();
      }

      // Track if we've actually started dragging (mouse moved)
      let hasMoved = false;
      const startX = e.clientX;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // Only consider it a drag if mouse moved more than 3px
        if (!hasMoved && Math.abs(moveEvent.clientX - startX) > 3) {
          hasMoved = true;
          // Acquire resize ownership before the ratio write below can reflow
          // the panes. Waiting for the isDragging effect leaves one commit
          // where ResizeObserver can publish mid-gesture PTY geometry.
          onDragStateChange?.(true);
          setIsDragging(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }

        if (!hasMoved) return;

        const {
          containerRect,
          minRatio: min,
          maxRatio: max,
          onRatioChange: onChange,
        } = dragStateRef.current;
        if (!containerRect || containerRect.width <= 0) return;

        const offsetX = moveEvent.clientX - containerRect.left;
        const newRatio = Math.max(min, Math.min(max, offsetX / containerRect.width));
        if (Number.isFinite(newRatio)) {
          onChange(newRatio);
        }
      };

      const handleMouseUp = () => {
        cleanup();
        if (hasMoved) {
          setIsDragging(false);
          dragStateRef.current.onRatioCommit();
        }
        dragStateRef.current.containerRect = null;
      };

      const handleBlur = () => {
        cleanup();
        if (hasMoved) {
          setIsDragging(false);
          dragStateRef.current.onRatioCommit();
        }
        dragStateRef.current.containerRect = null;
      };

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;

      const cleanup = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("blur", handleBlur);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        cleanupFnRef.current = null;
      };

      // Store cleanup function for unmount safety
      cleanupFnRef.current = cleanup;

      // Attach listeners synchronously to catch immediate mouseup
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
    },
    [containerRef, onDragStateChange]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupFnRef.current) {
        cleanupFnRef.current();
      }
    };
  }, []);

  const applyRatio = useCallback(
    (next: number) => {
      const clamped = Math.max(minRatio, Math.min(maxRatio, next));
      onRatioChange(clamped);
      onRatioCommit(clamped);
    },
    [minRatio, maxRatio, onRatioChange, onRatioCommit]
  );

  const handleKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value: ratio,
    min: minRatio,
    max: maxRatio,
    step: KEYBOARD_STEP,
    largeStep: KEYBOARD_COARSE_STEP,
    onChange: applyRatio,
    onReset: onDoubleClick,
  });

  // The primary pane is the left one: its size is the value. Its body is the
  // region this separator controls, found in the DOM because a tab group's
  // rendered pane is its active tab, which the split's panel pair does not name.
  const [controlsId, setControlsId] = useState<string | undefined>(undefined);
  const resolveControlsId = useCallback(() => {
    const leftPane = containerRef.current?.firstElementChild;
    const body = leftPane?.querySelector<HTMLElement>('[id^="panel-body-"]');
    setControlsId(body?.id || undefined);
  }, [containerRef]);
  useLayoutEffect(resolveControlsId, [resolveControlsId]);

  const handleDoubleClick = useCallback(() => {
    onDoubleClick();
  }, [onDoubleClick]);

  // Dragging is the fast path; the menu is the same adjustment for a pointer
  // that cannot drag (WCAG 2.5.7), without widening the track to hold buttons.
  const canEvenSplit = minRatio <= 0.5 && maxRatio >= 0.5 && Math.abs(ratio - 0.5) > 0.005;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={stopContextMenuPropagation}>
        <ResizeHandle
          ref={dividerRef}
          growKey="ArrowRight"
          edge="inline"
          label="Resize left pane"
          value={percent(ratio)}
          min={percent(minRatio)}
          max={percent(maxRatio)}
          isResizing={isDragging}
          aria-controls={controlsId}
          aria-valuetext={`Left pane ${percent(ratio)}%, right pane ${100 - percent(ratio)}%`}
          className="z-10"
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
          onReset={handleDoubleClick}
          onFocus={resolveControlsId}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={ratio >= maxRatio}
          onSelect={() => applyRatio(ratio + KEYBOARD_COARSE_STEP)}
        >
          <PanelLeftOpen data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Widen left pane
        </ContextMenuItem>
        <ContextMenuItem
          disabled={ratio <= minRatio}
          onSelect={() => applyRatio(ratio - KEYBOARD_COARSE_STEP)}
        >
          <PanelRightOpen data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Widen right pane
        </ContextMenuItem>
        <ContextMenuItem disabled={!canEvenSplit} onSelect={() => applyRatio(0.5)}>
          <Columns2 data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Split evenly
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onDoubleClick}>
          <Ruler data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Reset split
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export { DIVIDER_WIDTH_PX };
