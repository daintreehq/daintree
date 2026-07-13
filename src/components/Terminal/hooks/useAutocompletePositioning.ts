import { useCallback, useLayoutEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { EditorView } from "@codemirror/view";
import type { ActiveCompletionContext } from "../hybridInputParsing";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

interface UseAutocompletePositioningParams {
  editorViewRef: React.RefObject<EditorView | null>;
  inputShellRef: React.RefObject<HTMLDivElement | null>;
  menuRef: React.RefObject<HTMLDivElement | null>;
  isAutocompleteOpen: boolean;
  activeCompletionContext: ActiveCompletionContext | null;
  setMenuLeftPx: Dispatch<SetStateAction<number>>;
}

export function useAutocompletePositioning({
  editorViewRef,
  inputShellRef,
  menuRef,
  isAutocompleteOpen,
  activeCompletionContext,
  setMenuLeftPx,
}: UseAutocompletePositioningParams) {
  const [inputShellEl, setInputShellEl] = useState<HTMLDivElement | null>(null);
  const [viewDomEl, setViewDomEl] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;

    const syncObservedElements = () => {
      if (cancelled) return;
      const nextInputShell = inputShellRef.current;
      const nextViewDom = editorViewRef.current?.dom ?? null;

      setInputShellEl((current) => (current === nextInputShell ? current : nextInputShell));
      setViewDomEl((current) => (current === nextViewDom ? current : nextViewDom));
    };

    syncObservedElements();
    rafId = requestAnimationFrame(syncObservedElements);

    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [editorViewRef, inputShellRef]);

  const compute = useCallback(() => {
    const view = editorViewRef.current;
    const shell = inputShellRef.current;
    if (!view || !shell || !isAutocompleteOpen) return;

    const anchorIndex = activeCompletionContext?.start;
    if (anchorIndex === undefined) return;

    const shellRect = shell.getBoundingClientRect();
    const coords = view.coordsAtPos(anchorIndex);
    if (!coords) return;
    const rawLeft = coords.left - shellRect.left;
    const menuWidth = menuRef.current?.offsetWidth ?? 420;
    const viewportRight = window.innerWidth;
    const menuAbsoluteLeft = shellRect.left + rawLeft;
    const maxAbsoluteLeft = viewportRight - menuWidth;
    const clampedAbsoluteLeft = Math.max(0, Math.min(menuAbsoluteLeft, maxAbsoluteLeft));
    const clampedLeft = clampedAbsoluteLeft - shellRect.left;
    setMenuLeftPx(Math.max(0, clampedLeft));
  }, [
    editorViewRef,
    inputShellRef,
    menuRef,
    setMenuLeftPx,
    isAutocompleteOpen,
    activeCompletionContext?.start,
  ]);

  useResizeObserverRaf(inputShellEl, () => compute());
  useResizeObserverRaf(viewDomEl, () => compute());

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
