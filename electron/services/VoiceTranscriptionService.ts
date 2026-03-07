import WebSocket from "ws";
import type { VoiceInputSettings } from "../../shared/types/ipc/api.js";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger.js";

const P = "[VoiceTranscription]";

export type VoiceTranscriptionEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string }
  | { type: "error"; message: string }
  | { type: "status"; status: "idle" | "connecting" | "recording" | "error" };

type VoiceStartResult = { ok: true } | { ok: false; error: string };

export class VoiceTranscriptionService {
  private ws: WebSocket | null = null;
  private sessionId = 0;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

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

  private settlePendingStart(sessionId: number, result: VoiceStartResult): void {
    if (this.pendingStart?.sessionId !== sessionId) return;
    const { resolve } = this.pendingStart;
    this.pendingStart = null;
    resolve(result);
  }

  async start(settings: VoiceInputSettings): Promise<VoiceStartResult> {
    if (!settings.apiKey) {
      logWarn(`${P} No API key configured`);
      return { ok: false, error: "OpenAI API key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, {
      language: settings.language,
      hasDictionary: settings.customDictionary.length > 0,
    });
    this.cleanupPreviousSession();
    this.sessionId = mySessionId;

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      logDebug(`${P} Opening WebSocket to OpenAI Realtime API (transcription-only)`);
      const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.connectTimeout = setTimeout(() => {
        this.connectTimeout = null;
        logError(`${P} WebSocket connection timed out (10s)`);
        ws.terminate();
        if (this.sessionId === mySessionId) {
          this.emit({ type: "error", message: "Connection timed out" });
          this.emit({ type: "status", status: "error" });
          this.settlePendingStart(mySessionId, { ok: false, error: "Connection timed out" });
        }
      }, 10000);

      ws.on("open", () => {
        this.clearConnectTimeout();
        logInfo(`${P} WebSocket connected`);
        if (this.sessionId !== mySessionId) {
          logWarn(`${P} Session expired during connect, terminating`);
          ws.terminate();
          return;
        }

        this.ws = ws;

        const prompt =
          settings.customDictionary.length > 0
            ? `Technical terms: ${settings.customDictionary.join(", ")}.`
            : undefined;

        const sessionConfig = {
          type: "transcription_session.update",
          session: {
            input_audio_format: "pcm16",
            input_audio_transcription: {
              model: settings.transcriptionModel || "gpt-4o-mini-transcribe",
              language: settings.language || "en",
              ...(prompt ? { prompt } : {}),
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        };
        logDebug(`${P} Sending transcription_session.update`, {
          language: settings.language || "en",
        });
        ws.send(JSON.stringify(sessionConfig));

        this.emit({ type: "status", status: "recording" });
        this.settlePendingStart(mySessionId, { ok: true });
      });

      ws.on("message", (data: WebSocket.RawData) => {
        if (this.sessionId !== mySessionId) return;
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          logDebug(`${P} Server event: ${event.type as string}`);
          this.handleServerEvent(event);
        } catch {
          logWarn(`${P} Failed to parse server message`);
        }
      });

      ws.on("error", (err) => {
        this.clearConnectTimeout();
        if (this.sessionId !== mySessionId) return;
        const message = err instanceof Error ? err.message : "WebSocket error";
        logError(`${P} WebSocket error`, err);
        this.ws = null;
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
        this.settlePendingStart(mySessionId, { ok: false, error: message });
      });

      ws.on("close", (code, reason) => {
        this.clearConnectTimeout();
        logInfo(`${P} WebSocket closed`, { code, reason: reason?.toString() });
        if (this.sessionId !== mySessionId) return;
        this.ws = null;
        this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
        this.emit({ type: "status", status: "idle" });
      });
    });
  }

  private handleServerEvent(event: Record<string, unknown>): void {
    const type = event.type as string;

    if (type === "conversation.item.input_audio_transcription.delta") {
      const delta = (event as { delta?: string }).delta ?? "";
      if (delta) {
        this.emit({ type: "delta", text: delta });
      }
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      const transcript = (event as { transcript?: string }).transcript ?? "";
      if (transcript) {
        this.emit({ type: "complete", text: transcript });
      }
    } else if (
      type === "transcription_session.created" ||
      type === "transcription_session.updated"
    ) {
      logInfo(`${P} ${type}`);
    } else if (type === "error") {
      const error = event.error as { message?: string; type?: string; code?: string } | undefined;
      const message =
        error?.message ??
        (typeof error === "object" ? JSON.stringify(error) : "Unknown error from OpenAI");
      logError(`${P} Server error`, { errorType: error?.type, code: error?.code, message });
      this.emit({ type: "error", message });
    }
  }

  private audioChunkCount = 0;
  private staleChunkWarned = false;

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this.staleChunkWarned) {
        this.staleChunkWarned = true;
        logWarn(`${P} sendAudioChunk called but WebSocket not open`, {
          readyState: this.ws?.readyState,
        });
      }
      return;
    }
    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 200 === 0) {
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, { bytes: chunk.byteLength });
    }
    const base64 = Buffer.from(chunk).toString("base64");
    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64,
      })
    );
  }

  private cleanupPreviousSession(): void {
    logDebug(`${P} Cleaning up previous session`, { sessionId: this.sessionId, hasWs: !!this.ws });
    const pendingSessionId = this.pendingStart?.sessionId;
    this.sessionId++;
    this.audioChunkCount = 0;
    this.staleChunkWarned = false;
    this.clearConnectTimeout();
    if (pendingSessionId !== undefined) {
      this.settlePendingStart(pendingSessionId, { ok: false, error: "Voice session stopped" });
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  stop(): void {
    logInfo(`${P} stop() called`, { sessionId: this.sessionId, hasWs: !!this.ws });
    this.cleanupPreviousSession();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
