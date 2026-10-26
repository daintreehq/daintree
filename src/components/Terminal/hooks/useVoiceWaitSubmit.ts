import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import type { Compartment } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store";
import { useProjectStore } from "@/store/projectStore";
import {
  voiceRecordingService,
  VOICE_CORRECTION_SEND_WAIT_MS,
} from "@/services/VoiceRecordingService";

/** What a voice send is waiting on: the transcript draining, or its correction. */
export type VoiceSubmitPhase = "finishing" | "polishing";

interface UseVoiceWaitSubmitParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
  editableCompartmentRef: React.RefObject<Compartment>;
  sendFromEditor: () => void;
}

function isVoiceSessionActiveFor(panelId: string): boolean {
  const voiceState = useVoiceRecordingStore.getState();
  return (
    voiceState.activeTarget?.panelId === panelId &&
    (voiceState.status === "recording" ||
      voiceState.status === "connecting" ||
      voiceState.status === "paused" ||
      voiceState.status === "reconnecting" ||
      voiceState.status === "finishing")
  );
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

  // Each Enter is its own attempt. After Escape and a second Enter, the first
  // continuation must neither send nor unlock the composer under the second.
  const attemptRef = useRef(0);
  const [voiceSubmitPhase, setVoiceSubmitPhase] = useState<VoiceSubmitPhase | null>(null);

  const startVoiceWaitSubmit = useCallback(() => {
    const store = useTerminalInputStore.getState();
    if (store.isVoiceSubmitting(terminalId)) return;

    const attempt = ++attemptRef.current;
    const isCurrentAttempt = () =>
      attemptRef.current === attempt &&
      useTerminalInputStore.getState().isVoiceSubmitting(terminalId);

    store.setVoiceSubmitting(terminalId, true);
    setVoiceSubmitPhase("finishing");

    const view = editorViewRef.current;
    if (view) {
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(false)),
      });
    }

    void (async () => {
      try {
        if (isVoiceSessionActiveFor(terminalId)) {
          await voiceRecordingService.stop("Submitting command.", {
            preserveLiveText: true,
            announce: false,
          });
        }

        if (!isCurrentAttempt()) return;

        // stop() has registered the passage's correction by now. The send
        // waits briefly for it, then goes with whatever text is current (#14611).
        if (voiceRecordingService.hasPendingCorrection(terminalId)) {
          setVoiceSubmitPhase("polishing");
          await voiceRecordingService.waitForPendingCorrections(
            terminalId,
            VOICE_CORRECTION_SEND_WAIT_MS
          );
          if (!isCurrentAttempt()) return;
        }

        // The send takes the draft as it stands. A correction still on its way
        // must not rewrite it while the send is in flight, or land on the next
        // draft afterwards.
        voiceRecordingService.discardPendingCorrections(terminalId);

        // `stop()` and a landed correction bump externalDraftRevision after
        // writing the draft store, but HybridInputBar's sync useEffect doesn't
        // fire until the next React render — which is AFTER this microtask.
        // Sync the editor here so sendFromEditor reads the final dictated text
        // and not the pre-stop doc (#9172).
        const projectId = useProjectStore.getState().currentProject?.id;
        const draft = useTerminalInputStore.getState().getDraftInput(terminalId, projectId);
        const finalView = editorViewRef.current;
        if (finalView) {
          const current = finalView.state.doc.toString();
          if (draft !== current) {
            finalView.dispatch({
              changes: { from: 0, to: current.length, insert: draft },
              selection: { anchor: draft.length },
            });
          }
        }

        sendFromEditorRef.current();
      } finally {
        if (attemptRef.current === attempt) {
          useTerminalInputStore.getState().setVoiceSubmitting(terminalId, false);
          setVoiceSubmitPhase(null);
          const v = editorViewRef.current;
          if (v) {
            v.dispatch({
              effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(true)),
            });
          }
        }
      }
    })();
  }, [terminalId, editorViewRef, editableCompartmentRef]);

  // Escape cancels the send, not the correction: it still lands in the draft.
  const cancelVoiceWaitSubmit = useCallback(() => {
    const store = useTerminalInputStore.getState();
    if (!store.isVoiceSubmitting(terminalId)) return false;
    attemptRef.current++;
    store.setVoiceSubmitting(terminalId, false);
    setVoiceSubmitPhase(null);
    const view = editorViewRef.current;
    if (view) {
      view.dispatch({
        effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(true)),
      });
    }
    return true;
  }, [terminalId, editorViewRef, editableCompartmentRef]);

  // Read at the key press rather than from the last render: a hotkey stop
  // registers its correction before any render shows it.
  const hasPendingVoiceCorrection = useCallback(
    () => voiceRecordingService.hasPendingCorrection(terminalId),
    [terminalId]
  );

  /** A send from the editor that waits for dictation still finishing or being corrected. */
  const submitFromEditor = useCallback(() => {
    if (isVoiceSessionActiveFor(terminalId) || voiceRecordingService.hasPendingCorrection(terminalId)) {
      startVoiceWaitSubmit();
      return;
    }
    sendFromEditorRef.current();
  }, [terminalId, startVoiceWaitSubmit]);

  return {
    startVoiceWaitSubmit,
    cancelVoiceWaitSubmit,
    hasPendingVoiceCorrection,
    submitFromEditor,
    voiceSubmitPhase,
  };
}
