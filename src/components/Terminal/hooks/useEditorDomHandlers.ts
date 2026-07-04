import { useEffect, useMemo, useRef } from "react";
import { EditorView as EditorViewFacet } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { usePanelStore } from "@/store/panelStore";
import { isEnterLikeLineBreakInputEvent } from "../hybridInputEvents";

interface LatestRefShape {
  disabled: boolean;
  isAutocompleteOpen: boolean;
  autocompleteItems: { key: string }[];
  isResultsStale: boolean;
  activeMode: "command" | "file" | "diff" | "terminal" | "selection" | null;
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
  applyAutocompleteSelection: (action: "insert" | "execute") => boolean;
  sendFromEditor: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
  setAtContext: (value: null) => void;
  setSlashContext: (value: null) => void;
  setDiffContext: (value: null) => void;
  setTerminalContext: (value: null) => void;
  setSelectionContext: (value: null) => void;
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
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
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
          if (
            latest.isAutocompleteOpen &&
            !latest.isResultsStale &&
            latest.autocompleteItems[latest.selectedIndex]
          ) {
            event.preventDefault();
            const action = latest.activeMode === "command" ? "execute" : "insert";
            applyAutocompleteSelectionRef.current(action);
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
          setAtContext(null);
          setSlashContext(null);
          setDiffContext(null);
          setTerminalContext(null);
          setSelectionContext(null);
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
