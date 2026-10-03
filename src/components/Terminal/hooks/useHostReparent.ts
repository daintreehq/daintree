import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { createAutoSize } from "../inputEditorExtensions";

export type ReparentEditorView = Pick<
  EditorView,
  "dom" | "scrollDOM" | "dispatch" | "requestMeasure" | "focus"
>;

interface UseHostReparentParams {
  editorViewRef: React.RefObject<ReparentEditorView | null>;
  compactEditorHostRef: React.RefObject<HTMLDivElement | null>;
  modalEditorHostRef: React.RefObject<HTMLDivElement | null>;
  autoSizeCompartmentRef: React.RefObject<Compartment>;
  isExpanded: boolean;
}

function resetEditorDomForHost(
  viewDom: HTMLElement,
  scrollDom: HTMLElement,
  overflowY: "" | "auto"
): void {
  viewDom.style.height = "";
  scrollDom.style.overflowY = overflowY;
}

export function useHostReparent({
  editorViewRef,
  compactEditorHostRef,
  modalEditorHostRef,
  autoSizeCompartmentRef,
  isExpanded,
}: UseHostReparentParams) {
  const previousExpandedRef = useRef<boolean | null>(null);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const viewDom = view.dom;
    const scrollDom = view.scrollDOM;
    const compactHost = compactEditorHostRef.current;
    const modalHost = modalEditorHostRef.current;
    const previousExpanded = previousExpandedRef.current;
    previousExpandedRef.current = isExpanded;
    // Only a real move between hosts hands the caret on. The first attach, and
    // React re-running this effect on an unchanged host (StrictMode's mount
    // replay), must not pull focus into an editor nobody asked for.
    const shouldRestoreFocus = previousExpanded !== null && previousExpanded !== isExpanded;
    let rafId: number | null = null;
    let nestedRafId: number | null = null;

    if (isExpanded && modalHost) {
      modalHost.appendChild(viewDom);
      view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure([]) });
      resetEditorDomForHost(viewDom, scrollDom, "auto");
      rafId = requestAnimationFrame(() => {
        nestedRafId = requestAnimationFrame(() => {
          view.requestMeasure();
          if (shouldRestoreFocus) view.focus();
        });
      });
    } else if (!isExpanded && compactHost) {
      compactHost.appendChild(viewDom);
      view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure(createAutoSize()) });
      resetEditorDomForHost(viewDom, scrollDom, "");
      rafId = requestAnimationFrame(() => {
        view.requestMeasure();
        if (shouldRestoreFocus) view.focus();
      });
    }

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (nestedRafId !== null) cancelAnimationFrame(nestedRafId);
    };
  }, [isExpanded, editorViewRef, compactEditorHostRef, modalEditorHostRef, autoSizeCompartmentRef]);
}
