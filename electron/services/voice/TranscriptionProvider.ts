import type {
  VoiceInputError,
  VoiceInputSettings,
  VoiceInputStatus,
} from "../../../shared/types/ipc/api.js";

export interface CorrectionWord {
  word: string;
  confidence: number;
  start?: number;
  end?: number;
}

export interface SegmentConfidence {
  minConfidence: number;
  wordCount: number;
  uncertainWords: string[];
  words: CorrectionWord[];
}

export type VoiceTranscriptionEvent =
  // `itemId` identifies the audio segment a delta/completion belongs to. A
  // delta without one is reconciled strictly sequentially by the renderer.
  // `replace` marks a delta carrying the item's whole text so far rather than
  // an addition: Deepgram revises its interim hypothesis in place.
  | { type: "delta"; text: string; itemId?: string; replace?: boolean }
  // `endOfSpeech` marks a completion the speaker paused after, rather than one
  // the provider cut mid-speech; only those may carry a spoken "send it".
  | {
      type: "complete";
      text: string;
      confidence?: SegmentConfidence;
      itemId?: string;
      endOfSpeech?: boolean;
    }
  | { type: "paragraph_boundary" }
  // The provider's own VAD heard speech begin, before any transcript of it.
  // Main-only: it holds back a spoken send and never reaches the renderer.
  | { type: "speech_started" }
  | { type: "error"; error: VoiceInputError }
  | { type: "status"; status: VoiceInputStatus }
  // The terms a request actually carried, after the provider's own sanitizing,
  // limits and retries. Internal: the handler records it and never forwards it.
  | { type: "terms_sent"; terms: string[]; keytermAttempt?: "full" | "trimmed" | "none" };

/** A provider event as the service forwards it, tagged with its dictation session. */
export type VoiceSessionEvent = VoiceTranscriptionEvent & { sessionId: string };

export type VoiceStartResult = { ok: true } | { ok: false; error: string };

/** What one start needs beyond its settings. Runtime only, never persisted. */
export interface TranscriptionStartContext {
  /**
   * Bias terms still being assembled, in place of `settings.keyterms`. Never
   * rejects. A provider that sends them after its socket opens connects
   * without waiting for them.
   */
  keyterms?: Promise<string[]>;
}

// Ceiling for audio held before it can be sent — both in the IPC handler while
// the provider is being brought up, and in each provider while its socket
// connects or reconnects. Sized to the renderer's own startup queue
// (`MAX_QUEUED_CHUNKS`: 150 chunks of 100ms, 24kHz mono PCM16 = 4,800 bytes
// each, so 15s), so nothing the renderer can hold is lost one hop later.
export const AUDIO_BUFFER_MAX_CHUNKS = 150;
export const AUDIO_BUFFER_MAX_BYTES = 720_000;

export const AUDIO_BUFFER_OVERFLOW_CODE = "audio_buffer_overflow";

/** Transient: the session keeps running, only audio past the cap was lost. */
export function createAudioBufferOverflowError(): VoiceInputError {
  return {
    severity: "transient",
    code: AUDIO_BUFFER_OVERFLOW_CODE,
    message: "Connecting took too long, so some audio from the start of dictation was lost.",
  };
}

// Providers emit a neutral, fully-confident stub: the real word-level
// confidence/correction pass lives in VoiceCorrectionService, not the
// transcription stream. Both providers reuse this so the renderer's confidence
// shape stays consistent regardless of backend.
export const STUB_CONFIDENCE: SegmentConfidence = {
  minConfidence: 1.0,
  wordCount: 0,
  uncertainWords: [],
  words: [],
};

/**
 * One concrete transcription backend (OpenAI Realtime, Deepgram, …). The
 * orchestrator (`VoiceTranscriptionService`) talks only to this interface and
 * never to a provider's protocol details. A provider owns its own WebSocket
 * connection, authentication, audio encoding, server-event parsing, and any
 * timers (commit cadence, keep-alive, heartbeat) its protocol requires.
 */
export interface TranscriptionProvider {
  /**
   * Whether the backend performs server-side voice-activity detection / turn
   * detection. When `false` the provider must drive utterance segmentation
   * itself (e.g. OpenAI's client-side VAD side-chain, which drives the commit
   * cadence because that provider sends `turn_detection: null`). When `true`
   * the backend emits finalized segments on its own, so no client-side commit
   * timer exists.
   */
  readonly hasServerVAD: boolean;
  /** `sessionId` is the renderer-minted dictation session id, for correlation. */
  start(
    settings: VoiceInputSettings,
    sessionId: string,
    context?: TranscriptionStartContext
  ): Promise<VoiceStartResult>;
  sendAudioChunk(chunk: ArrayBuffer): void;
  /**
   * Flush the current audio segment at a user-driven paragraph boundary (Enter
   * pressed mid-utterance). Server-VAD providers ask the backend to finalise
   * what it has buffered.
   */
  commitParagraphBoundary(): void;
  stopGracefully(): Promise<void>;
  stop(): void;
  destroy(): void;
  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void;
}
