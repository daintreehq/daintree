import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import WebSocket from "ws";
import type { VoiceInputError, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { logDebug, logInfo, logWarn, logError } from "../../utils/logger.js";
import {
  STUB_CONFIDENCE,
  type TranscriptionProvider,
  type VoiceStartResult,
  type VoiceTranscriptionEvent,
} from "./TranscriptionProvider.js";
import type { VadWorkerInbound, VadWorkerOutbound } from "./openaiVadWorkerProtocol.js";
import { formatKeytermPrompt, sanitizeOpenAIKeywords } from "../voiceContextKeyterms.js";

const P = "[VoiceTranscription:openai]";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the compiled VAD worker on disk. esbuild emits this provider into a
 * shared chunk under `dist-electron/electron/chunks/`, so `__dirname` may point
 * at that chunks dir — step up to the electron root, then to the worker's own
 * output path. Mirrors the host-process path resolution in
 * `WorkspaceHostProcess.ts`.
 */
function resolveVadWorkerPath(): string {
  const electronDir = path.basename(__dirname) === "chunks" ? path.dirname(__dirname) : __dirname;
  // From `dist-electron/electron/` down to the worker's bundled location.
  return path.join(electronDir, "services", "voice", "openaiVadWorker.js");
}

/**
 * Wire shape of `session.audio.input.transcription` for `gpt-live-transcribe`.
 *
 * Hand-typed on purpose: the installed `openai` SDK's `AudioTranscription` has
 * no `keywords` field and its `model` union predates `gpt-live-transcribe`, so
 * there is nothing to lean on. Declaring `language?: never` makes reintroducing
 * the deprecated singular field a compile error — `languages` and `language` are
 * mutually exclusive on the wire and must never both be sent.
 */
type OpenAITranscriptionDelay = "minimal" | "low" | "medium" | "high" | "xhigh";

interface OpenAITranscriptionConfig {
  model: string;
  languages: string[];
  delay: OpenAITranscriptionDelay;
  keywords?: string[];
  prompt?: string;
  language?: never;
}

// `gpt-live-transcribe` is a transcription model — it must be passed as
// `transcription.model`, NOT as the realtime session `model` query param.
// The session connects via `?intent=transcription` instead.
const OPENAI_REALTIME_URL =
  process.env.DAINTREE_REALTIME_WS_URL ?? "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
// How long the server buffers audio before emitting a partial
// `...transcription.delta`. Higher tiers cut word-error rate and partial
// "flapping" at the cost of how quickly interim text appears. We render those
// partials live as the user speaks, so a sluggish tier is directly felt —
// hence "low". This does NOT trade away final accuracy or add latency after our
// explicit `input_audio_buffer.commit`: the final `...completed` is transcribed
// from the whole frozen buffer regardless. It is therefore a different axis to
// VAD_MAX_SEGMENT_MS below (client-side segmentation), and the two do not fight.
const OPENAI_TRANSCRIPTION_DELAY: OpenAITranscriptionDelay = "low";
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
// We send `turn_detection: null`, so the server never auto-commits the input
// buffer. We drive segmentation ourselves with a client-side VAD side-chain
// (Silero v5, on a worker thread): commit at actual end-of-speech after a short
// holdover, and clear the server buffer on speech onset so accumulated silence
// between utterances isn't transcribed. This replaces the old blind 2s interval,
// which cut words mid-pause and added up to ~2s of latency at end-of-speech.
//
// Backstop: while speech runs continuously past this window with no detected
// pause, force a commit so the segment streams back and the server-side buffer
// stays bounded. Also the sole commit cadence in degraded mode (VAD init/worker
// failure), where we can't detect speech boundaries at all.
const VAD_MAX_SEGMENT_MS = 8_000;
// Recent audio retained to replay after an `input_audio_buffer.clear` on speech
// onset, so clearing the stale (silent) buffer doesn't also clip the start of
// the utterance the VAD just detected. ~300ms at 24kHz mono PCM16 (48 B/ms).
const VAD_PRE_ROLL_BYTES = 14_400;
// OpenAI rejects an `input_audio_buffer.commit` carrying under ~100ms of audio
// (24kHz mono PCM16 → 4800 bytes) with a fatal error event. Skip a commit
// below this threshold.
const MIN_COMMIT_BYTES = 4_800;

// OpenAI Realtime `error.code` values that are recoverable by reconnecting.
// All other codes (auth, content policy, schema violations) are fatal — a retry
// will fail the same way, so the user must intervene.
const TRANSIENT_OPENAI_CODES = new Set<string>(["rate_limit_exceeded", "server_error"]);

// WebSocket close codes that indicate a recoverable transport drop. The
// existing close handler already gates reconnect on `!isExpectedClose &&
// wasReady`; this set is used to classify the error emitted on giving up
// (and to decide reconnect-vs-fatal for the brand-new failure modes we now
// surface explicitly).
const TRANSIENT_CLOSE_CODES = new Set<number>([1006, 1011, 1012, 1013]);

/**
 * Reduces a server-echoed `session` object to the diagnostic fields worth
 * logging. Pure function — exported for unit testing.
 *
 * The echo replays the `prompt` and `keywords` we sent, which are built from the
 * user's branch names, project terms, custom dictionary and terminal output.
 * Main-process logs are readable by agents, so the contents must never be
 * logged — only their presence and size. Everything else here (model,
 * languages, delay, and above all whether `turn_detection` came back null) is
 * the ground truth for diagnosing a session that acks commits but transcribes
 * nothing.
 */
export function summarizeEchoedSession(session: unknown): Record<string, unknown> {
  if (typeof session !== "object" || session === null) return { session: "(absent)" };

  const input = (session as { audio?: { input?: unknown } }).audio?.input;
  if (typeof input !== "object" || input === null) return { sessionShape: "(no audio.input)" };

  const { transcription, turn_detection: turnDetection } = input as {
    transcription?: unknown;
    turn_detection?: unknown;
  };
  const t = (typeof transcription === "object" && transcription !== null ? transcription : {}) as {
    model?: unknown;
    languages?: unknown;
    delay?: unknown;
    keywords?: unknown;
    prompt?: unknown;
  };

  return {
    // Type-guarded rather than forwarded raw: an unexpected echo shape (an
    // object or a long string where a short scalar belongs) must not become a
    // channel for arbitrary content reaching the log.
    model: shortScalar(t.model),
    languages: Array.isArray(t.languages) ? t.languages.map(shortScalar) : shortScalar(t.languages),
    delay: shortScalar(t.delay),
    biasTermCount: Array.isArray(t.keywords) ? t.keywords.length : 0,
    hasPrompt: typeof t.prompt === "string" && t.prompt.length > 0,
    turnDetectionNull: turnDetection === null,
  };
}

/**
 * Renders an echoed config value as a short scalar for logging. Anything that
 * isn't a small string/number/boolean becomes a type marker, so a malformed or
 * oversized echo can't smuggle content into the log.
 */
function shortScalar(value: unknown): string | number | boolean {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length <= 64 ? value : `(string:${value.length})`;
  if (value === null || value === undefined) return "(unset)";
  return `(${Array.isArray(value) ? "array" : typeof value})`;
}

/**
 * Classifies an OpenAI Realtime `error` event payload into a structured
 * `VoiceInputError`. Pure function — exported for unit testing. The classifier
 * is conservative: anything not on the transient allowlist is treated as fatal
 * so the renderer surfaces a recovery action instead of silently retrying.
 */
export function classifyOpenAIError(payload: {
  message?: string;
  type?: string;
  code?: string;
  param?: string | null;
}): VoiceInputError {
  const code = payload.code ?? (payload.type === "server_error" ? "server_error" : "unknown_error");
  const severity: VoiceInputError["severity"] = TRANSIENT_OPENAI_CODES.has(code)
    ? "transient"
    : "fatal";
  return {
    severity,
    code,
    message: payload.message ?? "OpenAI realtime error",
    param: payload.param ?? null,
  };
}

/**
 * Classifies a WebSocket close code into a `VoiceInputError` severity. Used to
 * tag the error emitted when reconnect attempts exhaust, so the renderer can
 * distinguish "we tried, the network kept dropping" from "the server rejected
 * us outright".
 */
export function classifyCloseCode(code: number, reason?: string): VoiceInputError {
  const severity: VoiceInputError["severity"] = TRANSIENT_CLOSE_CODES.has(code)
    ? "transient"
    : "fatal";
  return {
    severity,
    code: `ws_close_${code}`,
    message: reason && reason.trim() ? reason : `Connection closed (code ${code})`,
  };
}

// We use the `ws` package rather than Node 22's global `WebSocket`. The
// WHATWG spec exposes only `(url, protocols?)` — its constructor silently
// discards any third options argument, so custom upgrade headers cannot be
// sent. The `ws` package accepts a 2-arg `(url, options)` form with full
// header support, which is also what the openai SDK uses internally.

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly hasServerVAD = false;

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
  // Last classified transport/server error that drove the current reconnect
  // cycle. Used when reconnect attempts exhaust so the fatal error surfaced to
  // the renderer carries the original failure context (e.g. `ws_close_1006`)
  // instead of a generic "reconnect failed" string.
  private lastReconnectError: VoiceInputError | null = null;
  // Set on graceful/fatal teardown so the trailing `close` event isn't mistaken
  // for an unexpected drop and doesn't trigger a reconnect.
  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;

  // VAD side-chain. The worker runs Silero v5 on a worker thread and reports
  // speech-start/speech-end events that drive commits. `vadWorkerSessionId`
  // tags the spawning session so a message arriving after teardown (or after a
  // new session started) is ignored — the stale-callback guard from #4850/#4851.
  private vadWorker: Worker | null = null;
  private isSpeaking = false;
  // True once the VAD has reported at least one speech-end this connection. The
  // barge-in clear on speech-start is gated on it: audio buffered after a
  // speech-end is confirmed silence and safe to drop, but audio buffered before
  // the first speech-end (e.g. captured before the worker finished loading) may
  // be real speech, so the first speech-start must not clear it.
  private vadHasEndedSpeech = false;
  // Set when the worker fails to initialize or crashes. In this mode the VAD
  // can't segment, so we fall back to a periodic backstop commit (no speech
  // gating) — dictation still works, just without speech-aware boundaries.
  private vadDegraded = false;
  // Backstop commit timer. While speaking (or always, in degraded mode) it
  // forces a commit every VAD_MAX_SEGMENT_MS so long utterances stream back and
  // the server buffer stays bounded.
  private maxSegmentTimer: ReturnType<typeof setInterval> | null = null;
  // Sliding window of the most recent audio chunks, replayed after a
  // speech-onset `input_audio_buffer.clear` so the utterance's onset survives.
  private preRollChunks: ArrayBuffer[] = [];
  private preRollBytes = 0;
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

  private emitError(error: VoiceInputError): void {
    this.emit({ type: "error", error });
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
    this.lastReconnectError = null;
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
        headers: buildOpenAIHeaders(
          settings.openaiApiKey,
          settings.organizationId,
          settings.projectId
        ),
      });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to open WebSocket");
      logError(`${P} ${message}`);
      if (this.isReconnecting) {
        this.scheduleReconnect(mySessionId, settings);
      } else {
        this.emitError({ severity: "fatal", code: "ws_construct_failed", message });
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
      // Expected teardown — the trailing `close` from connection.close() must
      // not override the "error" status below with "idle".
      this.isExpectedClose = true;
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
      this.cleanupConnection();
      this.emitError({
        severity: "fatal",
        code: "connection_timeout",
        message: "Connection timed out",
      });
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
      // Keyterm biasing, assembled at session start and frozen on the settings
      // snapshot, so a reconnect deterministically rebuilds the same fields.
      // `keywords` takes the literal terms; `prompt` carries the same terms as
      // bounded free-form context. Both derive from ONE sanitized list so a term
      // rejected from `keywords` can't sneak back in via `prompt`.
      const keywords = sanitizeOpenAIKeywords(settings.keyterms ?? []);
      const keytermPrompt = formatKeytermPrompt(keywords);
      // `languages` (array) supersedes the deprecated singular `language`. Never
      // send both. Our settings hold a single code, so this is a 1-element array.
      // Type-checked, not just nullish-checked: persisted settings are cast, not
      // validated, and the setter takes an arbitrary patch — a non-string here
      // would throw inside this `open` handler, outside any try/catch.
      const language = typeof settings.language === "string" ? settings.language.trim() : "";
      const languages = [language || "en"];
      // `turn_detection` MUST be explicitly `null`. It is not enough to omit it:
      // when absent the server applies a default VAD, and then silently produces
      // no transcription — it still acks `input_audio_buffer.committed` but
      // emits no `conversation.item.added` / `conversation.item.done`. With it
      // set to `null`, each manual commit yields a transcribed item. Whether
      // `gpt-live-transcribe` would accept a server-VAD block is unverified and
      // deliberately not attempted here: every documented example for this model
      // still shows `null`, and our client-side Silero side-chain is the tested
      // path. Revisit only as its own change, with the error response checked.
      const transcription: OpenAITranscriptionConfig = {
        model: OPENAI_TRANSCRIPTION_MODEL,
        languages,
        delay: OPENAI_TRANSCRIPTION_DELAY,
        // Omit rather than send `[]` / `""` when nothing survived sanitization.
        ...(keywords.length > 0 ? { keywords } : {}),
        ...(keytermPrompt ? { prompt: keytermPrompt } : {}),
      };
      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription,
              turn_detection: null,
            },
          },
        },
      };
      // Log the session SHAPE, never its contents — `keywords`/`prompt` carry
      // the user's branch names, project terms, custom dictionary and terminal
      // identifiers, and these logs are readable by agents. The fields below are
      // the ones that actually cause "commits acked but no transcription items"
      // regressions (especially the explicit `turn_detection: null`).
      // `biasTermCount`, not `keywordCount`: the logger redacts any key whose
      // name contains "key", which would blank the count and defeat the whole
      // diagnostic.
      logInfo(`${P} → session.update`, {
        model: transcription.model,
        languages: transcription.languages,
        delay: transcription.delay,
        biasTermCount: keywords.length,
        hasPrompt: keytermPrompt.length > 0,
        turnDetectionNull: sessionUpdate.session.audio.input.turn_detection === null,
      });
      try {
        connection.send(JSON.stringify(sessionUpdate));
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to send session.update");
        logError(`${P} ${message}`);
        this.handleFatalError(mySessionId, {
          severity: "fatal",
          code: "session_update_send_failed",
          message,
        });
      }
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
      this.clearConnectTimeout();
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      const message = formatErrorMessage(err, "WebSocket error");
      logError(`${P} WebSocket error`, { message });
      // A transport error on a ready (or reconnecting) session is recoverable —
      // `ws` always fires `close` right after `error`, and the close handler
      // owns the reconnect decision, so just log here. A pre-ready error
      // (auth/DNS/refused on the very first connect) is fatal: tear down now.
      if (!this.isReady && !this.isReconnecting) {
        this.handleFatalError(mySessionId, {
          severity: "fatal",
          code: "ws_transport_error",
          message,
        });
      }
    });

    connection.on("close", (code, reason) => {
      this.clearConnectTimeout();
      this.clearHeartbeat();
      // Ignore the close of a socket that's already been superseded or torn down
      // out-of-band (reconnect swap, or handleFatalError which terminates after
      // nulling this.connection) — that path has already emitted its status.
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      const wasReady = this.isReady;
      const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? "");
      logInfo(`${P} WebSocket closed`, {
        code,
        reason: reasonText,
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
      // Don't overwrite a pre-existing `lastReconnectError` (set by the
      // transient OpenAI server-error path before it terminated the socket) —
      // that's richer context than the synthetic 1006 from terminate().
      if (!this.isExpectedClose && (wasReady || this.isReconnecting)) {
        if (!this.lastReconnectError) {
          this.lastReconnectError = classifyCloseCode(
            typeof code === "number" ? code : 1006,
            reasonText
          );
        }
        this.scheduleReconnect(mySessionId, settings);
        return;
      }
      this.settlePendingStart(mySessionId, { ok: false, error: "Connection closed" });
      // A deliberate teardown (fatal error / connect timeout) already emitted its
      // terminal status ("error"); don't override it with "idle" here. Only an
      // unexpected close of a never-ready connection should fall through to idle.
      if (!this.isExpectedClose) {
        this.emit({ type: "status", status: "idle" });
      }
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
      const last = this.lastReconnectError;
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "reconnect_exhausted",
        message: last
          ? `Reconnect failed (${last.code}): ${last.message}`
          : "Connection lost — reconnect failed",
      });
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

  private handleFatalError(mySessionId: number, error: VoiceInputError): void {
    logError(`${P} Fatal error — tearing down session`, {
      code: error.code,
      message: error.message,
      severity: error.severity,
    });
    // Mark the close as expected so the trailing `close` event (after the
    // socket tears down) isn't treated as a recoverable drop.
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.lastReconnectError = null;
    this.clearReconnectTimer();
    // Close the physical socket — a server-sent fatal `error` event leaves the
    // connection open otherwise. Captured before cleanupConnection() nulls it.
    const conn = this.connection;
    this.cleanupConnection();
    if (conn) {
      try {
        conn.terminate();
      } catch {
        // Ignore terminate errors
      }
    }
    this.emitError(error);
    this.emit({ type: "status", status: "error" });
    this.settlePendingStart(mySessionId, { ok: false, error: error.message });
    this.settleDrain("fatal-error");
  }

  private handleServerEvent(
    mySessionId: number,
    type: string,
    payload: Record<string, unknown>
  ): void {
    switch (type) {
      case "session.created":
        logInfo(`${P} ← session.created`, summarizeEchoedSession(payload.session));
        return;

      case "session.updated":
        this.clearConnectTimeout();
        // Log the session config the server actually applied — this is ground
        // truth for whether `turn_detection`, model, and format took effect.
        // Summarized, not raw: the echo replays our `prompt`/`keywords`.
        logInfo(`${P} ← session.updated — session ready`, summarizeEchoedSession(payload.session));
        if (this.preConnectBuffer.length > 0 && this.connection) {
          logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`);
          // Detach the buffer before flushing so its state stays consistent even
          // if a send throws partway through the loop.
          const buffered = this.preConnectBuffer;
          this.preConnectBuffer = [];
          this.preConnectBufferBytes = 0;
          for (const chunk of buffered) {
            this.sendAudioJson(chunk);
          }
        }
        // A successful (re)connection clears the reconnect state so a later drop
        // gets a fresh full backoff budget.
        this.reconnectAttempt = 0;
        this.isReconnecting = false;
        this.lastReconnectError = null;
        this.isReady = true;
        this.startVadWorker(mySessionId);
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
        // VAD signals — not expected, since we send `turn_detection: null`, but
        // log them if they appear; their presence would mean the server applied
        // a VAD default we didn't ask for.
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
          { id?: string; content?: Array<{ type?: string; transcript?: string }> } | undefined;
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
          { id?: string; content?: Array<{ type?: string; transcript?: string }> } | undefined;
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
          { message?: string; type?: string; code?: string; param?: string | null } | undefined;
        const classified = classifyOpenAIError(errorPayload ?? {});
        logError(`${P} ← server error event`, {
          severity: classified.severity,
          code: classified.code,
          message: classified.message,
          param: classified.param,
          openaiType: errorPayload?.type,
        });
        // Transient server-side errors (rate_limit_exceeded, server_error) are
        // recoverable. Emit the classified error first so the renderer can show
        // "rate-limited, retrying" in the tooltip, then terminate the socket —
        // its trailing `close` fires the existing close handler, which schedules
        // a reconnect with the same backoff/jitter machinery used for transport
        // drops. Calling scheduleReconnect directly here would race the in-flight
        // close event and risk double-scheduling.
        if (classified.severity === "transient" && this.connection) {
          this.lastReconnectError = classified;
          this.emitError(classified);
          try {
            this.connection.terminate();
          } catch {
            // Ignore terminate errors — the close handler still drives reconnect.
          }
          return;
        }
        this.handleFatalError(mySessionId, classified);
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
    try {
      this.connection.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
    } catch (err) {
      // A send can throw if the socket transitioned to CLOSING mid-flush. Don't
      // let it escape the buffer-flush loop (which would leave the buffer in a
      // partially-cleared state) — the trailing `close` event drives reconnect.
      logWarn(`${P} Failed to send audio chunk`, {
        message: formatErrorMessage(err, "send failed"),
      });
      return;
    }
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
    // Feed the VAD side-chain so it can detect speech boundaries, and keep a
    // short pre-roll for onset replay after a speech-start clear. Audio streams
    // to OpenAI continuously regardless of speech state — the VAD only governs
    // when we commit and when we clear, so a VAD that under-detects can never
    // strand audio: the backstop and final commit still flush it.
    this.feedVad(chunk);
    this.pushPreRoll(chunk);
    this.sendAudioJson(chunk);
  }

  /**
   * Posts a chunk to the VAD worker. The chunk is copied (not transferred) so
   * the original ArrayBuffer stays usable for the OpenAI send on this thread.
   */
  private feedVad(chunk: ArrayBuffer): void {
    if (!this.vadWorker || this.vadDegraded) return;
    // Copy (not transfer) the original chunk — it's still needed for the OpenAI
    // send on this thread. The copy is transferred so the worker owns it.
    const copy = chunk.slice(0);
    try {
      this.vadWorker.postMessage({ type: "audio", pcm: copy } satisfies VadWorkerInbound, [copy]);
    } catch (err) {
      logWarn(`${P} Failed to post audio to VAD worker`, {
        message: formatErrorMessage(err, "vad post failed"),
      });
    }
  }

  /** Maintains the sliding pre-roll window, evicting oldest chunks by byte cap. */
  private pushPreRoll(chunk: ArrayBuffer): void {
    this.preRollChunks.push(chunk);
    this.preRollBytes += chunk.byteLength;
    while (this.preRollBytes > VAD_PRE_ROLL_BYTES && this.preRollChunks.length > 1) {
      const evicted = this.preRollChunks.shift();
      if (evicted) this.preRollBytes -= evicted.byteLength;
    }
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
    // Terminate the VAD worker with the connection — a reconnect re-spawns it
    // fresh on the next `session.updated`, so VAD state never straddles two
    // physical sockets.
    this.stopVadWorker();
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
    this.stopVadWorker();
    this.vadDegraded = false;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.lastReconnectError = null;
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

  /**
   * Spawns the VAD side-chain worker for the current session. Speech-boundary
   * events it reports drive `input_audio_buffer.commit`/`clear`. Every message
   * is guarded by `mySessionId` so a message arriving after this session was
   * torn down (or superseded by a new `start()`) is ignored (#4850/#4851). If
   * the worker can't be spawned or its model fails to load, we fall back to a
   * periodic backstop commit (degraded mode) so dictation still works.
   */
  private startVadWorker(mySessionId: number): void {
    this.stopVadWorker();
    this.isSpeaking = false;
    this.vadHasEndedSpeech = false;
    this.vadDegraded = false;
    this.preRollChunks = [];
    this.preRollBytes = 0;

    let worker: Worker;
    try {
      worker = new Worker(resolveVadWorkerPath());
    } catch (err) {
      logError(`${P} Failed to spawn VAD worker — degraded mode`, {
        message: formatErrorMessage(err, "worker spawn failed"),
      });
      this.enterDegradedMode(mySessionId);
      return;
    }
    this.vadWorker = worker;
    logDebug(`${P} VAD worker spawned`, { sessionId: mySessionId });

    worker.on("message", (message: VadWorkerOutbound) => {
      if (this.sessionId !== mySessionId || this.vadWorker !== worker) return;
      switch (message.type) {
        case "ready":
          logInfo(`${P} VAD worker ready`);
          return;
        case "speech-start":
          this.handleVadSpeechStart();
          return;
        case "speech-end":
          this.handleVadSpeechEnd();
          return;
        case "error":
          logError(`${P} VAD worker error — degraded mode`, { message: message.message });
          this.enterDegradedMode(mySessionId);
          return;
      }
    });

    worker.on("error", (err) => {
      if (this.sessionId !== mySessionId || this.vadWorker !== worker) return;
      logError(`${P} VAD worker thread error — degraded mode`, {
        message: formatErrorMessage(err, "worker error"),
      });
      this.enterDegradedMode(mySessionId);
    });

    worker.on("exit", (code) => {
      if (this.sessionId !== mySessionId || this.vadWorker !== worker) return;
      if (code !== 0) {
        logError(`${P} VAD worker exited unexpectedly — degraded mode`, { code });
        this.enterDegradedMode(mySessionId);
      }
    });
  }

  /**
   * Terminates the VAD worker and clears all VAD-derived state. Safe to call
   * when no worker is running. Does not touch `vadDegraded` so a degraded
   * session that's being torn down doesn't briefly re-arm speech gating.
   */
  private stopVadWorker(): void {
    this.clearBackstopTimer();
    this.isSpeaking = false;
    this.preRollChunks = [];
    this.preRollBytes = 0;
    const worker = this.vadWorker;
    this.vadWorker = null;
    if (worker) {
      worker.removeAllListeners();
      try {
        worker.postMessage({ type: "destroy" } satisfies VadWorkerInbound);
      } catch {
        // Worker may already be dead — terminate regardless.
      }
      void worker.terminate();
    }
  }

  /**
   * Falls back to a periodic backstop commit when the VAD is unavailable. We
   * can't detect speech boundaries, so we commit on a fixed cadence — the same
   * shape as the old behavior, but at the longer backstop interval rather than
   * the 2s blind timer.
   */
  private enterDegradedMode(mySessionId: number): void {
    if (this.sessionId !== mySessionId || this.vadDegraded) return;
    this.vadDegraded = true;
    this.isSpeaking = false;
    const worker = this.vadWorker;
    this.vadWorker = null;
    if (worker) {
      worker.removeAllListeners();
      void worker.terminate();
    }
    logWarn(`${P} VAD degraded — committing on ${VAD_MAX_SEGMENT_MS}ms backstop only`);
    this.startBackstopTimer("vad-degraded-backstop");
  }

  private handleVadSpeechStart(): void {
    if (this.isSpeaking) return;
    this.isSpeaking = true;
    this.startBackstopTimer("vad-speech");
    logDebug(`${P} VAD speech-start`, { preRollBytes: this.preRollBytes });

    // Barge-in clear: drop the silence the server buffered between the last
    // commit and now so it isn't transcribed, then replay our short pre-roll so
    // the onset of this utterance — already streamed before the clear —
    // survives. Only safe AFTER a speech-end: the audio buffered since a
    // speech-end commit is VAD-confirmed silence. The first speech-start of a
    // (re)connection has no such guarantee — audio streamed before the worker
    // was ready could be real speech — so we leave the buffer intact.
    if (!this.vadHasEndedSpeech || !this.connection || !this.isReady || this.isDraining) {
      return;
    }
    try {
      this.connection.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    } catch (err) {
      logWarn(`${P} Failed to clear buffer on speech-start`, {
        message: formatErrorMessage(err, "clear failed"),
      });
      // The server buffer was NOT cleared — replaying the pre-roll would
      // duplicate those bytes. Bail; the socket is likely dropping anyway.
      return;
    }
    this.bytesSinceCommit = 0;
    for (const chunk of this.preRollChunks) {
      this.sendAudioJson(chunk);
    }
  }

  private handleVadSpeechEnd(): void {
    if (!this.isSpeaking) return;
    this.isSpeaking = false;
    this.vadHasEndedSpeech = true;
    this.clearBackstopTimer();
    logDebug(`${P} VAD speech-end — committing segment`);
    this.maybeCommitSegment("vad-end-of-speech");
  }

  private startBackstopTimer(reason: string): void {
    this.clearBackstopTimer();
    this.maxSegmentTimer = setInterval(() => {
      this.maybeCommitSegment(reason);
    }, VAD_MAX_SEGMENT_MS);
  }

  private clearBackstopTimer(): void {
    if (this.maxSegmentTimer !== null) {
      clearInterval(this.maxSegmentTimer);
      this.maxSegmentTimer = null;
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
    this.stopVadWorker();
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
