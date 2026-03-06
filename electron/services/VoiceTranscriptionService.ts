import WebSocket from "ws";
import type { VoiceInputSettings } from "../../shared/types/ipc/api.js";

export type VoiceTranscriptionEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string }
  | { type: "error"; message: string }
  | { type: "status"; status: "idle" | "connecting" | "recording" | "error" };

export class VoiceTranscriptionService {
  private ws: WebSocket | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceTranscriptionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async start(settings: VoiceInputSettings): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.ws) {
      this.stop();
    }

    if (!settings.apiKey) {
      return { ok: false, error: "OpenAI API key not configured" };
    }

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      const ws = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
      });

      const timeout = setTimeout(() => {
        ws.terminate();
        resolve({ ok: false, error: "Connection timed out" });
      }, 10000);

      ws.on("open", () => {
        clearTimeout(timeout);
        this.ws = ws;

        const prompt =
          settings.customDictionary.length > 0
            ? `Technical terms: ${settings.customDictionary.join(", ")}.`
            : undefined;

        ws.send(
          JSON.stringify({
            type: "session.update",
            session: {
              modalities: [],
              input_audio_format: "pcm16",
              input_audio_transcription: {
                model: "whisper-1",
                language: settings.language || "en",
                ...(prompt ? { prompt } : {}),
              },
              turn_detection: {
                type: "server_vad",
                silence_duration_ms: 800,
              },
            },
          })
        );

        this.emit({ type: "status", status: "recording" });
        resolve({ ok: true });
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const event = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleServerEvent(event);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        const message = err instanceof Error ? err.message : "WebSocket error";
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
        if (!this.ws) {
          resolve({ ok: false, error: message });
        }
        this.ws = null;
      });

      ws.on("close", () => {
        this.ws = null;
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
    } else if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      this.emit({ type: "error", message: error?.message ?? "Unknown error from OpenAI" });
    }
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const base64 = Buffer.from(chunk).toString("base64");
    this.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64,
      })
    );
  }

  stop(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
