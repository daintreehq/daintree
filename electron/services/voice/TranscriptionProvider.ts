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
  | { type: "delta"; text: string }
  | { type: "complete"; text: string; confidence?: SegmentConfidence }
  | { type: "paragraph_boundary" }
  | { type: "error"; error: VoiceInputError }
  | { type: "status"; status: VoiceInputStatus };

export type VoiceStartResult = { ok: true } | { ok: false; error: string };

// Ceiling for audio held before it can be sent — both in the IPC handler while
// the provider is being brought up, and in each provider while its socket
// connects. 24kHz mono PCM16 ≈ 48KB/s, so ~150KB ≈ 3s, the point past which
// voice context is lost anyway. Caps memory if chunks are large.
export const AUDIO_BUFFER_MAX_CHUNKS = 100;
export const AUDIO_BUFFER_MAX_BYTES = 150_000;

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
  start(settings: VoiceInputSettings): Promise<VoiceStartResult>;
  sendAudioChunk(chunk: ArrayBuffer): void;
  /**
   * Flush the current audio segment at a user-driven paragraph boundary (Enter
   * pressed mid-utterance). A no-op for server-VAD providers, which segment on
   * their own.
   */
  commitParagraphBoundary(): void;
  stopGracefully(): Promise<void>;
  stop(): void;
  destroy(): void;
  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void;
}
