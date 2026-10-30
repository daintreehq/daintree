import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import { resizeCappedPreference } from "@/hooks/useViewportCappedWidth";
import { useCanopyStore } from "@/store/canopyStore";
import {
  CANOPY_LIST_MAX_WIDTH,
  CANOPY_LIST_MIN_WIDTH,
  canopyListAttainableWidth,
  canopyListStyle,
} from "./canopyListWidth";

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

interface ListDrag {
  startX: number;
  startWidth: number;
  /** The width the user had chosen when the drag began, null for the default. */
  preference: number | null;
  attainable: number;
  setDrag: (width: number | null) => void;
  /** Once, on whatever ends the drag: the width it reached, null if it never moved. */
  onEnd: (width: number | null) => void;
}

// Outside the component, as the assistant panel's is: document listeners and
// body styles are event-time side effects the React Compiler can't see past.
function beginListDrag({
  startX,
  startWidth,
  preference,
  attainable,
  setDrag,
  onEnd,
}: ListDrag): () => void {
  let reached: number | null = null;
  const onMouseMove = (event: globalThis.MouseEvent) => {
    reached = resizeCappedPreference(
      startWidth + event.clientX - startX,
      preference ?? startWidth,
      CANOPY_LIST_MIN_WIDTH,
      CANOPY_LIST_MAX_WIDTH,
      attainable
    );
    setDrag(reached);
  };

  const prevUserSelect = document.body.style.userSelect;
  const prevCursor = document.body.style.cursor;
  let ended = false;
  // Mouseup, a window blur (alt-tab, an OS gesture) or the column leaving
  // mid-drag: each lands the drag once, so the terminal's hold always lifts.
  const end = () => {
    if (ended) return;
    ended = true;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", end);
    window.removeEventListener("blur", end);
    document.body.style.userSelect = prevUserSelect;
    document.body.style.cursor = prevCursor;
    onEnd(reached);
  };

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", end);
  window.addEventListener("blur", end);
  // A selection already in the terminal would tear as its rows move under the drag.
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
  return end;
}

/**
 * The inbox's list, with its right edge dragged, stepped or reset the way the
 * worktree sidebar's is. The width shows live while the edge moves and is kept
 * once it lands; the open terminal holds its size until then, so the agent
 * redraws once rather than at every pause in the drag.
 *
 * Its contents come in as children, so a drag re-renders the column and its
 * handle and nothing in the list.
 */
export function CanopyListColumn({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);
  const listWidth = useCanopyStore((state) => state.listWidth);
  const listDrag = useCanopyStore((state) => state.listDrag);
  const setListWidth = useCanopyStore((state) => state.setListWidth);
  const setListDrag = useCanopyStore((state) => state.setListDrag);
  // What the window actually shows, which the default and a narrow window
  // decide as much as the width set: the handle steps and reads from here.
  const [shown, setShown] = useState({ width: 0, split: 0 });
  const endDragRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const column = columnRef.current;
    const split = column?.parentElement;
    if (!column || !split) return;
    const measure = () => {
      const width = column.getBoundingClientRect().width;
      const splitWidth = split.getBoundingClientRect().width;
      setShown((was) =>
        was.width === width && was.split === splitWidth ? was : { width, split: splitWidth }
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(split);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => endDragRef.current?.(), []);

  const shownWidth = shown.width > 0 ? shown.width : (listWidth ?? CANOPY_LIST_MIN_WIDTH);
  const attainable = canopyListAttainableWidth(shown.split);

  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0 || endDragRef.current) return;
    event.preventDefault();
    const column = columnRef.current;
    const split = column?.parentElement;
    if (!column || !split) return;
    const startWidth = column.getBoundingClientRect().width;
    setListDrag(Math.round(startWidth));
    endDragRef.current = beginListDrag({
      startX: event.clientX,
      startWidth,
      preference: listWidth,
      attainable: canopyListAttainableWidth(split.getBoundingClientRect().width),
      setDrag: setListDrag,
      onEnd: (reached) => {
        endDragRef.current = null;
        // Kept before the drag lets go, so no frame shows the old width between.
        // A press that never moved leaves the default as the default.
        if (reached !== null && reached !== listWidth) setListWidth(reached);
        setListDrag(null);
      },
    });
  };

  const onKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value: shownWidth,
    min: CANOPY_LIST_MIN_WIDTH,
    max: Math.min(CANOPY_LIST_MAX_WIDTH, attainable),
    step: RESIZE_STEP,
    largeStep: RESIZE_STEP_LARGE,
    onChange: (width) =>
      setListWidth(
        resizeCappedPreference(
          width,
          listWidth ?? shownWidth,
          CANOPY_LIST_MIN_WIDTH,
          CANOPY_LIST_MAX_WIDTH,
          attainable
        )
      ),
    onReset: () => setListWidth(null),
  });

  return (
    <div
      ref={columnRef}
      className={cn("canopy-list-column relative", className)}
      style={canopyListStyle(listDrag ?? listWidth)}
    >
      {children}
      <ResizeHandle
        growKey="ArrowRight"
        edge="right"
        label="Resize agent list"
        value={shownWidth}
        min={CANOPY_LIST_MIN_WIDTH}
        max={Math.min(CANOPY_LIST_MAX_WIDTH, attainable)}
        isResizing={listDrag !== null}
        className="z-10"
        data-testid="canopy-list-resize"
        onMouseDown={startDrag}
        onKeyDown={onKeyDown}
        onReset={() => setListWidth(null)}
      />
    </div>
  );
}
