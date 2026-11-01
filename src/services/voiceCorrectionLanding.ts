import { makeDraftKey } from "@/lib/draftKey";
import { minimalDocChange, type TextChange } from "@/lib/textRangeMapping";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";

/**
 * The send-time learning baseline (#9749) on either side of a swap: the
 * dictated passages as heard, and as corrected.
 */
export interface CorrectionBaseline {
  raw: string;
  corrected: string;
  /**
   * The session, for a chunk cleaned while it ran (#14772): the two sides are
   * the chunk's passages alone, which the baseline written at that session's
   * stop holds among the rest of its words.
   */
  partOf?: string;
}

/** A correction just swapped into a panel's draft, on its way to that panel's composer. */
export interface LandedCorrection {
  /** Where the corrected span starts in the draft. */
  from: number;
  rawText: string;
  correctedText: string;
  baseline: CorrectionBaseline | null;
  /** The dictation session whose words it cleaned. */
  sessionId: string;
  /**
   * The draft write that swapped it in, passage by passage, for a composer
   * still showing `before`: one replacement over the whole span would drop
   * the image chips between the passages.
   */
  write?: { before: string; after: string; changes: readonly TextChange[] };
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

// The composers showing each draft, by draft key. A composer writes its text
// to the store a render after each keystroke, so the store can trail it.
const draftWriters = new Map<string, Set<() => void>>();

/**
 * Lets a correction be placed in the text a composer shows, not the store's
 * copy a render behind it (#15873). `writeThrough` writes typing the store
 * doesn't hold yet straight to it, and leaves alone a store holding an outside
 * write the composer hasn't shown.
 */
export function registerComposerDraftWriter(
  panelId: string,
  projectId: string | undefined,
  writeThrough: () => void
): () => void {
  const key = makeDraftKey(panelId, projectId);
  let writers = draftWriters.get(key);
  if (!writers) {
    writers = new Set();
    draftWriters.set(key, writers);
  }
  writers.add(writeThrough);
  return () => {
    const current = draftWriters.get(key);
    if (!current) return;
    current.delete(writeThrough);
    if (current.size === 0) draftWriters.delete(key);
  };
}

/** Brings a stored draft up to the typing its composers show, before a correction reads it. */
export function writeComposerDraftThrough(panelId: string, projectId: string | undefined): void {
  const writers = draftWriters.get(makeDraftKey(panelId, projectId));
  if (!writers) return;
  for (const writeThrough of [...writers]) writeThrough();
}

/** The correction waiting for this draft's composer, left for it to take. */
export function peekLandedCorrection(
  panelId: string,
  projectId: string | undefined
): LandedCorrection | null {
  return landed.get(makeDraftKey(panelId, projectId)) ?? null;
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
 * Whether a correction still belongs to the latest dictation on its voice
 * panel. Once another has started, the correction is behind the user, and it
 * lands without a review (#14875).
 */
export function isLatestDictation(panelId: string, correction: LandedCorrection): boolean {
  const latest = useVoiceRecordingStore.getState().panelBuffers[panelId]?.dictationSessionId;
  return !latest || latest === correction.sessionId;
}

/**
 * The change that brings a composer showing `shown` up to `draft`. A landed
 * correction that is exactly the write between them goes in passage by
 * passage, so the chips between its passages stay; anything else is the one
 * span that differs.
 */
export function outsideWriteChange(
  shown: string,
  draft: string,
  landed: LandedCorrection | null
): TextChange | readonly TextChange[] | null {
  const write = landed?.write;
  if (write && write.before === shown && write.after === draft) return write.changes;
  return minimalDocChange(shown, draft);
}

/**
 * Whether the composer was typed into after `landed` was placed in the text it
 * showed (`placedIn`, what it last wrote through). Its passages may have been
 * typed into, so the composer's text stands and the correction is dropped, as
 * an edit to a passage drops it (#15873). A composer that was only behind the
 * draft, typing nothing, still takes the correction.
 */
export function typedPastCorrection(
  shown: string,
  draft: string,
  landed: LandedCorrection | null,
  placedIn: string | null
): landed is LandedCorrection {
  const write = landed?.write;
  return (
    write !== undefined &&
    write.after === draft &&
    write.before === placedIn &&
    shown !== write.before &&
    shown !== write.after
  );
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
  const { raw, corrected, partOf } = correction.baseline;
  const [from, to] = now === "raw" ? [corrected, raw] : [raw, corrected];
  const buffer = voice.panelBuffers[panelId];
  const current = buffer?.sessionCorrectedText;
  if (!partOf) {
    if (current === from) voice.setSessionCorrectedText(panelId, to);
    return;
  }
  // Only inside its own session's baseline, and only where it can't be
  // mistaken for another copy of the same words.
  if (!current || !from || buffer.dictationSessionId !== partOf) return;
  const at = current.indexOf(from);
  if (at < 0 || current.indexOf(from, at + 1) >= 0) return;
  voice.setSessionCorrectedText(
    panelId,
    current.slice(0, at) + to + current.slice(at + from.length)
  );
}

export function announceCorrectionShown(): void {
  useVoiceRecordingStore.getState().announce("Correction applied. Undo restores the original.");
}
