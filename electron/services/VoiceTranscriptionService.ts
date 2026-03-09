import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import type { ListenLiveClient, LiveTranscriptionEvent } from "@deepgram/sdk";
import type { VoiceInputSettings } from "../../shared/types/ipc/api.js";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger.js";

const P = "[VoiceTranscription]";

export type VoiceTranscriptionEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string }
  | { type: "paragraph_boundary" }
  | { type: "error"; message: string }
  | { type: "status"; status: "idle" | "connecting" | "recording" | "finishing" | "error" };

type VoiceStartResult = { ok: true } | { ok: false; error: string };

export class VoiceTranscriptionService {
  private connection: ListenLiveClient | null = null;
  private sessionId = 0;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

  private preConnectBuffer: ArrayBuffer[] = [];
  private isReady = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;

  /** Tracks accumulated is_final segments for the current utterance. */
  private utteranceSegments: string[] = [];
  /** Total text emitted as delta events for the current utterance (for incremental diffs). */
  private liveText = "";

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceTranscriptionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout !== null) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private clearKeepAliveInterval(): void {
    if (this.keepAliveInterval !== null) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private settlePendingStart(sessionId: number, result: VoiceStartResult): void {
    if (this.pendingStart?.sessionId !== sessionId) return;
    const { resolve } = this.pendingStart;
    this.pendingStart = null;
    resolve(result);
  }

  async start(settings: VoiceInputSettings): Promise<VoiceStartResult> {
    if (!settings.deepgramApiKey) {
      logWarn(`${P} No Deepgram API key configured`);
      return { ok: false, error: "Deepgram API key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, {
      language: settings.language,
      hasDictionary: settings.customDictionary.length > 0,
    });
    this.cleanupPreviousSession();
    this.sessionId = mySessionId;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.resetUtteranceState();

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };

      const keyterms = settings.customDictionary.slice(0, 100);
      const deepgram = createClient(settings.deepgramApiKey);

      logDebug(`${P} Opening Deepgram live connection`, {
        model: settings.transcriptionModel || "nova-3",
        language: settings.language || "en",
        keyterms: keyterms.length,
      });

      // Paragraphing strategy controls which Deepgram features are enabled:
      //   "spoken-command" (default): Deepgram Dictation mode — the user says "new paragraph"
      //     and Deepgram intercepts it, inserting \n\n into the transcript text. This is the
      //     reliable live-streaming mechanism. `paragraphs: true` was evaluated and rejected
      //     because it populates a JSON object rather than injecting \n\n into transcript text.
      //   "manual": No dictation mode; paragraph breaks come from the Enter key only.
      // Both modes use endpointing: 800ms (the sweet spot for dictation — 500ms fragments
      // speech mid-thought; 1500ms feels sluggish) with utterance_end_ms: 1000ms as fallback.
      const isSpokenCommand =
        (settings.paragraphingStrategy ?? "spoken-command") === "spoken-command";

      const connection = deepgram.listen.live({
        model: settings.transcriptionModel || "nova-3",
        language: settings.language || "en",
        smart_format: true,
        interim_results: true,
        endpointing: 800,
        utterance_end_ms: 1000,
        encoding: "linear16",
        sample_rate: 24000,
        ...(isSpokenCommand ? { dictation: true, punctuate: true } : {}),
        ...(keyterms.length > 0 ? { keyterm: keyterms } : {}),
      });

      this.connection = connection;

      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        logError(`${P} Connection timed out (10s)`);
        if (this.sessionId === mySessionId) {
          this.cleanupConnection();
          this.emit({ type: "error", message: "Connection timed out" });
          this.emit({ type: "status", status: "error" });
          this.settlePendingStart(mySessionId, { ok: false, error: "Connection timed out" });
        }
      }, 10000);

      connection.on(LiveTranscriptionEvents.Open, () => {
        this.clearConnectTimeout();
        logInfo(`${P} Connection opened`);

        if (this.sessionId !== mySessionId) {
          logWarn(`${P} Session expired during connect, closing`);
          connection.requestClose();
          return;
        }

        if (this.preConnectBuffer.length > 0) {
          logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`);
          for (const chunk of this.preConnectBuffer) {
            connection.send(chunk as ArrayBuffer);
          }
          this.preConnectBuffer = [];
        }

        this.keepAliveInterval = setInterval(() => {
          if (this.connection === connection) {
            connection.keepAlive();
          }
        }, 8000);

        this.isReady = true;
        this.emit({ type: "status", status: "recording" });
        this.settlePendingStart(mySessionId, { ok: true });
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data: LiveTranscriptionEvent) => {
        if (this.sessionId !== mySessionId) return;
        try {
          const transcript: string = data.channel?.alternatives?.[0]?.transcript ?? "";
          const isFinal: boolean = data.is_final ?? false;
          const speechFinal: boolean = data.speech_final ?? false;

          logDebug(`${P} Transcript event`, { isFinal, speechFinal, len: transcript.length });

          this.handleTranscript(transcript, isFinal, speechFinal);
        } catch {
          logWarn(`${P} Failed to process transcript event`);
        }
      });

      connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
        if (this.sessionId !== mySessionId) return;
        logDebug(`${P} UtteranceEnd — flushing accumulated segments`);
        this.flushUtterance();
      });

      connection.on(LiveTranscriptionEvents.Error, (err: Error) => {
        this.clearConnectTimeout();
        if (this.sessionId !== mySessionId) return;
        const errObj = err as { message?: string; error?: string };
        const message =
          err instanceof Error
            ? err.message
            : (errObj?.message ?? errObj?.error ?? "Deepgram error");
        logError(`${P} Connection error`, { message });
        this.cleanupConnection();
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
        this.settlePendingStart(mySessionId, { ok: false, error: message });
        this.settleDrain();
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        this.clearConnectTimeout();
        logInfo(`${P} Connection closed`);
        if (this.sessionId !== mySessionId) return;
        this.cleanupConnection();
        this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
        if (this.isDraining) {
          this.settleDrain();
        } else {
          this.emit({ type: "status", status: "idle" });
        }
      });
    });
  }

  private emitCompleteWithParagraphDetection(text: string): void {
    // In spoken-command mode, Deepgram Dictation intercepts "new paragraph" and
    // injects \n\n into the transcript text. Split on these markers so each paragraph
    // is emitted separately with a paragraph_boundary event between them.
    // Only emit boundaries between non-empty parts to avoid spurious events
    // from leading/trailing \n\n (e.g. "para\n\n" or "\n\npara").
    const parts = text
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      this.emit({ type: "complete", text: parts[i] });
      if (i < parts.length - 1) {
        this.emit({ type: "paragraph_boundary" });
      }
    }
  }

  private handleTranscript(transcript: string, isFinal: boolean, speechFinal: boolean): void {
    if (speechFinal) {
      const segments = [...this.utteranceSegments, transcript].filter((s) => s.trim());
      const fullText = segments.join(" ").trim();
      this.resetUtteranceState();

      if (fullText) {
        this.emitCompleteWithParagraphDetection(fullText);
      }
      if (this.isDraining) {
        this.settleDrain();
      }
    } else if (isFinal) {
      const segmentText = transcript.trim();
      if (segmentText) {
        const accumulated = [...this.utteranceSegments, segmentText].filter(Boolean).join(" ");
        this.emitIncrementalDelta(accumulated);
        this.utteranceSegments.push(segmentText);
      }
    } else {
      if (!transcript) return;
      const accumulated = [...this.utteranceSegments, transcript].filter(Boolean).join(" ");
      this.emitIncrementalDelta(accumulated);
    }
  }

  private emitIncrementalDelta(accumulated: string): void {
    if (accumulated.startsWith(this.liveText)) {
      const newChars = accumulated.slice(this.liveText.length);
      if (newChars) {
        this.emit({ type: "delta", text: newChars });
        this.liveText = accumulated;
      }
    } else if (!this.liveText) {
      this.emit({ type: "delta", text: accumulated });
      this.liveText = accumulated;
    } else {
      // Deepgram revised earlier text (non-prefix change). Update the baseline
      // so future appends can still emit incremental deltas correctly.
      this.liveText = accumulated;
    }
  }

  private flushUtterance(): void {
    // Use liveText if set — it includes any pending interim transcript that has
    // not yet received is_final=true (e.g. when UtteranceEnd fires without speech_final).
    const fullText = (this.liveText || this.utteranceSegments.join(" ")).trim();
    this.resetUtteranceState();
    if (fullText) {
      this.emitCompleteWithParagraphDetection(fullText);
    }
    if (this.isDraining) {
      this.settleDrain();
    }
  }

  private resetUtteranceState(): void {
    this.utteranceSegments = [];
    this.liveText = "";
  }

  private audioChunkCount = 0;
  private staleChunkWarned = false;

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      if (this.connection || this.pendingStart) {
        if (this.preConnectBuffer.length < 100) {
          this.preConnectBuffer.push(chunk);
        }
      } else if (!this.staleChunkWarned) {
        this.staleChunkWarned = true;
        logWarn(`${P} sendAudioChunk called but no active session`);
      }
      return;
    }
    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 200 === 0) {
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, { bytes: chunk.byteLength });
    }
    this.connection.send(chunk as ArrayBuffer);
  }

  private cleanupConnection(): void {
    this.clearKeepAliveInterval();
    this.connection = null;
    this.isReady = false;
  }

  private cleanupPreviousSession(): void {
    logDebug(`${P} Cleaning up previous session`, {
      sessionId: this.sessionId,
      hasConnection: !!this.connection,
    });
    const pendingSessionId = this.pendingStart?.sessionId;
    this.sessionId++;
    this.audioChunkCount = 0;
    this.staleChunkWarned = false;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.clearConnectTimeout();
    this.clearKeepAliveInterval();
    this.clearDrainTimeout();
    this.isDraining = false;
    this.resetUtteranceState();
    if (this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
    if (pendingSessionId !== undefined) {
      this.settlePendingStart(pendingSessionId, { ok: false, error: "Voice session stopped" });
    }
    if (this.connection) {
      try {
        this.connection.requestClose();
      } catch {
        // Ignore close errors
      }
      this.connection = null;
    }
  }

  private clearDrainTimeout(): void {
    if (this.drainTimeout !== null) {
      clearTimeout(this.drainTimeout);
      this.drainTimeout = null;
    }
  }

  private settleDrain(): void {
    this.clearDrainTimeout();
    this.isDraining = false;
    this.drainPromise = null;
    if (this.drainResolve) {
      logInfo(`${P} Drain completed`);
      const resolve = this.drainResolve;
      this.drainResolve = null;
      resolve();
    }
  }

  async stopGracefully(): Promise<void> {
    logInfo(`${P} stopGracefully() called`, {
      sessionId: this.sessionId,
      hasConnection: !!this.connection,
    });

    if (this.drainPromise) {
      logDebug(`${P} Already draining, joining existing promise`);
      return this.drainPromise;
    }

    if (!this.connection || !this.isReady) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isDraining = true;
    this.emit({ type: "status", status: "finishing" });

    try {
      this.connection.finish();
      logDebug(`${P} Sent finalize to Deepgram`);
    } catch {
      logWarn(`${P} Failed to send finalize, closing immediately`);
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        logWarn(`${P} Drain timed out after 3s, force closing`);
        this.flushUtterance();
        this.settleDrain();
      }, 3000);
    });

    const sessionIdBeforeDrain = this.sessionId;
    await this.drainPromise;

    // If start() was called during drain it already ran cleanupPreviousSession()
    // and incremented sessionId — don't tear down the new session.
    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  stop(): void {
    logInfo(`${P} stop() called`, { sessionId: this.sessionId, hasConnection: !!this.connection });
    this.cleanupPreviousSession();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
