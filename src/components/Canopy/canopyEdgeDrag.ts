import { resizeCappedPreference } from "@/hooks/useViewportCappedWidth";

interface EdgeDrag {
  startX: number;
  startWidth: number;
  /** The width the user had chosen when the drag began, null for the default. */
  preference: number | null;
  /** The widest the pane can show, past which the width kept doesn't move on screen. */
  room: number;
  min: number;
  max: number;
  /** Which way along x grows the pane: 1 for an edge on its right, -1 for one on its left. */
  grow: 1 | -1;
  setDrag: (width: number | null) => void;
  /** Once, on whatever ends the drag: the width it reached, null if the edge never moved on screen. */
  onEnd: (width: number | null) => void;
}

/** Whether a width the pane is set to shows as `shown` does, once the window's cap has had its say. */
export function sameOnScreen(width: number, shown: number, room: number): boolean {
  return Math.round(Math.min(width, room)) === Math.round(shown);
}

/**
 * Drag one of Canopy's pane edges: the list's, or the docked assistant's.
 * Outside any component, as the assistant panel's is: document listeners and
 * body styles are event-time side effects the React Compiler can't see past.
 */
export function beginEdgeDrag({
  startX,
  startWidth,
  preference,
  room,
  min,
  max,
  grow,
  setDrag,
  onEnd,
}: EdgeDrag): () => void {
  let reached: number | null = null;
  // Pushing against the cap moves nothing on screen, and a drag that never
  // moved the edge keeps nothing. One that moved and came back still does.
  let moved = false;
  const onMouseMove = (event: globalThis.MouseEvent) => {
    reached = resizeCappedPreference(
      startWidth + grow * (event.clientX - startX),
      preference ?? startWidth,
      min,
      max,
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
