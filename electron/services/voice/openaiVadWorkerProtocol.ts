/**
 * Message protocol for the OpenAI transcription VAD side-chain
 * (`openaiVadWorker.ts`). The VAD runs Silero v5 (via `avr-vad`) in a
 * `utilityProcess` child so ONNX inference never blocks the Electron main
 * process and a native ONNX abort cannot take it down (#12577). It reports
 * speech-boundary events back to `OpenAITranscriptionProvider`, which drives
 * `input_audio_buffer.commit`/`clear` from them instead of a blind timer.
 *
 * Audio is raw 24kHz mono PCM16 — the same format streamed to OpenAI. The
 * child resamples to 16kHz internally (avr-vad handles this when `sampleRate`
 * is above 16kHz), so the main process posts chunks verbatim.
 */

/** Main process → VAD process. */
export type VadWorkerInbound =
  | {
      /** A chunk of 24kHz mono PCM16 audio to feed the VAD. */
      type: "audio";
      /** Raw PCM16 little-endian samples. Structured-cloned across the process boundary. */
      pcm: ArrayBuffer;
    }
  | {
      /**
       * Drain in-flight model load and inference, release the ONNX session,
       * then exit.
       */
      type: "destroy";
    };

/** VAD process → main process. */
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
       * After `destroy`: pending native work finished and the ONNX session was
       * released. The process exits immediately after posting this.
       */
      type: "drained";
    }
  | {
      /**
       * Fatal VAD error (model load failed, ONNX threw). The provider falls
       * back to a backstop-only commit cadence so dictation still works.
       */
      type: "error";
      message: string;
    };
