import { useCallback, useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { EditorView } from "@codemirror/view";
import type { ActiveCompletionContext } from "../hybridInputParsing";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

/** Where the menu sits in the shell, and the box it has to fit inside. */
export interface MenuPlacement {
  left: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** Clear space kept between the menu and the edges of whatever clips it. */
const EDGE_GAP_PX = 8;

/** The space the menu leaves above the shell, clear of the editor's focus outline. */
export const MENU_SHELL_GAP_PX = 6;

/** The menu's own width (`AutocompleteMenu`'s `w-[420px]`), before it is fitted. */
const MENU_WIDTH_PX = 420;

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
}

export function useAutocompletePositioning({
  editorViewRef,
  inputShellRef,
  rootRef,
  isAutocompleteOpen,
  activeCompletionContext,
  setMenuPlacement,
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
    if (anchorIndex === undefined) return;

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
      return current.left === next.left &&
        current.maxWidth === next.maxWidth &&
        current.maxHeight === next.maxHeight
        ? current
        : next;
    });
  }, [
    editorViewRef,
    inputShellRef,
    rootRef,
    setMenuPlacement,
    isAutocompleteOpen,
    activeCompletionContext?.start,
  ]);

  useResizeObserverRaf(inputShellEl, () => compute());
  useResizeObserverRaf(viewDomEl, () => compute());
  // The height the menu may take comes from the column, which a grid resize
  // changes without touching the shell or the editor.
  useResizeObserverRaf(columnEl, () => compute());

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
