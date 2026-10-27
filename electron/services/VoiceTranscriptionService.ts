import type { VoiceInputSettings } from "../../shared/types/ipc/api.js";
import { logInfo } from "../utils/logger.js";
import { DeepgramTranscriptionProvider } from "./voice/DeepgramTranscriptionProvider.js";
import { GrokTranscriptionProvider } from "./voice/GrokTranscriptionProvider.js";
import { OpenAITranscriptionProvider } from "./voice/OpenAITranscriptionProvider.js";
import type {
  ProviderSessionStats,
  TranscriptionProvider,
  TranscriptionStartContext,
  VoiceSessionEvent,
  VoiceStartResult,
} from "./voice/TranscriptionProvider.js";

// Re-export the provider-shared types so existing importers (and tests) keep a
// single entry point even though the definitions now live alongside the
// provider interface.
export type {
  VoiceSessionEvent,
  VoiceStartResult,
  VoiceTranscriptionEvent,
} from "./voice/TranscriptionProvider.js";

const P = "[VoiceTranscription]";

/**
 * Orchestrates voice transcription across pluggable backends. Selects a
 * `TranscriptionProvider` from `settings.transcriptionProvider`, forwards its
 * events to subscribers tagged with the session it was started for, and tears
 * the previous provider down on every new session so a provider switch (or a
 * plain restart) can't leak listeners or a live socket (lesson #4754).
 *
 * The provider owns its own protocol, connection lifecycle, timers, and — for
 * backends without server-side VAD — its segmentation cadence. This layer holds
 * no transcription logic of its own; it is purely selection + event forwarding.
 */
export class VoiceTranscriptionService {
  private provider: TranscriptionProvider | null = null;
  // The session the current provider was started for.
  private providerSessionId: string | null = null;
  private providerUnsub: (() => void) | null = null;
  private listeners: Set<(event: VoiceSessionEvent) => void> = new Set();

  onEvent(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private createProvider(settings: VoiceInputSettings): TranscriptionProvider {
    switch (settings.transcriptionProvider) {
      case "deepgram":
        return new DeepgramTranscriptionProvider();
      case "grok":
        return new GrokTranscriptionProvider();
      case "openai":
      default:
        return new OpenAITranscriptionProvider();
    }
  }

  private disposeProvider(): void {
    if (this.providerUnsub) {
      this.providerUnsub();
      this.providerUnsub = null;
    }
    if (this.provider) {
      this.provider.destroy();
      this.provider = null;
    }
    this.providerSessionId = null;
  }

  /**
   * Deepgram and Grok take their bias terms on the socket URL, so they can't
   * connect until they're assembled. OpenAI sends them in the `session.update`
   * after its socket opens, so it takes them as a pending start context instead.
   */
  keytermsNeededToConnect(settings: VoiceInputSettings): boolean {
    return (
      settings.transcriptionProvider === "deepgram" || settings.transcriptionProvider === "grok"
    );
  }

  async start(
    settings: VoiceInputSettings,
    sessionId: string,
    context?: TranscriptionStartContext
  ): Promise<VoiceStartResult> {
    // Tear down any previous provider (and its subscription) before swapping in
    // a new one — covers both a provider switch and a plain restart.
    this.disposeProvider();
    const provider = this.createProvider(settings);
    this.provider = provider;
    this.providerSessionId = sessionId;
    logInfo(`${P} Using provider`, {
      sessionId,
      provider: settings.transcriptionProvider,
      hasServerVAD: provider.hasServerVAD,
    });
    // Subscribe before start() so the synchronous "connecting" status emitted
    // during start() is forwarded to listeners. The id is captured per provider,
    // so nothing a retired provider still emits can carry the new session's id.
    this.providerUnsub = provider.onEvent((event) => this.emit({ ...event, sessionId }));
    return provider.start(settings, sessionId, context);
  }

  /** The provider's counts, only while it is still the one started for `sessionId`. */
  getSessionStats(sessionId: string): ProviderSessionStats | null {
    if (!this.provider || this.providerSessionId !== sessionId) return null;
    return this.provider.getSessionStats();
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    this.provider?.sendAudioChunk(chunk);
  }

  commitParagraphBoundary(): void {
    this.provider?.commitParagraphBoundary();
  }

  async stopGracefully(): Promise<void> {
    if (!this.provider) return;
    await this.provider.stopGracefully();
  }

  stop(): void {
    this.provider?.stop();
  }

  destroy(): void {
    this.disposeProvider();
    this.listeners.clear();
  }
}
