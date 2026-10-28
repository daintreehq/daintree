import {
  VOICE_DELAY_TIERS,
  type VoiceDelayTier,
} from "../../../shared/types/voiceSessionSummary.js";

/**
 * How `OpenAITranscriptionProvider` trades preview speed against accuracy and
 * where it cuts continuous speech. Production runs `OPENAI_TRANSCRIPTION_TUNING`;
 * the live harness (`npm run perf voice-tuning`) passes variants to the
 * constructor, so every arm runs the same provider code. Kept apart from the
 * provider so the harness can type a variant without loading it.
 */
export interface OpenAITranscriptionTuning {
  /**
   * How long the model buffers audio before emitting a partial. At `low` the
   * completed transcript is the partials joined, not a second pass over the
   * segment (#14852), so a higher tier could reach the draft's accuracy, not
   * just the preview's speed.
   */
  delay: VoiceDelayTier;
  /**
   * Once a segment of continuous speech has run this long, the next short pause
   * the VAD hears commits it. Null commits only at `maxSegmentMs`.
   */
  minSegmentMs: number | null;
  /** Speech that runs this long without a commit is committed wherever it is. */
  maxSegmentMs: number;
}

// Measured on the replay clips (`npm run perf voice-tuning`, #14625). `medium`
// and `high` were level with `low` session for session on word error and term
// recall, and added a median 31ms and 99ms to the last final after a stop.
// Every cut in continuous speech cost words where it landed, so fewer won: a
// 15s cap halved the long clips' word error against 8s at no cost after the
// stop. Cutting at a short pause did no better than the 15s cap, since the
// commit lands up to a chunk after the pause is heard and synthesised pauses
// are short enough for that to clip the next word; recordings may differ.
export const OPENAI_TRANSCRIPTION_TUNING: Readonly<OpenAITranscriptionTuning> = {
  delay: "low",
  minSegmentMs: null,
  maxSegmentMs: 15_000,
};

function positiveMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Production's tuning with `overrides` on top. Throws on one that can't run. */
export function resolveOpenAITranscriptionTuning(
  overrides: Partial<OpenAITranscriptionTuning> = {}
): Readonly<OpenAITranscriptionTuning> {
  const tuning = { ...OPENAI_TRANSCRIPTION_TUNING, ...overrides };
  if (!VOICE_DELAY_TIERS.includes(tuning.delay)) {
    throw new Error(`Unknown transcription delay tier: ${String(tuning.delay)}`);
  }
  if (!positiveMs(tuning.maxSegmentMs)) {
    throw new Error(`maxSegmentMs must be a positive number of milliseconds`);
  }
  if (
    tuning.minSegmentMs !== null &&
    (!positiveMs(tuning.minSegmentMs) || tuning.minSegmentMs > tuning.maxSegmentMs)
  ) {
    throw new Error(`minSegmentMs must be null or a positive number no larger than maxSegmentMs`);
  }
  return tuning;
}
