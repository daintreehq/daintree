import { useCallback, useEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";

interface TwoPaneSplitDividerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onRatioCommit: () => void;
  onDoubleClick: () => void;
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
  minRatio = 0.2,
  maxRatio = 0.8,
}: TwoPaneSplitDividerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dividerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const containerWidth = rect.width;
      const offsetX = e.clientX - rect.left;
      const newRatio = Math.max(minRatio, Math.min(maxRatio, offsetX / containerWidth));
      onRatioChange(newRatio);
    },
    [isDragging, containerRef, minRatio, maxRatio, onRatioChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    onRatioCommit();
  }, [onRatioCommit]);

  const handleBlur = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("blur", handleBlur);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("blur", handleBlur);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isDragging, handleMouseMove, handleMouseUp, handleBlur]);

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
