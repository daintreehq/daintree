import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import { clampWidth } from "./kitDataTableModel";
import type { RichColumn } from "./kitDataTableColumns";

const RESIZE_STEP_PX = 8;
const RESIZE_BIG_STEP_PX = 32;

export function ColumnResizeHandle({
  column,
  width,
  onResize,
  onReset,
}: {
  column: RichColumn;
  width: number | undefined;
  onResize: (px: number, final: boolean) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  // An unsized column has no width of its own until it is measured.
  const [measured, setMeasured] = useState<number | null>(null);
  const [handle, setHandle] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const cell = handle?.parentElement;
    if (!cell || typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasured(cell.getBoundingClientRect().width || null);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [handle]);
  const value = clampWidth(width ?? measured ?? column.minWidth, column.minWidth, column.maxWidth);
  const onKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value,
    min: column.minWidth,
    max: column.maxWidth,
    step: RESIZE_STEP_PX,
    largeStep: RESIZE_BIG_STEP_PX,
    onChange: (next) => onResize(clampWidth(next, column.minWidth, column.maxWidth), true),
    onReset,
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width ?? target.parentElement?.getBoundingClientRect().width ?? value;
    // RTL drags grow the column to the left.
    const direction = getComputedStyle(target).direction === "rtl" ? -1 : 1;
    target.setPointerCapture?.(event.pointerId);
    setDragging(true);
    let last = startWidth;
    const move = (moveEvent: PointerEvent) => {
      last = clampWidth(
        startWidth + (moveEvent.clientX - startX) * direction,
        column.minWidth,
        column.maxWidth
      );
      onResize(last, false);
    };
    const end = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
      setDragging(false);
      onResize(last, true);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };
  return (
    <ResizeHandle
      ref={setHandle}
      growKey="ArrowRight"
      edge="right"
      label={`Resize ${column.menuLabel}`}
      value={value}
      min={column.minWidth}
      max={column.maxWidth}
      isResizing={dragging}
      onReset={onReset}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (onKeyDown(event)) event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      className="z-[4] touch-none"
    />
  );
}
