/**
 * How `GrokTranscriptionProvider` ends utterances and the stream. Production
 * runs `GROK_TRANSCRIPTION_TUNING`; the live harness (`npm run perf
 * voice-pipeline`) passes variants to the constructor, so every arm runs the
 * same provider code. Kept apart from the provider so the harness can type a
 * variant without loading it.
 */
export interface GrokTranscriptionTuning {
  /**
   * The silence, in ms, the server waits before it ends an utterance with a
   * `speech_final`. Deepgram's endpoint, so a spoken "send it" gets the same
   * settle in the handler; xAI's default is 400.
   */
  endpointingMs: number;
  /**
   * Ask xAI to write numbers, symbols and the like (`format`, its inverse text
   * normalisation) for a language it formats. Off, the transcript is the words
   * as spoken and cleanup writes them.
   */
  format: boolean;
}

// A stop sends audio.done alone. Sending finalize ahead of it brought the last
// final back about 90ms sooner on the pipeline benchmark, but finalised before
// the server had read the last audio and lost the closing word.
export const GROK_TRANSCRIPTION_TUNING: Readonly<GrokTranscriptionTuning> = {
  endpointingMs: 300,
  format: true,
};

/** Production's tuning with `overrides` on top. Throws on one that can't run. */
export function resolveGrokTranscriptionTuning(
  overrides: Partial<GrokTranscriptionTuning> = {}
): Readonly<GrokTranscriptionTuning> {
  const tuning = { ...GROK_TRANSCRIPTION_TUNING, ...overrides };
  // xAI accepts 0 to 5000.
  if (
    !Number.isInteger(tuning.endpointingMs) ||
    tuning.endpointingMs < 0 ||
    tuning.endpointingMs > 5_000
  ) {
    throw new Error(`endpointingMs must be a whole number of milliseconds from 0 to 5000`);
  }
  return tuning;
}
