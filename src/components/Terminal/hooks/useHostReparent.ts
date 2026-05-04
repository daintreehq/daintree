import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { createAutoSize } from "../inputEditorExtensions";

interface UseHostReparentParams {
  editorViewRef: React.RefObject<EditorView | null>;
  compactEditorHostRef: React.RefObject<HTMLDivElement | null>;
  modalEditorHostRef: React.RefObject<HTMLDivElement | null>;
  autoSizeCompartmentRef: React.RefObject<Compartment>;
  isExpanded: boolean;
}

export function useHostReparent({
  editorViewRef,
  compactEditorHostRef,
  modalEditorHostRef,
  autoSizeCompartmentRef,
  isExpanded,
}: UseHostReparentParams) {
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const compactHost = compactEditorHostRef.current;
    const modalHost = modalEditorHostRef.current;

    if (isExpanded && modalHost) {
      modalHost.appendChild(view.dom);
      view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure([]) });
      view.dom.style.height = "";
      view.scrollDOM.style.overflowY = "auto";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          view.requestMeasure();
          view.focus();
        });
      });
    } else if (!isExpanded && compactHost) {
      compactHost.appendChild(view.dom);
      view.dispatch({ effects: autoSizeCompartmentRef.current.reconfigure(createAutoSize()) });
      view.dom.style.height = "";
      view.scrollDOM.style.overflowY = "";
      requestAnimationFrame(() => {
        view.requestMeasure();
        view.focus();
      });
    }
  }, [isExpanded, autoSizeCompartmentRef]);
}
