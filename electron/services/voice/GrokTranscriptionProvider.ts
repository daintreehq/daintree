import WebSocket from "ws";
import type { VoiceInputError, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { VOICE_STOP_AUDIO_LOST_CODE } from "../../../shared/types/voice.js";
import {
  normalizeVoiceLanguage,
  VOICE_LANGUAGE_AUTO,
} from "../../../shared/config/voiceLanguages.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import { logDebug, logInfo, logWarn, logError } from "../../utils/logger.js";
import { voiceErrorLogFields, voicePayloadShape } from "../../../shared/utils/voiceLogFields.js";
import {
  flagUncertainWords,
  shiftSpans,
  type RecognisedWord,
  type VoiceTextSpan,
} from "../../../shared/utils/voiceUncertainWords.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  createAudioBufferOverflowError,
  isRetryableHttpStatus,
  type ProviderSessionStats,
  type TranscriptionProvider,
  type VoiceStartResult,
  type VoiceTranscriptionEvent,
} from "./TranscriptionProvider.js";

const P = "[VoiceTranscription:grok]";

const GROK_BASE_URL = process.env.DAINTREE_GROK_WS_URL ?? "wss://api.x.ai/v1/stt";
const GROK_MODEL = "grok-voice-transcribe-2.0";
// Words scored below this reach cleanup as unsure. xAI publishes no guidance
// on what its scores mean, so this is Deepgram's cut-off.
const UNCERTAIN_BELOW = 0.65;
// Deepgram's endpoint, so a spoken "send it" gets the same settle in the
// handler. xAI's default is 400.
const ENDPOINTING_MS = 300;
// `format` (inverse text normalisation) needs an explicit language, and xAI
// lists only these for it.
const FORMAT_LANGUAGES = new Set([
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "ja",
  "pt",
  "ru",
  "sv",
  "vi",
  "zh",
]);
// Covers both the upgrade and the wait for `transcript.created`, since audio
// can't go out until the server says it's ready.
const CONNECT_TIMEOUT_MS = 10_000;
// Backstop for the graceful drain: after `audio.done` the server flushes its
// remaining transcripts, sends `transcript.done` and closes.
const DRAIN_TIMEOUT_MS = 3_000;
// How long a graceful stop that lands before the session is ready waits for
// it, so the buffered audio can still be transcribed.
const STOP_CONNECT_TIMEOUT_MS = 3_000;
// xAI documents no keep-alive and lists stream timeouts among the errors that
// close a session. The renderer stops sending audio while dictation is
// paused, so a gap this long is filled with a frame of silence.
const KEEPALIVE_CHECK_MS = 1_000;
const KEEPALIVE_IDLE_MS = 3_000;
// Reconnect after an unexpected mid-session drop, as Deepgram's provider does:
// retry with equal-jitter backoff until RECONNECT_WINDOW_MS has passed.
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_CAP_MS = 3_000;
const RECONNECT_MIN_CONNECT_MS = 1_000;
// A connection that came up and failed again before transcribing anything or
// lasting this long doesn't earn a fresh recovery window, so a server that
// accepts and then rejects every session can't keep the loop going forever.
const HEALTHY_CONNECTION_MS = 10_000;
// pcm (signed 16-bit LE) mono @ 24kHz. Result timing is in seconds of audio
// received on the connection; this converts it back to a byte offset.
const AUDIO_BYTES_PER_SAMPLE = 2;
const AUDIO_SAMPLE_RATE = 24_000;
const AUDIO_BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE;
// One renderer chunk: 100ms.
const SILENCE_FRAME = new ArrayBuffer(AUDIO_BYTES_PER_SECOND / 10);
const RECONNECT_BUFFER_MAX_BYTES = (RECONNECT_WINDOW_MS / 1_000) * AUDIO_BYTES_PER_SECOND;
const RECONNECT_BUFFER_MAX_CHUNKS = 400;
// Ceiling on audio sent but not yet covered by a final result. Chunk finals
// lock about every 3s of speech and utterance finals land at every 300ms
// pause, so this has the same headroom as Deepgram's ledger.
const REPLAY_MAX_BYTES = RECONNECT_BUFFER_MAX_BYTES + 10 * AUDIO_BYTES_PER_SECOND;

// Close codes that mean the server refused what we sent. A new connection
// would fail the same way.
const PERMANENT_CLOSE_CODES = new Set<number>([1002, 1003, 1007, 1008, 1009]);

// xAI caps keyterms at 100 terms of 50 characters each. Assembly gathers fewer
// terms than that, so the count rarely binds; the length does, for long
// worktree names and commands. Counted in UTF-16 units, which is never fewer
// than the characters xAI could be counting.
const MAX_GROK_KEYTERMS = 100;
const MAX_GROK_KEYTERM_LENGTH = 50;
// The keyterms' share of the query string, measured as encoded, keeping the
// whole URL under the 8 KiB request-line limit common to proxies.
const MAX_GROK_KEYTERM_QUERY_LENGTH = 6_000;
// A first rejection retries with just the head of the list (dictionary first,
// newest first) before the last resort of sending none.
const TRIMMED_RETRY_KEYTERMS = 20;

// Two results belong to the same stretch of audio when one starts this close
// to where the other ends.
const RESULT_TIMING_TOLERANCE_SECONDS = 0.1;
// A transcript.done word starting this close to where the last utterance
// final ended is past it: the two are the same instant in float seconds.
const WORD_BOUNDARY_EPSILON_SECONDS = 0.001;

// Grok sends nothing when speech starts, which a held spoken "send it" waits
// on (Deepgram's `SpeechStarted`). A plain level check over the outgoing audio
// stands in: 40ms over the renderer's speech-level floor after 200ms under
// half of it. Noise can set it off, which only makes a held send wait for a
// transcript, as Deepgram's VAD does.
const ONSET_WINDOW_SAMPLES = AUDIO_SAMPLE_RATE / 50;
const ONSET_RMS = 0.01;
const ONSET_REARM_RMS = 0.005;
const ONSET_WINDOWS = 2;
const ONSET_REARM_WINDOWS = 10;

type KeytermAttempt = "full" | "trimmed" | "none";

// Process-wide: the orchestrator builds a fresh provider per session, so a
// per-instance counter would hand the renderer the same id twice.
let utteranceSeq = 0;

function nextUtteranceItemId(): string {
  return `grok-${++utteranceSeq}`;
}

// What one term adds to the query: `&keyterm=` and the term, encoded exactly
// as URLSearchParams serializes it.
function encodedKeytermLength(term: string): number {
  return new URLSearchParams([["keyterm", term]]).toString().length + 1;
}

/**
 * The assembled keyterms that fit xAI's limits, in priority order. A term too
 * long for xAI is skipped rather than ending the list, so shorter later terms
 * still go.
 */
export function sanitizeGrokKeyterms(keyterms: readonly string[]): string[] {
  const result: string[] = [];
  let encoded = 0;
  for (const raw of keyterms) {
    const term = raw.trim();
    if (!term || term.length > MAX_GROK_KEYTERM_LENGTH) continue;
    if (result.length >= MAX_GROK_KEYTERMS) break;
    const termEncoded = encodedKeytermLength(term);
    if (encoded + termEncoded > MAX_GROK_KEYTERM_QUERY_LENGTH) continue;
    result.push(term);
    encoded += termEncoded;
  }
  return result;
}

function keytermsForAttempt(sanitized: readonly string[], attempt: KeytermAttempt): string[] {
  if (attempt === "none") return [];
  if (attempt === "trimmed") return sanitized.slice(0, TRIMMED_RETRY_KEYTERMS);
  return [...sanitized];
}

/** Build the streaming URL. PCM at 24kHz matches the renderer's capture rate. */
function buildUrl(settings: VoiceInputSettings, keyterms: readonly string[]): string {
  const params = new URLSearchParams({
    model: GROK_MODEL,
    encoding: "pcm",
    sample_rate: String(AUDIO_SAMPLE_RATE),
    interim_results: "true",
    endpointing: String(ENDPOINTING_MS),
  });
  // Left out, the server detects the language itself.
  const language = normalizeVoiceLanguage(settings.language);
  if (language !== VOICE_LANGUAGE_AUTO) {
    params.set("language", language);
    if (FORMAT_LANGUAGES.has(language)) params.set("format", "true");
  }
  for (const term of keyterms) {
    params.append("keyterm", term);
  }
  return `${GROK_BASE_URL}?${params.toString()}`;
}

function finiteSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Transcript text and the spans of the words in it the recogniser was unsure of. */
interface ScoredText {
  text: string;
  uncertain: VoiceTextSpan[];
}

const NO_TEXT: ScoredText = { text: "", uncertain: [] };

/** One word of a result, with where it starts in the connection's audio. */
interface TimedWord extends RecognisedWord {
  start: number | null;
}

function confidenceScore(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 1 ? value : null;
}

/**
 * A result's words in transcript order, a malformed one kept in place as an
 * empty word. xAI leaves a confidence of 0 out of the word, so a word without
 * one scored 0. A result where no word has one is read as reporting no
 * confidence instead, so a server that never scores can't flag every word.
 */
function timedWords(words: readonly unknown[]): TimedWord[] {
  const entries = words.map(
    (entry) => (entry ?? {}) as { text?: unknown; start?: unknown; confidence?: unknown }
  );
  const scored = entries.some((word) => confidenceScore(word.confidence) !== null);
  return entries.map((word) => ({
    text: typeof word.text === "string" ? word.text.trim() : "",
    start: finiteSeconds(word.start),
    confidence:
      confidenceScore(word.confidence) ?? (scored && word.confidence === undefined ? 0 : NaN),
  }));
}

/** `text` with the spans of the words in `words` scored below the cut-off. */
function scoreText(text: string, words: unknown): ScoredText {
  if (!text || !Array.isArray(words)) return { text, uncertain: [] };
  return { text, uncertain: flagUncertainWords(text, timedWords(words), UNCERTAIN_BELOW) };
}

/** Joins the parts with a space, moving each part's spans to where it lands. */
function joinTranscript(parts: readonly ScoredText[]): ScoredText {
  let text = "";
  const uncertain: VoiceTextSpan[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    if (text) text += " ";
    uncertain.push(...shiftSpans(part.uncertain, text.length));
    text += part.text;
  }
  return { text, uncertain };
}

/** A chunk final the current utterance has locked, timed on its connection. */
interface LockedChunk extends ScoredText {
  end: number;
}

export class GrokTranscriptionProvider implements TranscriptionProvider {
  readonly hasServerVAD = true;

  private connection: WebSocket | null = null;
  private sessionId = 0;
  // The dictation session this provider was started for, minted by the
  // renderer. Diagnostics only: `sessionId` above guards reconnects.
  private voiceSessionId = "";
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

  private preConnectBuffer: ArrayBuffer[] = [];
  private preConnectBufferBytes = 0;
  // Set by `transcript.created`, not by the socket opening.
  private isReady = false;

  private sessionStartedAt = 0;
  private connectStartedAt = 0;
  private firstTranscriptLogged = false;

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioSentAt = 0;

  // Session-level, so reconnects reuse the list the session settled on.
  private keytermAttempt: KeytermAttempt = "full";
  // Once a connection with this session's terms became ready, a later
  // rejection can't be about the terms.
  private keytermsAccepted = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectNow: (() => void) | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  private reconnectDeadlineAt: number | null = null;
  private lastReconnectError: VoiceInputError | null = null;
  // When the current connection became ready, and whether it has transcribed
  // anything since: together they say whether a drop earns a fresh window.
  private readyAt = 0;
  private transcribedSinceReady = false;

  // Audio sent on the current connection that no received final result covers
  // yet, oldest first, from connection byte offset `unconfirmedOffset`. Every
  // ready connection resends it ahead of the pre-connect buffer.
  private unconfirmedAudio: ArrayBuffer[] = [];
  private unconfirmedBytes = 0;
  private unconfirmedOffset = 0;
  private replayEvictionWarned = false;

  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;
  private stopPendingReady = false;
  private stopHeldBytes = 0;

  private audioChunkCount = 0;
  private droppedConnectChunks = 0;
  private droppedReplayChunks = 0;
  private reconnectCount = 0;
  private staleChunkWarned = false;
  private preConnectBufferOverflowWarned = false;

  // One utterance is one item: its interims and chunk finals replace one
  // preview, and its utterance final, which restates the whole utterance,
  // completes it. Chunk finals locked on an earlier connection are carried as
  // text, since their audio was confirmed and isn't resent. Every piece keeps
  // its own unsure words, placed in the completion wherever the piece lands.
  private utteranceItemId: string | null = null;
  private carriedText: ScoredText[] = [];
  private lockedChunks: LockedChunk[] = [];
  private preview: ScoredText = NO_TEXT;
  // Where the last utterance completed on this connection ends, in its
  // seconds, so `transcript.done` can tell the tail no final covered.
  private connectionCompletedEnd = 0;
  // The connection's audio position, in seconds, when a Finalize went out
  // with something open; null with none outstanding. The utterance final that
  // answers it, the one whose utterance started before that point, ends
  // because Enter did, not because the speaker paused.
  private finalizeAtSeconds: number | null = null;
  // The onset guard heard speech since the last utterance final, so the
  // server may have an utterance open before any preview of it arrived.
  private speechSinceFinal = false;

  // Onset guard state, over fresh audio only.
  private onsetSpeaking = false;
  private onsetLoudWindows = 0;
  private onsetQuietWindows = 0;
  private onsetSumSquares = 0;
  private onsetSamples = 0;

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Asks the server to close out the current utterance; the socket stays open. */
  commitParagraphBoundary(): void {
    if (!this.connection || !this.isReady || this.isDraining) return;
    try {
      this.connection.send(JSON.stringify({ type: "Finalize" }));
      // With nothing open the server has nothing to finalise, and the next
      // utterance's own final must still end speech.
      if (this.utteranceItemId !== null || this.speechSinceFinal) {
        this.finalizeAtSeconds =
          (this.unconfirmedOffset + this.unconfirmedBytes) / AUDIO_BYTES_PER_SECOND;
      }
      logDebug(`${P} → Finalize (paragraph boundary)`);
    } catch (err) {
      logWarn(`${P} Failed to send Finalize`, voiceErrorLogFields(err));
    }
  }

  private emit(event: VoiceTranscriptionEvent): void {
    if (event.type === "status") {
      logInfo(`${P} status → ${event.status}`);
    } else if (event.type === "error") {
      logWarn(`${P} emitting error event`, {
        severity: event.error.severity,
        code: event.error.code,
      });
    }
    if (
      !this.firstTranscriptLogged &&
      (event.type === "delta" || event.type === "complete") &&
      event.text.trim()
    ) {
      this.firstTranscriptLogged = true;
      logInfo(`${P} First transcript`, {
        sessionId: this.sessionId,
        voiceSessionId: this.voiceSessionId,
        eventType: event.type,
        length: event.text.length,
        sinceStartMs: this.sinceStartMs(),
      });
    }
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

  private sinceStartMs(): number {
    return Math.round(performance.now() - this.sessionStartedAt);
  }

  async start(settings: VoiceInputSettings, voiceSessionId: string): Promise<VoiceStartResult> {
    if (!settings.xaiApiKey) {
      logWarn(`${P} No xAI API key configured`);
      return { ok: false, error: "xAI API key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, {
      voiceSessionId,
      language: settings.language,
    });
    this.cleanupPreviousSession();
    this.sessionId = mySessionId;
    this.voiceSessionId = voiceSessionId;
    this.sessionStartedAt = performance.now();
    this.firstTranscriptLogged = false;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.isExpectedClose = false;
    this.droppedConnectChunks = 0;
    this.droppedReplayChunks = 0;
    this.reconnectCount = 0;

    this.emit({ type: "status", status: "connecting" });

    // Frozen for the session, so every attempt and reconnect draws on one list.
    const sanitized = sanitizeGrokKeyterms(settings.keyterms ?? []);
    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      this.connect(mySessionId, settings, sanitized);
    });
  }

  /**
   * Opens one WebSocket and wires its handlers. Shared by `start()` (with a
   * pending start to settle) and the reconnect timer; the reconnect path is
   * told apart by `isReconnecting`, so an attempt that fails before it's ready
   * schedules the next one instead of ending the session.
   */
  private connect(
    mySessionId: number,
    settings: VoiceInputSettings,
    sanitized: readonly string[]
  ): void {
    this.connectStartedAt = performance.now();
    this.readyAt = 0;
    this.transcribedSinceReady = false;
    const attempt = this.keytermAttempt;
    const urlKeyterms = keytermsForAttempt(sanitized, attempt);
    const url = buildUrl(settings, urlKeyterms);
    let connection: WebSocket;
    try {
      connection = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${settings.xaiApiKey}`,
        },
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to open WebSocket");
      logError(`${P} Failed to open WebSocket`, undefined, voiceErrorLogFields(err));
      if (this.isReconnecting) {
        this.lastReconnectError = { severity: "transient", code: "ws_construct_failed", message };
        this.retryAfterFailedAttempt(mySessionId, settings, sanitized);
        return;
      }
      this.emit({
        type: "error",
        error: { severity: "fatal", code: "ws_construct_failed", message },
      });
      this.emit({ type: "status", status: "error" });
      this.settlePendingStart(mySessionId, { ok: false, error: message });
      this.settleDrain("connect-failed");
      return;
    }

    this.connection = connection;
    let transportError: VoiceInputError | null = null;
    // Never the URL: it carries the assembled keyterms.
    logInfo(`${P} Opening Grok WebSocket`, {
      keytermCount: urlKeyterms.length,
      language: settings.language || "en",
      keytermAttempt: attempt,
      reconnectAttempt: this.isReconnecting ? this.reconnectAttempt : 0,
    });

    const isCurrent = () => this.sessionId === mySessionId && this.connection === connection;

    // The next rung of the keyterm ladder, or null when a rejection can't be
    // about the terms: none went, or this session's terms were already accepted.
    const nextKeytermAttempt = (): KeytermAttempt | null => {
      if (this.keytermsAccepted || attempt === "none" || urlKeyterms.length === 0) return null;
      return attempt === "full" && sanitized.length > TRIMMED_RETRY_KEYTERMS ? "trimmed" : "none";
    };

    const retryWithFewerKeyterms = (next: KeytermAttempt, reason: string): void => {
      logWarn(`${P} Grok rejected the session (${reason}) — retrying (${next} keyterms)`);
      this.keytermAttempt = next;
      this.cleanupConnection();
      try {
        connection.terminate();
      } catch {
        // Ignore terminate errors
      }
      this.connect(mySessionId, settings, sanitized);
    };

    const connectTimeoutMs =
      this.isReconnecting && this.reconnectDeadlineAt !== null
        ? Math.max(
            RECONNECT_MIN_CONNECT_MS,
            Math.min(CONNECT_TIMEOUT_MS, this.reconnectDeadlineAt - performance.now())
          )
        : CONNECT_TIMEOUT_MS;
    this.connectTimeout = setTimeout(() => {
      this.connectTimeout = null;
      if (this.sessionId !== mySessionId) return;
      logError(`${P} Connection timed out (${Math.round(connectTimeoutMs)}ms)`);
      if (this.isReconnecting) {
        this.lastReconnectError = {
          severity: "transient",
          code: "connection_timeout",
          message: "Connection timed out",
        };
        this.cleanupConnection();
        try {
          connection.terminate();
        } catch {
          // Ignore terminate errors
        }
        this.retryAfterFailedAttempt(mySessionId, settings, sanitized);
        return;
      }
      this.isExpectedClose = true;
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
      this.cleanupConnection();
      this.emit({
        type: "error",
        error: { severity: "fatal", code: "connection_timeout", message: "Connection timed out" },
      });
      this.emit({ type: "status", status: "error" });
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection timed out" });
      this.settleDrain("connection-timeout");
    }, connectTimeoutMs);

    // A non-101 upgrade response surfaces here, and registering this listener
    // disables ws's built-in abort, so the socket must be drained and destroyed
    // by hand. 400 is bad parameters (most plausibly the terms), 401 a bad key.
    connection.on("unexpected-response", (req, res) => {
      try {
        res.resume();
        req.socket?.destroy();
      } catch {
        // Ignore teardown errors
      }
      if (!isCurrent()) return;
      this.clearConnectTimeout();
      const statusCode = res.statusCode;
      const next = statusCode === 400 ? nextKeytermAttempt() : null;
      if (next) {
        retryWithFewerKeyterms(next, "HTTP 400");
        return;
      }
      const message = `Grok rejected the connection (HTTP ${statusCode ?? "unknown"})`;
      if (this.isReconnecting && isRetryableHttpStatus(statusCode)) {
        logWarn(`${P} Reconnect attempt rejected — retrying`, { statusCode });
        this.lastReconnectError = { severity: "transient", code: "ws_http_error", message };
        this.cleanupConnection();
        this.retryAfterFailedAttempt(mySessionId, settings, sanitized);
        return;
      }
      logError(`${P} Grok rejected the connection`, undefined, { statusCode });
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "ws_http_error",
        message,
      });
    });

    connection.on("open", () => {
      if (!isCurrent()) {
        logWarn(`${P} Session expired during connect, closing`);
        try {
          connection.close();
        } catch {
          // Ignore close errors
        }
        return;
      }
      // Audio waits for `transcript.created`; the connect timeout still runs.
      logInfo(`${P} WebSocket opened — waiting for the session`, {
        sessionId: mySessionId,
        connectMs: Math.round(performance.now() - this.connectStartedAt),
      });
    });

    const onReady = (): void => {
      if (this.isReady) return;
      this.clearConnectTimeout();
      logInfo(`${P} Session ready`, {
        sessionId: mySessionId,
        voiceSessionId: this.voiceSessionId,
        connectMs: Math.round(performance.now() - this.connectStartedAt),
        sinceStartMs: this.sinceStartMs(),
        bufferedChunks: this.preConnectBuffer.length,
        reconnectAttempt: this.reconnectAttempt,
        resentChunks: this.unconfirmedAudio.length,
      });
      this.keytermsAccepted = true;
      this.emit({ type: "terms_sent", terms: urlKeyterms, keytermAttempt: attempt });
      this.flushHeldAudio();
      this.isReady = true;
      this.readyAt = performance.now();
      // The recovery window and attempt count stay until this connection
      // proves healthy (see `scheduleReconnect`).
      this.isReconnecting = false;
      this.lastReconnectError = null;
      if (this.isDraining) {
        // Stopped while connecting: the mic is already released, so skip the
        // keep-alive and "recording" — finish the stream and drain.
        this.settlePendingStart(mySessionId, { ok: true });
        if (this.stopPendingReady) this.finishStreamAfterLateReady();
        return;
      }
      this.startKeepAlive(connection, mySessionId);
      this.emit({ type: "status", status: "recording" });
      this.settlePendingStart(mySessionId, { ok: true });
    };

    const onServerError = (payload: Record<string, unknown>): void => {
      const message =
        (typeof payload.message === "string" && payload.message.trim()) || "Grok error";
      logError(`${P} ← server error event`, undefined, { ready: this.isReady });
      if (this.isDraining && this.isReady) {
        this.settleDrain("server-error");
        return;
      }
      if (!this.isReady) {
        this.clearConnectTimeout();
        const next = nextKeytermAttempt();
        if (next) {
          retryWithFewerKeyterms(next, "error before ready");
          return;
        }
        if (this.isReconnecting) {
          this.lastReconnectError = { severity: "transient", code: "grok_server_error", message };
          this.cleanupConnection();
          try {
            connection.terminate();
          } catch {
            // Ignore terminate errors
          }
          this.retryAfterFailedAttempt(mySessionId, settings, sanitized);
          return;
        }
        this.handleFatalError(mySessionId, {
          severity: "fatal",
          code: "grok_server_error",
          message,
        });
        return;
      }
      // Most errors close the session, stream timeouts among them. Recover the
      // way a drop does, whether or not the server closes the socket itself.
      this.lastReconnectError = { severity: "transient", code: "grok_server_error", message };
      this.cleanupConnection();
      try {
        connection.terminate();
      } catch {
        // Ignore terminate errors
      }
      this.scheduleReconnect(mySessionId, settings, sanitized);
    };

    connection.on("message", (data) => {
      if (!isCurrent()) return;
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data as ArrayBuffer).toString("utf8");

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        logWarn(`${P} Ignoring non-JSON message`, { length: raw.length });
        return;
      }

      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "transcript.created") {
        logDebug(`${P} ← transcript.created`);
        onReady();
        return;
      }
      if (type === "error") {
        onServerError(parsed);
        return;
      }
      this.handleServerEvent(type, parsed);
    });

    connection.on("error", (err) => {
      if (!isCurrent()) return;
      this.clearConnectTimeout();
      const message = formatErrorMessage(err, "WebSocket error");
      logError(`${P} WebSocket error`, undefined, voiceErrorLogFields(err));
      // `ws` fires `close` right after `error`, and the close handler owns the
      // reconnect decision. Only a transport error on the first connect is
      // fatal here.
      if (this.isReady || this.isReconnecting) {
        transportError = { severity: "transient", code: "ws_transport_error", message };
        return;
      }
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "ws_transport_error",
        message,
      });
    });

    connection.on("close", (code, reason) => {
      if (!isCurrent()) return;
      this.clearConnectTimeout();
      this.clearKeepAlive();
      const wasReady = this.isReady;
      logInfo(`${P} WebSocket closed`, {
        code,
        reasonLength: reason?.length ?? 0,
        wasReady,
        wasReconnecting: this.isReconnecting,
        wasExpected: this.isExpectedClose,
        wasDraining: this.isDraining,
        audioChunksStreamed: this.audioChunkCount,
      });
      this.cleanupConnection();
      if (this.isDraining) {
        this.settleDrain("connection-closed");
        return;
      }
      if (!this.isExpectedClose && (wasReady || this.isReconnecting)) {
        const closeCode = typeof code === "number" ? code : 1006;
        const reasonText = (
          Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? "")
        ).trim();
        if (PERMANENT_CLOSE_CODES.has(closeCode)) {
          this.handleFatalError(mySessionId, {
            severity: "fatal",
            code: `ws_close_${closeCode}`,
            message: reasonText
              ? `Grok closed the connection: ${reasonText}`
              : `Grok closed the connection (code ${closeCode})`,
          });
          return;
        }
        this.lastReconnectError = transportError ?? {
          severity: "transient",
          code: `ws_close_${closeCode}`,
          message: reasonText || `Connection closed (code ${closeCode})`,
        };
        this.scheduleReconnect(mySessionId, settings, sanitized);
        return;
      }
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
      if (this.isExpectedClose) return;
      this.emit({ type: "status", status: "idle" });
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectNow = null;
  }

  private connectionProvedHealthy(): boolean {
    if (this.readyAt === 0) return false;
    return this.transcribedSinceReady || performance.now() - this.readyAt >= HEALTHY_CONNECTION_MS;
  }

  /**
   * Schedules the next reconnect attempt, or gives up with a fatal error once
   * the recovery window has passed. A drop of a connection that proved
   * healthy starts a fresh window; one that failed straight after coming up
   * keeps counting down the last one.
   */
  private scheduleReconnect(
    mySessionId: number,
    settings: VoiceInputSettings,
    sanitized: readonly string[]
  ): void {
    if (this.sessionId !== mySessionId) return;
    if (this.reconnectDeadlineAt !== null && this.connectionProvedHealthy()) {
      this.reconnectDeadlineAt = null;
      this.reconnectAttempt = 0;
    }
    this.readyAt = 0;
    const now = performance.now();
    this.reconnectDeadlineAt ??= now + RECONNECT_WINDOW_MS;
    const remainingMs = this.reconnectDeadlineAt - now;
    if (remainingMs <= 0) {
      const last = this.lastReconnectError;
      logError(`${P} Reconnect failed for ${RECONNECT_WINDOW_MS}ms — giving up`, undefined, {
        attempts: this.reconnectAttempt,
        lastCode: last?.code,
      });
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "reconnect_exhausted",
        message: last
          ? `Couldn't reconnect to Grok: ${last.message}`
          : "Couldn't reconnect to Grok",
      });
      return;
    }

    this.isReconnecting = true;
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempt);
    const delay = Math.min(remainingMs, ceiling / 2 + Math.random() * (ceiling / 2));
    this.reconnectAttempt++;
    logInfo(`${P} Scheduling reconnect`, {
      attempt: this.reconnectAttempt,
      delayMs: Math.round(delay),
      remainingMs: Math.round(remainingMs),
      lastCode: this.lastReconnectError?.code,
    });
    this.clearReconnectTimer();
    const reconnectNow = (): void => {
      if (this.reconnectNow !== reconnectNow) return;
      this.clearReconnectTimer();
      if (this.sessionId !== mySessionId) return;
      logInfo(`${P} Reconnecting`, { attempt: this.reconnectAttempt });
      this.reconnectCount++;
      this.cleanupConnection();
      this.connect(mySessionId, settings, sanitized);
    };
    this.reconnectNow = reconnectNow;
    this.reconnectTimer = setTimeout(reconnectNow, delay);
    this.emit({ type: "status", status: "reconnecting" });
  }

  /**
   * A reconnect attempt failed before its session was ready. A graceful stop
   * that was waiting on it gives up on the held audio rather than retrying
   * past the user's stop.
   */
  private retryAfterFailedAttempt(
    mySessionId: number,
    settings: VoiceInputSettings,
    sanitized: readonly string[]
  ): void {
    if (this.isDraining) {
      this.settleDrain("reconnect-failed");
      return;
    }
    this.scheduleReconnect(mySessionId, settings, sanitized);
  }

  private startKeepAlive(connection: WebSocket, mySessionId: number): void {
    this.clearKeepAlive();
    this.lastAudioSentAt = performance.now();
    this.keepAliveTimer = setInterval(() => {
      if (this.sessionId !== mySessionId || this.connection !== connection || !this.isReady) {
        this.clearKeepAlive();
        return;
      }
      if (performance.now() - this.lastAudioSentAt < KEEPALIVE_IDLE_MS) return;
      // Tracked like real audio, so result timing still lines up with the
      // ledger's byte offsets.
      this.sendAudioBinary(SILENCE_FRAME.slice(0));
      logDebug(`${P} → silence (keep-alive)`);
    }, KEEPALIVE_CHECK_MS);
  }

  private clearKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private handleFatalError(mySessionId: number, error: VoiceInputError): void {
    logError(`${P} Fatal error — tearing down session`, undefined, { code: error.code });
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.reconnectDeadlineAt = null;
    this.lastReconnectError = null;
    this.clearReconnectTimer();
    this.discardHeldAudio();
    const conn = this.connection;
    this.cleanupConnection();
    if (conn) {
      try {
        conn.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    // What the utterance already showed lands ahead of the error that ends
    // the dictation.
    this.settleOpenUtterance("fatal-error");
    this.emit({ type: "error", error });
    this.emit({ type: "status", status: "error" });
    this.settlePendingStart(mySessionId, { ok: false, error: error.message });
    this.settleDrain("fatal-error");
  }

  private handleServerEvent(type: string, payload: Record<string, unknown>): void {
    switch (type) {
      case "transcript.partial": {
        const text = payload.text;
        // A malformed result must neither show text nor retire the preview.
        if (typeof text !== "string" || typeof payload.is_final !== "boolean") {
          logDebug(`${P} ← malformed transcript.partial`, voicePayloadShape(payload));
          return;
        }
        const speechFinal = payload.speech_final === true;
        const isFinal = payload.is_final || speechFinal;
        const start = finiteSeconds(payload.start);
        const duration = finiteSeconds(payload.duration);
        const trimmed = text.trim();
        logDebug(`${P} ← transcript.partial`, { length: trimmed.length, isFinal, speechFinal });
        if (trimmed) this.transcribedSinceReady = true;
        const scored = scoreText(trimmed, payload.words);
        if (speechFinal) {
          this.completeUtterance(scored, start, duration);
        } else if (isFinal) {
          this.lockChunk(scored, start, duration);
        } else {
          this.showInterim(scored, start);
        }
        return;
      }

      case "transcript.done":
        // Restates the whole connection's transcript, which the utterances
        // already delivered; only the words past the last one are settled.
        logDebug(`${P} ← transcript.done`);
        this.settleOpenUtterance("transcript-done", this.uncompletedWords(payload.words));
        if (this.isDraining) this.settleDrain("transcript-done");
        return;

      default:
        logDebug(`${P} ← unhandled server event`, { type, ...voicePayloadShape(payload) });
    }
  }

  /**
   * The chunk finals a result follows: those ending where it starts. A
   * result that restates the utterance so far starts before any of them ends,
   * so none are kept. One without timing is taken as following them all, or,
   * for an utterance final, as restating them, as xAI documents.
   */
  private chunksBefore(start: number | null, restates: boolean): LockedChunk[] {
    if (start === null) return restates ? [] : this.lockedChunks;
    return this.lockedChunks.filter(
      (chunk) => chunk.end <= start + RESULT_TIMING_TOLERANCE_SECONDS
    );
  }

  private showPreview(parts: readonly ScoredText[]): void {
    const preview = joinTranscript(parts);
    // An empty revision retracts the preview; before any text it's noise.
    if (!preview.text && !this.utteranceItemId) return;
    this.utteranceItemId ??= nextUtteranceItemId();
    this.preview = preview;
    this.emit({ type: "delta", text: preview.text, itemId: this.utteranceItemId, replace: true });
  }

  private showInterim(interim: ScoredText, start: number | null): void {
    const before = this.chunksBefore(start, false);
    this.showPreview([...this.carriedText, ...before, interim]);
  }

  /**
   * A chunk final never changes, so its audio is confirmed and its text kept
   * for the preview. It doesn't complete anything: the utterance final
   * restates it.
   */
  private lockChunk(chunk: ScoredText, start: number | null, duration: number | null): void {
    this.confirmAudio(start, duration);
    const before = this.chunksBefore(start, false);
    const end = start === null ? Number.NEGATIVE_INFINITY : start + (duration ?? 0);
    this.lockedChunks = chunk.text ? [...before, { ...chunk, end }] : before;
    this.showPreview([...this.carriedText, ...this.lockedChunks]);
  }

  private completeUtterance(
    final: ScoredText,
    start: number | null,
    duration: number | null
  ): void {
    this.confirmAudio(start, duration);
    const before = this.chunksBefore(start, true);
    const { text: full, uncertain } = joinTranscript([...this.carriedText, ...before, final]);
    const itemId = this.utteranceItemId;
    if (start !== null && duration !== null) {
      this.connectionCompletedEnd = Math.max(this.connectionCompletedEnd, start + duration);
    }
    // An utterance begun after the Finalize point isn't its answer, which
    // then never came.
    const forced =
      this.finalizeAtSeconds !== null && (start === null || start < this.finalizeAtSeconds);
    this.finalizeAtSeconds = null;
    this.speechSinceFinal = this.onsetSpeaking;
    this.resetUtterance();
    if (itemId || full) {
      this.emit({
        type: "complete",
        text: full,
        ...(uncertain.length > 0 ? { uncertain } : {}),
        itemId: itemId ?? nextUtteranceItemId(),
        ...(forced ? {} : { endOfSpeech: true }),
      });
    } else if (!forced) {
      // Nothing was said in it; it only marks that the utterance ended.
      this.emit({ type: "complete", text: "", endOfSpeech: true });
    }
    // The final lands a moment after the pause that ended it, so the speaker
    // may already have gone on; say so, as Deepgram's VAD would have.
    if (this.onsetSpeaking) this.emit({ type: "speech_started" });
  }

  /**
   * The words of `transcript.done` that no utterance final on this connection
   * covered, or null when it names none: then only the preview is left.
   */
  private uncompletedWords(words: unknown): ScoredText | null {
    if (!Array.isArray(words)) return null;
    const tail = timedWords(words).filter(
      (word) =>
        word.start !== null &&
        word.start + WORD_BOUNDARY_EPSILON_SECONDS >= this.connectionCompletedEnd &&
        word.text
    );
    if (tail.length === 0) return null;
    const text = tail.map((word) => word.text).join(" ");
    return { text, uncertain: flagUncertainWords(text, tail, UNCERTAIN_BELOW) };
  }

  /**
   * Completes an utterance whose final never came. The server's own words
   * for the tail, when `transcript.done` gave them, end it as a final would;
   * otherwise it lands with what its preview showed, as incomplete: the
   * stream ended or failed before the utterance did, so its last words may
   * be missing and none of them can be read as a command.
   */
  private settleOpenUtterance(reason: string, serverTail: ScoredText | null = null): void {
    const itemId = this.utteranceItemId;
    const { text, uncertain } = serverTail
      ? joinTranscript([...this.carriedText, serverTail])
      : this.preview;
    this.resetUtterance();
    if (!itemId && !text) return;
    logInfo(`${P} Settling an utterance that never got its final`, {
      reason,
      length: text.length,
      fromServer: serverTail !== null,
    });
    this.emit({
      type: "complete",
      text,
      ...(uncertain.length > 0 ? { uncertain } : {}),
      itemId: itemId ?? nextUtteranceItemId(),
      ...(serverTail ? { endOfSpeech: true } : { incomplete: true }),
    });
  }

  private resetUtterance(): void {
    this.utteranceItemId = null;
    this.carriedText = [];
    this.lockedChunks = [];
    this.preview = NO_TEXT;
  }

  private sendAudioBinary(chunk: ArrayBuffer): void {
    if (!this.connection) return;
    // Tracked before the send: a send that throws means the socket is going
    // down, and the chunk goes out again on the next connection.
    this.trackUnconfirmedAudio(chunk);
    this.lastAudioSentAt = performance.now();
    try {
      this.connection.send(Buffer.from(chunk));
    } catch (err) {
      logWarn(`${P} Failed to send audio chunk`, voiceErrorLogFields(err));
    }
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      if (this.connection || this.pendingStart || this.isReconnecting) {
        this.detectOnset(chunk);
        this.bufferPreConnectChunk(chunk);
      } else if (!this.staleChunkWarned) {
        this.staleChunkWarned = true;
        logWarn(`${P} sendAudioChunk called but no active session`);
      }
      return;
    }
    this.detectOnset(chunk);
    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 100 === 0) {
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, { bytes: chunk.byteLength });
    }
    this.sendAudioBinary(chunk);
  }

  /** Emits `speech_started` when fresh audio rises to speech level after a quiet spell. */
  private detectOnset(chunk: ArrayBuffer): void {
    const samples = new Int16Array(chunk, 0, Math.floor(chunk.byteLength / AUDIO_BYTES_PER_SAMPLE));
    for (const sample of samples) {
      const value = sample / 32768;
      this.onsetSumSquares += value * value;
      if (++this.onsetSamples < ONSET_WINDOW_SAMPLES) continue;
      const rms = Math.sqrt(this.onsetSumSquares / this.onsetSamples);
      this.onsetSumSquares = 0;
      this.onsetSamples = 0;
      if (!this.onsetSpeaking) {
        this.onsetLoudWindows = rms >= ONSET_RMS ? this.onsetLoudWindows + 1 : 0;
        if (this.onsetLoudWindows >= ONSET_WINDOWS) {
          this.onsetSpeaking = true;
          this.speechSinceFinal = true;
          this.onsetQuietWindows = 0;
          logDebug(`${P} speech onset`);
          this.emit({ type: "speech_started" });
        }
      } else {
        this.onsetQuietWindows = rms < ONSET_REARM_RMS ? this.onsetQuietWindows + 1 : 0;
        if (this.onsetQuietWindows >= ONSET_REARM_WINDOWS) {
          this.onsetSpeaking = false;
          this.onsetLoudWindows = 0;
        }
      }
    }
  }

  private resetOnset(): void {
    this.onsetSpeaking = false;
    this.onsetLoudWindows = 0;
    this.onsetQuietWindows = 0;
    this.onsetSumSquares = 0;
    this.onsetSamples = 0;
  }

  private bufferPreConnectChunk(chunk: ArrayBuffer): void {
    const maxChunks = this.isReconnecting ? RECONNECT_BUFFER_MAX_CHUNKS : AUDIO_BUFFER_MAX_CHUNKS;
    // Gap audio joins the unconfirmed audio in the replay ledger on the next
    // ready, so together they stay under its cap.
    const maxBytes = this.isReconnecting
      ? Math.min(RECONNECT_BUFFER_MAX_BYTES, REPLAY_MAX_BYTES - this.unconfirmedBytes)
      : AUDIO_BUFFER_MAX_BYTES;
    if (
      this.preConnectBuffer.length >= maxChunks ||
      this.preConnectBufferBytes + chunk.byteLength > maxBytes
    ) {
      this.droppedConnectChunks++;
      if (!this.preConnectBufferOverflowWarned) {
        this.preConnectBufferOverflowWarned = true;
        logWarn(`${P} Pre-connect buffer full, dropping audio`, {
          chunks: this.preConnectBuffer.length,
          bytes: this.preConnectBufferBytes,
          maxChunks,
          maxBytes,
          isReconnecting: this.isReconnecting,
        });
        this.emit({ type: "error", error: createAudioBufferOverflowError() });
      }
      return;
    }
    this.preConnectBuffer.push(chunk);
    this.preConnectBufferBytes += chunk.byteLength;
  }

  private trackUnconfirmedAudio(chunk: ArrayBuffer): void {
    this.unconfirmedAudio.push(chunk);
    this.unconfirmedBytes += chunk.byteLength;
    while (this.unconfirmedBytes > REPLAY_MAX_BYTES && this.unconfirmedAudio.length > 1) {
      const evicted = this.unconfirmedAudio.shift()!;
      this.droppedReplayChunks++;
      this.unconfirmedBytes -= evicted.byteLength;
      this.unconfirmedOffset += evicted.byteLength;
      if (!this.replayEvictionWarned) {
        this.replayEvictionWarned = true;
        logWarn(`${P} No final result for the held audio — oldest dropped from replay`, {
          maxBytes: REPLAY_MAX_BYTES,
        });
      }
    }
  }

  /** Releases the held audio a final result covers, up to its `start + duration`. */
  private confirmAudio(start: number | null, duration: number | null): void {
    if (start === null || duration === null) return;
    const confirmedSeconds = start + duration;
    if (confirmedSeconds <= 0) return;
    const confirmedOffset =
      Math.round(confirmedSeconds * AUDIO_SAMPLE_RATE) * AUDIO_BYTES_PER_SAMPLE;
    while (this.unconfirmedAudio.length > 0) {
      const chunk = this.unconfirmedAudio[0];
      const chunkEnd = this.unconfirmedOffset + chunk.byteLength;
      if (chunkEnd <= confirmedOffset) {
        this.unconfirmedAudio.shift();
        this.unconfirmedBytes -= chunk.byteLength;
        this.unconfirmedOffset = chunkEnd;
        continue;
      }
      if (this.unconfirmedOffset < confirmedOffset) {
        const covered = confirmedOffset - this.unconfirmedOffset;
        this.unconfirmedAudio[0] = chunk.slice(covered);
        this.unconfirmedBytes -= covered;
        this.unconfirmedOffset = confirmedOffset;
      }
      return;
    }
  }

  /**
   * Sends the audio held while a session connected: first what the previous
   * connection never confirmed, then what was captured in the gap. Both are
   * tracked again from offset 0, since result timing restarts per connection,
   * and the open utterance's locked chunks become carried text: their audio
   * isn't resent, so the new connection's results follow them.
   */
  private flushHeldAudio(): void {
    this.carriedText = [...this.carriedText, ...this.lockedChunks];
    this.lockedChunks = [];
    this.connectionCompletedEnd = 0;
    this.finalizeAtSeconds = null;
    const unconfirmed = this.unconfirmedAudio;
    const buffered = this.preConnectBuffer;
    this.unconfirmedAudio = [];
    this.unconfirmedBytes = 0;
    this.unconfirmedOffset = 0;
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    if (unconfirmed.length > 0) {
      logInfo(`${P} Resending ${unconfirmed.length} unconfirmed audio chunks`);
    }
    if (buffered.length > 0) {
      logInfo(`${P} Flushing ${buffered.length} buffered audio chunks`);
    }
    for (const chunk of unconfirmed) this.sendAudioBinary(chunk);
    for (const chunk of buffered) this.sendAudioBinary(chunk);
  }

  private discardHeldAudio(): void {
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.unconfirmedAudio = [];
    this.unconfirmedBytes = 0;
    this.unconfirmedOffset = 0;
  }

  /**
   * Tears down per-connection state only. The session id, reconnect state,
   * held audio and the open utterance survive it, since a reconnect carries
   * them to the next socket.
   */
  private cleanupConnection(): void {
    this.clearConnectTimeout();
    this.clearKeepAlive();
    this.connection = null;
    this.isReady = false;
  }

  private cleanupPreviousSession(): void {
    logDebug(`${P} Cleaning up previous session`, {
      sessionId: this.sessionId,
      voiceSessionId: this.voiceSessionId,
      hasConnection: !!this.connection,
    });
    const pendingSessionId = this.pendingStart?.sessionId;
    this.sessionId++;
    this.audioChunkCount = 0;
    this.staleChunkWarned = false;
    this.preConnectBufferOverflowWarned = false;
    this.resetUtterance();
    this.connectionCompletedEnd = 0;
    this.finalizeAtSeconds = null;
    this.speechSinceFinal = false;
    this.resetOnset();
    this.replayEvictionWarned = false;
    this.isReady = false;
    this.discardHeldAudio();
    this.clearConnectTimeout();
    this.clearDrainTimeout();
    this.clearKeepAlive();
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.reconnectDeadlineAt = null;
    this.lastReconnectError = null;
    this.readyAt = 0;
    this.transcribedSinceReady = false;
    this.keytermAttempt = "full";
    this.keytermsAccepted = false;
    this.isExpectedClose = false;
    this.isDraining = false;
    this.stopPendingReady = false;
    this.stopHeldBytes = 0;
    if (this.drainResolve) {
      this.drainResolve();
      this.drainResolve = null;
    }
    this.drainPromise = null;
    if (pendingSessionId !== undefined) {
      this.settlePendingStart(pendingSessionId, { ok: false, error: "Voice session stopped" });
    }
    if (this.connection) {
      try {
        this.connection.close();
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

  private settleDrain(reason: string): void {
    const resolve = this.drainResolve;
    const lostBytes = resolve && this.stopPendingReady ? this.stopHeldBytes : 0;
    this.clearDrainTimeout();
    this.isDraining = false;
    this.stopPendingReady = false;
    this.stopHeldBytes = 0;
    this.drainPromise = null;
    this.drainResolve = null;
    if (!resolve) {
      logDebug(`${P} settleDrain called with no pending drain`, { reason });
      return;
    }
    // Whatever ended the drain, the utterance it was waiting on keeps what it showed.
    this.settleOpenUtterance(reason);
    if (lostBytes > 0) this.reportStopAudioLost(lostBytes, reason);
    logInfo(`${P} Drain completed`, { reason });
    resolve();
  }

  /** Tells the user a stop gave up on audio it was holding, before the drain resolves. */
  private reportStopAudioLost(lostBytes: number, reason: string): void {
    const seconds = Math.max(1, Math.ceil(lostBytes / AUDIO_BYTES_PER_SECOND));
    logWarn(`${P} Stop discarded held audio`, { reason, lostBytes, seconds });
    const lost = pluralize(seconds, "second");
    this.emit({
      type: "error",
      error: {
        severity: "transient",
        code: VOICE_STOP_AUDIO_LOST_CODE,
        message: `Grok wasn't connected when dictation stopped, so up to ${lost} at the end may be missing.`,
      },
    });
  }

  // No delay tier: its turn detection is `endpointing`, a separate setting.
  getSessionStats(): ProviderSessionStats {
    return {
      delayTier: "none",
      droppedConnect: this.droppedConnectChunks,
      droppedReplay: this.droppedReplayChunks,
      reconnects: this.reconnectCount,
    };
  }

  async stopGracefully(): Promise<void> {
    logInfo(`${P} stopGracefully() called`, {
      sessionId: this.sessionId,
      voiceSessionId: this.voiceSessionId,
      hasConnection: !!this.connection,
    });

    if (this.drainPromise) {
      logDebug(`${P} Already draining, joining existing promise`);
      return this.drainPromise;
    }

    this.isExpectedClose = true;

    const heldBytes = this.preConnectBufferBytes + this.unconfirmedBytes;
    if (!this.isReady && (this.connection || this.reconnectTimer) && heldBytes > 0) {
      return this.stopAfterConnect();
    }
    this.isReconnecting = false;
    this.clearReconnectTimer();

    if (!this.connection || !this.isReady) {
      this.settleOpenUtterance("stopped-disconnected");
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isDraining = true;
    this.clearKeepAlive();
    this.emit({ type: "status", status: "finishing" });

    const sessionIdBeforeDrain = this.sessionId;
    // Armed before the control frame, so an answer that comes back at once
    // finds the drain waiting.
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`);
        this.settleDrain("timeout");
      }, DRAIN_TIMEOUT_MS);
    });
    const drainPromise = this.drainPromise;

    // audio.done asks the server to flush what it has: the remaining results,
    // then transcript.done, then it closes.
    try {
      this.connection.send(JSON.stringify({ type: "audio.done" }));
      logInfo(`${P} → audio.done`);
    } catch {
      logWarn(`${P} Failed to send audio.done, closing immediately`);
      this.settleDrain("audio-done-failed");
    }
    await drainPromise;

    // A start() during the drain already cleaned up and moved the session on.
    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Graceful stop before the session is ready. The drain first waits (bounded
   * by STOP_CONNECT_TIMEOUT_MS) for `transcript.created`, which flushes the
   * buffer and calls `finishStreamAfterLateReady()`; from there it's the
   * normal audio.done drain. A reconnect waiting out its backoff is made now,
   * and only once.
   */
  private async stopAfterConnect(): Promise<void> {
    logInfo(`${P} Stop before the session is ready — waiting to flush buffered audio`, {
      bufferedChunks: this.preConnectBuffer.length,
      bufferedBytes: this.preConnectBufferBytes,
      unconfirmedBytes: this.unconfirmedBytes,
      isReconnecting: this.isReconnecting,
    });
    this.isDraining = true;
    this.stopPendingReady = true;
    this.stopHeldBytes = this.preConnectBufferBytes + this.unconfirmedBytes;
    this.emit({ type: "status", status: "finishing" });

    const sessionIdBeforeDrain = this.sessionId;
    const drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        logWarn(
          `${P} Session not ready ${STOP_CONNECT_TIMEOUT_MS}ms after stop — discarding buffered audio`,
          { bufferedBytes: this.preConnectBufferBytes }
        );
        this.settleDrain("connect-timeout");
      }, STOP_CONNECT_TIMEOUT_MS);
    });
    this.drainPromise = drainPromise;
    this.reconnectNow?.();
    await drainPromise;

    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Second half of `stopAfterConnect()`, run once the buffered audio has been
   * flushed: send audio.done and re-arm the drain backstop.
   */
  private finishStreamAfterLateReady(): void {
    this.stopPendingReady = false;
    this.stopHeldBytes = 0;
    this.clearDrainTimeout();
    this.drainTimeout = setTimeout(() => {
      logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`);
      this.settleDrain("timeout");
    }, DRAIN_TIMEOUT_MS);
    try {
      this.connection?.send(JSON.stringify({ type: "audio.done" }));
      logInfo(`${P} → audio.done (after late ready)`);
    } catch {
      logWarn(`${P} Failed to send audio.done after late ready`);
      this.settleDrain("audio-done-failed");
    }
  }

  stop(): void {
    logInfo(`${P} stop() called`, {
      sessionId: this.sessionId,
      voiceSessionId: this.voiceSessionId,
      hasConnection: !!this.connection,
    });
    this.isExpectedClose = true;
    this.cleanupPreviousSession();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
