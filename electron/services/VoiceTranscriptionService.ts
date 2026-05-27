import WebSocket from "ws";
import type { VoiceInputSettings, VoiceInputStatus } from "../../shared/types/ipc/api.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { logDebug, logInfo, logWarn, logError } from "../utils/logger.js";

const P = "[VoiceTranscription]";

// `gpt-realtime-whisper` is a transcription model — it must be passed as
// `transcription.model`, NOT as the realtime session `model` query param.
// The session connects via `?intent=transcription` instead.
const OPENAI_REALTIME_URL =
  process.env.DAINTREE_REALTIME_WS_URL ?? "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const CONNECT_TIMEOUT_MS = 10_000;
// Backstop for the drain: if a committed segment's `conversation.item.done`
// never arrives (server error, dropped frame), force-close after this long
// rather than hanging the stop.
const DRAIN_TIMEOUT_MS = 3_000;
const PRE_CONNECT_BUFFER_MAX = 100;
// Hard byte ceiling for buffered-but-not-yet-sent audio (pre-connect and during
// a reconnect window). 24kHz mono PCM16 ≈ 48KB/s, so ~150KB ≈ 3s — the point
// past which voice context is lost anyway. Caps memory if chunks are large.
const PRE_CONNECT_BUFFER_MAX_BYTES = 150_000;
// Client-side ping/pong heartbeat. The OpenAI Realtime server sends its own
// pings (auto-ponged by `ws`), but a half-open TCP connection on our side —
// server alive, our socket silently dead — is only detectable by us pinging
// and watching for the pong. On a missed pong we `terminate()` (no closing
// handshake on a dead socket) which fires `close` and drives the reconnect.
const HEARTBEAT_INTERVAL_MS = 20_000;
// Automatic reconnect on an unexpected mid-session drop. Exponential backoff
// with full jitter: delay = random() * min(CAP, INITIAL * MULTIPLIER^attempt).
// Gentle multiplier so the first few retries are near-instant; after
// RECONNECT_MAX_ATTEMPTS we give up and surface a fatal error.
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_INITIAL_MS = 150;
const RECONNECT_MULTIPLIER = 1.5;
const RECONNECT_CAP_MS = 3_000;
// `gpt-realtime-whisper` does not support server VAD (`turn_detection` must be
// null), so the server never auto-commits the input buffer. We drive
// segmentation ourselves: commit the buffer on a fixed cadence so the model
// transcribes each segment and streams delta/completed events back while the
// user is still speaking. Without this, no transcription arrives until stop.
const COMMIT_INTERVAL_MS = 2_000;
// OpenAI rejects an `input_audio_buffer.commit` carrying under ~100ms of audio
// (24kHz mono PCM16 → 4800 bytes) with a fatal error event. Skip a commit
// below this threshold.
const MIN_COMMIT_BYTES = 4_800;

export interface CorrectionWord {
  word: string;
  confidence: number;
  start?: number;
  end?: number;
}

export interface SegmentConfidence {
  minConfidence: number;
  wordCount: number;
  uncertainWords: string[];
  words: CorrectionWord[];
}

export type VoiceTranscriptionEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; text: string; confidence?: SegmentConfidence }
  | { type: "paragraph_boundary" }
  | { type: "error"; message: string }
  | { type: "status"; status: VoiceInputStatus };

type VoiceStartResult = { ok: true } | { ok: false; error: string };

// We use the `ws` package rather than Node 22's global `WebSocket`. The
// WHATWG spec exposes only `(url, protocols?)` — its constructor silently
// discards any third options argument, so custom upgrade headers cannot be
// sent. The `ws` package accepts a 2-arg `(url, options)` form with full
// header support, which is also what the openai SDK uses internally.

const STUB_CONFIDENCE: SegmentConfidence = {
  minConfidence: 1.0,
  wordCount: 0,
  uncertainWords: [],
  words: [],
};

export class VoiceTranscriptionService {
  private connection: WebSocket | null = null;
  private sessionId = 0;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

  private preConnectBuffer: ArrayBuffer[] = [];
  private preConnectBufferBytes = 0;
  private isReady = false;

  // Heartbeat (half-open detection) for the current connection. `isAlive` is
  // set on every pong and on open; the interval terminates the socket if a full
  // cycle elapses with no pong.
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private isAlive = false;

  // Reconnect state. `reconnectAttempt` and `isReconnecting` survive across
  // individual connection teardowns (cleanupConnection) and are only reset by
  // cleanupPreviousSession (a full session reset) or a successful reconnect.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  // Set on graceful/fatal teardown so the trailing `close` event isn't mistaken
  // for an unexpected drop and doesn't trigger a reconnect.
  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;

  private commitTimer: ReturnType<typeof setInterval> | null = null;
  private bytesSinceCommit = 0;
  // Commits sent (interval, paragraph-boundary, or final) whose
  // `conversation.item.done` we haven't seen yet. Each commit yields exactly
  // one completion, so the drain is finished precisely when this hits zero —
  // no timing heuristic needed.
  private pendingCommits = 0;
  // Item ids already counted toward `pendingCommits` — guards against a
  // completion being counted twice (e.g. a `.completed` and a `.done` for the
  // same item).
  private completedItemIds = new Set<string>();

  /** Cumulative delta text since the last complete event — used for incremental diffs. */
  private liveText = "";

  private audioChunkCount = 0;
  private staleChunkWarned = false;
  private preConnectBufferOverflowWarned = false;

  onEvent(listener: (event: VoiceTranscriptionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Flushes the current audio segment at a user-driven paragraph boundary
   * (Enter pressed mid-utterance). With no server VAD, committing here closes
   * the in-progress segment so its transcript finalizes promptly and the next
   * `completed` event reflects only speech after the boundary. Also clears the
   * live-delta state since the renderer has already captured the displayed text.
   */
  commitParagraphBoundary(): void {
    this.maybeCommitSegment("paragraph-boundary");
    this.liveText = "";
  }

  private emit(event: VoiceTranscriptionEvent): void {
    if (event.type === "status") {
      logInfo(`${P} status → ${event.status}`);
    } else if (event.type === "error") {
      logWarn(`${P} emitting error event`, { message: event.message });
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
    if (!settings.openaiApiKey) {
      logWarn(`${P} No OpenAI API key configured`);
      return { ok: false, error: "OpenAI API key not configured" };
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
    this.preConnectBufferBytes = 0;
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.isExpectedClose = false;
    this.liveText = "";

    this.emit({ type: "status", status: "connecting" });

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      this.connect(mySessionId, settings);
    });
  }

  /**
   * Opens the WebSocket and wires every event handler for one connection
   * attempt. Shared by `start()` (initial connect, with a pending start promise
   * to settle) and `reconnectOnce()` (mid-session reconnect, no pending start).
   * The reconnect path is distinguished purely by `this.isReconnecting`, so a
   * construct/timeout failure reschedules instead of surfacing a fatal error.
   */
  private connect(mySessionId: number, settings: VoiceInputSettings): void {
    let connection: WebSocket;
    try {
      connection = new WebSocket(OPENAI_REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${settings.openaiApiKey}`,
        },
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to open WebSocket");
      logError(`${P} ${message}`);
      if (this.isReconnecting) {
        this.scheduleReconnect(mySessionId, settings);
      } else {
        this.emit({ type: "error", message });
        this.emit({ type: "status", status: "error" });
        this.settlePendingStart(mySessionId, { ok: false, error: message });
      }
      return;
    }

    this.connection = connection;
    logInfo(`${P} Opening OpenAI realtime WebSocket`, {
      url: OPENAI_REALTIME_URL,
      model: OPENAI_TRANSCRIPTION_MODEL,
      language: settings.language || "en",
      customDictionaryTerms: settings.customDictionary.length,
      reconnectAttempt: this.isReconnecting ? this.reconnectAttempt : 0,
    });

    this.connectTimeout = setTimeout(() => {
      this.connectTimeout = null;
      if (this.sessionId !== mySessionId) return;
      logError(`${P} Connection timed out (${CONNECT_TIMEOUT_MS}ms)`);
      if (this.isReconnecting) {
        // Force the dead socket closed; the `close` handler schedules the next
        // reconnect attempt (or gives up once attempts are exhausted).
        try {
          connection.terminate();
        } catch {
          // Ignore terminate errors
        }
        return;
      }
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
      this.cleanupConnection();
      this.emit({ type: "error", message: "Connection timed out" });
      this.emit({ type: "status", status: "error" });
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection timed out" });
    }, CONNECT_TIMEOUT_MS);

    connection.on("pong", () => {
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.isAlive = true;
    });

    // Open handler — same logic for initial connect and reconnect.
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
      this.startHeartbeat(connection, mySessionId);
      logInfo(`${P} WebSocket opened, sending session.update`);
      // TODO: pass `transcription.prompt` from settings once #7832 lands.
      // `turn_detection` MUST be explicitly `null` for `gpt-realtime-whisper`
      // (VAD is not supported for this model). It is not enough to omit it:
      // when absent the server applies a default VAD that this model can't
      // use, and then silently produces no transcription — it still acks
      // `input_audio_buffer.committed` but emits no `conversation.item.added`
      // / `conversation.item.done`. With it set to `null`, each manual commit
      // yields a transcribed item. (An explicit non-null `turn_detection`
      // block, by contrast, is hard-rejected with an error event.)
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: OPENAI_TRANSCRIPTION_MODEL,
                language: settings.language || "en",
              },
              turn_detection: null,
            },
          },
        },
      };
      // Log the exact payload — the session config (especially the explicit
      // `turn_detection: null`) is the most common cause of "commits acked
      // but no transcription items" regressions.
      logInfo(`${P} → session.update`, { session: sessionUpdate.session });
      try {
        connection.send(JSON.stringify(sessionUpdate));
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to send session.update");
        logError(`${P} ${message}`);
        this.handleFatalError(mySessionId, message);
      }
    });

    connection.on("message", (data) => {
      if (this.sessionId !== mySessionId) return;
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
      this.clearConnectTimeout();
      if (this.sessionId !== mySessionId) return;
      const message = formatErrorMessage(err, "WebSocket error");
      logError(`${P} WebSocket error`, { message });
      // A transport error on a ready (or reconnecting) session is recoverable —
      // `ws` always fires `close` right after `error`, and the close handler
      // owns the reconnect decision, so just log here. A pre-ready error
      // (auth/DNS/refused on the very first connect) is fatal: tear down now.
      if (!this.isReady && !this.isReconnecting) {
        this.handleFatalError(mySessionId, message);
      }
    });

    connection.on("close", (code, reason) => {
      this.clearConnectTimeout();
      this.clearHeartbeat();
      if (this.sessionId !== mySessionId) return;
      const wasReady = this.isReady;
      logInfo(`${P} WebSocket closed`, {
        code,
        reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? ""),
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
      // An unexpected drop of a ready session (or a failed reconnect attempt
      // while still mid-reconnect) is recoverable — schedule a retry instead of
      // ending the session. Graceful stops and fatal errors set isExpectedClose.
      if (!this.isExpectedClose && (wasReady || this.isReconnecting)) {
        this.scheduleReconnect(mySessionId, settings);
        return;
      }
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
      this.emit({ type: "status", status: "idle" });
    });
  }

  /**
   * Starts the ping/pong heartbeat for one connection. `isAlive` is set true on
   * open and on every pong; each interval tick terminates the socket if no pong
   * arrived since the last ping, then sends a fresh ping. The session-id /
   * socket-identity guard stops a stale interval from terminating a newer
   * connection (lesson #4850).
   */
  private startHeartbeat(connection: WebSocket, mySessionId: number): void {
    this.clearHeartbeat();
    this.isAlive = true;
    this.heartbeatInterval = setInterval(() => {
      if (this.sessionId !== mySessionId || this.connection !== connection) {
        this.clearHeartbeat();
        return;
      }
      if (!this.isAlive) {
        logWarn(`${P} Heartbeat: no pong, terminating half-open connection`);
        try {
          connection.terminate();
        } catch {
          // Ignore terminate errors — the close handler drives reconnect.
        }
        return;
      }
      this.isAlive = false;
      try {
        connection.ping();
      } catch (err) {
        logWarn(`${P} Heartbeat ping failed`, { message: formatErrorMessage(err, "ping failed") });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Schedules the next reconnect attempt with exponential backoff + full jitter.
   * Gives up (fatal error) once RECONNECT_MAX_ATTEMPTS is reached. The timer
   * callback re-checks the session id so a `stop()`/new `start()` between
   * scheduling and firing cancels it (lessons #4850/#4851).
   */
  private scheduleReconnect(mySessionId: number, settings: VoiceInputSettings): void {
    if (this.sessionId !== mySessionId) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      logError(`${P} Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts — giving up`);
      this.isReconnecting = false;
      this.handleFatalError(mySessionId, "Connection lost — reconnect failed");
      return;
    }

    this.isReconnecting = true;
    const ceiling = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_INITIAL_MS * RECONNECT_MULTIPLIER ** this.reconnectAttempt
    );
    const delay = Math.random() * ceiling;
    this.reconnectAttempt++;
    logInfo(`${P} Scheduling reconnect`, {
      attempt: this.reconnectAttempt,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
      delayMs: Math.round(delay),
    });
    this.emit({ type: "status", status: "reconnecting" });

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.sessionId !== mySessionId) return;
      this.reconnectOnce(mySessionId, settings);
    }, delay);
  }

  /**
   * Tears down the dead connection (without touching the session id, reconnect
   * counter, or buffered audio) and opens a fresh one. Audio captured during
   * the reconnect window stays in `preConnectBuffer` and is flushed once the new
   * connection reaches `session.updated`.
   */
  private reconnectOnce(mySessionId: number, settings: VoiceInputSettings): void {
    if (this.sessionId !== mySessionId) return;
    logInfo(`${P} Reconnecting`, { attempt: this.reconnectAttempt });
    this.cleanupConnection();
    this.connect(mySessionId, settings);
  }

  private handleFatalError(mySessionId: number, message: string): void {
    logError(`${P} Fatal error — tearing down session`, { message });
    // Mark the close as expected so the trailing `close` event (after the
    // socket tears down) isn't treated as a recoverable drop.
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.clearReconnectTimer();
    this.cleanupConnection();
    this.emit({ type: "error", message });
    this.emit({ type: "status", status: "error" });
    this.settlePendingStart(mySessionId, { ok: false, error: message });
    this.settleDrain("fatal-error");
  }

  private handleServerEvent(
    mySessionId: number,
    type: string,
    payload: Record<string, unknown>
  ): void {
    switch (type) {
      case "session.created":
        logInfo(`${P} ← session.created`, { session: payload.session });
        return;

      case "session.updated":
        this.clearConnectTimeout();
        // Log the session config the server actually applied — this is ground
        // truth for whether `turn_detection`, model, and format took effect.
        logInfo(`${P} ← session.updated — session ready`, { session: payload.session });
        if (this.preConnectBuffer.length > 0 && this.connection) {
          logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`);
          for (const chunk of this.preConnectBuffer) {
            this.sendAudioJson(chunk);
          }
          this.preConnectBuffer = [];
          this.preConnectBufferBytes = 0;
        }
        // A successful (re)connection clears the reconnect state so a later drop
        // gets a fresh full backoff budget.
        this.reconnectAttempt = 0;
        this.isReconnecting = false;
        this.isReady = true;
        this.startCommitTimer();
        this.emit({ type: "status", status: "recording" });
        this.settlePendingStart(mySessionId, { ok: true });
        return;

      case "input_audio_buffer.committed":
        // Server ack that our commit landed. A transcription item
        // (`conversation.item.added` then `.done`) should follow within ~1s; if
        // it never does, the session config or the commit cadence is wrong.
        logDebug(`${P} ← input_audio_buffer.committed`, {
          itemId: typeof payload.item_id === "string" ? payload.item_id : undefined,
        });
        return;

      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
        // VAD signals — not expected for gpt-realtime-whisper (no turn
        // detection), but log them if they appear; their presence would mean
        // the server applied a VAD default we didn't ask for.
        logInfo(`${P} ← ${type}`, { payload });
        return;

      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        // Length only — dictated text is user content, kept out of logs.
        logDebug(`${P} ← transcription.delta`, { length: delta.length });
        if (!delta) return;
        this.emit({ type: "delta", text: delta });
        this.liveText += delta;
        return;
      }

      case "conversation.item.input_audio_transcription.completed": {
        // Side-channel transcription event used by conversation-style sessions.
        // The `?intent=transcription` endpoint reports completions via
        // `conversation.item.done` instead (handled below) — this case stays so
        // a session that does emit it still works.
        const transcript = typeof payload.transcript === "string" ? payload.transcript : "";
        const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
        logInfo(`${P} ← transcription.completed`, { itemId, length: transcript.length });
        this.handleTranscriptComplete(transcript, itemId);
        return;
      }

      case "conversation.item.added": {
        // The `?intent=transcription` endpoint creates the item shell here on
        // commit; the transcript arrives with `conversation.item.done`.
        const item = payload.item as
          | { id?: string; content?: Array<{ type?: string; transcript?: string }> }
          | undefined;
        logDebug(`${P} ← conversation.item.added`, {
          itemId: item?.id,
          contentTypes: item?.content?.map((part) => part.type),
        });
        return;
      }

      case "conversation.item.done": {
        // The `?intent=transcription` endpoint reports each committed segment's
        // final transcript via `conversation.item.done`, not via
        // `...input_audio_transcription.completed`. The text lives on the
        // item's `input_audio` content part.
        const item = payload.item as
          | { id?: string; content?: Array<{ type?: string; transcript?: string }> }
          | undefined;
        const audioPart = item?.content?.find((part) => part.type === "input_audio");
        const transcript = audioPart?.transcript ?? "";
        // Length only — dictated text is user content, kept out of logs.
        logInfo(`${P} ← conversation.item.done`, {
          itemId: item?.id,
          hasInputAudioPart: !!audioPart,
          length: transcript.length,
        });
        if (!audioPart) {
          // Not a transcription segment — don't count it against an
          // outstanding commit, or a stray `done` could settle the drain early.
          logWarn(`${P} conversation.item.done carried no input_audio content part — not counted`, {
            contentTypes: item?.content?.map((part) => part.type),
          });
          return;
        }
        this.handleTranscriptComplete(transcript, item?.id);
        return;
      }

      case "error": {
        const errorPayload = payload.error as
          | { message?: string; type?: string; code?: string; param?: string }
          | undefined;
        const message = errorPayload?.message ?? "OpenAI realtime error";
        logError(`${P} ← server error event`, {
          message,
          type: errorPayload?.type,
          code: errorPayload?.code,
          param: errorPayload?.param,
        });
        this.handleFatalError(mySessionId, message);
        return;
      }

      default:
        // Log the full payload (truncated) so an unrecognised event shape is
        // never invisible — this is how the conversation.item.done schema
        // mismatch was originally caught.
        logDebug(`${P} ← unhandled server event`, {
          type,
          payload: JSON.stringify(payload).slice(0, 600),
        });
    }
  }

  /**
   * Handles one committed segment's transcript: emits it to the renderer and
   * decrements the outstanding-commit counter. While draining, settles the
   * drain the moment every committed segment has reported back. Shared by the
   * `...input_audio_transcription.completed` and `conversation.item.done`
   * paths since both report a committed segment.
   *
   * `itemId` is deduped: a completion already counted (e.g. a `.completed` and
   * a `.done` for the same item, or a repeated frame) is ignored entirely, so
   * it can't drop `pendingCommits` below the number genuinely in flight and
   * settle the drain before the final transcript lands.
   */
  private handleTranscriptComplete(rawTranscript: string, itemId?: string): void {
    if (itemId && this.completedItemIds.has(itemId)) {
      logDebug(`${P} Duplicate completion for item ${itemId} — ignoring`);
      return;
    }
    if (itemId) {
      this.completedItemIds.add(itemId);
    }

    const transcript = rawTranscript.trim();
    this.liveText = "";
    if (this.pendingCommits > 0) {
      this.pendingCommits--;
    }
    if (transcript) {
      logDebug(`${P} Emitting complete transcript to renderer`, { length: transcript.length });
      this.emit({ type: "complete", text: transcript, confidence: { ...STUB_CONFIDENCE } });
    } else {
      logDebug(`${P} Completion had an empty transcript — nothing emitted`);
    }
    // Each commit yields exactly one completion. Once every committed segment
    // has reported back the drain is genuinely finished — no grace timer, no
    // guessing whether a late final-commit transcript is still in flight.
    if (this.isDraining && this.pendingCommits === 0) {
      logDebug(`${P} All committed segments transcribed — settling drain`);
      this.settleDrain("all-segments-transcribed");
    }
  }

  private sendAudioJson(chunk: ArrayBuffer): void {
    if (!this.connection) return;
    const audio = Buffer.from(chunk).toString("base64");
    this.connection.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    this.bytesSinceCommit += chunk.byteLength;
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      // Buffer while connecting (initial) or reconnecting (mid-session drop) so
      // audio captured during the gap is flushed once the session is ready.
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
      logDebug(`${P} Sending audio chunk #${this.audioChunkCount}`, {
        bytes: chunk.byteLength,
        bytesSinceCommit: this.bytesSinceCommit + chunk.byteLength,
      });
    }
    this.sendAudioJson(chunk);
  }

  /**
   * Appends a chunk to the pre-connect / reconnect buffer, enforcing both a
   * chunk-count cap and a byte cap. Oldest-wins: once either ceiling is hit the
   * chunk is dropped (warned once) — a voice gap past ~3s is unrecoverable
   * anyway, so there's no value in retaining unbounded audio.
   */
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

  /**
   * Tears down per-connection state without ending the session. Deliberately
   * does NOT touch `sessionId`, `reconnectAttempt`, `isReconnecting`,
   * `isExpectedClose`, or the pre-connect buffer — those survive across a
   * reconnect. Use `cleanupPreviousSession()` for a full session reset.
   */
  private cleanupConnection(): void {
    this.clearCommitTimer();
    this.clearHeartbeat();
    this.connection = null;
    this.isReady = false;
    this.isAlive = false;
    this.bytesSinceCommit = 0;
    this.pendingCommits = 0;
    this.completedItemIds.clear();
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
    this.bytesSinceCommit = 0;
    this.pendingCommits = 0;
    this.completedItemIds.clear();
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.clearConnectTimeout();
    this.clearDrainTimeout();
    this.clearCommitTimer();
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.isExpectedClose = false;
    this.isAlive = false;
    this.isDraining = false;
    this.liveText = "";
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

  private startCommitTimer(): void {
    this.clearCommitTimer();
    logDebug(`${P} Starting interval commit timer`, { intervalMs: COMMIT_INTERVAL_MS });
    this.commitTimer = setInterval(() => {
      this.maybeCommitSegment("interval");
    }, COMMIT_INTERVAL_MS);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer !== null) {
      clearInterval(this.commitTimer);
      this.commitTimer = null;
    }
  }

  /**
   * Sends `input_audio_buffer.commit` to close the current segment so the model
   * transcribes it and streams back delta/completed events. No-ops when there's
   * no live connection, the session isn't ready, we're already draining, or too
   * little audio has accumulated since the last commit (OpenAI rejects an
   * undersized buffer with a fatal error event).
   */
  private maybeCommitSegment(reason: string): void {
    if (!this.connection || !this.isReady || this.isDraining) {
      logDebug(`${P} Commit skipped — session not in a committable state`, {
        reason,
        hasConnection: !!this.connection,
        isReady: this.isReady,
        isDraining: this.isDraining,
      });
      return;
    }
    if (this.bytesSinceCommit < MIN_COMMIT_BYTES) {
      logDebug(`${P} Commit skipped — buffer below threshold`, {
        reason,
        bytesSinceCommit: this.bytesSinceCommit,
        thresholdBytes: MIN_COMMIT_BYTES,
      });
      return;
    }
    try {
      this.connection.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this.pendingCommits++;
      logDebug(`${P} → input_audio_buffer.commit`, {
        reason,
        bytes: this.bytesSinceCommit,
        chunksStreamed: this.audioChunkCount,
        pendingCommits: this.pendingCommits,
      });
      this.bytesSinceCommit = 0;
    } catch (err) {
      logWarn(`${P} Failed to commit audio segment`, {
        reason,
        message: formatErrorMessage(err, "commit failed"),
      });
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

    // A graceful stop is an expected close — cancel any pending reconnect and
    // stop the close handler from retrying.
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.clearReconnectTimer();

    if (!this.connection || !this.isReady) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isDraining = true;
    this.clearCommitTimer();
    this.emit({ type: "status", status: "finishing" });

    // Flush whatever audio accumulated since the last interval commit so its
    // transcript is included. If too little remains, OpenAI would reject the
    // commit as undersized — skip it; an interval commit's transcript may still
    // be in flight, and `pendingCommits` already accounts for it.
    if (this.bytesSinceCommit >= MIN_COMMIT_BYTES) {
      try {
        this.connection.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        this.pendingCommits++;
        logInfo(`${P} → input_audio_buffer.commit (final)`, {
          bytes: this.bytesSinceCommit,
          chunksStreamed: this.audioChunkCount,
          pendingCommits: this.pendingCommits,
        });
        this.bytesSinceCommit = 0;
      } catch {
        logWarn(`${P} Failed to send final commit, closing immediately`);
        this.cleanupPreviousSession();
        this.emit({ type: "status", status: "idle" });
        return;
      }
    } else {
      logInfo(`${P} Stop with sub-threshold buffer — no final commit`, {
        bytesSinceCommit: this.bytesSinceCommit,
        thresholdBytes: MIN_COMMIT_BYTES,
      });
    }

    const sessionIdBeforeDrain = this.sessionId;

    // Drain only while there are committed segments still awaiting their
    // `conversation.item.done`. If none are outstanding, the session is already
    // fully transcribed — close immediately rather than waiting on a timer.
    if (this.pendingCommits > 0) {
      logInfo(`${P} Draining — awaiting ${this.pendingCommits} transcription(s)`);
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
        this.drainTimeout = setTimeout(() => {
          logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`, {
            pendingCommits: this.pendingCommits,
          });
          this.settleDrain("timeout");
        }, DRAIN_TIMEOUT_MS);
      });
      await this.drainPromise;
    } else {
      logInfo(`${P} Nothing to drain — no outstanding transcriptions`);
      this.isDraining = false;
    }

    // If start() was called during drain it already ran cleanupPreviousSession()
    // and incremented sessionId — don't tear down the new session.
    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  stop(): void {
    logInfo(`${P} stop() called`, { sessionId: this.sessionId, hasConnection: !!this.connection });
    // Suppress any reconnect: this is a deliberate stop. The sessionId bump in
    // cleanupPreviousSession is the primary guard; the flag documents intent and
    // covers the brief window before the bump takes effect.
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.clearReconnectTimer();
    this.cleanupPreviousSession();
    this.emit({ type: "status", status: "idle" });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }
}
