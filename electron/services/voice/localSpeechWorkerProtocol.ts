/**
 * Messages between main and the on-device speech process
 * (`localSpeechWorker.ts`). One process serves one dictation at a time and
 * keeps the model loaded between them. Silero VAD and the speech model read
 * the same ordered audio in it, so a pause and the words around it are placed
 * by where they fall in that audio, never by which process answered first.
 *
 * Every session message carries the session's number; anything the process
 * still posts for an earlier session is dropped by main.
 */

/** Main → speech process. */
export type LocalSpeechWorkerInbound =
  | {
      /** Load the model from its checked folder. Once per process. */
      type: "load";
      dir: string;
      threads: number;
    }
  | {
      /** A new dictation: fresh model state, a fresh VAD, the language's prompt. */
      type: "start";
      session: number;
      promptId: number;
    }
  | {
      /** 24 kHz mono PCM16, little-endian, as the renderer captures it. */
      type: "audio";
      session: number;
      pcm: ArrayBuffer;
    }
  | {
      /** Enter mid-utterance: transcribe what has been heard and close the passage. */
      type: "cut";
      session: number;
    }
  | {
      /**
       * Audio was lost here (the connect buffer overflowed): close the
       * passage as incomplete, so no command is read across the gap.
       */
      type: "gap";
      session: number;
    }
  | {
      /** A graceful stop: transcribe everything heard, close the passage, then `finished`. */
      type: "finish";
      session: number;
    }
  | {
      /** The session is over without a drain: drop it and post nothing more for it. */
      type: "end";
      session: number;
    }
  | {
      /** Finish native work, release the model, post `drained`, exit. */
      type: "destroy";
    };

export type LocalSpeechSegmentReason = "pause" | "cap" | "cut" | "gap" | "finish";

/** Speech process → main. */
export type LocalSpeechWorkerOutbound =
  | { type: "ready"; loadMs: number }
  | { type: "load-failed"; message: string }
  | {
      /** The session's state is reset; `vad` is false when the VAD couldn't start. */
      type: "started";
      session: number;
      vad: boolean;
    }
  | {
      /** The open passage's whole text so far, replacing what was shown. */
      type: "text";
      session: number;
      segment: number;
      text: string;
    }
  | { type: "speech-start"; session: number }
  | {
      /**
       * A passage closed. `endOfSpeech`: a pause closed it and the VAD still
       * heard silence when it closed. `shown`: a `text` for it was posted.
       */
      type: "segment";
      session: number;
      segment: number;
      text: string;
      shown: boolean;
      reason: LocalSpeechSegmentReason;
      endOfSpeech: boolean;
    }
  | { type: "finished"; session: number }
  | {
      /** The session can't go on: inference failed. */
      type: "session-error";
      session: number;
      message: string;
    }
  | { type: "drained" }
  | {
      /** The process itself failed; it exits after posting this. */
      type: "error";
      message: string;
    };
