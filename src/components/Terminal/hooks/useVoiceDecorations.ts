import { useEffect } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import { setInterimRange, setPendingAIRanges } from "../inputEditorExtensions";

const AI_CORRECTION_MATCH_RADIUS = 32;

export function resolveAICorrectionRange(
  doc: string,
  segmentStart: number,
  text: string
): { from: number; to: number } | null {
  if (!text) return null;

  const exactEnd = segmentStart + text.length;
  if (segmentStart >= 0 && exactEnd <= doc.length && doc.slice(segmentStart, exactEnd) === text) {
    return { from: segmentStart, to: exactEnd };
  }

  const nearbyStart = Math.max(0, segmentStart - AI_CORRECTION_MATCH_RADIUS);
  const nearbyEnd = Math.min(doc.length, segmentStart + AI_CORRECTION_MATCH_RADIUS + text.length);
  const nearbySlice = doc.slice(nearbyStart, nearbyEnd);
  const nearbyIndex = nearbySlice.indexOf(text);
  if (nearbyIndex >= 0) {
    const from = nearbyStart + nearbyIndex;
    return { from, to: from + text.length };
  }

  const firstIndex = doc.indexOf(text);
  if (firstIndex >= 0 && doc.indexOf(text, firstIndex + 1) === -1) {
    return { from: firstIndex, to: firstIndex + text.length };
  }

  return null;
}

interface UseVoiceDecorationsParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
  voiceDraftRevision: number;
}

export function useVoiceDecorations({
  terminalId,
  editorViewRef,
  voiceDraftRevision,
}: UseVoiceDecorationsParams) {
  const transcriptPhase = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
  );
  const liveSegmentStart = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.draftLengthAtSegmentStart ?? -1
  );
  const pendingCorrections = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.pendingCorrections
  );
  const voiceCorrectionEnabled = useVoiceRecordingStore((s) => s.correctionEnabled);

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    if (!voiceCorrectionEnabled) {
      view.dispatch({
        effects: [setInterimRange.of(null), setPendingAIRanges.of([])],
      });
      return;
    }

    const docLen = view.state.doc.length;
    const doc = view.state.doc.toString();
    const pendingRanges =
      pendingCorrections?.flatMap((correction) => {
        const range = resolveAICorrectionRange(doc, correction.segmentStart, correction.rawText);
        return range ? [range] : [];
      }) ?? [];

    switch (transcriptPhase) {
      case "interim": {
        const interimRange =
          liveSegmentStart >= 0 && liveSegmentStart < docLen
            ? { from: liveSegmentStart, to: docLen }
            : null;
        view.dispatch({
          effects: [setInterimRange.of(interimRange), setPendingAIRanges.of(pendingRanges)],
        });
        break;
      }
      case "paragraph_pending_ai":
      case "utterance_final":
      case "stable":
      case "idle": {
        view.dispatch({
          effects: [setInterimRange.of(null), setPendingAIRanges.of(pendingRanges)],
        });
        break;
      }
      default:
        view.dispatch({
          effects: [setInterimRange.of(null), setPendingAIRanges.of(pendingRanges)],
        });
        break;
    }
  }, [
    transcriptPhase,
    voiceDraftRevision,
    liveSegmentStart,
    voiceCorrectionEnabled,
    pendingCorrections,
    editorViewRef,
  ]);
}
