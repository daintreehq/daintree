import WebSocket from "ws";
import type { VoiceInputError, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { logDebug, logInfo, logWarn, logError } from "../../utils/logger.js";
import {
  STUB_CONFIDENCE,
  type TranscriptionProvider,
  type VoiceStartResult,
  type VoiceTranscriptionEvent,
} from "./TranscriptionProvider.js";

const P = "[VoiceTranscription:deepgram]";

const DEEPGRAM_BASE_URL =
  process.env.DAINTREE_DEEPGRAM_WS_URL ?? "wss://api.deepgram.com/v1/listen";
const DEEPGRAM_MODEL = "nova-3";
const CONNECT_TIMEOUT_MS = 10_000;
// Backstop for the graceful drain: after `CloseStream` the server flushes its
// remaining transcripts and closes. If it never closes (network hiccup), force
// the stop through after this long rather than hanging.
const DRAIN_TIMEOUT_MS = 3_000;
// Deepgram drops an idle connection after ~10s of no audio with a NET-0001
// error. A periodic KeepAlive text frame resets that timer; well under 10s
// gives margin even if a tick is delayed.
const KEEPALIVE_INTERVAL_MS = 5_000;
const PRE_CONNECT_BUFFER_MAX = 100;
// 24kHz mono PCM16 ≈ 48KB/s, so ~150KB ≈ 3s of audio — past which voice
// context is lost anyway. Matches the OpenAI provider's ceiling.
const PRE_CONNECT_BUFFER_MAX_BYTES = 150_000;

// Deepgram caps Nova-3 keyterms at 100 terms and 500 aggregate tokens. The
// tokenizer is syllable-based (~5 tokens per single-word term), so the term
// count alone doesn't bound tokens. We cap the URL injection well below both
// ceilings — 50 terms is a 2x margin on the count, and a ~3000-char aggregate
// guard backstops pathologically long terms before they blow the token budget.
// This is deliberately tighter than the assembly-side MAX_KEYTERMS (96): that
// constant governs how many terms to gather, this one governs how many survive
// into the wire request.
const MAX_DEEPGRAM_URL_KEYTERMS = 50;
const MAX_DEEPGRAM_URL_KEYTERM_CHARS = 3_000;

/**
 * Conservatively trim assembled keyterms before they go on the streaming URL.
 * Drops empty/whitespace-only terms, then accepts terms in priority order until
 * either the term-count or aggregate-char budget is reached.
 */
function truncateKeytermsForUrl(keyterms: string[]): string[] {
  const result: string[] = [];
  let chars = 0;
  for (const raw of keyterms) {
    const term = raw.trim();
    if (!term) continue;
    if (result.length >= MAX_DEEPGRAM_URL_KEYTERMS) break;
    // Skip (don't stop on) an oversized term so smaller later terms still fit.
    if (chars + term.length > MAX_DEEPGRAM_URL_KEYTERM_CHARS) continue;
    result.push(term);
    chars += term.length;
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
 * turns on server-side VAD: a 300ms pause finalizes the current segment. */
function buildUrl(settings: VoiceInputSettings): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    encoding: "linear16",
    sample_rate: "24000",
    endpointing: "300",
  });
  if (settings.language) {
    params.set("language", settings.language);
  }
  // Nova-3 keyterms are repeated `keyterm=` params — one per term. A comma-
  // joined value would be treated as a single literal phrase, not a list.
  // (NOT the legacy `keywords` param, which 400s the upgrade on nova-3.)
  if (settings.keyterms && settings.keyterms.length > 0) {
    for (const term of truncateKeytermsForUrl(settings.keyterms)) {
      params.append("keyterm", term);
    }
  }
  return `${DEEPGRAM_BASE_URL}?${params.toString()}`;
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly hasServerVAD = true;

  private connection: WebSocket | null = null;
  private sessionId = 0;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

  private preConnectBuffer: ArrayBuffer[] = [];
  private preConnectBufferBytes = 0;
  private isReady = false;

  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  // Set on graceful/fatal teardown so the trailing `close` event isn't treated
  // as an unexpected drop.
  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;

  private audioChunkCount = 0;
  private staleChunkWarned = false;
  private preConnectBufferOverflowWarned = false;

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
      logWarn(`${P} Failed to send Finalize`, { message: formatErrorMessage(err, "send failed") });
    }
  }

  private emit(event: VoiceTranscriptionEvent): void {
    if (event.type === "status") {
      logInfo(`${P} status → ${event.status}`);
    } else if (event.type === "error") {
      logWarn(`${P} emitting error event`, {
        severity: event.error.severity,
        code: event.error.code,
        message: event.error.message,
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

  async start(settings: VoiceInputSettings): Promise<VoiceStartResult> {
    if (!settings.deepgramApiKey) {
      logWarn(`${P} No Deepgram API key configured`);
      return { ok: false, error: "Deepgram API key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, { language: settings.language });
    this.cleanupPreviousSession();
    this.sessionId = mySessionId;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.isExpectedClose = false;

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      this.connect(mySessionId, settings);
    });
  }

  private connect(
    mySessionId: number,
    settings: VoiceInputSettings,
    retryWithoutKeyterms = false
  ): void {
    // On a keyterm-overflow retry, strip keyterms from the URL but keep every
    // other setting identical.
    const effectiveSettings = retryWithoutKeyterms
      ? { ...settings, keyterms: undefined }
      : settings;
    const url = buildUrl(effectiveSettings);
    let connection: WebSocket;
    try {
      connection = new WebSocket(url, {
        headers: {
          Authorization: `Token ${settings.deepgramApiKey}`,
        },
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to open WebSocket");
      logError(`${P} ${message}`);
      this.emit({
        type: "error",
        error: { severity: "fatal", code: "ws_construct_failed", message },
      });
      this.emit({ type: "status", status: "error" });
      this.settlePendingStart(mySessionId, { ok: false, error: message });
      return;
    }

    this.connection = connection;
    // Don't log the full URL — it carries the assembled keyterms (project/branch/
    // terminal identifiers). The term count is enough to debug keyterm wiring.
    logInfo(`${P} Opening Deepgram WebSocket`, {
      keytermCount: effectiveSettings.keyterms?.length ?? 0,
      language: settings.language || "en",
      retryWithoutKeyterms,
    });

    this.connectTimeout = setTimeout(() => {
      this.connectTimeout = null;
      if (this.sessionId !== mySessionId) return;
      logError(`${P} Connection timed out (${CONNECT_TIMEOUT_MS}ms)`);
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
    }, CONNECT_TIMEOUT_MS);

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
      // Retry once with keyterms stripped: a 400 here most plausibly means the
      // assembled keyterms overflowed Deepgram's token budget. The new socket
      // becomes `this.connection`, so this old socket's trailing close is
      // ignored by the `this.connection !== connection` guards.
      if (statusCode === 400 && !retryWithoutKeyterms) {
        logWarn(`${P} Deepgram rejected upgrade with HTTP 400 — retrying without keyterms`);
        this.cleanupConnection();
        this.connect(mySessionId, settings, true);
        return;
      }
      // Any other status (401 auth, 403, 429, 5xx) — or a second 400 after the
      // keyterm-free retry — is fatal.
      const message = `Deepgram rejected the connection (HTTP ${statusCode ?? "unknown"})`;
      logError(`${P} ${message}`);
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "ws_http_error",
        message,
      });
    });

    connection.on("open", () => {
      if (this.sessionId !== mySessionId) {
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
      logInfo(`${P} WebSocket opened — session ready`);
      if (this.preConnectBuffer.length > 0) {
        logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`);
        const buffered = this.preConnectBuffer;
        this.preConnectBuffer = [];
        this.preConnectBufferBytes = 0;
        for (const chunk of buffered) {
          this.sendAudioBinary(chunk);
        }
      }
      this.isReady = true;
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
        logWarn(`${P} Ignoring non-JSON message`, { raw: raw.slice(0, 200) });
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
      logError(`${P} WebSocket error`, { message });
      // `ws` fires `close` right after `error`; a pre-ready transport error
      // (auth/DNS/refused) is fatal, otherwise let the close handler decide.
      if (!this.isReady) {
        this.handleFatalError(mySessionId, {
          severity: "fatal",
          code: "ws_transport_error",
          message,
        });
      }
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
        reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? ""),
        wasReady,
        wasExpected: this.isExpectedClose,
        wasDraining: this.isDraining,
        audioChunksStreamed: this.audioChunkCount,
      });
      this.cleanupConnection();
      if (this.isDraining) {
        this.settleDrain("connection-closed");
        return;
      }
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
      if (this.isExpectedClose) return;
      // No reconnect for Deepgram (first-cut provider). An unexpected drop of a
      // ready session is surfaced as an error; a never-ready drop falls through
      // to idle (matches the OpenAI provider's terminal semantics).
      if (wasReady) {
        this.emit({
          type: "error",
          error: { severity: "fatal", code: "ws_close_unexpected", message: "Connection lost" },
        });
        this.emit({ type: "status", status: "error" });
      } else {
        this.emit({ type: "status", status: "idle" });
      }
    });
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
          message: formatErrorMessage(err, "send failed"),
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
    logError(`${P} Fatal error — tearing down session`, {
      code: error.code,
      message: error.message,
    });
    this.isExpectedClose = true;
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
          { alternatives?: Array<{ transcript?: string }> } | undefined;
        const transcript = channel?.alternatives?.[0]?.transcript ?? "";
        const isFinal = payload.is_final === true;
        const speechFinal = payload.speech_final === true;
        // Interim hypotheses (is_final === false) are revised in place; emitting
        // them as append-style deltas would corrupt the renderer's live buffer.
        // Only finalized segments are emitted — they arrive within ~300ms of an
        // endpoint and won't change. A speech_final result is always is_final,
        // so this branch covers both.
        logDebug(`${P} ← Results`, { length: transcript.length, isFinal, speechFinal });
        if (!isFinal) return;
        const trimmed = transcript.trim();
        if (trimmed) {
          this.emit({ type: "complete", text: trimmed, confidence: { ...STUB_CONFIDENCE } });
        }
        return;
      }

      case "UtteranceEnd":
      case "SpeechStarted":
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
        logError(`${P} ← server error event`, { message });
        this.handleFatalError(_mySessionId, {
          severity: "fatal",
          code: "deepgram_server_error",
          message,
        });
        return;
      }

      default:
        logDebug(`${P} ← unhandled server event`, {
          type,
          payload: JSON.stringify(payload).slice(0, 600),
        });
    }
  }

  private sendAudioBinary(chunk: ArrayBuffer): void {
    if (!this.connection) return;
    try {
      // Deepgram expects raw PCM16 as binary WebSocket frames — NOT base64 JSON.
      this.connection.send(Buffer.from(chunk));
    } catch (err) {
      logWarn(`${P} Failed to send audio chunk`, {
        message: formatErrorMessage(err, "send failed"),
      });
    }
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      if (this.connection || this.pendingStart) {
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
    if (
      this.preConnectBuffer.length >= PRE_CONNECT_BUFFER_MAX ||
      this.preConnectBufferBytes + chunk.byteLength > PRE_CONNECT_BUFFER_MAX_BYTES
    ) {
      if (!this.preConnectBufferOverflowWarned) {
        this.preConnectBufferOverflowWarned = true;
        logWarn(`${P} Pre-connect buffer full, dropping audio`, {
          chunks: this.preConnectBuffer.length,
          bytes: this.preConnectBufferBytes,
          maxChunks: PRE_CONNECT_BUFFER_MAX,
          maxBytes: PRE_CONNECT_BUFFER_MAX_BYTES,
        });
      }
      return;
    }
    this.preConnectBuffer.push(chunk);
    this.preConnectBufferBytes += chunk.byteLength;
  }

  private cleanupConnection(): void {
    this.clearKeepAlive();
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
    this.preConnectBufferOverflowWarned = false;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.clearConnectTimeout();
    this.clearDrainTimeout();
    this.clearKeepAlive();
    this.isExpectedClose = false;
    this.isDraining = false;
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
    this.clearDrainTimeout();
    this.isDraining = false;
    this.drainPromise = null;
    if (this.drainResolve) {
      logInfo(`${P} Drain completed`, { reason });
      const resolve = this.drainResolve;
      this.drainResolve = null;
      resolve();
    } else {
      logDebug(`${P} settleDrain called with no pending drain`, { reason });
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

    this.isExpectedClose = true;

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

  stop(): void {
    logInfo(`${P} stop() called`, { sessionId: this.sessionId, hasConnection: !!this.connection });
    this.isExpectedClose = true;
    this.cleanupPreviousSession();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
