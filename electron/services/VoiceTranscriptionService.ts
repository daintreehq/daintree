import { v2 } from "@google-cloud/speech";
import type { VoiceInputSettings } from "../../shared/types/ipc/api.js";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger.js";

const P = "[VoiceTranscription]";

/** Pre-emptive reconnect before the 5-minute Chirp 3 session limit. */
const SESSION_RECONNECT_MS = 4.5 * 60 * 1000;
/** Duration to send audio to both old and new stream during handoff. */
const DUAL_STREAM_OVERLAP_MS = 2000;

export type VoiceTranscriptionEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string }
  | { type: "error"; message: string }
  | { type: "status"; status: "idle" | "connecting" | "recording" | "finishing" | "error" };

type VoiceStartResult = { ok: true } | { ok: false; error: string };

interface ActiveStream {
  stream: ReturnType<InstanceType<typeof v2.SpeechClient>["_streamingRecognize"]>;
  sessionTimer: ReturnType<typeof setTimeout>;
  overlapTimer: ReturnType<typeof setTimeout> | null;
}

export class VoiceTranscriptionService {
  private client: InstanceType<typeof v2.SpeechClient> | null = null;
  private activeStream: ActiveStream | null = null;
  private pendingStream: ActiveStream | null = null;
  private sessionId = 0;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;
  private isReady = false;
  private preConnectBuffer: Buffer[] = [];

  private stopResolve: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopTimeout: ReturnType<typeof setTimeout> | null = null;
  private isStopping = false;

  private audioChunkCount = 0;
  private settings: VoiceInputSettings | null = null;

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceTranscriptionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private settlePendingStart(sessionId: number, result: VoiceStartResult): void {
    if (this.pendingStart?.sessionId !== sessionId) return;
    const { resolve } = this.pendingStart;
    this.pendingStart = null;
    resolve(result);
  }

  async start(settings: VoiceInputSettings): Promise<VoiceStartResult> {
    if (!settings.googleCloudCredentialPath) {
      logWarn(`${P} No Google Cloud credential path configured`);
      return { ok: false, error: "Google Cloud service account key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, {
      language: settings.language,
      hasDictionary: settings.customDictionary.length > 0,
    });

    this.cleanupSession();
    this.sessionId = mySessionId;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.isStopping = false;
    this.settings = settings;

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      this.openStream(mySessionId, true);
    });
  }

  private buildRecognizeConfig(settings: VoiceInputSettings) {
    const phrases = settings.customDictionary.map((term) => ({ value: term, boost: 15 }));

    return {
      recognizer: `projects/-/locations/global/recognizers/_`,
      streamingConfig: {
        config: {
          model: "chirp_3",
          languageCodes: [this.toChirp3Locale(settings.language || "en")],
          explicitDecodingConfig: {
            encoding: "LINEAR16" as const,
            sampleRateHertz: 24000,
            audioChannelCount: 1,
          },
          ...(phrases.length > 0
            ? {
                adaptation: {
                  phraseSets: [
                    {
                      inlinePhraseSet: { phrases },
                    },
                  ],
                },
              }
            : {}),
        },
        streamingFeatures: { interimResults: true },
      },
    };
  }

  private toChirp3Locale(language: string): string {
    const localeMap: Record<string, string> = {
      en: "en-US",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      ja: "ja-JP",
      zh: "zh-CN",
      ko: "ko-KR",
      pt: "pt-BR",
      it: "it-IT",
      ru: "ru-RU",
    };
    return localeMap[language] ?? language;
  }

  private openStream(mySessionId: number, isPrimary: boolean): void {
    if (this.sessionId !== mySessionId) return;

    if (!this.client) {
      const settings = this.settings;
      if (!settings) return;
      this.client = new v2.SpeechClient({
        keyFilename: settings.googleCloudCredentialPath,
      });
      logDebug(`${P} Created SpeechClient`);
    }

    const settings = this.settings;
    if (!settings) return;

    logInfo(`${P} Opening Chirp 3 stream (primary=${isPrimary})`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (this.client as any)._streamingRecognize() as ReturnType<
      InstanceType<typeof v2.SpeechClient>["_streamingRecognize"]
    >;

    stream.on(
      "data",
      (response: {
        results?: Array<{ isFinal?: boolean; alternatives?: Array<{ transcript?: string }> }>;
      }) => {
        if (this.sessionId !== mySessionId) return;
        const results = response.results ?? [];
        for (const result of results) {
          const transcript = result.alternatives?.[0]?.transcript ?? "";
          if (!transcript) continue;
          if (result.isFinal) {
            logDebug(`${P} Final transcript: "${transcript.slice(0, 50)}..."`);
            this.emit({ type: "complete", text: transcript });
          } else {
            this.emit({ type: "delta", text: transcript });
          }
        }
      }
    );

    stream.on("error", (err: Error) => {
      if (this.sessionId !== mySessionId) return;
      const message = err.message;
      logError(`${P} Stream error`, err);

      if (isPrimary) {
        this.isReady = false;
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
        this.settlePendingStart(mySessionId, { ok: false, error: message });
        this.activeStream = null;
      } else {
        // Clear dead pending stream so it won't be promoted
        if (this.pendingStream?.stream === stream) {
          this.pendingStream = null;
        }
      }
      if (isPrimary) this.settleDrain();
    });

    stream.on("end", () => {
      if (this.sessionId !== mySessionId) return;
      logInfo(`${P} Stream ended (primary=${isPrimary})`);
      if (isPrimary) {
        this.activeStream = null;
        this.isReady = false;
        if (this.isStopping) {
          this.settleDrain();
        } else {
          this.emit({ type: "status", status: "idle" });
        }
      } else {
        // Clear dead pending stream so it won't be promoted
        if (this.pendingStream?.stream === stream) {
          this.pendingStream = null;
        }
      }
    });

    const sessionTimer = setTimeout(() => {
      if (this.sessionId !== mySessionId || !isPrimary) return;
      logInfo(`${P} Pre-emptive reconnect at 4m30s`);
      this.rotateStream(mySessionId);
    }, SESSION_RECONNECT_MS);

    const entry: ActiveStream = { stream, sessionTimer, overlapTimer: null };

    // Send config as first message
    try {
      stream.write(this.buildRecognizeConfig(settings));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`${P} Failed to write config to stream`, err);
      clearTimeout(sessionTimer);
      this.settlePendingStart(mySessionId, { ok: false, error: message });
      return;
    }

    if (isPrimary) {
      this.activeStream = entry;

      // Flush pre-connect buffer
      if (this.preConnectBuffer.length > 0) {
        logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`);
        for (const buf of this.preConnectBuffer) {
          try {
            stream.write({ audio: buf });
          } catch {
            /* best-effort */
          }
        }
        this.preConnectBuffer = [];
      }

      this.isReady = true;
      this.emit({ type: "status", status: "recording" });
      this.settlePendingStart(mySessionId, { ok: true });
    } else {
      this.pendingStream = entry;
    }
  }

  private rotateStream(mySessionId: number): void {
    if (this.sessionId !== mySessionId) return;

    logInfo(`${P} Rotating stream — opening new stream`);
    this.openStream(mySessionId, false);

    // After overlap window, promote pending to active
    const overlapTimer = setTimeout(() => {
      if (this.sessionId !== mySessionId) return;
      const old = this.activeStream;
      const next = this.pendingStream;
      this.pendingStream = null;

      if (old) {
        logInfo(`${P} Closing old stream after overlap`);
        clearTimeout(old.sessionTimer);
        if (old.overlapTimer) clearTimeout(old.overlapTimer);
        try {
          old.stream.end();
        } catch {
          /* best-effort */
        }
      }

      if (next) {
        // Clear the pending stream's original timer (it has isPrimary=false, so it's inert)
        clearTimeout(next.sessionTimer);
        // Arm a new session timer for the promoted stream
        next.sessionTimer = setTimeout(() => {
          if (this.sessionId !== mySessionId) return;
          logInfo(`${P} Pre-emptive reconnect at 4m30s`);
          this.rotateStream(mySessionId);
        }, SESSION_RECONNECT_MS);
        this.activeStream = next;
        logInfo(`${P} New stream promoted to active`);
      }
    }, DUAL_STREAM_OVERLAP_MS);

    if (this.activeStream) {
      this.activeStream.overlapTimer = overlapTimer;
    }
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isStopping) return;

    const buf = Buffer.from(chunk);

    if (!this.isReady || !this.activeStream) {
      if (this.pendingStart) {
        if (this.preConnectBuffer.length < 100) {
          this.preConnectBuffer.push(buf);
        }
      }
      return;
    }

    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 200 === 0) {
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, { bytes: buf.byteLength });
    }

    try {
      this.activeStream.stream.write({ audio: buf });
      // Also send to pending stream during overlap
      if (this.pendingStream) {
        this.pendingStream.stream.write({ audio: buf });
      }
    } catch {
      logWarn(`${P} Failed to write audio chunk`);
    }
  }

  private settleDrain(): void {
    this.isStopping = false;
    this.stopPromise = null;
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    if (this.stopResolve) {
      const resolve = this.stopResolve;
      this.stopResolve = null;
      resolve();
    }
  }

  async stopGracefully(): Promise<void> {
    logInfo(`${P} stopGracefully() called`, { sessionId: this.sessionId });

    if (this.stopPromise) {
      return this.stopPromise;
    }

    if (!this.activeStream) {
      this.cleanupSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isStopping = true;
    this.emit({ type: "status", status: "finishing" });

    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      this.stopTimeout = setTimeout(() => {
        logWarn(`${P} Stop timed out after 3s`);
        this.settleDrain();
      }, 3000);

      const stream = this.activeStream?.stream;
      if (stream) {
        try {
          stream.end();
          logDebug(`${P} Called stream.end() for graceful stop`);
        } catch {
          this.settleDrain();
        }
      } else {
        this.settleDrain();
      }
    });

    await this.stopPromise;
    this.cleanupSession();
    this.emit({ type: "status", status: "idle" });
  }

  stop(): void {
    logInfo(`${P} stop() called`);
    this.cleanupSession();
    this.emit({ type: "status", status: "idle" });
  }

  private cleanupSession(): void {
    logDebug(`${P} Cleaning up session`, { sessionId: this.sessionId });
    this.sessionId++;
    this.audioChunkCount = 0;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.isStopping = false;
    this.settings = null;
    this.stopResolve = null;
    this.stopPromise = null;
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }

    if (this.pendingStart) {
      const { resolve } = this.pendingStart;
      this.pendingStart = null;
      resolve({ ok: false, error: "Voice session stopped" });
    }

    for (const entry of [this.activeStream, this.pendingStream]) {
      if (!entry) continue;
      clearTimeout(entry.sessionTimer);
      if (entry.overlapTimer) clearTimeout(entry.overlapTimer);
      try {
        entry.stream.end();
      } catch {
        /* best-effort */
      }
    }
    this.activeStream = null;
    this.pendingStream = null;

    if (this.client) {
      try {
        void this.client.close();
      } catch {
        /* best-effort */
      }
      this.client = null;
    }
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
