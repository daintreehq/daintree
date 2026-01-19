import { useCallback, useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";

interface TwoPaneSplitDividerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onRatioCommit: () => void;
  onDoubleClick: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
  minRatio?: number;
  maxRatio?: number;
}

const DIVIDER_WIDTH_PX = 6;
const KEYBOARD_STEP = 0.02;

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
          setIsDragging(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }

        if (!hasMoved) return;

        const { containerRect, minRatio: min, maxRatio: max, onRatioChange: onChange } = dragStateRef.current;
        if (!containerRect) return;

        const offsetX = moveEvent.clientX - containerRect.left;
        const newRatio = Math.max(min, Math.min(max, offsetX / containerRect.width));
        onChange(newRatio);
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
      };

      // Attach listeners synchronously to catch immediate mouseup
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
    },
    [containerRef]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const newRatio = Math.max(minRatio, ratio - KEYBOARD_STEP);
        onRatioChange(newRatio);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const newRatio = Math.min(maxRatio, ratio + KEYBOARD_STEP);
        onRatioChange(newRatio);
      } else if (e.key === "Enter" || e.key === " " || e.key === "Home") {
        e.preventDefault();
        onDoubleClick();
      }
    },
    [ratio, minRatio, maxRatio, onRatioChange, onDoubleClick]
  );

  const handleDoubleClick = useCallback(() => {
    onDoubleClick();
  }, [onDoubleClick]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="Resize panels"
      aria-orientation="vertical"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(minRatio * 100)}
      aria-valuemax={Math.round(maxRatio * 100)}
      tabIndex={0}
      className={cn(
        "group cursor-col-resize flex items-center justify-center z-10 shrink-0",
        "hover:bg-white/[0.03] transition-colors focus-visible:outline-none focus-visible:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-canopy-accent/50",
        isDragging && "bg-canopy-accent/20"
      )}
      style={{ width: DIVIDER_WIDTH_PX }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={cn(
          "w-px h-16 rounded-full transition-colors",
          "bg-canopy-text/20",
          "group-hover:bg-canopy-text/35 group-focus-visible:bg-canopy-accent",
          isDragging && "bg-canopy-accent"
        )}
      />
    </div>
  );
}

export { DIVIDER_WIDTH_PX };
