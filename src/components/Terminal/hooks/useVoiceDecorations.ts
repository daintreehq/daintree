import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import { setInterimText, setPendingAIRanges } from "../inputEditorExtensions";

interface UseVoiceDecorationsParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
}

export function useVoiceDecorations({ terminalId, editorViewRef }: UseVoiceDecorationsParams) {
  const transcriptPhase = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
  );
  const liveText = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.liveText ?? "");
  const correctionRange = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.correctionRange ?? null
  );

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const ghostText = transcriptPhase === "interim" && liveText.length > 0 ? liveText : "";

    const docLen = view.state.doc.length;
    const pendingRanges =
      correctionRange &&
      correctionRange.from >= 0 &&
      correctionRange.to <= docLen &&
      correctionRange.from < correctionRange.to
        ? [correctionRange]
        : [];

    view.dispatch({
      effects: [setInterimText.of(ghostText), setPendingAIRanges.of(pendingRanges)],
    });
  }, [transcriptPhase, liveText, correctionRange, editorViewRef]);
}
