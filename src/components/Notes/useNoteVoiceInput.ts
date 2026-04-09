import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

/**
 * Bridges voice transcription from voiceRecordingStore into a CodeMirror EditorView.
 *
 * The VoiceRecordingService writes deltas/completions to voiceRecordingStore.panelBuffers
 * (and to terminalInputStore for terminal panels). This hook subscribes to the store
 * for the given panelId and dispatches incremental changes into the EditorView.
 * AI corrections and paragraph boundaries are not routed to notes — they silently
 * no-op because terminalInputStore has no content for this panelId.
 */
export function useNoteVoiceInput(
  panelId: string,
  editorViewRef: React.RefObject<EditorView | null>
): void {
  const insertFromRef = useRef(-1);
  const liveLengthRef = useRef(0);
  const lastSegmentCountRef = useRef(0);

  useEffect(() => {
    const unsubscribe = useVoiceRecordingStore.subscribe((state, prevState) => {
      const view = editorViewRef.current;
      if (!view) return;

      const buffer = state.panelBuffers[panelId];
      if (!buffer) return;

      const prevBuffer = prevState.panelBuffers[panelId];

      // Handle completed segments FIRST — completeSegment clears liveText and
      // adds the final text in a single store update. We must use insertFromRef
      // and liveLengthRef before they get reset.
      const segmentCount = buffer.completedSegments.length;
      const prevSegmentCount = prevBuffer?.completedSegments.length ?? 0;

      if (segmentCount > prevSegmentCount && segmentCount > lastSegmentCountRef.current) {
        const newSegments = buffer.completedSegments.slice(prevSegmentCount);
        const finalText = newSegments.join(" ");

        if (insertFromRef.current >= 0) {
          const from = insertFromRef.current;
          const to = from + liveLengthRef.current;

          view.dispatch({
            changes: { from, to, insert: finalText },
            selection: { anchor: from + finalText.length },
            scrollIntoView: true,
          });
        }

        insertFromRef.current = -1;
        liveLengthRef.current = 0;
        lastSegmentCountRef.current = segmentCount;
        return;
      }

      // Handle live text (delta streaming)
      if (buffer.liveText !== (prevBuffer?.liveText ?? "")) {
        const liveText = buffer.liveText;

        if (!liveText) {
          // Live text cleared without a new completed segment (e.g. empty utterance)
          insertFromRef.current = -1;
          liveLengthRef.current = 0;
          return;
        }

        if (insertFromRef.current === -1) {
          // First delta of a new utterance — snapshot cursor position
          insertFromRef.current = view.state.selection.main.head;
          liveLengthRef.current = 0;
        }

        const from = insertFromRef.current;
        const to = from + liveLengthRef.current;

        view.dispatch({
          changes: { from, to, insert: liveText },
          selection: { anchor: from + liveText.length },
          scrollIntoView: true,
        });

        liveLengthRef.current = liveText.length;
      }
    });

    return () => {
      unsubscribe();
      insertFromRef.current = -1;
      liveLengthRef.current = 0;
      lastSegmentCountRef.current = 0;
    };
  }, [panelId, editorViewRef]);
}
