import WebSocket from "ws";
import type { VoiceInputError, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { VOICE_STOP_AUDIO_LOST_CODE } from "../../../shared/types/voice.js";
import {
  normalizeVoiceLanguage,
  VOICE_LANGUAGE_AUTO,
} from "../../../shared/config/voiceLanguages.js";
import { MAX_KEYTERMS } from "../../../shared/config/voiceKeyterms.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { pluralize } from "../../../shared/utils/pluralize.js";
import { logDebug, logInfo, logWarn, logError } from "../../utils/logger.js";
import { voiceErrorLogFields, voicePayloadShape } from "../../../shared/utils/voiceLogFields.js";
import {
  flagUncertainWords,
  type RecognisedWord,
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

const P = "[VoiceTranscription:deepgram]";

const DEEPGRAM_BASE_URL =
  process.env.DAINTREE_DEEPGRAM_WS_URL ?? "wss://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-3";
// Words scored below this reach cleanup as unsure. Deepgram's own guidance for
// its calibrated scores: most words land above 0.90, and around 0.65 picks out
// likely errors with high precision (developers.deepgram.com/docs/confidence).
const UNCERTAIN_BELOW = 0.65;
const CONNECT_TIMEOUT_MS = 10_000;
// Backstop for the graceful drain: after `CloseStream` the server flushes its
// remaining transcripts and closes. If it never closes (network hiccup), force
// the stop through after this long rather than hanging.
const DRAIN_TIMEOUT_MS = 3_000;
// How long a graceful stop that lands before the socket opens waits for it, so
// the buffered audio can still be transcribed. Past this it's discarded, and
// the user is told.
const STOP_CONNECT_TIMEOUT_MS = 3_000;
// Deepgram drops an idle connection after ~10s of no audio with a NET-0001
// error. A periodic KeepAlive text frame resets that timer; well under 10s
// gives margin even if a tick is delayed.
const KEEPALIVE_INTERVAL_MS = 5_000;
// Reconnect after an unexpected mid-session drop: retry with backoff until
// RECONNECT_WINDOW_MS has passed since the drop, then give up. A time window
// rather than an attempt count, because an attempt made while the network is
// still down fails in milliseconds and would burn a count before a wifi blip
// or post-wake reassociation is over. Equal jitter:
// delay = ceiling/2 + random() * ceiling/2, ceiling = min(CAP, INITIAL * 2^attempt).
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_CAP_MS = 3_000;
// The last attempt in the window still gets this long to connect.
const RECONNECT_MIN_CONNECT_MS = 1_000;
// linear16 mono @ 24kHz. Deepgram reports result timing in seconds of audio
// received on the connection; this converts it back to a byte offset.
const AUDIO_BYTES_PER_SAMPLE = 2;
const AUDIO_SAMPLE_RATE = 24_000;
const AUDIO_BYTES_PER_SECOND = AUDIO_SAMPLE_RATE * AUDIO_BYTES_PER_SAMPLE;
// Audio captured while reconnecting is held for the whole window, so a long
// blip is transcribed late rather than lost. Start-up keeps the shared ~3s cap.
const RECONNECT_BUFFER_MAX_BYTES = (RECONNECT_WINDOW_MS / 1_000) * AUDIO_BYTES_PER_SECOND;
const RECONNECT_BUFFER_MAX_CHUNKS = 400;
// Ceiling on audio sent but not yet covered by a final result. Results arrive
// at every 300ms pause, so in normal speech this stays small; it has to hold a
// full reconnect flush (~10s before the drop plus the window) so a second drop
// during the flush still resends all of it.
const REPLAY_MAX_BYTES = RECONNECT_BUFFER_MAX_BYTES + 10 * AUDIO_BYTES_PER_SECOND;

// Close codes that mean Deepgram refused what we sent (undecodable audio,
// policy, oversized frame). A new connection would fail the same way.
const PERMANENT_CLOSE_CODES = new Set<number>([1002, 1003, 1007, 1008, 1009]);

// Deepgram caps Nova-3 keyterms at 100 terms and 500 aggregate tokens. The
// tokenizer is syllable-based (~5 tokens per single-word term), so the term
// count alone doesn't bound tokens. The URL takes every term assembly gathers
// (MAX_KEYTERMS, inside the 100-term count, and derived so raising it can't
// silently clip the last tiers), a ~3000-char aggregate guard backstops
// pathologically long terms, and an estimated-token guard keeps the total under
// the token cap.
const MAX_DEEPGRAM_URL_KEYTERMS = MAX_KEYTERMS;
const MAX_DEEPGRAM_URL_KEYTERM_CHARS = 3_000;
// The keyterms' share of the query string, measured as encoded, since a CJK
// character percent-encodes to nine. With the fixed parameters this keeps the
// whole URL under 8 KiB, the request-line limit common to proxies and edge
// servers. Deepgram publishes no URL cap, and a 414 on the first connect is
// fatal: only a 400 triggers the keyterm retry.
const MAX_DEEPGRAM_KEYTERM_QUERY_LENGTH = 6_000;
// Deepgram 400s the upgrade when its tokenizer counts more than 500 tokens
// across all keyterms, and that retry keeps only the head of the list: the
// dictionary, with every context tier gone. Long worktree names and multi-word
// commands can cross 500 in under 100 terms, so the estimate below trims the
// lowest-priority terms first, with headroom for what it misjudges.
const MAX_DEEPGRAM_KEYTERM_TOKENS = 450;
// Keyterms arrive dictionary-first, newest first, so a first rejection retries
// with just the head of the list before the last resort of sending none.
const TRIMMED_RETRY_KEYTERMS = 20;

type KeytermAttempt = "full" | "trimmed" | "none";

// Process-wide: the orchestrator builds a fresh provider per session, so a
// per-instance counter would hand the renderer the same id twice.
let spanSeq = 0;
/**
 * A result's words as its transcript writes them. With punctuation on,
 * `punctuated_word` is the form in the transcript; a malformed entry stays in
 * place as an empty word, so it can't shift the ones after it.
 */
function recognisedWords(words: unknown): RecognisedWord[] {
  if (!Array.isArray(words)) return [];
  return words.map((entry: unknown) => {
    const word = (entry ?? {}) as {
      word?: unknown;
      punctuated_word?: unknown;
      confidence?: unknown;
    };
    const text =
      typeof word.punctuated_word === "string"
        ? word.punctuated_word
        : typeof word.word === "string"
          ? word.word
          : "";
    return { text, confidence: typeof word.confidence === "number" ? word.confidence : NaN };
  });
}

function nextSpanItemId(): string {
  return `deepgram-${++spanSeq}`;
}

// What one term adds to the query: `&keyterm=` and the term, encoded exactly
// as URLSearchParams serializes it.
function encodedKeytermLength(term: string): number {
  return new URLSearchParams([["keyterm", term]]).toString().length + 1;
}

/**
 * An over-estimate of the tokens Deepgram counts for one keyterm. Its tokenizer
 * isn't published and counts roughly by syllable, so a run of ASCII letters
 * costs one token per three letters (English syllables run longer), and every
 * digit, symbol and other character costs one of its own.
 */
export function estimateKeytermTokens(term: string): number {
  let tokens = 0;
  for (const [piece] of term.matchAll(/[A-Za-z]+|\S/gu)) {
    tokens += /^[A-Za-z]/.test(piece) ? Math.ceil(piece.length / 3) : 1;
  }
  return tokens;
}

/**
 * Conservatively trim assembled keyterms before they go on the streaming URL.
 * Drops empty/whitespace-only terms, then accepts terms in priority order until
 * the term-count, aggregate-char, encoded-length or estimated-token budget is
 * reached, so the lowest-priority terms are the ones left off.
 */
function truncateKeytermsForUrl(keyterms: string[]): string[] {
  const result: string[] = [];
  let chars = 0;
  let encoded = 0;
  let tokens = 0;
  for (const raw of keyterms) {
    const term = raw.trim();
    if (!term) continue;
    if (result.length >= MAX_DEEPGRAM_URL_KEYTERMS) break;
    const termEncoded = encodedKeytermLength(term);
    const termTokens = estimateKeytermTokens(term);
    // Skip (don't stop on) an oversized term so smaller later terms still fit.
    if (chars + term.length > MAX_DEEPGRAM_URL_KEYTERM_CHARS) continue;
    if (encoded + termEncoded > MAX_DEEPGRAM_KEYTERM_QUERY_LENGTH) continue;
    if (tokens + termTokens > MAX_DEEPGRAM_KEYTERM_TOKENS) continue;
    result.push(term);
    chars += term.length;
    encoded += termEncoded;
    tokens += termTokens;
  }
  return result;
}

// Like the OpenAI provider we use the `ws` package rather than Node's global
// WebSocket so the `Authorization` upgrade header can be sent. Deepgram differs
// from OpenAI in two ways: audio is streamed as raw binary frames (not base64
// JSON), and turn detection is server-side (`endpointing`), so there is no
// client-side commit timer — finalized segments arrive on their own.

/** Build the Deepgram streaming URL. `linear16` @ 24kHz matches the renderer's
 * AudioContext capture rate, so no resampling is needed. `endpointing=300`
 * turns on server-side VAD: a 300ms pause finalizes the current segment.
 * `vad_events` reports speech starting well before its first interim result.
 * Punctuation, casing and interim results are all off unless asked for. */
function buildUrl(settings: VoiceInputSettings, keyterms: readonly string[]): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: "24000",
    endpointing: "300",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    vad_events: "true",
  });
  // Streaming has no `detect_language` (prerecorded only); Nova-3's `multi` is
  // the live multilingual mode.
  const language = normalizeVoiceLanguage(settings.language);
  params.set("language", language === VOICE_LANGUAGE_AUTO ? "multi" : language);
  // Nova-3 keyterms are repeated `keyterm=` params — one per term. A comma-
  // joined value would be treated as a single literal phrase, not a list.
  // (NOT the legacy `keywords` param, which 400s the upgrade on nova-3.)
  for (const term of keyterms) {
    params.append("keyterm", term);
  }
  return `${DEEPGRAM_BASE_URL}?${params.toString()}`;
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
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
  private isReady = false;

  // Start-path timings on the main-process clock, so a log can show whether
  // lost opening words sat behind the socket, the handshake, or the model.
  private sessionStartedAt = 0;
  private connectStartedAt = 0;
  private firstTranscriptLogged = false;

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  // Session-level, so reconnects reuse the URL the session settled on: once a
  // 400 forced a smaller keyterm list, every reconnect keeps that step.
  private keytermAttempt: KeytermAttempt = "full";

  // Reconnect state. Survives per-connection teardown (cleanupConnection) and
  // is reset by a successful open or a full session reset.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // The attempt `reconnectTimer` will make, so a stop can make it now instead
  // of waiting out the backoff.
  private reconnectNow: (() => void) | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  // performance.now() past which this recovery gives up. Monotonic, so time
  // the machine spends asleep doesn't eat the window.
  private reconnectDeadlineAt: number | null = null;
  // The most specific failure seen this reconnect cycle, carried into the
  // fatal error if the attempts run out.
  private lastReconnectError: VoiceInputError | null = null;

  // Audio sent on the current connection that no received final result covers
  // yet, oldest first. `unconfirmedOffset` is the connection byte offset of the
  // first chunk. Every open resends it ahead of the pre-connect buffer, so words
  // in flight when the socket dropped are transcribed on the next connection.
  // Trimming follows only results actually received, so a resend can't repeat
  // text the renderer already has.
  private unconfirmedAudio: ArrayBuffer[] = [];
  private unconfirmedBytes = 0;
  private unconfirmedOffset = 0;
  private replayEvictionWarned = false;

  // Set on graceful/fatal teardown so the trailing `close` event isn't treated
  // as an unexpected drop.
  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;
  // A graceful stop arrived before the socket opened; the drain is waiting on
  // `open` to flush the buffered audio and send CloseStream (#13108).
  private stopPendingReady = false;
  // What that stop was holding, taken when it landed: a fatal error discards
  // the audio before the drain settles and reports the loss.
  private stopHeldBytes = 0;

  private audioChunkCount = 0;
  // Session-summary counts. They outlive the drain's cleanup and reset only
  // when the next session starts.
  private droppedConnectChunks = 0;
  private droppedReplayChunks = 0;
  private reconnectCount = 0;
  private staleChunkWarned = false;
  private preConnectBufferOverflowWarned = false;

  // Each interim result is Deepgram's whole hypothesis for the audio since the
  // last final, so that span is one item: its interims replace one preview and
  // its final retires exactly that preview. Null until the span shows a preview.
  private spanItemId: string | null = null;

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * With server-side VAD the backend segments utterances on its own, so a
   * user-driven boundary just asks Deepgram to finalize whatever it has
   * buffered now via a `Finalize` control frame; the resulting final Results
   * event flows through as a `complete`.
   */
  commitParagraphBoundary(): void {
    if (!this.connection || !this.isReady || this.isDraining) return;
    try {
      this.connection.send(JSON.stringify({ type: "Finalize" }));
      logDebug(`${P} → Finalize (paragraph boundary)`);
    } catch (err) {
      logWarn(`${P} Failed to send Finalize`, { ...voiceErrorLogFields(err) });
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
    if (!settings.deepgramApiKey) {
      logWarn(`${P} No Deepgram API key configured`);
      return { ok: false, error: "Deepgram API key not configured" };
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

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      this.connect(mySessionId, settings);
    });
  }

  /**
   * Opens one WebSocket and wires its handlers. Shared by `start()` (with a
   * pending start to settle) and the reconnect timer; the reconnect path is
   * told apart by `isReconnecting`, so an attempt that fails before opening
   * schedules the next one instead of ending the session.
   */
  private connect(mySessionId: number, settings: VoiceInputSettings): void {
    this.connectStartedAt = performance.now();
    // On a keyterm-overflow retry, shrink the keyterms on the URL but keep every
    // other setting identical.
    const attempt = this.keytermAttempt;
    const effectiveSettings =
      attempt === "none"
        ? { ...settings, keyterms: undefined }
        : attempt === "trimmed"
          ? { ...settings, keyterms: settings.keyterms?.slice(0, TRIMMED_RETRY_KEYTERMS) }
          : settings;
    const urlKeyterms = truncateKeytermsForUrl(effectiveSettings.keyterms ?? []);
    const url = buildUrl(effectiveSettings, urlKeyterms);
    let connection: WebSocket;
    try {
      connection = new WebSocket(url, {
        headers: {
          Authorization: `Token ${settings.deepgramApiKey}`,
        },
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to open WebSocket");
      logError(`${P} Failed to open WebSocket`, undefined, voiceErrorLogFields(err));
      if (this.isReconnecting) {
        this.lastReconnectError = { severity: "transient", code: "ws_construct_failed", message };
        this.retryAfterFailedAttempt(mySessionId, settings);
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
    // This socket's own transport error, preferred over the bare close code
    // that follows it when reporting why recovery failed.
    let transportError: VoiceInputError | null = null;
    // Don't log the full URL — it carries the assembled keyterms (project/branch/
    // terminal identifiers). The term count is enough to debug keyterm wiring.
    logInfo(`${P} Opening Deepgram WebSocket`, {
      keytermCount: effectiveSettings.keyterms?.length ?? 0,
      language: settings.language || "en",
      keytermAttempt: attempt,
      reconnectAttempt: this.isReconnecting ? this.reconnectAttempt : 0,
    });

    // A reconnect attempt can't hang past the recovery window.
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
        // Detach first so the dead socket's trailing error/close are ignored,
        // then move straight to the next attempt.
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
        this.retryAfterFailedAttempt(mySessionId, settings);
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

    // A non-101 HTTP response to the WebSocket upgrade surfaces here (not via
    // `error`), and only when we register this listener — which also disables
    // ws's built-in abort, so we MUST drain and destroy the socket ourselves or
    // it leaks. `res.statusCode` is the only reliable way to tell a 400 (likely
    // keyterm overflow) from a 401 (bad API key).
    connection.on("unexpected-response", (req, res) => {
      try {
        res.resume();
        req.socket?.destroy();
      } catch {
        // Ignore teardown errors
      }
      // Clear AFTER the stale guard: a 400 retry installs a fresh connectTimeout
      // for the new socket, so the failed socket must not clear it on the way out.
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.clearConnectTimeout();
      const statusCode = res.statusCode;
      // Retry with fewer keyterms, then none: a 400 here most plausibly means the
      // assembled keyterms overflowed Deepgram's token budget. The new socket
      // becomes `this.connection`, so this old socket's trailing close is
      // ignored by the `this.connection !== connection` guards.
      if (statusCode === 400 && attempt !== "none") {
        const keytermCount = settings.keyterms?.length ?? 0;
        const next: KeytermAttempt =
          attempt === "full" && keytermCount > TRIMMED_RETRY_KEYTERMS ? "trimmed" : "none";
        logWarn(`${P} Deepgram rejected upgrade with HTTP 400 — retrying (${next} keyterms)`);
        this.keytermAttempt = next;
        this.cleanupConnection();
        this.connect(mySessionId, settings);
        return;
      }
      const message = `Deepgram rejected the connection (HTTP ${statusCode ?? "unknown"})`;
      // Mid-session, a rate limit or server fault is worth another attempt;
      // nothing is listening for this socket's trailing close, so schedule here.
      if (this.isReconnecting && isRetryableHttpStatus(statusCode)) {
        logWarn(`${P} Reconnect attempt rejected — retrying`, { statusCode });
        this.lastReconnectError = { severity: "transient", code: "ws_http_error", message };
        this.cleanupConnection();
        this.retryAfterFailedAttempt(mySessionId, settings);
        return;
      }
      // 401 auth, 402 credits, 403 scope, a 400 after the keyterm-free retry —
      // or, on the first connect, anything else — is fatal.
      logError(`${P} Deepgram rejected the connection`, undefined, { statusCode });
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "ws_http_error",
        message,
      });
    });

    connection.on("open", () => {
      if (this.sessionId !== mySessionId || this.connection !== connection) {
        logWarn(`${P} Session expired during connect, closing`);
        try {
          connection.close();
        } catch {
          // Ignore close errors
        }
        return;
      }
      // Deepgram is ready to receive audio the moment the socket opens — the
      // model config lives in the URL query string, so there's no session
      // handshake to await (unlike OpenAI's `session.update`).
      this.clearConnectTimeout();
      logInfo(`${P} WebSocket opened — session ready`, {
        sessionId: mySessionId,
        voiceSessionId: this.voiceSessionId,
        connectMs: Math.round(performance.now() - this.connectStartedAt),
        sinceStartMs: this.sinceStartMs(),
        bufferedChunks: this.preConnectBuffer.length,
        reconnectAttempt: this.reconnectAttempt,
        resentChunks: this.unconfirmedAudio.length,
      });
      this.emit({ type: "terms_sent", terms: urlKeyterms, keytermAttempt: attempt });
      this.flushHeldAudio();
      this.isReady = true;
      // A successful open gives a later drop a fresh recovery window.
      this.reconnectAttempt = 0;
      this.isReconnecting = false;
      this.reconnectDeadlineAt = null;
      this.lastReconnectError = null;
      if (this.isDraining) {
        // Stopped while connecting: the mic is already released, so skip
        // KeepAlive and "recording" — close the stream and drain.
        this.settlePendingStart(mySessionId, { ok: true });
        if (this.stopPendingReady) this.closeStreamAfterLateReady();
        return;
      }
      this.startKeepAlive(connection, mySessionId);
      this.emit({ type: "status", status: "recording" });
      this.settlePendingStart(mySessionId, { ok: true });
    });

    connection.on("message", (data) => {
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
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
      this.handleServerEvent(mySessionId, type, parsed);
    });

    connection.on("error", (err) => {
      // Clear AFTER the stale guard so a superseded socket (e.g. the failed
      // first attempt of a keyterm retry) can't cancel the live socket's timers.
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.clearConnectTimeout();
      const message = formatErrorMessage(err, "WebSocket error");
      logError(`${P} WebSocket error`, undefined, voiceErrorLogFields(err));
      // `ws` fires `close` right after `error`, and the close handler owns the
      // reconnect decision; keep the error as the reason to report if the
      // attempts run out. Only a transport error on the first connect
      // (auth/DNS/refused) is fatal here.
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
      // Clear AFTER the stale guard so a superseded socket's trailing close
      // can't cancel the live socket's connect timeout / keep-alive.
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
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
      // An unexpected drop of a ready session, or a failed reconnect attempt,
      // retries with backoff unless Deepgram refused what we sent.
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
              ? `Deepgram closed the connection: ${reasonText}`
              : `Deepgram closed the connection (code ${closeCode})`,
          });
          return;
        }
        this.lastReconnectError = transportError ?? {
          severity: "transient",
          code: `ws_close_${closeCode}`,
          message: reasonText || `Connection closed (code ${closeCode})`,
        };
        this.scheduleReconnect(mySessionId, settings);
        return;
      }
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
      if (this.isExpectedClose) return;
      // A drop before the first open falls through to idle (matches the OpenAI
      // provider's terminal semantics).
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

  /**
   * Schedules the next reconnect attempt, or gives up with a fatal error once
   * the recovery window has passed. The timer re-checks the session id, so a
   * `stop()` or new `start()` in between cancels it (lessons #4850/#4851).
   */
  private scheduleReconnect(mySessionId: number, settings: VoiceInputSettings): void {
    if (this.sessionId !== mySessionId) return;
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
          ? `Couldn't reconnect to Deepgram: ${last.message}`
          : "Couldn't reconnect to Deepgram",
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
      this.connect(mySessionId, settings);
    };
    this.reconnectNow = reconnectNow;
    this.reconnectTimer = setTimeout(reconnectNow, delay);
    this.emit({ type: "status", status: "reconnecting" });
  }

  /**
   * A reconnect attempt failed before its socket opened. A graceful stop that
   * was waiting on it gives up on the held audio rather than retrying past the
   * user's stop.
   */
  private retryAfterFailedAttempt(mySessionId: number, settings: VoiceInputSettings): void {
    if (this.isDraining) {
      this.settleDrain("reconnect-failed");
      return;
    }
    this.scheduleReconnect(mySessionId, settings);
  }

  private startKeepAlive(connection: WebSocket, mySessionId: number): void {
    this.clearKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.sessionId !== mySessionId || this.connection !== connection) {
        this.clearKeepAlive();
        return;
      }
      try {
        connection.send(JSON.stringify({ type: "KeepAlive" }));
        logDebug(`${P} → KeepAlive`);
      } catch (err) {
        logWarn(`${P} KeepAlive send failed`, {
          ...voiceErrorLogFields(err),
        });
      }
    }, KEEPALIVE_INTERVAL_MS);
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
    this.emit({ type: "error", error });
    this.emit({ type: "status", status: "error" });
    this.settlePendingStart(mySessionId, { ok: false, error: error.message });
    this.settleDrain("fatal-error");
  }

  private handleServerEvent(
    _mySessionId: number,
    type: string,
    payload: Record<string, unknown>
  ): void {
    switch (type) {
      case "Results": {
        const channel = payload.channel as
          { alternatives?: Array<{ transcript?: unknown; words?: unknown }> } | undefined;
        const alternative = channel?.alternatives?.[0];
        const transcript = alternative?.transcript;
        // A malformed result must neither show text nor retire the live span.
        if (typeof transcript !== "string" || typeof payload.is_final !== "boolean") {
          logDebug(`${P} ← malformed Results`, voicePayloadShape(payload));
          return;
        }
        const isFinal = payload.is_final;
        const speechFinal = payload.speech_final === true;
        logDebug(`${P} ← Results`, { length: transcript.length, isFinal, speechFinal });
        const trimmed = transcript.trim();
        if (!isFinal) {
          // An empty revision retracts the span's preview; before any text it's noise.
          if (!trimmed && !this.spanItemId) return;
          this.spanItemId ??= nextSpanItemId();
          this.emit({ type: "delta", text: trimmed, itemId: this.spanItemId, replace: true });
          return;
        }
        // Finals cover disjoint spans and never change. A speech_final result is
        // always is_final, so this covers both. A span that showed a preview
        // still completes when it finalises empty, so the preview doesn't linger.
        // Only a final confirms audio: interims are revised, so their span may
        // still need resending after a drop.
        this.confirmAudio(payload.start, payload.duration);
        const previewId = this.spanItemId;
        this.spanItemId = null;
        if (previewId || trimmed) {
          const uncertain = flagUncertainWords(
            trimmed,
            recognisedWords(alternative?.words),
            UNCERTAIN_BELOW
          );
          this.emit({
            type: "complete",
            text: trimmed,
            ...(uncertain.length > 0 ? { uncertain } : {}),
            itemId: previewId ?? nextSpanItemId(),
            ...(speechFinal ? { endOfSpeech: true } : {}),
          });
        } else if (speechFinal) {
          // The utterance's words landed in earlier finals; this one only says
          // it ended, which a "send it" among them waits on.
          this.emit({ type: "complete", text: "", endOfSpeech: true });
        }
        return;
      }

      case "SpeechStarted":
        // Interim results land about a second of audio apart; this says much
        // sooner that the speaker went on after a pause.
        logDebug(`${P} ← ${type}`);
        this.emit({ type: "speech_started" });
        return;

      case "UtteranceEnd":
      case "Metadata":
        // VAD / metadata signals. Segmentation is already handled via is_final
        // Results, so these are informational only.
        logDebug(`${P} ← ${type}`);
        return;

      case "Error": {
        const message =
          (typeof payload.description === "string" && payload.description) ||
          (typeof payload.message === "string" && payload.message) ||
          "Deepgram error";
        logError(`${P} ← server error event`);
        this.handleFatalError(_mySessionId, {
          severity: "fatal",
          code: "deepgram_server_error",
          message,
        });
        return;
      }

      default:
        // Shape only: an unrecognised event can still carry transcript text.
        logDebug(`${P} ← unhandled server event`, { type, ...voicePayloadShape(payload) });
    }
  }

  private sendAudioBinary(chunk: ArrayBuffer): void {
    if (!this.connection) return;
    // Tracked before the send: a send that throws means the socket is going
    // down, and the chunk goes out again on the next connection.
    this.trackUnconfirmedAudio(chunk);
    try {
      // Deepgram expects raw PCM16 as binary WebSocket frames — NOT base64 JSON.
      this.connection.send(Buffer.from(chunk));
    } catch (err) {
      logWarn(`${P} Failed to send audio chunk`, {
        ...voiceErrorLogFields(err),
      });
    }
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      // Held while connecting or reconnecting, then sent once a socket opens.
      if (this.connection || this.pendingStart || this.isReconnecting) {
        this.bufferPreConnectChunk(chunk);
      } else if (!this.staleChunkWarned) {
        this.staleChunkWarned = true;
        logWarn(`${P} sendAudioChunk called but no active session`);
      }
      return;
    }
    this.audioChunkCount++;
    if (this.audioChunkCount <= 3 || this.audioChunkCount % 100 === 0) {
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, { bytes: chunk.byteLength });
    }
    this.sendAudioBinary(chunk);
  }

  private bufferPreConnectChunk(chunk: ArrayBuffer): void {
    const maxChunks = this.isReconnecting ? RECONNECT_BUFFER_MAX_CHUNKS : AUDIO_BUFFER_MAX_CHUNKS;
    // Gap audio joins the unconfirmed audio in the replay ledger on the next
    // open, so together they stay under its cap. Otherwise repeated drops would
    // have the flush silently evict audio this buffer already accepted.
    const maxBytes = this.isReconnecting
      ? Math.min(RECONNECT_BUFFER_MAX_BYTES, REPLAY_MAX_BYTES - this.unconfirmedBytes)
      : AUDIO_BUFFER_MAX_BYTES;
    if (
      this.preConnectBuffer.length >= maxChunks ||
      this.preConnectBufferBytes + chunk.byteLength > maxBytes
    ) {
      // Counted first: the overflow error below can end the session.
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

  /**
   * Releases the held audio a final result covers. Deepgram times results in
   * seconds of audio received on this connection, so `start + duration` marks
   * the byte offset up to which nothing needs resending.
   */
  private confirmAudio(start: unknown, duration: unknown): void {
    if (typeof start !== "number" || typeof duration !== "number") return;
    const confirmedSeconds = start + duration;
    if (!Number.isFinite(confirmedSeconds) || confirmedSeconds <= 0) return;
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
   * Sends the audio held while a socket connected: first what the previous
   * connection never confirmed, then what was captured in the gap. Both are
   * tracked again from offset 0, since result timing restarts per connection.
   */
  private flushHeldAudio(): void {
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
   * Tears down per-connection state only. The session id, reconnect state and
   * held audio survive it, since a reconnect carries them to the next socket.
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
    this.spanItemId = null;
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
    this.keytermAttempt = "full";
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
    // Still waiting on a socket: what the stop was holding never went out.
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
    if (lostBytes > 0) this.reportStopAudioLost(lostBytes, reason);
    logInfo(`${P} Drain completed`, { reason });
    resolve();
  }

  /**
   * Tells the user a stop gave up on audio it was holding. Sent before the
   * drain resolves, so it still reaches the session's owner. The held audio is
   * the dictation's tail, and it may include silence or words an interim
   * result already showed, hence "up to".
   */
  private reportStopAudioLost(lostBytes: number, reason: string): void {
    const seconds = Math.max(1, Math.ceil(lostBytes / AUDIO_BYTES_PER_SECOND));
    logWarn(`${P} Stop discarded held audio`, { reason, lostBytes, seconds });
    const lost = pluralize(seconds, "second");
    this.emit({
      type: "error",
      error: {
        severity: "transient",
        code: VOICE_STOP_AUDIO_LOST_CODE,
        message: `Deepgram wasn't connected when dictation stopped, so up to ${lost} at the end may be missing.`,
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

    // Audio held while (re)connecting — captured in the gap, or sent but never
    // confirmed before a drop — goes out once a socket opens. If a live
    // attempt or a scheduled reconnect can still get there, make it and wait
    // for it rather than discarding what the user already said.
    const heldBytes = this.preConnectBufferBytes + this.unconfirmedBytes;
    if (!this.isReady && (this.connection || this.reconnectTimer) && heldBytes > 0) {
      return this.stopAfterConnect();
    }
    this.isReconnecting = false;
    this.clearReconnectTimer();

    if (!this.connection || !this.isReady) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isDraining = true;
    this.clearKeepAlive();
    this.emit({ type: "status", status: "finishing" });

    // CloseStream tells Deepgram we're done sending audio. The server flushes
    // any remaining transcripts (delivered as final Results, emitted above) and
    // then closes the socket, which settles the drain via the close handler.
    try {
      this.connection.send(JSON.stringify({ type: "CloseStream" }));
      logInfo(`${P} → CloseStream`);
    } catch {
      logWarn(`${P} Failed to send CloseStream, closing immediately`);
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    const sessionIdBeforeDrain = this.sessionId;

    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`);
        this.settleDrain("timeout");
      }, DRAIN_TIMEOUT_MS);
    });
    await this.drainPromise;

    // If start() was called during drain it already ran cleanupPreviousSession()
    // and incremented sessionId — don't tear down the new session.
    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Graceful stop before the socket opens. The drain promise first waits
   * (bounded by STOP_CONNECT_TIMEOUT_MS) for `open`, which flushes the buffer
   * and calls `closeStreamAfterLateReady()`; from there it's the normal
   * CloseStream drain. A reconnect waiting out its backoff is made now, and
   * only once: a failure settles the drain via the close/fatal paths rather
   * than retrying past the stop. Audio arriving meanwhile is dropped by
   * `sendAudioChunk`.
   */
  private async stopAfterConnect(): Promise<void> {
    logInfo(`${P} Stop before socket open — waiting to flush buffered audio`, {
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
          `${P} Socket not open ${STOP_CONNECT_TIMEOUT_MS}ms after stop — discarding buffered audio`,
          { bufferedBytes: this.preConnectBufferBytes }
        );
        this.settleDrain("connect-timeout");
      }, STOP_CONNECT_TIMEOUT_MS);
    });
    this.drainPromise = drainPromise;
    // An attempt that can't even construct its socket settles the drain
    // before this returns, hence awaiting the local promise.
    this.reconnectNow?.();
    await drainPromise;

    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Second half of `stopAfterConnect()`, run from `open` once the buffered
   * audio has been flushed: send CloseStream and re-arm the drain backstop for
   * the server's final Results and close.
   */
  private closeStreamAfterLateReady(): void {
    this.stopPendingReady = false;
    this.stopHeldBytes = 0;
    this.clearDrainTimeout();
    try {
      this.connection?.send(JSON.stringify({ type: "CloseStream" }));
      logInfo(`${P} → CloseStream (after late open)`);
    } catch {
      logWarn(`${P} Failed to send CloseStream after late open`);
      this.settleDrain("close-stream-failed");
      return;
    }
    this.drainTimeout = setTimeout(() => {
      logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`);
      this.settleDrain("timeout");
    }, DRAIN_TIMEOUT_MS);
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
