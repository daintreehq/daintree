import { useCallback, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

interface UseVoiceWaitSubmitParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
  editableCompartmentRef: React.RefObject<Compartment>;
  sendFromEditor: () => void;
}

export function useVoiceWaitSubmit({
  terminalId,
  editorViewRef,
  editableCompartmentRef,
  sendFromEditor,
}: UseVoiceWaitSubmitParams) {
  const sendFromEditorRef = useRef(sendFromEditor);
  useEffect(() => {
    sendFromEditorRef.current = sendFromEditor;
  }, [sendFromEditor]);

  const startVoiceWaitSubmit = useCallback(() => {
    const store = useTerminalInputStore.getState();
    if (store.isVoiceSubmitting(terminalId)) return;

    store.setVoiceSubmitting(terminalId, true);

    const view = editorViewRef.current;
    if (view) {
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(false)),
      });
    }

    void (async () => {
      try {
        const voiceState = useVoiceRecordingStore.getState();
        const isSessionActive =
          voiceState.activeTarget?.panelId === terminalId &&
          (voiceState.status === "recording" ||
            voiceState.status === "connecting" ||
            voiceState.status === "reconnecting" ||
            voiceState.status === "finishing");

        if (isSessionActive) {
          await voiceRecordingService.stop("Submitting command.", {
            preserveLiveText: true,
            announce: false,
          });
        }

        if (!useTerminalInputStore.getState().isVoiceSubmitting(terminalId)) return;

        sendFromEditorRef.current();
      } finally {
        useTerminalInputStore.getState().setVoiceSubmitting(terminalId, false);
        const v = editorViewRef.current;
        if (v) {
          v.dispatch({
            effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(true)),
          });
        }
      }
    })();
  }, [terminalId, editorViewRef, editableCompartmentRef]);

  const cancelVoiceWaitSubmit = useCallback(() => {
    const store = useTerminalInputStore.getState();
    if (!store.isVoiceSubmitting(terminalId)) return false;
    store.setVoiceSubmitting(terminalId, false);
    const view = editorViewRef.current;
    if (view) {
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(true)),
      });
    }
    return true;
  }, [terminalId, editorViewRef, editableCompartmentRef]);

  return { startVoiceWaitSubmit, cancelVoiceWaitSubmit };
}
