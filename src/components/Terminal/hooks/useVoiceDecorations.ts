import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import type { VoiceCorrectionRange } from "@/store/voiceRecordingStore";
import { setInterimText, setPendingAIRanges } from "../inputEditorExtensions";

const NO_RANGES: VoiceCorrectionRange[] = [];

interface UseVoiceDecorationsParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
}

export function useVoiceDecorations({ terminalId, editorViewRef }: UseVoiceDecorationsParams) {
  const transcriptPhase = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
  );
  const liveText = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.liveText ?? "");
  const correctionRanges = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.correctionRanges ?? NO_RANGES
  );

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const ghostText = transcriptPhase === "interim" && liveText.length > 0 ? liveText : "";

    const docLen = view.state.doc.length;
    const pendingRanges = correctionRanges.filter(
      (range) => range.from >= 0 && range.to <= docLen && range.from < range.to
    );

    view.dispatch({
      effects: [setInterimText.of(ghostText), setPendingAIRanges.of(pendingRanges)],
    });
  }, [transcriptPhase, liveText, correctionRanges, editorViewRef]);
}
