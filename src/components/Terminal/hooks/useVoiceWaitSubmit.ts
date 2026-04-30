import { useCallback, useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store";
import { voiceRecordingService } from "@/services/VoiceRecordingService";

const VOICE_SUBMIT_TIMEOUT_MS = 10_000;

export function waitForCorrectionsToSettle(panelId: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;

    const check = (state: ReturnType<typeof useVoiceRecordingStore.getState>): boolean => {
      const buffer = state.panelBuffers[panelId];
      const pendingCount = buffer?.pendingCorrections?.length ?? 0;
      const phase = buffer?.transcriptPhase ?? "idle";
      return pendingCount === 0 && phase !== "paragraph_pending_ai";
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve();
    }, timeoutMs);

    const unsubscribe = useVoiceRecordingStore.subscribe((state) => {
      if (settled || !check(state)) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });

    if (check(useVoiceRecordingStore.getState())) {
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    }
  });
}

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
            voiceState.status === "finishing");

        if (isSessionActive) {
          await voiceRecordingService.stop("Submitting command.", {
            preserveLiveText: true,
            announce: false,
          });
        }

        await waitForCorrectionsToSettle(terminalId, VOICE_SUBMIT_TIMEOUT_MS);

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
