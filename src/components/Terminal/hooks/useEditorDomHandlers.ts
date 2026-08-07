import { useEffect, useMemo, useRef } from "react";
import { EditorView as EditorViewFacet } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { hasFileDrag } from "@/lib/fileDragPayload";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore } from "@/store/panelStore";
import { isEnterLikeLineBreakInputEvent } from "../hybridInputEvents";

interface LatestRefShape {
  disabled: boolean;
  isAutocompleteOpen: boolean;
  autocompleteItems: { key: string }[];
  staleItemKeys: ReadonlySet<string>;
  selectedIndex: number;
  value: string;
  terminalId: string;
  onSendKey?: (key: string) => void;
  isExpanded: boolean;
}

interface UseEditorDomHandlersParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  editorViewRef: React.RefObject<EditorView | null>;
  isComposingRef: React.RefObject<boolean>;
  handledEnterRef: React.MutableRefObject<boolean>;
  lastEnterKeydownNewlineRef: React.MutableRefObject<boolean>;
  submitAfterCompositionRef: React.MutableRefObject<boolean>;
  applyAutocompleteSelection: (mode: "enter" | "complete") => boolean;
  sendFromEditor: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setActiveCompletionContext: (value: null) => void;
}

export function useEditorDomHandlers({
  latestRef,
  editorViewRef,
  isComposingRef,
  handledEnterRef,
  lastEnterKeydownNewlineRef,
  submitAfterCompositionRef,
  applyAutocompleteSelection,
  sendFromEditor,
  rootRef,
  setActiveCompletionContext,
}: UseEditorDomHandlersParams) {
  "use no memo";
  const sendFromEditorRef = useRef(sendFromEditor);
  useEffect(() => {
    sendFromEditorRef.current = sendFromEditor;
  }, [sendFromEditor]);

  const applyAutocompleteSelectionRef = useRef(applyAutocompleteSelection);
  useEffect(() => {
    applyAutocompleteSelectionRef.current = applyAutocompleteSelection;
  }, [applyAutocompleteSelection]);

  const domEventHandlers = useMemo(
    () =>
      EditorViewFacet.domEventHandlers({
        focus: () => {
          // Record the session-wide focus preference so Cmd-Opt-Arrow keeps
          // landing on the hybrid input across panes. Idempotent: the slice
          // setter no-ops when the value is already "hybridInput", so a burst
          // of focus events from re-renders does not churn subscribers.
          usePanelStore.getState().setPreferredTerminalFocusTarget("hybridInput");
          return false;
        },
        drop: (event) => {
          if (!event.dataTransfer) return false;
          // CodeMirror reads a dropped file with a FileReader and dispatches its
          // text, which lands alongside the `@file` chip `useDragDrop` inserts
          // when the same drop reaches the wrapper (#11710). Claiming the event
          // retires that branch — a true return only prevents the default, so
          // the drop still bubbles and the chip path stays the sole producer.
          // Drags carrying no file stay CodeMirror's: dropping text still
          // inserts text, and moving a selection within the input still moves.
          return hasFileDrag(event.dataTransfer.types);
        },
        beforeinput: (event) => {
          const latest = latestRef.current;
          if (!latest) return false;
          if (latest.disabled) {
            event.preventDefault();
            return true;
          }
          const nativeEvent = event as InputEvent;
          if (!isEnterLikeLineBreakInputEvent(nativeEvent)) return false;
          if (handledEnterRef.current) {
            handledEnterRef.current = false;
            event.preventDefault();
            return true;
          }
          if (lastEnterKeydownNewlineRef.current) return false;
          const enterItem = latest.isAutocompleteOpen
            ? latest.autocompleteItems[latest.selectedIndex]
            : undefined;
          if (enterItem && !latest.staleItemKeys.has(enterItem.key)) {
            event.preventDefault();
            applyAutocompleteSelectionRef.current("enter");
            return true;
          }
          event.preventDefault();
          if (nativeEvent.isComposing) {
            submitAfterCompositionRef.current = true;
            return true;
          }
          if (useTerminalInputStore.getState().isVoiceSubmitting(latest.terminalId)) {
            event.preventDefault();
            return true;
          }
          const text = editorViewRef.current?.state.doc.toString() ?? latest.value;
          if (text.trim().length === 0) {
            if (latest.onSendKey) latest.onSendKey("enter");
            return true;
          }
          sendFromEditorRef.current();
          return true;
        },
        compositionstart: () => {
          isComposingRef.current = true;
          submitAfterCompositionRef.current = false;
          lastEnterKeydownNewlineRef.current = false;
          return false;
        },
        compositionend: () => {
          isComposingRef.current = false;
          if (!submitAfterCompositionRef.current) return false;
          submitAfterCompositionRef.current = false;
          const latest = latestRef.current;
          if (latest && useTerminalInputStore.getState().isVoiceSubmitting(latest.terminalId)) {
            return false;
          }
          setTimeout(() => sendFromEditorRef.current(), 0);
          return false;
        },
        keydown: (event) => {
          const isEnter =
            event.key === "Enter" ||
            event.key === "Return" ||
            event.code === "Enter" ||
            event.code === "NumpadEnter";
          if (isEnter) lastEnterKeydownNewlineRef.current = event.shiftKey || event.altKey;
          if (event.isComposing) {
            if (isEnter && !event.shiftKey && !event.altKey) {
              submitAfterCompositionRef.current = true;
            }
            return false;
          }
          return false;
        },
        blur: (event) => {
          const nextTarget = event.relatedTarget as HTMLElement | null;
          const root = rootRef.current;
          if (root && nextTarget && root.contains(nextTarget)) return false;
          if (latestRef.current?.isExpanded) return false;
          setActiveCompletionContext(null);
          lastEnterKeydownNewlineRef.current = false;
          handledEnterRef.current = false;
          submitAfterCompositionRef.current = false;
          return false;
        },
      }),
    []
  );

  return domEventHandlers;
}
