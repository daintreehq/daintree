import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

/** A correction just swapped into a panel's draft, on its way to that panel's composer. */
export interface LandedCorrection {
  /** Where the corrected passage starts in the draft. */
  from: number;
  rawText: string;
  correctedText: string;
}

// Keyed by panel. The composer takes it with the draft revision the swap
// bumped; a composer that is not mounted takes it when it next syncs.
const landed = new Map<string, LandedCorrection>();

export function recordCorrectionLanded(panelId: string, correction: LandedCorrection): void {
  if (correction.rawText === correction.correctedText) return;
  landed.set(panelId, correction);
}

/**
 * The correction waiting for `panelId`'s composer, if `draft` still holds it
 * where it landed. Taken either way: one that no longer matches the draft has
 * nothing left to show.
 */
export function takeLandedCorrection(panelId: string, draft: string): LandedCorrection | null {
  const correction = landed.get(panelId);
  if (!correction) return null;
  landed.delete(panelId);
  const { from, correctedText } = correction;
  return draft.slice(from, from + correctedText.length) === correctedText ? correction : null;
}

/**
 * Moves the send-time learning baseline (#9749) with the passage. Putting the
 * raw transcription back is rejecting the correction, not correcting the
 * transcriber, so learning diffs the send against what was heard. Only a
 * baseline that still matches the other side moves: a newer session's, or one
 * a send already consumed, stays as it is.
 */
export function rebaseCorrectionBaseline(
  panelId: string,
  correction: LandedCorrection,
  now: "raw" | "corrected"
): void {
  const voice = useVoiceRecordingStore.getState();
  const baseline = voice.panelBuffers[panelId]?.sessionCorrectedText;
  const [from, to] =
    now === "raw"
      ? [correction.correctedText, correction.rawText]
      : [correction.rawText, correction.correctedText];
  if (baseline === from) voice.setSessionCorrectedText(panelId, to);
}

export function announceCorrectionShown(): void {
  useVoiceRecordingStore.getState().announce("Correction applied. Undo restores the original.");
}
