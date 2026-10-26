import { makeDraftKey } from "@/lib/draftKey";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

/**
 * The send-time learning baseline (#9749) on either side of a swap: the
 * dictated passages as heard, and as corrected.
 */
export interface CorrectionBaseline {
  raw: string;
  corrected: string;
}

/** A correction just swapped into a panel's draft, on its way to that panel's composer. */
export interface LandedCorrection {
  /** Where the corrected span starts in the draft. */
  from: number;
  rawText: string;
  correctedText: string;
  baseline: CorrectionBaseline | null;
}

// Keyed by draft, so an isolated composer for the same terminal never takes
// the pane's. The composer takes it with the draft revision the swap bumped;
// one that is not mounted takes it when it next syncs.
const landed = new Map<string, LandedCorrection>();

export function recordCorrectionLanded(
  panelId: string,
  projectId: string | undefined,
  correction: LandedCorrection
): void {
  if (correction.rawText === correction.correctedText) return;
  landed.set(makeDraftKey(panelId, projectId), correction);
}

/**
 * The correction waiting for this draft's composer, if `draft` still holds it
 * where it landed. Taken either way: one that no longer matches the draft has
 * nothing left to show.
 */
export function takeLandedCorrection(
  panelId: string,
  projectId: string | undefined,
  draft: string
): LandedCorrection | null {
  const key = makeDraftKey(panelId, projectId);
  const correction = landed.get(key);
  if (!correction) return null;
  landed.delete(key);
  const { from, correctedText } = correction;
  return draft.slice(from, from + correctedText.length) === correctedText ? correction : null;
}

/**
 * Moves the send-time learning baseline with the passage. Putting the raw
 * transcription back is rejecting the correction, not correcting the
 * transcriber, so learning diffs the send against what was heard. Only a
 * baseline that still matches the other side moves: a newer session's, or one
 * a send already consumed, stays as it is.
 */
export function rebaseCorrectionBaseline(
  panelId: string,
  correction: { baseline?: CorrectionBaseline | null },
  now: "raw" | "corrected"
): void {
  if (!correction.baseline) return;
  const voice = useVoiceRecordingStore.getState();
  const { raw, corrected } = correction.baseline;
  const [from, to] = now === "raw" ? [corrected, raw] : [raw, corrected];
  if (voice.panelBuffers[panelId]?.sessionCorrectedText === from) {
    voice.setSessionCorrectedText(panelId, to);
  }
}

export function announceCorrectionShown(): void {
  useVoiceRecordingStore.getState().announce("Correction applied. Undo restores the original.");
}
