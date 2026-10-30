import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import { resizeCappedPreference } from "@/hooks/useViewportCappedWidth";
import { useCanopyStore } from "@/store/canopyStore";
import {
  CANOPY_LIST_MAX_WIDTH,
  CANOPY_LIST_MIN_WIDTH,
  canopyListRoom,
  canopyListStyle,
} from "./canopyListWidth";

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

interface ListDrag {
  startX: number;
  startWidth: number;
  /** The width the user had chosen when the drag began, null for the default. */
  preference: number | null;
  /** The widest the list can show, past which the width kept doesn't move on screen. */
  room: number;
  setDrag: (width: number | null) => void;
  /** Once, on whatever ends the drag: the width it reached, null if the edge never moved on screen. */
  onEnd: (width: number | null) => void;
}

/** Whether a width the list is set to shows as `shown` does, once the window's cap has had its say. */
function sameOnScreen(width: number, shown: number, room: number): boolean {
  return Math.round(Math.min(width, room)) === Math.round(shown);
}

// Outside the component, as the assistant panel's is: document listeners and
// body styles are event-time side effects the React Compiler can't see past.
function beginListDrag({
  startX,
  startWidth,
  preference,
  room,
  setDrag,
  onEnd,
}: ListDrag): () => void {
  let reached: number | null = null;
  // Pushing against the cap moves nothing on screen, and a drag that never
  // moved the edge keeps nothing. One that moved and came back still does.
  let moved = false;
  const onMouseMove = (event: globalThis.MouseEvent) => {
    reached = resizeCappedPreference(
      startWidth + event.clientX - startX,
      preference ?? startWidth,
      CANOPY_LIST_MIN_WIDTH,
      CANOPY_LIST_MAX_WIDTH,
      room
    );
    if (!sameOnScreen(reached, startWidth, room)) moved = true;
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
    onEnd(moved ? reached : null);
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
  const room = canopyListRoom(shown.split);
  // A window too narrow for both minimums has nowhere to move the edge to.
  const resizable = room > CANOPY_LIST_MIN_WIDTH;

  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0 || endDragRef.current) return;
    const column = columnRef.current;
    const split = column?.parentElement;
    if (!column || !split) return;
    const dragRoom = canopyListRoom(split.getBoundingClientRect().width);
    if (dragRoom <= CANOPY_LIST_MIN_WIDTH) return;
    event.preventDefault();
    const startWidth = column.getBoundingClientRect().width;
    setListDrag(Math.round(startWidth));
    endDragRef.current = beginListDrag({
      startX: event.clientX,
      startWidth,
      preference: listWidth,
      room: dragRoom,
      setDrag: setListDrag,
      onEnd: (reached) => {
        endDragRef.current = null;
        // Kept before the drag lets go, so no frame shows the old width between.
        // A drag that moved is kept even where it came back to this view's
        // width, since a sibling view may have stored another meanwhile.
        if (reached !== null) setListWidth(reached);
        setListDrag(null);
      },
    });
  };

  const onKeyDown = useSplitterKeys({
    growKey: "ArrowRight",
    value: shownWidth,
    min: Math.min(CANOPY_LIST_MIN_WIDTH, room),
    max: Math.min(CANOPY_LIST_MAX_WIDTH, room),
    step: RESIZE_STEP,
    largeStep: RESIZE_STEP_LARGE,
    onChange: (width) => {
      if (!resizable) return;
      const next = resizeCappedPreference(
        width,
        listWidth ?? shownWidth,
        CANOPY_LIST_MIN_WIDTH,
        CANOPY_LIST_MAX_WIDTH,
        room
      );
      // A step at a bound or the cap moves nothing on screen, so keeps nothing.
      if (!sameOnScreen(next, shownWidth, room)) setListWidth(next);
    },
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
        min={Math.min(CANOPY_LIST_MIN_WIDTH, room)}
        max={Math.min(CANOPY_LIST_MAX_WIDTH, room)}
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
