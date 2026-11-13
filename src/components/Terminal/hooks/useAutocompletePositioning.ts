import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { EditorView } from "@codemirror/view";
import type { ActiveCompletionContext } from "../hybridInputParsing";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

/** Where the menu sits in the shell, and the box it has to fit inside. */
export interface MenuPlacement {
  left: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Set only at a caret in the Expanded Editor, where the menu opens either way. */
  side?: "above" | "below";
  top?: number;
  bottom?: number;
}

/** Clear space kept between the menu and the edges of whatever clips it. */
const EDGE_GAP_PX = 8;

/** The space the menu leaves above the shell, clear of the editor's focus outline. */
export const MENU_SHELL_GAP_PX = 6;

/** The menu's own width (`AutocompleteMenu`'s `w-[420px]`), before it is fitted. */
const MENU_WIDTH_PX = 420;

/** The space the menu leaves between itself and the caret's line. */
const MENU_CARET_GAP_PX = 4;

/** The menu's header and one row: less than that shows no completion at all. */
const MENU_MIN_HEIGHT_PX = 64;

function samePlacement(a: MenuPlacement, b: MenuPlacement): boolean {
  return (
    a.left === b.left &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.side === b.side &&
    a.top === b.top &&
    a.bottom === b.bottom
  );
}

interface CaretFrame {
  rect: Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;
  clientLeft: number;
  clientTop: number;
  clientHeight: number;
  /** Measured size over layout size: AppDialog scales its panel in. */
  scaleX: number;
  scaleY: number;
}

interface CaretToken {
  left: number;
  /** From the top of the token's first line to the bottom of its last. */
  top: number;
  bottom: number;
  /** The last line alone, where the caret types. */
  lastTop: number;
  lastBottom: number;
}

/**
 * The menu's place at a caret in the Expanded Editor: on whichever side of the
 * token's lines has more room (below on a tie), within the frame that clips it
 * and the window, as offsets against the frame's padding box.
 */
export function placeMenuAtCaret(
  frame: CaretFrame,
  token: CaretToken,
  viewport: { width: number; height: number }
): MenuPlacement {
  const { rect, scaleX, scaleY } = frame;
  const minLeft = Math.max(rect.left, 0) + EDGE_GAP_PX;
  const maxRight = Math.min(rect.right, viewport.width) - EDGE_GAP_PX;
  const minTop = Math.max(rect.top, 0) + EDGE_GAP_PX;
  const maxBottom = Math.min(rect.bottom, viewport.height) - EDGE_GAP_PX;
  // A token scrolled out of the frame keeps the menu at the edge it left by.
  const fit = (top: number, bottom: number) => {
    const lineTop = Math.min(Math.max(top, rect.top), rect.bottom);
    const lineBottom = Math.min(Math.max(bottom, rect.top), rect.bottom);
    return {
      lineTop,
      lineBottom,
      roomAbove: lineTop - MENU_CARET_GAP_PX - minTop,
      roomBelow: maxBottom - lineBottom - MENU_CARET_GAP_PX,
    };
  };
  let lines = fit(token.top, token.bottom);
  // A token wrapped past both of the frame's edges leaves neither side of it.
  if (Math.max(lines.roomAbove, lines.roomBelow) < MENU_MIN_HEIGHT_PX) {
    lines = fit(token.lastTop, token.lastBottom);
  }

  const maxWidth = Math.max(0, maxRight - minLeft);
  const menuWidth = Math.min(MENU_WIDTH_PX, maxWidth);
  const left = Math.max(minLeft, Math.min(token.left, maxRight - menuWidth));
  // Client coordinates in, the frame's own unscaled offsets out.
  const x = (clientX: number) => (clientX - rect.left) / scaleX - frame.clientLeft;
  const y = (clientY: number) => (clientY - rect.top) / scaleY - frame.clientTop;

  if (lines.roomBelow >= lines.roomAbove) {
    return {
      side: "below",
      left: x(left),
      top: y(lines.lineBottom) + MENU_CARET_GAP_PX,
      maxWidth: maxWidth / scaleX,
      maxHeight: Math.max(0, lines.roomBelow) / scaleY,
    };
  }
  return {
    side: "above",
    left: x(left),
    bottom: frame.clientHeight - y(lines.lineTop) + MENU_CARET_GAP_PX,
    maxWidth: maxWidth / scaleX,
    maxHeight: Math.max(0, lines.roomAbove) / scaleY,
  };
}

/**
 * The nearest ancestor that clips the menu: a grid pane is `overflow-hidden`
 * and paint-contained, so a menu that runs past it is cut off there, not at the
 * window's edge. Falls back to the window.
 */
function clipRect(el: Element): DOMRect {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const clips =
      style.overflowX !== "visible" ||
      style.overflowY !== "visible" ||
      /\b(paint|content|strict)\b/.test(style.contain);
    if (clips) return node.getBoundingClientRect();
  }
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

interface UseAutocompletePositioningParams {
  editorViewRef: React.RefObject<EditorView | null>;
  inputShellRef: React.RefObject<HTMLDivElement | null>;
  /** The composer's outermost element; its parent is what the composer sits under. */
  rootRef: React.RefObject<HTMLDivElement | null>;
  isAutocompleteOpen: boolean;
  activeCompletionContext: ActiveCompletionContext | null;
  setMenuPlacement: Dispatch<SetStateAction<MenuPlacement>>;
  isExpanded: boolean;
  /** The Expanded Editor's frame, which the menu sits in while the editor is there. */
  modalFrameEl: HTMLElement | null;
}

export function useAutocompletePositioning({
  editorViewRef,
  inputShellRef,
  rootRef,
  isAutocompleteOpen,
  activeCompletionContext,
  setMenuPlacement,
  isExpanded,
  modalFrameEl,
}: UseAutocompletePositioningParams) {
  const [inputShellEl, setInputShellEl] = useState<HTMLDivElement | null>(null);
  const [viewDomEl, setViewDomEl] = useState<HTMLElement | null>(null);
  const [columnEl, setColumnEl] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    const syncObservedElements = () => {
      if (cancelled) return;
      const nextInputShell = inputShellRef.current;
      const nextViewDom = editorViewRef.current?.dom ?? null;
      const nextColumn = rootRef.current?.parentElement ?? null;

      setInputShellEl((current) => (current === nextInputShell ? current : nextInputShell));
      setViewDomEl((current) => (current === nextViewDom ? current : nextViewDom));
      setColumnEl((current) => (current === nextColumn ? current : nextColumn));
    };

    syncObservedElements();
    rafId = requestAnimationFrame(syncObservedElements);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [editorViewRef, inputShellRef, rootRef]);

  const compute = useCallback(() => {
    const view = editorViewRef.current;
    const shell = inputShellRef.current;
    if (!view || !shell || !isAutocompleteOpen) return;

    const anchorIndex = activeCompletionContext?.start;
    const tokenEnd = activeCompletionContext?.tokenEnd;
    if (anchorIndex === undefined || tokenEnd === undefined) return;

    if (isExpanded) {
      // Until the editor has moved into the dialog, its caret is still in the bar.
      if (!modalFrameEl || !modalFrameEl.contains(view.dom)) return;
      const start = view.coordsAtPos(anchorIndex);
      if (!start) return;
      // A long query can wrap: the menu clears every line the token is on.
      const end = view.coordsAtPos(tokenEnd, -1) ?? start;
      const rect = modalFrameEl.getBoundingClientRect();
      const { offsetWidth, offsetHeight } = modalFrameEl;
      const next = placeMenuAtCaret(
        {
          rect,
          clientLeft: modalFrameEl.clientLeft,
          clientTop: modalFrameEl.clientTop,
          clientHeight: modalFrameEl.clientHeight,
          scaleX: rect.width > 0 && offsetWidth > 0 ? rect.width / offsetWidth : 1,
          scaleY: rect.height > 0 && offsetHeight > 0 ? rect.height / offsetHeight : 1,
        },
        {
          left: start.left,
          top: start.top,
          bottom: Math.max(start.bottom, end.bottom),
          lastTop: end.top,
          lastBottom: end.bottom,
        },
        { width: window.innerWidth, height: window.innerHeight }
      );
      setMenuPlacement((current) => (samePlacement(current, next) ? current : next));
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const coords = view.coordsAtPos(anchorIndex);
    if (!coords) return;

    // Across, the menu stays within its own composer: never wider than the
    // field it completes, and never past what clips it or the window. Up, it
    // opens over the content the composer sits under (its root's parent: a
    // pane's terminal column, below the pane's header), within what clips it.
    const clip = clipRect(shell);
    const column = rootRef.current?.parentElement?.getBoundingClientRect();
    const minLeft = Math.max(shellRect.left, clip.left + EDGE_GAP_PX, EDGE_GAP_PX);
    const maxRight = Math.min(
      shellRect.right,
      clip.right - EDGE_GAP_PX,
      window.innerWidth - EDGE_GAP_PX
    );
    const minTop = Math.max(clip.top, column?.top ?? 0, 0) + EDGE_GAP_PX;

    const maxWidth = Math.max(0, maxRight - minLeft);
    const menuWidth = Math.min(MENU_WIDTH_PX, maxWidth);
    // Opens at the token, shifted left as far as it must to stay inside.
    const left = Math.max(minLeft, Math.min(coords.left, maxRight - menuWidth));
    const maxHeight = Math.max(0, shellRect.top - MENU_SHELL_GAP_PX - minTop);

    setMenuPlacement((current) => {
      // `left` is a client x; the menu is positioned against the shell's
      // padding box, which starts inside its border.
      const next = { left: left - shellRect.left - shell.clientLeft, maxWidth, maxHeight };
      return samePlacement(current, next) ? current : next;
    });
  }, [
    editorViewRef,
    inputShellRef,
    rootRef,
    setMenuPlacement,
    isAutocompleteOpen,
    activeCompletionContext?.start,
    activeCompletionContext?.tokenEnd,
    isExpanded,
    modalFrameEl,
  ]);

  useResizeObserverRaf(inputShellEl, () => compute());
  useResizeObserverRaf(viewDomEl, () => compute());
  // The height the menu may take comes from the column, which a grid resize
  // changes without touching the shell or the editor.
  useResizeObserverRaf(columnEl, () => compute());
  useResizeObserverRaf(modalFrameEl, () => compute());

  // The Expanded Editor scrolls its draft under a menu that stays in its frame.
  useEffect(() => {
    if (!isAutocompleteOpen || !modalFrameEl) return;
    const onScroll = () => compute();
    modalFrameEl.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => modalFrameEl.removeEventListener("scroll", onScroll, { capture: true });
  }, [compute, isAutocompleteOpen, modalFrameEl]);

  useLayoutEffect(() => {
    if (!isAutocompleteOpen) return;
    compute();

    const onResize = () => compute();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [compute, isAutocompleteOpen]);
}
