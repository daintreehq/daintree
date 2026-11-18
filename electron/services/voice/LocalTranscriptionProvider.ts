import type { VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import type { VoiceInputError } from "../../../shared/types/voice.js";
import { logInfo, logWarn } from "../../utils/logger.js";
import { getLocalSpeechHost, getLocalSpeechModels } from "./localSpeech.js";
import { localSpeechPromptId } from "./localSpeechModelSpec.js";
import type { LocalSpeechHost, LocalSpeechLease } from "./localSpeechProcess.js";
import type { LocalSpeechModelStore } from "./localSpeechModelStore.js";
import type { LocalSpeechWorkerOutbound } from "./localSpeechWorkerProtocol.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  createAudioBufferOverflowError,
  type ProviderSessionStats,
  type TranscriptionProvider,
  type VoiceStartResult,
  type VoiceTranscriptionEvent,
} from "./TranscriptionProvider.js";

const P = "[VoiceTranscription:local]";

/**
 * How long a stop waits for what was heard to be transcribed, the model's
 * load included when the stop comes before it is ready; past it, what is
 * left is dropped.
 */
export const LOCAL_DRAIN_TIMEOUT_MS = 15_000;
/**
 * How long a loaded model may take to begin a session. It answers within
 * about 100 ms; one that hasn't in this long is stuck on earlier work.
 */
export const LOCAL_START_TIMEOUT_MS = 10_000;

export const LOCAL_MODEL_MISSING_CODE = "local_model_missing";
export const LOCAL_MODEL_FAILED_CODE = "local_model_failed";
export const LOCAL_DRAIN_TIMEOUT_CODE = "local_drain_timeout";

type SessionMessage = Extract<LocalSpeechWorkerOutbound, { session: number }>;
/** What arrived before the model was ready, in order. */
type Queued = { type: "audio"; pcm: ArrayBuffer } | { type: "cut" } | { type: "gap" };

export interface LocalTranscriptionDeps {
  models: () => Pick<LocalSpeechModelStore, "readyDir" | "invalidate">;
  host: () => Pick<LocalSpeechHost, "acquire">;
}

const DEFAULT_DEPS: LocalTranscriptionDeps = {
  models: getLocalSpeechModels,
  host: getLocalSpeechHost,
};

/**
 * Transcribes on this machine with the on-device model (`localSpeechWorker.ts`),
 * which streams previews as it decodes and closes a passage at each pause its
 * own VAD hears. No socket, no key, no bias terms: nothing leaves the machine.
 * The model process outlives a session, so a session is a lease on it; every
 * message carries the lease's session, and nothing from an earlier one is
 * ever emitted for a later one.
 */
export class LocalTranscriptionProvider implements TranscriptionProvider {
  readonly hasServerVAD = false;
  private readonly listeners = new Set<(event: VoiceTranscriptionEvent) => void>();
  /** Moves on with every start and stop: work begun for an older one does nothing. */
  private generation = 0;
  private voiceSessionId = "";
  private lease: LocalSpeechLease | null = null;
  private ready = false;
  private queued: Queued[] = [];
  private queuedChunks = 0;
  private queuedBytes = 0;
  private overflowWarned = false;
  private droppedConnect = 0;
  private intakeClosed = false;
  private finishRequested = false;
  private pendingStart: { generation: number; resolve: (r: VoiceStartResult) => void } | null =
    null;
  private drain: {
    promise: Promise<void>;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private sessionStartedAt = 0;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  /** Gives up a lease still waiting on the model's load. */
  private acquireAbort: AbortController | null = null;
  /** Previews shown for passages not yet completed, by item. */
  private readonly openPreviews = new Map<string, string>();

  constructor(private readonly deps: LocalTranscriptionDeps = DEFAULT_DEPS) {}

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: VoiceTranscriptionEvent): void {
    if (event.type === "status") logInfo(`${P} status → ${event.status}`);
    for (const listener of this.listeners) listener(event);
  }

  async start(settings: VoiceInputSettings, voiceSessionId: string): Promise<VoiceStartResult> {
    this.cleanup();
    const generation = ++this.generation;
    this.voiceSessionId = voiceSessionId;
    this.sessionStartedAt = performance.now();
    this.droppedConnect = 0;
    this.overflowWarned = false;
    this.emit({ type: "status", status: "connecting" });
    const result = new Promise<VoiceStartResult>((resolve) => {
      this.pendingStart = { generation, resolve };
    });
    void this.open(generation, settings);
    return result;
  }

  private async open(generation: number, settings: VoiceInputSettings): Promise<void> {
    let models: ReturnType<LocalTranscriptionDeps["models"]>;
    let dir: string | null;
    try {
      models = this.deps.models();
      dir = await models.readyDir();
    } catch {
      models = { readyDir: async () => null, invalidate: () => {} };
      dir = null;
    }
    if (generation !== this.generation) return;
    if (!dir) {
      this.fail(generation, {
        severity: "fatal",
        code: LOCAL_MODEL_MISSING_CODE,
        message: "The on-device model isn't downloaded. Download it in Settings > Voice.",
      });
      return;
    }
    let lease: LocalSpeechLease;
    const abort = new AbortController();
    this.acquireAbort = abort;
    try {
      lease = await this.deps.host().acquire(
        dir,
        {
          onMessage: (message) => this.handle(generation, message),
          onLost: () => this.lost(generation),
        },
        abort.signal
      );
    } catch {
      if (generation !== this.generation || abort.signal.aborted) return;
      models.invalidate();
      this.fail(generation, {
        severity: "fatal",
        code: LOCAL_MODEL_FAILED_CODE,
        message: "The on-device model couldn't be loaded. Check it in Settings > Voice.",
      });
      return;
    }
    if (this.acquireAbort === abort) this.acquireAbort = null;
    if (generation !== this.generation) {
      lease.release();
      return;
    }
    this.lease = lease;
    logInfo(`${P} Model ready`, {
      voiceSessionId: this.voiceSessionId,
      sinceStartMs: Math.round(performance.now() - this.sessionStartedAt),
    });
    lease.post({
      type: "start",
      session: lease.session,
      promptId: localSpeechPromptId(settings.language),
    });
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (generation !== this.generation || this.ready) return;
      logWarn(`${P} Session didn't start`, { voiceSessionId: this.voiceSessionId });
      this.abandonLease();
      this.fail(generation, {
        severity: "fatal",
        code: LOCAL_MODEL_FAILED_CODE,
        message: "On-device transcription didn't start. Try again.",
      });
    }, LOCAL_START_TIMEOUT_MS);
  }

  private handle(generation: number, message: SessionMessage): void {
    if (generation !== this.generation || this.lease?.session !== message.session) return;
    switch (message.type) {
      case "started":
        this.onStarted(message.vad);
        return;
      case "text": {
        const itemId = this.itemId(message.segment);
        this.openPreviews.set(itemId, message.text);
        this.emit({ type: "delta", text: message.text, itemId, replace: true });
        return;
      }
      case "speech-start":
        this.emit({ type: "speech_started" });
        return;
      case "segment": {
        const pause = message.reason === "pause";
        const itemId = this.itemId(message.segment);
        this.openPreviews.delete(itemId);
        if (message.reason === "gap") {
          // Words around the gap are missing: whatever it closed lands as said.
          this.emit({
            type: "complete",
            text: message.text,
            ...(message.shown || message.text ? { itemId } : {}),
            incomplete: true,
          });
          return;
        }
        if (message.text === "" && !message.shown) return;
        this.emit({
          type: "complete",
          text: message.text,
          itemId,
          ...(pause ? { endsAtPause: true, paused: true } : {}),
          ...(pause && message.endOfSpeech ? { endOfSpeech: true } : {}),
        });
        return;
      }
      case "finished":
        this.settleDrain();
        return;
      case "session-error":
        logWarn(`${P} Transcription failed`, { voiceSessionId: this.voiceSessionId });
        this.fail(generation, {
          severity: "fatal",
          code: LOCAL_MODEL_FAILED_CODE,
          message: "On-device transcription stopped working.",
        });
        return;
    }
  }

  private onStarted(vad: boolean): void {
    const lease = this.lease;
    if (!lease) return;
    if (!vad) logWarn(`${P} VAD unavailable; passages close only at Enter and stop`);
    this.clearStartTimer();
    this.ready = true;
    this.emit({ type: "terms_sent", terms: [] });
    this.emit({ type: "status", status: this.intakeClosed ? "finishing" : "recording" });
    for (const item of this.queued) {
      if (item.type === "audio")
        lease.post({ type: "audio", session: lease.session, pcm: item.pcm });
      else lease.post({ type: item.type, session: lease.session });
    }
    this.queued = [];
    this.queuedChunks = 0;
    this.queuedBytes = 0;
    this.settleStart({ ok: true });
    if (this.finishRequested) lease.post({ type: "finish", session: lease.session });
  }

  private itemId(segment: number): string {
    return `local-${this.lease?.session ?? 0}-${segment}`;
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.intakeClosed) return;
    const lease = this.lease;
    if (this.ready && lease) {
      lease.post({ type: "audio", session: lease.session, pcm: chunk });
      return;
    }
    if (!this.pendingStart) return;
    if (
      this.queuedChunks >= AUDIO_BUFFER_MAX_CHUNKS ||
      this.queuedBytes + chunk.byteLength > AUDIO_BUFFER_MAX_BYTES
    ) {
      this.droppedConnect++;
      if (!this.overflowWarned) {
        this.overflowWarned = true;
        // The words lost here would say what came before them meant: the
        // passage closes at the gap as incomplete, so no command is read
        // across it.
        this.queued.push({ type: "gap" });
        this.emit({ type: "error", error: createAudioBufferOverflowError() });
      }
      return;
    }
    this.queued.push({ type: "audio", pcm: chunk });
    this.queuedChunks++;
    this.queuedBytes += chunk.byteLength;
  }

  commitParagraphBoundary(): void {
    if (this.intakeClosed) return;
    const lease = this.lease;
    if (this.ready && lease) lease.post({ type: "cut", session: lease.session });
    else if (this.pendingStart && this.queued.length > 0) this.queued.push({ type: "cut" });
  }

  async stopGracefully(): Promise<void> {
    if (this.drain) return this.drain.promise;
    const generation = this.generation;
    this.intakeClosed = true;
    const holdsAudio = this.ready || this.queuedChunks > 0;
    if (!holdsAudio || (!this.lease && !this.pendingStart)) {
      this.cleanup();
      this.emit({ type: "status", status: "idle" });
      return;
    }
    this.emit({ type: "status", status: "finishing" });
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(() => {
      logWarn(`${P} Drain timed out`, { voiceSessionId: this.voiceSessionId, ready: this.ready });
      this.settleUnfinished(generation);
    }, LOCAL_DRAIN_TIMEOUT_MS);
    this.drain = { promise, resolve, timer };
    const lease = this.lease;
    if (this.ready && lease) lease.post({ type: "finish", session: lease.session });
    else this.finishRequested = true;
    await promise;
    if (generation === this.generation) {
      this.cleanup();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * The model never finished what it heard. What it showed lands as said and
   * marked incomplete, so no command is read across the missing words, and a
   * process that stopped answering is replaced for the next dictation.
   */
  private settleUnfinished(generation: number): void {
    if (generation !== this.generation) return;
    for (const [itemId, text] of this.openPreviews) {
      this.emit({ type: "complete", text, itemId, incomplete: true });
    }
    this.openPreviews.clear();
    // A load that hasn't finished in all this time has hung: it goes too.
    this.acquireAbort?.abort("wedged");
    this.acquireAbort = null;
    this.emit({
      type: "error",
      error: {
        severity: "transient",
        code: LOCAL_DRAIN_TIMEOUT_CODE,
        message: "On-device transcription didn't finish, so the last words may be missing.",
      },
    });
    this.abandonLease();
    this.settleDrain();
  }

  private settleDrain(): void {
    const drain = this.drain;
    if (!drain) return;
    this.drain = null;
    clearTimeout(drain.timer);
    drain.resolve();
  }

  private settleStart(result: VoiceStartResult): void {
    const pending = this.pendingStart;
    this.pendingStart = null;
    pending?.resolve(result);
  }

  private fail(generation: number, error: VoiceInputError): void {
    if (generation !== this.generation) return;
    this.emit({ type: "error", error });
    this.emit({ type: "status", status: "error" });
    this.settleStart({ ok: false, error: error.message });
    this.settleDrain();
    this.releaseLease();
  }

  private lost(generation: number): void {
    if (generation !== this.generation) return;
    this.lease = null;
    this.fail(generation, {
      severity: "fatal",
      code: LOCAL_MODEL_FAILED_CODE,
      message: "On-device transcription stopped unexpectedly.",
    });
  }

  private releaseLease(): void {
    const lease = this.lease;
    this.lease = null;
    lease?.release();
  }

  private abandonLease(): void {
    const lease = this.lease;
    this.lease = null;
    lease?.abandon();
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  /** Ends the session's state; the next start begins clean. */
  private cleanup(): void {
    this.generation++;
    this.clearStartTimer();
    this.acquireAbort?.abort("stopped");
    this.acquireAbort = null;
    this.openPreviews.clear();
    this.releaseLease();
    this.ready = false;
    this.queued = [];
    this.queuedChunks = 0;
    this.queuedBytes = 0;
    this.intakeClosed = false;
    this.finishRequested = false;
    this.settleStart({ ok: false, error: "Stopped" });
    this.settleDrain();
  }

  getSessionStats(): ProviderSessionStats {
    return {
      delayTier: "none",
      droppedConnect: this.droppedConnect,
      droppedReplay: 0,
      reconnects: 0,
    };
  }

  stop(): void {
    this.cleanup();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
