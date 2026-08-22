import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createHoverSettle, type HoverSettleController } from "@/lib/pointerTransit";

interface HoverSelectionRow {
  rowKey: string;
}

interface UseDockLaunchHoverSelectionArgs<Row extends HoverSelectionRow> {
  open: boolean;
  results: readonly Row[];
  setSelectedIndex: (index: number) => void;
}

interface UseDockLaunchHoverSelection {
  /** Goes on the listbox host element. Not on a row — see `onHover`. */
  listboxRef: (node: HTMLDivElement | null) => void;
  onHover: (index: number, rowKey: string, pointerType: string) => void;
  /** Call before any keystroke that moves the selection. */
  notifyKeyboardSelection: () => void;
}

/**
 * Keeps pointer transit from being read as a choice of row (#11919).
 *
 * Hover is wired to the palette's selection setter, so sweeping down the list
 * used to drag the selection through every row passed, and the
 * `scrollIntoView` that follows keyboard navigation used to slide a row under a
 * resting cursor and hand the selection back to the mouse. Both are the same
 * bug: a row treating transit as intent.
 *
 * The gate lives here rather than inside the row so no ref crosses a component
 * boundary as a prop, which is a silent React Compiler bailout. Suppression is
 * held in refs, never state: pointermove arrives at 60-120Hz and must not
 * render.
 */
export function useDockLaunchHoverSelection<Row extends HoverSelectionRow>({
  open,
  results,
  setSelectedIndex,
}: UseDockLaunchHoverSelectionArgs<Row>): UseDockLaunchHoverSelection {
  // Paired in one object so a deferred flush can never combine one render's
  // rows with another render's setter — `setSelectedIndex` closes over the
  // `results` it was built from, and both take a new identity every render.
  const latestRef = useRef({ results, setSelectedIndex });
  useLayoutEffect(() => {
    latestRef.current = { results, setSelectedIndex };
  }, [results, setSelectedIndex]);

  // The row the pointer was last over while suppressed. Recorded by key, never
  // index: results can reshuffle underneath a suppressed sweep, and an index
  // captured then points at a different row by the time it is spent.
  const pendingRowKeyRef = useRef<string | null>(null);
  const controllerRef = useRef<HoverSettleController | null>(null);

  // State rather than a ref, because the attach effect has to re-run when the
  // node arrives. Radix loads the popover's content lazily, so the listbox can
  // mount without `DockLaunchButton` rendering again — a lookup by id in an
  // effect keyed on `open` would miss that mount outright and never recover.
  const [listboxNode, setListboxNode] = useState<HTMLDivElement | null>(null);
  const listboxRef = useCallback((node: HTMLDivElement | null) => {
    setListboxNode(node);
  }, []);

  useEffect(() => {
    if (!open || !listboxNode) return;

    const controller = createHoverSettle({
      onSettle: (source) => {
        const rowKey = pendingRowKeyRef.current;
        pendingRowKeyRef.current = null;
        // A scroll settling says only that the list stopped moving. Where the
        // cursor happens to have landed is the bug, not the answer.
        if (source !== "pointer" || rowKey === null) return;
        const { results: liveResults, setSelectedIndex: select } = latestRef.current;
        const index = liveResults.findIndex((row) => row.rowKey === rowKey);
        // Filtered away mid-sweep: no fallback. Selecting whatever now sits at
        // that index would be the same guess this whole gate exists to refuse.
        if (index >= 0) select(index);
      },
    });
    controllerRef.current = controller;

    const handleMove = (event: PointerEvent) => controller.pointerMove(event);
    // Both of these clear the pending row for any pointer type: once the
    // pointer is off the list, or a scroll has taken authority, the row it was
    // over is no longer where it is pointing.
    const handleLeave = (event: PointerEvent) => {
      pendingRowKeyRef.current = null;
      controller.pointerLeave(event);
    };
    const handleScroll = (event: Event) => {
      // Only a scroller the list actually sits inside can move rows under the
      // cursor. This app is full of independent scrollers, and a terminal
      // streaming output must not stand the launcher's hover down.
      const target = event.target;
      if (!(target instanceof Node) || !target.contains(listboxNode)) return;
      pendingRowKeyRef.current = null;
      controller.listMoved();
    };

    listboxNode.addEventListener("pointermove", handleMove, { passive: true });
    listboxNode.addEventListener("pointerleave", handleLeave);
    // Scroll does not bubble and the scroller is the palette body wrapping this
    // list, not the list itself, so this watches the document in the capture
    // phase rather than reaching for a ref it has no path to.
    document.addEventListener("scroll", handleScroll, { passive: true, capture: true });

    return () => {
      listboxNode.removeEventListener("pointermove", handleMove);
      listboxNode.removeEventListener("pointerleave", handleLeave);
      document.removeEventListener("scroll", handleScroll, { capture: true });
      pendingRowKeyRef.current = null;
      if (controllerRef.current === controller) controllerRef.current = null;
      // Cancels the backstop without settling — a torn-down gesture has no
      // intent left to spend.
      controller.destroy();
    };
  }, [open, listboxNode]);

  // Stable for the lifetime of the component: every per-render value it needs
  // is read through a ref, so the rows never re-render for this prop and an
  // in-flight suppression is never reset by a keystroke.
  const onHover = useCallback((index: number, rowKey: string, pointerType: string) => {
    // Touch and pen have no hover state to protect.
    if (pointerType !== "mouse") {
      latestRef.current.setSelectedIndex(index);
      return;
    }

    const source = controllerRef.current?.suppressionSource() ?? null;
    if (source === null) {
      latestRef.current.setSelectedIndex(index);
      return;
    }

    // Only a pointer gesture earns a flush when it settles. Nothing needs
    // clearing when a new episode starts: settle, leave, scroll takeover and
    // teardown all clear this, so it is already null by then.
    pendingRowKeyRef.current = source === "pointer" ? rowKey : null;
  }, []);

  // A keystroke that moves the selection makes the pointer's last opinion
  // stale, and the row that lands under a resting cursor when the new selection
  // scrolls into view is not a choice either. Standing hover down here rather
  // than waiting for the scroll event keeps this off the boundary event the
  // scroll fires, whichever order the browser emits the two in.
  const notifyKeyboardSelection = useCallback(() => {
    pendingRowKeyRef.current = null;
    controllerRef.current?.listMoved();
  }, []);

  return { listboxRef, onHover, notifyKeyboardSelection };
}
