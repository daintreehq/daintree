import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import type { VoiceCorrectionRange } from "@/store/voiceRecordingStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { planVoiceWords } from "@/services/voiceInsertion";
import {
  interimWidgetField,
  setInterimText,
  setPendingAIRanges,
  type InterimPreview,
} from "../inputEditorExtensions";

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
  // A spoken rewrite instruction is not prompt text, so it never shows as ghost text.
  const recordingRewrite = useVoiceRecordingStore(
    (s) => s.activeTarget?.panelId === terminalId && s.activeTarget.rewrite !== undefined
  );
  const correctionRanges = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.correctionRanges ?? NO_RANGES
  );
  const sessionId = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.dictationSessionId ?? null
  );
  const projectId = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.projectId);
  const anchor = useDictationRangeStore((s) =>
    sessionId ? s.getAnchor({ sessionId, panelId: terminalId, projectId }) : null
  );

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    let preview: InterimPreview = { text: "", pos: null };
    if (transcriptPhase === "interim" && liveText.length > 0 && !recordingRewrite) {
      const draft = useTerminalInputStore.getState().getDraftInput(terminalId, projectId);
      // Store positions only mean something in the text they were taken in.
      // While the editor and the store disagree (a keystroke on its way to the
      // store), the preview stays where it was, mapped through the typing.
      if (anchor && view.state.doc.toString() === draft) {
        // Shown as it will be written, spacing included, where it will go.
        const { change } = planVoiceWords(draft, anchor, liveText);
        preview = { text: change.insert, pos: change.from };
      } else {
        const shown = view.state.field(interimWidgetField, false);
        preview = { text: liveText, pos: anchor ? (shown?.pos ?? null) : null };
      }
    }

    const docLen = view.state.doc.length;
    const pendingRanges = correctionRanges.filter(
      (range) => range.from >= 0 && range.to <= docLen && range.from < range.to
    );
    // A rewrite hides the words under it, so it is only drawn over the text
    // its positions were taken in; until the editor and the store agree, the
    // passage shows as dictated.
    const rewritesHold =
      pendingRanges.some((range) => range.rewrite) &&
      view.state.doc.toString() ===
        useTerminalInputStore.getState().getDraftInput(terminalId, projectId);
    const shownRanges = pendingRanges.map((range) =>
      range.rewrite &&
      (!rewritesHold || range.rewrite.to <= range.from || range.rewrite.to > range.to)
        ? { from: range.from, to: range.to }
        : range
    );

    view.dispatch({
      effects: [setInterimText.of(preview), setPendingAIRanges.of(shownRanges)],
    });
  }, [
    transcriptPhase,
    liveText,
    recordingRewrite,
    correctionRanges,
    anchor,
    terminalId,
    projectId,
    editorViewRef,
  ]);
}
