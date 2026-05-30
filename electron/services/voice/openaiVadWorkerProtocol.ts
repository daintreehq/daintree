/**
 * Message protocol for the OpenAI transcription VAD side-chain worker
 * (`openaiVadWorker.ts`). The worker runs Silero VAD v5 (via `avr-vad`) on a
 * worker thread so ONNX inference never blocks the Electron main process, and
 * reports speech-boundary events back to `OpenAITranscriptionProvider`, which
 * drives `input_audio_buffer.commit`/`clear` from them instead of a blind timer.
 *
 * Audio is raw 24kHz mono PCM16 — the same format streamed to OpenAI. The
 * worker resamples to 16kHz internally (avr-vad handles this when `sampleRate`
 * is above 16kHz), so the main process posts chunks verbatim.
 */

/** Main process → worker. */
export type VadWorkerInbound =
  | {
      /** A chunk of 24kHz mono PCM16 audio to feed the VAD. */
      type: "audio";
      /** Raw PCM16 little-endian samples. Transferred, not copied. */
      pcm: ArrayBuffer;
    }
  | {
      /** Tear down the VAD and release the ONNX session. */
      type: "destroy";
    };

/** Worker → main process. */
export type VadWorkerOutbound =
  | {
      /** VAD initialized and processing audio. Emitted once after model load. */
      type: "ready";
    }
  | {
      /** Speech onset detected — provider clears the server buffer (barge-in). */
      type: "speech-start";
    }
  | {
      /** End of speech after the holdover — provider commits the segment. */
      type: "speech-end";
    }
  | {
      /**
       * Fatal worker error (model load failed, ONNX threw). The provider falls
       * back to a backstop-only commit cadence so dictation still works.
       */
      type: "error";
      message: string;
    };
