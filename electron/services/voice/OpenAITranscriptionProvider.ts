import WebSocket from "ws";
import type { VoiceInputError, VoiceInputSettings } from "../../../shared/types/ipc/api.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { buildOpenAIHeaders } from "../../../shared/utils/openaiHeaders.js";
import { logDebug, logInfo, logWarn, logError } from "../../utils/logger.js";
import type { VoiceDelayTier } from "../../../shared/types/voiceSessionSummary.js";
import { voiceErrorLogFields, voicePayloadShape } from "../../../shared/utils/voiceLogFields.js";
import {
  AUDIO_BUFFER_MAX_BYTES,
  AUDIO_BUFFER_MAX_CHUNKS,
  createAudioBufferOverflowError,
  createTranscriptionItemFailedError,
  isRetryableHttpStatus,
  type ProviderSessionStats,
  type TranscriptionProvider,
  type TranscriptionStartContext,
  type VoiceStartResult,
  type VoiceTranscriptionEvent,
} from "./TranscriptionProvider.js";
import type { VadWorkerOutbound } from "./openaiVadWorkerProtocol.js";
import { OpenAIVadProcess, type VadRetireReason } from "./openaiVadProcess.js";
import {
  formatKeytermPrompt,
  MAX_PROMPT_CHARS,
  sanitizeOpenAIKeywords,
} from "../voiceContextKeyterms.js";
import {
  normalizeVoiceLanguage,
  VOICE_LANGUAGE_AUTO,
  VOICE_LANGUAGES,
  voiceLanguageName,
} from "../../../shared/config/voiceLanguages.js";

const P = "[VoiceTranscription:openai]";

/**
 * Wire shape of `session.audio.input.transcription` for `gpt-live-transcribe`.
 *
 * Hand-typed on purpose: the installed `openai` SDK's `AudioTranscription` has
 * no `keywords` field and its `model` union predates `gpt-live-transcribe`, so
 * there is nothing to lean on. Declaring `language?: never` makes reintroducing
 * the deprecated singular field a compile error — `languages` and `language` are
 * mutually exclusive on the wire and must never both be sent.
 */
interface OpenAITranscriptionConfig {
  model: string;
  languages?: string[];
  delay: VoiceDelayTier;
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
const OPENAI_TRANSCRIPTION_DELAY: VoiceDelayTier = "low";
const CONNECT_TIMEOUT_MS = 10_000;
// Backstop for the drain: if a committed segment never reports a terminal
// result (server error, dropped frame, or only an empty `conversation.item.done`),
// force-close after this long rather than hanging the stop.
const DRAIN_TIMEOUT_MS = 3_000;
// How long a graceful stop that lands before `session.updated` waits for the
// session to become ready so the buffered audio can still be transcribed.
// Connecting normally takes ~1.5-2s; past this the audio is discarded.
const STOP_CONNECT_TIMEOUT_MS = 3_000;
// How long a completed segment may wait behind an earlier one that hasn't
// reported back before the earlier one is settled with its interim text, so a
// lost or failed transcription can't hold later dictation back indefinitely.
const HELD_COMPLETION_TIMEOUT_MS = 5_000;
// Client-side ping/pong heartbeat. The OpenAI Realtime server sends its own
// pings (auto-ponged by `ws`), but a half-open TCP connection on our side —
// server alive, our socket silently dead — is only detectable by us pinging
// and watching for the pong. On a missed pong we `terminate()` (no closing
// handshake on a dead socket) which fires `close` and drives the reconnect.
//
// The check runs every HEARTBEAT_TICK_MS. Idle, it pings every
// HEARTBEAT_IDLE_MS and allows as long for the answer. Once audio has gone out
// since the server was last heard from, a dead socket is swallowing speech, so
// it pings at once and allows HEARTBEAT_ACTIVE_MS: a drop is noticed in
// seconds rather than 20-40s. Any frame from the server counts as an answer.
//
// The answer can't come before the server has received everything queued
// ahead of the ping, which after a reconnect can be seconds of flushed audio
// on a slow uplink. A pong proves delivery of everything sent before its ping,
// so each ping also gets the bytes not yet proven delivered at
// HEARTBEAT_FLOOR_BYTES_PER_MS: the audio stream's own wire rate (4,800 PCM
// bytes per 100ms, base64 in JSON), since an uplink slower than that can't
// carry dictation anyway.
const HEARTBEAT_TICK_MS = 2_000;
const HEARTBEAT_IDLE_MS = 20_000;
const HEARTBEAT_ACTIVE_MS = 3_000;
const HEARTBEAT_FLOOR_BYTES_PER_MS = 64;
// Reconnect after an unexpected mid-session drop: retry with backoff until
// RECONNECT_WINDOW_MS has passed since the drop, then give up. A time window
// rather than an attempt count, because an attempt made while the network is
// still down fails in milliseconds and would burn a count before a wifi blip
// or a VPN flip is over. Equal jitter:
// delay = ceiling/2 + random() * ceiling/2, ceiling = min(CAP, INITIAL * 2^attempt).
const RECONNECT_WINDOW_MS = 30_000;
const RECONNECT_INITIAL_MS = 250;
const RECONNECT_CAP_MS = 3_000;
// The last attempt in the window still gets this long to become ready, which
// takes a `session.updated` round trip on top of the socket opening.
const RECONNECT_MIN_CONNECT_MS = 3_000;
// 24kHz mono PCM16.
const AUDIO_BYTES_PER_SECOND = 48_000;
// Audio captured while reconnecting is held for the whole window, so a long
// blip is transcribed late rather than lost. Start-up keeps the shared cap.
const RECONNECT_BUFFER_MAX_BYTES =
  ((RECONNECT_WINDOW_MS + RECONNECT_MIN_CONNECT_MS) / 1_000) * AUDIO_BYTES_PER_SECOND;
const RECONNECT_BUFFER_MAX_CHUNKS = 400;
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
// The commit reason of a segment the VAD closed at a pause.
const VAD_PAUSE_COMMIT = "vad-end-of-speech";
// Recent audio retained to replay after an `input_audio_buffer.clear` on speech
// onset, so clearing the stale (silent) buffer doesn't also clip the start of
// the utterance the VAD just detected. ~300ms at 24kHz mono PCM16 (48 B/ms).
const VAD_PRE_ROLL_BYTES = 14_400;
// OpenAI rejects an `input_audio_buffer.commit` carrying under ~100ms of audio
// (24kHz mono PCM16 → 4800 bytes) with a fatal error event. Skip a commit
// below this threshold.
const MIN_COMMIT_BYTES = 4_800;
// Audio sent since the server last acknowledged a commit is replayed onto the
// next connection after a drop. Speech keeps it short (the 8s backstop, plus a
// few seconds to notice a dead socket), so the cap only bites on a long silent
// tail, where the oldest audio goes first. It has to hold a whole reconnect
// flush on top of that, so a second drop during the flush still resends it all.
const REPLAY_MAX_BYTES = RECONNECT_BUFFER_MAX_BYTES + 20 * AUDIO_BYTES_PER_SECOND;
// A tail the VAD already called silence is cut to its last 2s before replay,
// so a reconnect doesn't send (and pay to transcribe) minutes of room noise.
// 2s is far past the VAD's lag behind live audio, so an onset it hasn't
// reported yet still survives.
const REPLAY_SILENCE_KEEP_BYTES = 96_000;

// OpenAI sends this, then closes with 1001, once a session reaches its maximum
// duration (60 minutes). A new session carries on where it left off.
const SESSION_EXPIRED_CODE = "session_expired";

// OpenAI Realtime `error.code` values that are recoverable by reconnecting.
// All other codes (auth, content policy, schema violations) are fatal — a retry
// will fail the same way, so the user must intervene.
const TRANSIENT_OPENAI_CODES = new Set<string>([
  "rate_limit_exceeded",
  "server_error",
  SESSION_EXPIRED_CODE,
]);

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
    // Bounded before mapping: we only ever send one language, so a large echoed
    // array is malformed and must not drive unbounded work here.
    languages: Array.isArray(t.languages)
      ? t.languages.slice(0, MAX_LOGGED_LANGUAGES).map(shortScalar)
      : shortScalar(t.languages),
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
const MAX_LOGGED_LANGUAGES = 8;

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
  // The dictation session this provider was started for, minted by the
  // renderer. Diagnostics only: `sessionId` above guards reconnects.
  private voiceSessionId = "";
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<(event: VoiceTranscriptionEvent) => void> = new Set();
  private pendingStart: { sessionId: number; resolve: (result: VoiceStartResult) => void } | null =
    null;

  private preConnectBuffer: ArrayBuffer[] = [];
  private preConnectBufferBytes = 0;
  // Commits asked for while the audio was still held (a VAD speech-end, the
  // backstop, a paragraph boundary), as chunk counts into `preConnectBuffer`.
  // The flush sends a commit after each, so speech the VAD segmented while the
  // socket connected keeps its boundaries, pauses included.
  private heldCommits: Array<{ at: number; atPause: boolean }> = [];
  private isReady = false;

  // Bias terms for `session.update`, frozen for the session so a reconnect
  // sends the same fields. Null while the start's assembly is still running:
  // the socket opens without waiting for them, and an open socket parks its
  // update in `sendSessionUpdateOnKeyterms` until they land.
  private keyterms: string[] | null = null;
  private sendSessionUpdateOnKeyterms: (() => void) | null = null;

  // Start-path timings on the main-process clock, so a log can show whether
  // lost opening words sat behind the socket, the handshake, or the model.
  private sessionStartedAt = 0;
  private connectStartedAt = 0;
  private firstTranscriptLogged = false;

  // Heartbeat (half-open detection) for the current connection. Times are
  // tick multiples (`heartbeatTick * HEARTBEAT_TICK_MS`), exact for a ping
  // since pings only go out on a tick. `heartbeatPing` is the ping being judged,
  // null once answered; `heartbeatPingMarks` holds `heartbeatBytesSent` at each
  // unanswered ping, oldest first, and a pong moves `heartbeatDeliveredBytes`
  // up to the oldest. `audioSentSinceHeard` makes an unanswered ping urgent.
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTick = 0;
  private heartbeatLastHeardMs = 0;
  private heartbeatPing: { sentMs: number; backlogBytes: number } | null = null;
  private heartbeatPingMarks: number[] = [];
  private heartbeatBytesSent = 0;
  private heartbeatDeliveredBytes = 0;
  private audioSentSinceHeard = false;

  // Reconnect state. `reconnectAttempt`, `isReconnecting` and the deadline
  // survive across individual connection teardowns (cleanupConnection) and are
  // only reset by cleanupPreviousSession (a full session reset), a fatal error
  // or a successful reconnect.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private isReconnecting = false;
  // When recovery from the current drop gives up, on the performance clock.
  private reconnectDeadlineAt: number | null = null;
  // Why the current connection failed (its transport error, connect timeout,
  // or a transient server error), preferred over the bare close code after it.
  private connectionError: VoiceInputError | null = null;
  // The most recent failure this reconnect cycle, carried into the fatal error
  // when the window runs out so the renderer sees why (e.g. a DNS failure)
  // instead of a generic "reconnect failed" string.
  private lastReconnectError: VoiceInputError | null = null;
  // Set on graceful/fatal teardown so the trailing `close` event isn't mistaken
  // for an unexpected drop and doesn't trigger a reconnect.
  private isExpectedClose = false;

  private drainResolve: (() => void) | null = null;
  private drainTimeout: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private isDraining = false;
  // A graceful stop arrived before the session was ready; the drain is waiting
  // on `session.updated` to flush and commit the buffered audio (#13108).
  private stopPendingReady = false;

  // VAD side-chain. A utility process runs Silero v5 and reports
  // speech-start/speech-end events that drive commits. Its handlers are tagged
  // with the spawning session so a message arriving after teardown (or after a
  // new session started) is ignored — the stale-callback guard from #4850/#4851.
  private vadWorker: OpenAIVadProcess | null = null;
  // The model has loaded. Diagnostics only: audio posted before then queues
  // in the process behind the load.
  private vadReady = false;
  private isSpeaking = false;
  // True once the VAD has reported a speech-end on a ready connection. The
  // barge-in clear on speech-start is gated on it: audio buffered after a
  // speech-end is confirmed silence and safe to drop, but audio buffered before
  // the first one may be real speech, so the first speech-start must not clear
  // it. A speech-end heard while the socket connected only marks a held commit,
  // so it doesn't count: nothing yet proves that commit was sent.
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
  // Replay ledger: every chunk handed to the socket whose transcript hasn't
  // landed, kept even when the send threw, since `ws` drops sends on a closing
  // socket without one. `replaySegments` are commits sent, oldest first, each
  // tagged with its item once the server acknowledges it; `replayTail` is
  // audio since the last commit. It survives a drop and is resent, segment
  // boundaries and all, when the next connection is ready. A segment is
  // released when its item's transcript is emitted, so an acknowledged commit
  // the drop cut off before its transcript is transcribed again rather than
  // settled with a preview that lags the speech. `replayEvictedSegments` counts
  // unacknowledged segments the byte cap dropped whole, so their acks don't
  // tag the wrong segment.
  private replaySegments: Array<{
    chunks: ArrayBuffer[];
    bytes: number;
    atPause: boolean;
    itemId?: string;
  }> = [];
  // Whether each commit awaiting its ack on this connection closed a segment
  // at a pause the VAD heard, oldest first, and the acknowledged items that
  // did. A pause ends what was said even when the speaker goes on before its
  // transcript lands; a backstop commit cuts mid-speech.
  private commitPauses: boolean[] = [];
  private pauseItemIds = new Set<string>();
  private replayTail: ArrayBuffer[] = [];
  private replayTailBytes = 0;
  private replayBytes = 0;
  private replayEvictedSegments = 0;
  private replayOverflowWarned = false;
  // Commits sent (interval, paragraph-boundary, or final) whose terminal result
  // we haven't seen yet — a `...transcription.completed`/`.failed`, or a
  // `conversation.item.done` that actually carries text. Each commit yields
  // exactly one, so the drain is finished precisely when this hits zero — no
  // timing heuristic needed.
  private pendingCommits = 0;
  // Item ids already counted toward `pendingCommits` — guards against a
  // completion being counted twice (e.g. a `.completed` and a `.done` for the
  // same item).
  private completedItemIds = new Set<string>();
  // Item ids in the order the server acknowledged their commits. Transcription
  // runs per item, so completions can arrive out of commit order; a completion
  // whose predecessors are still in flight waits in `heldCompletions` and is
  // released in commit order, so the renderer can append each final transcript
  // to the draft without tracking per-segment offsets.
  private commitOrder: string[] = [];
  private heldCompletions = new Map<string, string>();
  // Interim text per in-flight item, used to settle an item that never reports
  // back in its commit-order slot rather than after the text that follows it.
  private itemDeltaText = new Map<string, string>();
  // Items the server reported failed: settled with interim text, which is no
  // proof the speaker finished, so they never count as end of speech.
  private failedItemIds = new Set<string>();
  private heldCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  // The item the hold timer is waiting on. The deadline belongs to that item,
  // so later completions queuing behind it don't keep pushing it back.
  private heldCompletionTimerItemId: string | null = null;
  // Items that finished before their commit was acknowledged. Their text has
  // landed, so the ack, when it comes, releases their audio.
  private completedBeforeAck = new Set<string>();
  // A dropped connection's items whose audio the replay resends, oldest first,
  // each with the text it would settle with. Their previews stay up until the
  // replay goes out and retires them; from then the text is only a fallback,
  // dropped once the new connection transcribes anything, for a session that
  // ends before it does.
  private replayItems: Array<{ itemId: string; text: string; retired: boolean }> = [];

  /** Cumulative delta text since the last complete event — used for incremental diffs. */
  private liveText = "";

  private audioChunkCount = 0;
  private staleChunkWarned = false;
  // Session-summary counts. They outlive the drain's cleanup and reset only
  // when the next session starts.
  private droppedConnectChunks = 0;
  private droppedReplayChunks = 0;
  private reconnectCount = 0;
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

  private sinceStartMs(): number {
    return Math.round(performance.now() - this.sessionStartedAt);
  }

  async start(
    settings: VoiceInputSettings,
    voiceSessionId: string,
    context?: TranscriptionStartContext
  ): Promise<VoiceStartResult> {
    if (!settings.openaiApiKey) {
      logWarn(`${P} No OpenAI API key configured`);
      return { ok: false, error: "OpenAI API key not configured" };
    }

    const mySessionId = this.sessionId + 1;
    logInfo(`${P} Starting session ${mySessionId}`, {
      voiceSessionId,
      language: settings.language,
      hasDictionary: settings.dictionary.length > 0,
    });
    this.cleanupPreviousSession();
    this.sessionId = mySessionId;
    this.voiceSessionId = voiceSessionId;
    this.sessionStartedAt = performance.now();
    this.firstTranscriptLogged = false;
    this.isReady = false;
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.heldCommits = [];
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.reconnectDeadlineAt = null;
    this.lastReconnectError = null;
    this.isExpectedClose = false;
    this.liveText = "";
    this.keyterms = context?.keyterms ? null : [...(settings.keyterms ?? [])];
    this.sendSessionUpdateOnKeyterms = null;
    this.droppedConnectChunks = 0;
    this.droppedReplayChunks = 0;
    this.reconnectCount = 0;

    this.emit({ type: "status", status: "connecting" });
    // The model loads while the socket connects, so the VAD is ready by the
    // time the session is, and hears the opening speech held meanwhile.
    this.startVadWorker(mySessionId);

    return new Promise((resolve) => {
      this.pendingStart = { sessionId: mySessionId, resolve };
      if (context?.keyterms) this.awaitKeyterms(mySessionId, context.keyterms);
      this.connect(mySessionId, settings);
    });
  }

  /** Freezes the session's bias terms once assembled, and sends a parked update. */
  private awaitKeyterms(mySessionId: number, pending: Promise<string[]>): void {
    const settle = (terms: string[]) => {
      if (this.sessionId !== mySessionId) return;
      this.keyterms = [...terms];
      const send = this.sendSessionUpdateOnKeyterms;
      this.sendSessionUpdateOnKeyterms = null;
      send?.();
    };
    pending.then(settle, () => settle([]));
  }

  /**
   * Opens the WebSocket and wires every event handler for one connection
   * attempt. Shared by `start()` (initial connect, with a pending start promise
   * to settle) and `reconnectOnce()` (mid-session reconnect, no pending start).
   * The reconnect path is distinguished purely by `this.isReconnecting`, so a
   * construct/timeout failure reschedules instead of surfacing a fatal error.
   */
  private connect(mySessionId: number, settings: VoiceInputSettings): void {
    this.connectStartedAt = performance.now();
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
      logError(`${P} Failed to open WebSocket`, undefined, voiceErrorLogFields(err));
      if (this.isDraining) {
        this.settleDrain("connect-failed");
      } else if (this.isReconnecting) {
        this.lastReconnectError = { severity: "transient", code: "ws_construct_failed", message };
        this.scheduleReconnect(mySessionId, settings);
      } else {
        this.stopVadWorker("connection-closed");
        this.emitError({ severity: "fatal", code: "ws_construct_failed", message });
        this.emit({ type: "status", status: "error" });
        this.settlePendingStart(mySessionId, { ok: false, error: message });
      }
      return;
    }

    this.connection = connection;
    this.connectionError = null;
    logInfo(`${P} Opening OpenAI realtime WebSocket`, {
      url: OPENAI_REALTIME_URL,
      model: OPENAI_TRANSCRIPTION_MODEL,
      language: normalizeVoiceLanguage(settings.language),
      customDictionaryTerms: settings.dictionary.length,
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
        // Force the dead socket closed; the `close` handler schedules the next
        // reconnect attempt (or gives up once the window has passed).
        this.connectionError = {
          severity: "transient",
          code: "connection_timeout",
          message: "Connection timed out",
        };
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
      this.settleDrain("connection-timeout");
    }, connectTimeoutMs);

    connection.on("pong", () => {
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.handlePong();
    });

    // A reconnect attempt the server refuses outright (a revoked key, a lost
    // permission) would be refused for the whole window, so only a rate limit
    // or server fault is retried. Registering this listener disables ws's own
    // abort, so the response is drained and the socket destroyed here. The
    // first connect keeps ws's default: an `error`, then a failed start.
    if (this.isReconnecting) {
      connection.on("unexpected-response", (req, res) => {
        try {
          res.resume();
          req.socket?.destroy();
        } catch {
          // Ignore teardown errors
        }
        if (this.sessionId !== mySessionId || this.connection !== connection) return;
        const statusCode = res.statusCode;
        const message = `OpenAI rejected the connection (HTTP ${statusCode ?? "unknown"})`;
        if (!isRetryableHttpStatus(statusCode)) {
          logError(`${P} Reconnect attempt rejected`, undefined, { statusCode });
          this.handleFatalError(mySessionId, { severity: "fatal", code: "ws_http_error", message });
          return;
        }
        logWarn(`${P} Reconnect attempt rejected — retrying`, { statusCode });
        this.lastReconnectError = { severity: "transient", code: "ws_http_error", message };
        // Detached first: nothing else will close this socket on our behalf.
        this.cleanupConnection();
        if (this.isDraining) {
          this.settleDrain("reconnect-failed");
          return;
        }
        this.scheduleReconnect(mySessionId, settings);
      });
    }

    // Open handler — same logic for initial connect and reconnect.
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
      this.startHeartbeat(connection, mySessionId);
      const openedAt = performance.now();
      logInfo(`${P} WebSocket opened`, {
        sessionId: mySessionId,
        voiceSessionId: this.voiceSessionId,
        connectMs: Math.round(openedAt - this.connectStartedAt),
        sinceStartMs: this.sinceStartMs(),
      });
      if (this.keyterms) {
        this.sendSessionUpdate(connection, mySessionId, settings, this.keyterms, openedAt);
        return;
      }
      // Still assembling. Whatever happens to this socket meanwhile, only the
      // one still current when they land sends its update.
      this.sendSessionUpdateOnKeyterms = () => {
        if (this.sessionId !== mySessionId || this.connection !== connection) return;
        this.sendSessionUpdate(connection, mySessionId, settings, this.keyterms ?? [], openedAt);
      };
    });

    connection.on("message", (data) => {
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.markHeard();
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
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.clearConnectTimeout();
      const message = formatErrorMessage(err, "WebSocket error");
      logError(`${P} WebSocket error`, undefined, voiceErrorLogFields(err));
      // A transport error on a ready (or reconnecting) session is recoverable —
      // `ws` always fires `close` right after `error`, and the close handler
      // owns the reconnect decision, so just keep the error as its reason. A
      // pre-ready error (auth/DNS/refused on the very first connect) is fatal:
      // tear down now.
      if (this.isReady || this.isReconnecting) {
        this.connectionError ??= { severity: "transient", code: "ws_transport_error", message };
      } else {
        this.handleFatalError(mySessionId, {
          severity: "fatal",
          code: "ws_transport_error",
          message,
        });
      }
    });

    connection.on("close", (code, reason) => {
      // Ignore the close of a socket that's already been superseded or torn down
      // out-of-band (reconnect swap, or handleFatalError which terminates after
      // nulling this.connection) — that path has already emitted its status and
      // cleared its timers. Checked before touching any timer: a gracefully
      // closed socket's close can land after its successor armed its own.
      if (this.sessionId !== mySessionId || this.connection !== connection) return;
      this.clearConnectTimeout();
      this.clearHeartbeat();
      const wasReady = this.isReady;
      const reasonText = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? "");
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
      // An unexpected drop of a ready session (or a failed reconnect attempt
      // while still mid-reconnect) is recoverable — schedule a retry instead of
      // ending the session. Graceful stops and fatal errors set isExpectedClose.
      // The connection's own failure is richer context than the synthetic 1006
      // from terminate().
      if (!this.isExpectedClose && (wasReady || this.isReconnecting)) {
        this.lastReconnectError =
          this.connectionError ??
          classifyCloseCode(typeof code === "number" ? code : 1006, reasonText);
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
   * Configures a freshly opened socket for transcription. The bias terms come
   * from the session's frozen list, so every connection of a session, a
   * reconnect included, sends the same fields.
   */
  private sendSessionUpdate(
    connection: WebSocket,
    mySessionId: number,
    settings: VoiceInputSettings,
    keyterms: string[],
    openedAt: number
  ): void {
    // `keywords` takes the literal terms; `prompt` carries the same terms as
    // bounded free-form context. Both derive from ONE sanitized list so a term
    // rejected from `keywords` can't sneak back in via `prompt`.
    const keywords = sanitizeOpenAIKeywords(keyterms);
    // `languages` (array) supersedes the deprecated singular `language`. Never
    // send both. Our settings hold a single code, so this is a 1-element array.
    // Type-checked, not just nullish-checked: persisted settings are cast, not
    // validated, and the setter takes an arbitrary patch — a non-string here
    // would throw inside the socket's `open` handler, outside any try/catch.
    const language = normalizeVoiceLanguage(settings.language);
    const autoLanguage = language === VOICE_LANGUAGE_AUTO;
    // `languages` is a bias hint, not a constraint, so a fixed language also
    // gets an explicit directive in the transcription prompt. Auto omits both.
    // Unknown (malformed) codes get no directive, which also keeps its length bounded.
    const languageDirective =
      autoLanguage || !VOICE_LANGUAGES.some((l) => l.code === language)
        ? ""
        : `Transcribe in ${voiceLanguageName(language)}. Do not translate.`;
    const keytermPrompt = formatKeytermPrompt(
      keywords,
      MAX_PROMPT_CHARS - (languageDirective ? languageDirective.length + 1 : 0)
    );
    const prompt = [languageDirective, keytermPrompt].filter(Boolean).join(" ");
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
      ...(autoLanguage ? {} : { languages: [language] }),
      delay: OPENAI_TRANSCRIPTION_DELAY,
      // Omit rather than send `[]` / `""` when nothing survived sanitization.
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(prompt ? { prompt } : {}),
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
    // diagnostic. `biasTermsWaitMs` is how long the open socket waited on
    // assembly, zero when the terms were there first.
    logInfo(`${P} → session.update`, {
      model: transcription.model,
      languages: transcription.languages,
      delay: transcription.delay,
      biasTermCount: keywords.length,
      biasTermsWaitMs: Math.round(performance.now() - openedAt),
      hasPrompt: prompt.length > 0,
      turnDetectionNull: sessionUpdate.session.audio.input.turn_detection === null,
    });
    try {
      connection.send(JSON.stringify(sessionUpdate));
      this.emit({ type: "terms_sent", terms: keywords });
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to send session.update");
      logError(`${P} Failed to send session.update`, undefined, voiceErrorLogFields(err));
      this.handleFatalError(mySessionId, {
        severity: "fatal",
        code: "session_update_send_failed",
        message,
      });
    }
  }

  /**
   * Starts the heartbeat for one connection. Each tick either judges the
   * outstanding ping against its deadline (send time, plus the allowance, plus
   * the time the bytes ahead of it need at the floor rate) or sends a new one
   * when audio has gone out unanswered or the idle interval is up. Deadlines
   * are fixed when the ping goes out, apart from audio shortening an idle
   * allowance to the active one, and checked only on later ticks, so they can
   * run late but never early. The session-id / socket-identity guard stops a
   * stale interval from terminating a newer connection (lesson #4850).
   */
  private startHeartbeat(connection: WebSocket, mySessionId: number): void {
    this.clearHeartbeat();
    this.heartbeatTick = 0;
    this.heartbeatLastHeardMs = 0;
    this.heartbeatPing = null;
    this.heartbeatPingMarks = [];
    this.heartbeatBytesSent = 0;
    this.heartbeatDeliveredBytes = 0;
    this.audioSentSinceHeard = false;
    this.heartbeatInterval = setInterval(() => {
      if (this.sessionId !== mySessionId || this.connection !== connection) {
        this.clearHeartbeat();
        return;
      }
      const nowMs = ++this.heartbeatTick * HEARTBEAT_TICK_MS;
      const ping = this.heartbeatPing;
      if (ping) {
        const allowanceMs = this.audioSentSinceHeard ? HEARTBEAT_ACTIVE_MS : HEARTBEAT_IDLE_MS;
        const deadlineMs =
          ping.sentMs + allowanceMs + ping.backlogBytes / HEARTBEAT_FLOOR_BYTES_PER_MS;
        if (nowMs < deadlineMs) return;
        logWarn(`${P} Heartbeat: no answer, terminating half-open connection`, {
          waitedMs: nowMs - ping.sentMs,
          backlogBytes: ping.backlogBytes,
          audioUnanswered: this.audioSentSinceHeard,
        });
        try {
          connection.terminate();
        } catch {
          // Ignore terminate errors — the close handler drives reconnect.
        }
        return;
      }
      if (!this.audioSentSinceHeard && nowMs - this.heartbeatLastHeardMs < HEARTBEAT_IDLE_MS) {
        return;
      }
      this.heartbeatPing = {
        sentMs: nowMs,
        backlogBytes: this.heartbeatBytesSent - this.heartbeatDeliveredBytes,
      };
      this.heartbeatPingMarks.push(this.heartbeatBytesSent);
      try {
        connection.ping();
      } catch (err) {
        logWarn(`${P} Heartbeat ping failed`, { ...voiceErrorLogFields(err) });
      }
    }, HEARTBEAT_TICK_MS);
  }

  /** A pong: everything sent before the oldest unanswered ping has arrived. */
  private handlePong(): void {
    const mark = this.heartbeatPingMarks.shift();
    if (mark !== undefined) {
      this.heartbeatDeliveredBytes = Math.max(this.heartbeatDeliveredBytes, mark);
    }
    this.markHeard();
  }

  /** Records that the current connection answered: a pong or any server frame. */
  private markHeard(): void {
    this.heartbeatLastHeardMs = this.heartbeatTick * HEARTBEAT_TICK_MS;
    this.heartbeatPing = null;
    this.audioSentSinceHeard = false;
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
   * Schedules the next reconnect attempt, or gives up with a fatal error once
   * the recovery window has passed. The timer callback re-checks the session
   * id so a `stop()`/new `start()` between scheduling and firing cancels it
   * (lessons #4850/#4851).
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
          ? `Reconnect failed (${last.code}): ${last.message}`
          : "Connection lost — reconnect failed",
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
    this.reconnectCount++;
    this.cleanupConnection();
    this.connect(mySessionId, settings);
  }

  private handleFatalError(mySessionId: number, error: VoiceInputError): void {
    logError(`${P} Fatal error — tearing down session`, undefined, {
      code: error.code,
      severity: error.severity,
    });
    // Mark the close as expected so the trailing `close` event (after the
    // socket tears down) isn't treated as a recoverable drop.
    this.isExpectedClose = true;
    this.isReconnecting = false;
    this.reconnectDeadlineAt = null;
    this.lastReconnectError = null;
    this.clearReconnectTimer();
    // Close the physical socket — a server-sent fatal `error` event leaves the
    // connection open otherwise. Captured before cleanupConnection() nulls it.
    const conn = this.connection;
    this.cleanupConnection();
    // Ahead of the error status, which ends the dictation before anything after it lands.
    this.releaseHeldCompletions(true);
    this.clearReplay();
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

      case "session.updated": {
        this.clearConnectTimeout();
        // Log the session config the server actually applied — this is ground
        // truth for whether `turn_detection`, model, and format took effect.
        // Summarized, not raw: the echo replays our `prompt`/`keywords`.
        logInfo(`${P} ← session.updated — session ready`, {
          ...summarizeEchoedSession(payload.session),
          sinceStartMs: this.sinceStartMs(),
          bufferedChunks: this.preConnectBuffer.length,
          vad: this.vadState(),
        });
        if (this.isReady) {
          // Everything below runs once per connection: a second flush would
          // resend the replayed audio onto the socket that already has it.
          logWarn(`${P} Ignoring a repeated session.updated on a ready connection`);
          return;
        }
        // Audio the dropped connection never transcribed goes first, then
        // whatever was captured while reconnecting.
        const recovering = this.isReconnecting;
        if (this.connection) {
          this.retireReplayedPreviews();
          this.replayUntranscribedAudio();
        }
        if ((this.preConnectBuffer.length > 0 || this.heldCommits.length > 0) && this.connection) {
          logInfo(`${P} Flushing ${this.preConnectBuffer.length} buffered audio chunks`, {
            heldCommits: this.heldCommits.length,
          });
          // Detach the buffer before flushing so its state stays consistent even
          // if a send throws partway through the loop.
          const buffered = this.preConnectBuffer;
          const commitsAfter = this.heldCommits;
          this.preConnectBuffer = [];
          this.preConnectBufferBytes = 0;
          this.heldCommits = [];
          let nextCommit = 0;
          // Asked for before anything new was held: it closes the replayed tail.
          const first = commitsAfter[0];
          if (first?.at === 0) {
            nextCommit++;
            this.commitHeldSegment(first.atPause);
          }
          for (let i = 0; i < buffered.length; i++) {
            this.sendAudioJson(buffered[i]);
            // Pre-roll follows what was sent, and each commit restarts it, so a
            // barge-in clear right after the flush replays the right audio.
            this.pushPreRoll(buffered[i]);
            const held = commitsAfter[nextCommit];
            if (held?.at === i + 1) {
              nextCommit++;
              this.commitHeldSegment(held.atPause);
            }
          }
        }
        // A successful (re)connection clears the reconnect state so a later drop
        // gets a full recovery window of its own.
        this.reconnectAttempt = 0;
        this.isReconnecting = false;
        this.reconnectDeadlineAt = null;
        this.lastReconnectError = null;
        this.isReady = true;
        if (this.isDraining) {
          // Stopped while connecting: the mic is already released, so skip the
          // VAD and "recording" — just commit what was flushed and drain.
          this.settlePendingStart(mySessionId, { ok: true });
          if (this.stopPendingReady) this.commitAfterLateReady();
          return;
        }
        // The first connection's VAD has been running since start(). A
        // reconnect's predecessor went with the dropped socket, and the new one
        // never hears the audio flushed above, so if the speech ended during the
        // outage nothing would commit it. A single backstop does, unless live
        // speech takes over the timer first.
        if (recovering) {
          this.startVadWorker(mySessionId);
          if (this.bytesSinceCommit >= MIN_COMMIT_BYTES && !this.vadDegraded) {
            this.startBackstopTimer("reconnect-recovery", { once: true });
          }
        }
        this.emit({ type: "status", status: "recording" });
        this.settlePendingStart(mySessionId, { ok: true });
        return;
      }

      case "input_audio_buffer.committed": {
        // Server ack that our commit landed. A transcription item
        // (`conversation.item.added` then `.done`) should follow within ~1s; if
        // it never does, the session config or the commit cadence is wrong.
        const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
        logDebug(`${P} ← input_audio_buffer.committed`, { itemId });
        if (!itemId) {
          this.commitPauses.shift();
          this.releaseAcknowledgedSegment();
          return;
        }
        if (this.completedBeforeAck.delete(itemId)) {
          this.commitPauses.shift();
          this.releaseAcknowledgedSegment();
          return;
        }
        // A repeated ack must not tag a second segment.
        if (!this.completedItemIds.has(itemId) && !this.commitOrder.includes(itemId)) {
          this.commitOrder.push(itemId);
          if (this.commitPauses.shift()) this.pauseItemIds.add(itemId);
          this.tagAcknowledgedSegment(itemId);
        }
        return;
      }

      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
        // VAD signals — not expected, since we send `turn_detection: null`, but
        // log them if they appear; their presence would mean the server applied
        // a VAD default we didn't ask for.
        logInfo(`${P} ← ${type}`);
        return;

      case "conversation.item.input_audio_transcription.delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
        // Length only — dictated text is user content, kept out of logs.
        logDebug(`${P} ← transcription.delta`, { itemId, length: delta.length });
        if (!delta) return;
        if (itemId) {
          // A delta for an item already finalized would resurrect its preview.
          if (this.completedItemIds.has(itemId)) return;
          this.itemDeltaText.set(itemId, (this.itemDeltaText.get(itemId) ?? "") + delta);
        }
        this.forgetRetiredReplayItems();
        this.emit({ type: "delta", text: delta, ...(itemId ? { itemId } : {}) });
        this.liveText += delta;
        return;
      }

      case "conversation.item.input_audio_transcription.completed": {
        // The authoritative final transcript for a committed item. The
        // `?intent=transcription` endpoint sends it after an empty
        // `conversation.item.done` for the same item, so it must count even
        // though a `done` was already seen. An empty transcript here is the
        // server's verdict of silence — still terminal, just nothing to emit.
        const transcript = typeof payload.transcript === "string" ? payload.transcript : "";
        const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
        logInfo(`${P} ← transcription.completed`, { itemId, length: transcript.length });
        this.handleTranscriptComplete(transcript, itemId);
        return;
      }

      case "conversation.item.input_audio_transcription.failed": {
        // Terminal for the item: no transcript is coming, so settle it with
        // its interim text, as a hold timeout would — releasing its
        // commit-order slot and counting the commit — rather than making the
        // stop wait out DRAIN_TIMEOUT_MS. Without an item id we can't tell
        // which commit failed, so leave the hold and drain backstops in
        // charge. The error payload may echo user content — log its code only.
        const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;
        const failure = payload.error as { code?: string; type?: string } | undefined;
        logWarn(`${P} ← transcription.failed`, {
          itemId,
          code: failure?.code,
          errorType: failure?.type,
        });
        if (!itemId || this.completedItemIds.has(itemId)) return;
        const interim = (this.itemDeltaText.get(itemId) ?? "").trim();
        this.failedItemIds.add(itemId);
        this.emitError(createTranscriptionItemFailedError());
        this.handleTranscriptComplete(interim, itemId);
        if (!this.commitOrder.includes(itemId)) this.failedItemIds.delete(itemId);
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
        // Some servers put a committed segment's final transcript on the item's
        // `input_audio` content part here. The `?intent=transcription` endpoint
        // instead sends this with an empty transcript *before* the deltas and
        // `...transcription.completed`, so only a `done` carrying text counts.
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
        if (!transcript.trim()) {
          // A placeholder, not a result: claiming the item id or decrementing
          // here would drop the real `.completed` as a duplicate and settle the
          // drain before the final transcript lands.
          logDebug(`${P} conversation.item.done had an empty transcript — awaiting completion`, {
            itemId: item?.id,
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
        // The message can quote a rejected keyword back — keep it out of the log.
        logError(`${P} ← server error event`, undefined, {
          severity: classified.severity,
          code: classified.code,
          param: classified.param,
          openaiType: errorPayload?.type,
        });
        // Transient server-side errors (rate_limit_exceeded, server_error,
        // session_expired) are recoverable. Emit the classified error first so
        // the renderer can show "rate-limited, retrying" in the tooltip, then
        // terminate the socket — its trailing `close` fires the existing close
        // handler, which schedules a reconnect with the same backoff/jitter
        // machinery used for transport drops. Calling scheduleReconnect directly
        // here would race the in-flight close event and risk double-scheduling.
        // An expiry is routine past OpenAI's maximum session length, so it rolls
        // over into a new session without telling the renderer anything failed.
        if (classified.severity === "transient" && this.connection) {
          this.connectionError = classified;
          if (classified.code !== SESSION_EXPIRED_CODE) this.emitError(classified);
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
        // Shape only: an unrecognised event can still carry transcript text.
        logDebug(`${P} ← unhandled server event`, { type, ...voicePayloadShape(payload) });
    }
  }

  /**
   * Handles one committed segment's terminal result: emits any transcript to
   * the renderer and decrements the outstanding-commit counter. While draining,
   * settles the drain the moment every committed segment has reported back.
   * Callers only route terminal results here — `.completed`, `.failed`, or a
   * `conversation.item.done` that carries text.
   *
   * `itemId` is deduped: a result already counted (e.g. a text-bearing `.done`
   * followed by `.completed` for the same item, or a repeated frame) is ignored entirely, so
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
    this.forgetRetiredReplayItems();
    if (itemId) this.itemDeltaText.delete(itemId);
    if (itemId && this.commitOrder.includes(itemId)) {
      this.heldCompletions.set(itemId, transcript);
      this.releaseHeldCompletions(false);
    } else {
      if (itemId) this.completedBeforeAck.add(itemId);
      this.emitCompletion(transcript, itemId);
    }
    // Each commit yields exactly one completion. Once every committed segment
    // has reported back the drain is genuinely finished — no grace timer, no
    // guessing whether a late final-commit transcript is still in flight.
    if (this.isDraining && this.pendingCommits === 0) {
      logDebug(`${P} All committed segments transcribed — settling drain`);
      this.settleDrain("all-segments-transcribed");
    }
  }

  /**
   * Emits held completions in commit order, stopping at the first item still in
   * flight. `force` settles every unresolved item with its interim text instead,
   * a dropped connection's items held for a replay first (the session is ending:
   * drain end, fatal error, stop); `settleHead` settles only the first one (the
   * hold timeout). Settling in place keeps the draft in commit order even when a
   * predecessor never reports back.
   */
  private releaseHeldCompletions(force: boolean, settleHead = false): void {
    if (force && this.replayItems.length > 0) {
      const items = this.replayItems;
      this.replayItems = [];
      logWarn(`${P} Settling items the replay never transcribed with their interim text`, {
        items: items.length,
      });
      for (const { itemId, text } of items) this.emitCompletion(text, itemId);
    }
    for (let itemId = this.commitOrder[0]; itemId !== undefined; itemId = this.commitOrder[0]) {
      let transcript = this.heldCompletions.get(itemId);
      const settled = transcript === undefined || this.failedItemIds.has(itemId);
      if (transcript === undefined) {
        if (!force && !settleHead) break;
        settleHead = false;
        transcript = (this.itemDeltaText.get(itemId) ?? "").trim();
        this.completedItemIds.add(itemId);
        this.itemDeltaText.delete(itemId);
        if (this.pendingCommits > 0) this.pendingCommits--;
        logWarn(`${P} Settling unreported item with its interim text`, {
          itemId,
          length: transcript.length,
        });
      }
      this.commitOrder.shift();
      this.heldCompletions.delete(itemId);
      this.failedItemIds.delete(itemId);
      this.releaseTranscribedSegment(itemId);
      // Only a reported transcript of the last commit, with no later commit
      // in flight and the VAD hearing silence it has seen speech end into,
      // ends an utterance; a backstop or replayed commit can land mid-speech.
      const endOfSpeech =
        !settled &&
        this.commitOrder.length === 0 &&
        this.pendingCommits === 0 &&
        this.replaySegments.length === 0 &&
        this.vadWorker !== null &&
        !this.vadDegraded &&
        this.vadHasEndedSpeech &&
        !this.isSpeaking;
      const endsAtPause = !settled && this.pauseItemIds.has(itemId);
      this.pauseItemIds.delete(itemId);
      this.emitCompletion(transcript, itemId, {
        ...(endOfSpeech ? { endOfSpeech: true } : {}),
        ...(endsAtPause ? { endsAtPause: true } : {}),
        // Its transcript never came, so words around it may be missing.
        ...(settled ? { incomplete: true } : {}),
      });
    }
    const blockingItemId = this.heldCompletions.size > 0 ? (this.commitOrder[0] ?? null) : null;
    if (this.heldCompletionTimer && this.heldCompletionTimerItemId === blockingItemId) return;
    this.clearHeldCompletionTimer();
    if (blockingItemId) {
      this.heldCompletionTimerItemId = blockingItemId;
      this.heldCompletionTimer = setTimeout(() => {
        this.heldCompletionTimer = null;
        this.heldCompletionTimerItemId = null;
        this.releaseHeldCompletions(false, true);
        if (this.isDraining && this.pendingCommits === 0) {
          this.settleDrain("held-completion-timeout");
        }
      }, HELD_COMPLETION_TIMEOUT_MS);
    }
  }

  private clearHeldCompletionTimer(): void {
    if (this.heldCompletionTimer) {
      clearTimeout(this.heldCompletionTimer);
      this.heldCompletionTimer = null;
    }
    this.heldCompletionTimerItemId = null;
  }

  private emitCompletion(
    transcript: string,
    itemId?: string,
    boundary: { endOfSpeech?: true; endsAtPause?: true; incomplete?: true } = {}
  ): void {
    if (transcript) {
      logDebug(`${P} Emitting complete transcript to renderer`, {
        itemId,
        length: transcript.length,
        endOfSpeech: boundary.endOfSpeech === true,
        endsAtPause: boundary.endsAtPause === true,
        incomplete: boundary.incomplete === true,
      });
      this.emit({
        type: "complete",
        text: transcript,
        ...(itemId ? { itemId } : {}),
        ...boundary,
      });
    } else if (itemId) {
      // An identified empty completion still reaches the renderer so it can
      // drop that item's interim preview. Silence closing the utterance still
      // ends it: a "send it" in an earlier item waits on that.
      logDebug(`${P} Completion had an empty transcript — retiring item`, { itemId });
      this.emit({ type: "complete", text: "", itemId, ...boundary });
    } else {
      logDebug(`${P} Completion had an empty transcript — nothing emitted`);
    }
  }

  private sendAudioJson(chunk: ArrayBuffer): void {
    if (!this.connection) return;
    // Retained before the send: whether it threw or `ws` quietly dropped it,
    // only the server's commit acknowledgement proves it arrived.
    this.retainForReplay(chunk);
    this.audioSentSinceHeard = true;
    const payload = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.from(chunk).toString("base64"),
    });
    this.heartbeatBytesSent += payload.length;
    try {
      this.connection.send(payload);
    } catch (err) {
      // A send can throw if the socket transitioned to CLOSING mid-flush. Don't
      // let it escape the buffer-flush loop (which would leave the buffer in a
      // partially-cleared state) — the trailing `close` event drives reconnect.
      logWarn(`${P} Failed to send audio chunk`, {
        ...voiceErrorLogFields(err),
      });
      return;
    }
    this.bytesSinceCommit += chunk.byteLength;
  }

  /**
   * Sends `input_audio_buffer.commit` and does the accounting every commit
   * shares: one more transcript outstanding, the tail becomes an unacknowledged
   * replay segment, and the pre-roll restarts so a later barge-in replay can't
   * resend audio this commit already carries. Throws if the send does; callers
   * own their eligibility checks, logging and failure handling.
   */
  private sendCommit(atPause = false): void {
    if (!this.connection) throw new Error("No connection");
    this.connection.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    this.pendingCommits++;
    this.commitPauses.push(atPause);
    this.bytesSinceCommit = 0;
    this.replaySegments.push({ chunks: this.replayTail, bytes: this.replayTailBytes, atPause });
    this.replayTail = [];
    this.replayTailBytes = 0;
    this.preRollChunks = [];
    this.preRollBytes = 0;
  }

  /** Adds a sent chunk to the replay tail, evicting the oldest audio past the cap. */
  private retainForReplay(chunk: ArrayBuffer): void {
    this.replayTail.push(chunk);
    this.replayTailBytes += chunk.byteLength;
    this.replayBytes += chunk.byteLength;
    while (this.replayBytes > REPLAY_MAX_BYTES) {
      const head = this.replaySegments[0];
      if (head?.itemId !== undefined) {
        // Acknowledged audio goes whole: replayed without its start, it would
        // replace a preview that has the words. Its item settles with that
        // preview on a drop instead.
        this.replaySegments.shift();
        this.droppedReplayChunks += head.chunks.length;
        this.replayBytes -= head.bytes;
      } else {
        const evicted = head ? head.chunks.shift() : this.replayTail.shift();
        if (!evicted) break;
        this.droppedReplayChunks++;
        this.replayBytes -= evicted.byteLength;
        if (head) {
          head.bytes -= evicted.byteLength;
          if (head.chunks.length === 0) {
            this.replaySegments.shift();
            this.replayEvictedSegments++;
          }
        } else {
          this.replayTailBytes -= evicted.byteLength;
        }
      }
      if (!this.replayOverflowWarned) {
        this.replayOverflowWarned = true;
        logWarn(`${P} Replay buffer full, dropping the oldest unacknowledged audio`, {
          maxBytes: REPLAY_MAX_BYTES,
          unacknowledgedSegments: this.replaySegments.length,
        });
      }
    }
  }

  /**
   * The server acknowledged the oldest outstanding commit with nothing left to
   * wait for: no item id to follow, or a transcript that already landed.
   */
  private releaseAcknowledgedSegment(): void {
    if (this.replayEvictedSegments > 0) {
      this.replayEvictedSegments--;
      return;
    }
    const index = this.replaySegments.findIndex((segment) => segment.itemId === undefined);
    if (index < 0) return;
    this.replayBytes -= this.replaySegments[index]!.bytes;
    this.replaySegments.splice(index, 1);
  }

  /** The oldest outstanding commit is `itemId`: its audio waits on that transcript. */
  private tagAcknowledgedSegment(itemId: string): void {
    if (this.replayEvictedSegments > 0) {
      this.replayEvictedSegments--;
      return;
    }
    const segment = this.replaySegments.find((s) => s.itemId === undefined);
    if (segment) segment.itemId = itemId;
  }

  /** An item's transcript reached the renderer: its audio is never needed again. */
  private releaseTranscribedSegment(itemId: string): void {
    const index = this.replaySegments.findIndex((segment) => segment.itemId === itemId);
    if (index < 0) return;
    this.replayBytes -= this.replaySegments[index]!.bytes;
    this.replaySegments.splice(index, 1);
  }

  /** The server buffer was cleared: audio since the last commit is gone there too. */
  private resetReplayTail(): void {
    this.replayBytes -= this.replayTailBytes;
    this.replayTail = [];
    this.replayTailBytes = 0;
  }

  /** Keeps only the newest `keepBytes` of the tail (at least its last chunk). */
  private trimReplayTail(keepBytes: number): void {
    while (
      this.replayTail.length > 1 &&
      this.replayTailBytes - this.replayTail[0]!.byteLength >= keepBytes
    ) {
      const dropped = this.replayTail.shift()!;
      this.replayTailBytes -= dropped.byteLength;
      this.replayBytes -= dropped.byteLength;
    }
  }

  private clearReplay(): void {
    this.replaySegments = [];
    this.replayTail = [];
    this.replayTailBytes = 0;
    this.replayBytes = 0;
    this.replayEvictedSegments = 0;
    this.replayOverflowWarned = false;
  }

  /**
   * Resends the replay ledger onto a newly ready connection: each segment
   * still awaiting its transcript followed by its commit, then the uncommitted
   * tail. The ledger is rebuilt by the sends themselves, so a send that fails
   * here leaves the audio retained for the next attempt.
   */
  private replayUntranscribedAudio(): void {
    if (this.replayBytes === 0) return;
    const segments = this.replaySegments;
    const tail = this.replayTail;
    logInfo(`${P} Replaying audio the dropped connection never transcribed`, {
      segments: segments.length,
      acknowledgedSegments: segments.filter((segment) => segment.itemId !== undefined).length,
      evictedSegments: this.replayEvictedSegments,
      bytes: this.replayBytes,
    });
    this.clearReplay();
    for (const segment of segments) {
      for (const chunk of segment.chunks) this.sendAudioJson(chunk);
      if (this.bytesSinceCommit < MIN_COMMIT_BYTES) continue;
      try {
        this.sendCommit(segment.atPause);
        logDebug(`${P} → input_audio_buffer.commit (replayed segment)`, {
          pendingCommits: this.pendingCommits,
        });
      } catch (err) {
        logWarn(`${P} Failed to commit a replayed segment`, { ...voiceErrorLogFields(err) });
      }
    }
    for (const chunk of tail) this.sendAudioJson(chunk);
  }

  /**
   * On a drop, settles in commit order what a replay can't redo, and holds the
   * rest for it: everything from the first unreported item whose audio is
   * still retained, a finished transcript behind it included, since emitting
   * that now would put it ahead of the speech the replay brings back. Then the
   * previews of audio never acknowledged, a lost commit's or the open tail's,
   * which the replay transcribes again under new items.
   */
  private holdItemsForReplay(): void {
    const replayFrom = this.commitOrder.findIndex(
      (itemId) =>
        !this.heldCompletions.has(itemId) &&
        this.replaySegments.some((segment) => segment.itemId === itemId)
    );
    const replayed = replayFrom < 0 ? [] : this.commitOrder.splice(replayFrom);
    while (this.commitOrder.length > 0) this.releaseHeldCompletions(false, true);
    for (const itemId of replayed) {
      const text = this.heldCompletions.get(itemId) ?? this.itemDeltaText.get(itemId) ?? "";
      this.replayItems.push({ itemId, text: text.trim(), retired: false });
      this.heldCompletions.delete(itemId);
      this.failedItemIds.delete(itemId);
      this.itemDeltaText.delete(itemId);
    }
    for (const [itemId, text] of this.itemDeltaText) {
      this.replayItems.push({ itemId, text: text.trim(), retired: false });
    }
    this.itemDeltaText.clear();
    this.clearHeldCompletionTimer();
  }

  /** The replay is going out: its items' old previews give way to the new ones. */
  private retireReplayedPreviews(): void {
    const pending = this.replayItems.filter((item) => !item.retired);
    if (pending.length === 0) return;
    logInfo(`${P} Retiring previews the replay transcribes again`, { items: pending.length });
    for (const item of pending) {
      item.retired = true;
      this.emit({ type: "complete", text: "", itemId: item.itemId });
    }
  }

  /** The new connection is transcribing: the replay's fallback text is no longer needed. */
  private forgetRetiredReplayItems(): void {
    if (this.replayItems.length === 0) return;
    this.replayItems = this.replayItems.filter((item) => !item.retired);
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    if (this.isDraining) return;

    if (!this.isReady || !this.connection) {
      // Buffer while connecting (initial) or reconnecting (mid-session drop) so
      // audio captured during the gap is flushed once the session is ready.
      // The VAD hears it as it's captured, so speech that ends before the
      // socket is ready still gets its commit; only kept chunks reach it, so
      // its boundaries line up with the buffer.
      if (this.holdsConnectAudio()) {
        if (this.bufferPreConnectChunk(chunk)) this.feedVad(chunk);
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
   * Posts a chunk to the VAD process. Posting structured-clones it, so the
   * original ArrayBuffer stays usable for the OpenAI send on this thread.
   */
  private feedVad(chunk: ArrayBuffer): void {
    if (!this.vadWorker || this.vadDegraded) return;
    try {
      this.vadWorker.post({ type: "audio", pcm: chunk });
    } catch (err) {
      logWarn(`${P} Failed to post audio to VAD worker`, {
        ...voiceErrorLogFields(err),
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
   * chunk is dropped (warned and reported once). Returns whether the chunk was
   * kept.
   */
  private bufferPreConnectChunk(chunk: ArrayBuffer): boolean {
    const maxChunks = this.isReconnecting ? RECONNECT_BUFFER_MAX_CHUNKS : AUDIO_BUFFER_MAX_CHUNKS;
    // Gap audio joins the unacknowledged audio in the replay ledger when it's
    // flushed, so together they stay under its cap. Otherwise the flush would
    // evict audio a second drop needs to resend.
    const maxBytes = this.isReconnecting
      ? Math.min(RECONNECT_BUFFER_MAX_BYTES, REPLAY_MAX_BYTES - this.replayBytes)
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
        this.emitError(createAudioBufferOverflowError());
      }
      return false;
    }
    this.preConnectBuffer.push(chunk);
    this.preConnectBufferBytes += chunk.byteLength;
    return true;
  }

  /** Audio is held for a socket that's connecting or reconnecting. */
  private holdsConnectAudio(): boolean {
    return this.connection !== null || this.pendingStart !== null || this.isReconnecting;
  }

  /**
   * Tears down per-connection state without ending the session. Deliberately
   * does NOT touch `sessionId`, `reconnectAttempt`, `isReconnecting`,
   * `isExpectedClose`, or the pre-connect buffer — those survive across a
   * reconnect. Use `cleanupPreviousSession()` for a full session reset.
   */
  private cleanupConnection(): void {
    // A tail the live VAD last called silence (speech ended, nothing since) is
    // cut before it's replayed. Read before the VAD is retired, which resets it.
    if (this.vadWorker && !this.vadDegraded && this.vadHasEndedSpeech && !this.isSpeaking) {
      this.trimReplayTail(REPLAY_SILENCE_KEEP_BYTES);
    }
    // Retire the VAD with the connection — a reconnect re-spawns it fresh on
    // the next `session.updated`, so VAD state never straddles two physical
    // sockets.
    this.stopVadWorker("connection-closed");
    this.clearHeartbeat();
    this.clearConnectTimeout();
    this.connection = null;
    this.sendSessionUpdateOnKeyterms = null;
    this.isReady = false;
    this.heartbeatPing = null;
    this.heartbeatPingMarks = [];
    this.audioSentSinceHeard = false;
    this.bytesSinceCommit = 0;
    this.pendingCommits = 0;
    this.commitPauses = [];
    // Item ids are per connection, so a reconnect starts a fresh ordering
    // chain: what arrived is released, and what the replay redoes waits for it.
    this.holdItemsForReplay();
    this.completedItemIds.clear();
    this.completedBeforeAck.clear();
    this.pauseItemIds.clear();
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
    this.isReady = false;
    this.bytesSinceCommit = 0;
    this.pendingCommits = 0;
    this.commitPauses = [];
    this.completedItemIds.clear();
    this.pauseItemIds.clear();
    this.commitOrder = [];
    this.heldCompletions.clear();
    this.itemDeltaText.clear();
    this.failedItemIds.clear();
    this.clearHeldCompletionTimer();
    this.completedBeforeAck.clear();
    this.replayItems = [];
    this.preConnectBuffer = [];
    this.preConnectBufferBytes = 0;
    this.heldCommits = [];
    this.sendSessionUpdateOnKeyterms = null;
    this.clearConnectTimeout();
    this.clearDrainTimeout();
    this.stopVadWorker("session-end");
    this.vadDegraded = false;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.isReconnecting = false;
    this.reconnectDeadlineAt = null;
    this.lastReconnectError = null;
    this.isExpectedClose = false;
    this.heartbeatPing = null;
    this.heartbeatPingMarks = [];
    this.audioSentSinceHeard = false;
    this.clearReplay();
    this.isDraining = false;
    this.stopPendingReady = false;
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
   * Spawns the VAD side-chain process for the current session. Speech-boundary
   * events it reports drive `input_audio_buffer.commit`/`clear`. Every message
   * is guarded by `mySessionId` so a message arriving after this session was
   * torn down (or superseded by a new `start()`) is ignored (#4850/#4851). If
   * the process can't be spawned, its model fails to load, or it dies — a
   * native ONNX abort included (#12577) — we fall back to a periodic backstop
   * commit (degraded mode) so dictation still works.
   */
  private startVadWorker(mySessionId: number): void {
    this.stopVadWorker("respawn");
    this.vadReady = false;
    this.isSpeaking = false;
    this.vadHasEndedSpeech = false;
    this.vadDegraded = false;
    this.preRollChunks = [];
    this.preRollBytes = 0;

    let vad: OpenAIVadProcess;
    const isCurrent = (): boolean => this.sessionId === mySessionId && this.vadWorker === vad;
    try {
      vad = new OpenAIVadProcess(mySessionId, {
        onMessage: (message: VadWorkerOutbound) => {
          if (!isCurrent()) return;
          switch (message.type) {
            case "ready":
              this.vadReady = true;
              return;
            case "speech-start":
              this.handleVadSpeechStart();
              return;
            case "speech-end":
              this.handleVadSpeechEnd();
              return;
            case "error":
              logError(`${P} VAD error — degraded mode`);
              this.enterDegradedMode(mySessionId);
              return;
          }
        },
        onUnexpectedExit: () => {
          if (!isCurrent()) return;
          this.enterDegradedMode(mySessionId);
        },
      });
    } catch (err) {
      logError(
        `${P} Failed to spawn VAD process — degraded mode`,
        undefined,
        voiceErrorLogFields(err)
      );
      this.enterDegradedMode(mySessionId);
      return;
    }
    this.vadWorker = vad;
  }

  /**
   * Retires the VAD process and clears all VAD-derived state. Safe to call
   * when no process is running. Does not touch `vadDegraded` so a degraded
   * session that's being torn down doesn't briefly re-arm speech gating.
   */
  private stopVadWorker(reason: VadRetireReason): void {
    this.clearBackstopTimer();
    this.vadReady = false;
    this.isSpeaking = false;
    this.preRollChunks = [];
    this.preRollBytes = 0;
    const vad = this.vadWorker;
    this.vadWorker = null;
    vad?.retire(reason);
  }

  private vadState(): "ready" | "loading" | "degraded" | "none" {
    if (this.vadDegraded) return "degraded";
    if (!this.vadWorker) return "none";
    return this.vadReady ? "ready" : "loading";
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
    const vad = this.vadWorker;
    this.vadWorker = null;
    vad?.retire("degraded");
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
        ...voiceErrorLogFields(err),
      });
      // The server buffer was NOT cleared — replaying the pre-roll would
      // duplicate those bytes. Bail; the socket is likely dropping anyway.
      return;
    }
    this.bytesSinceCommit = 0;
    this.resetReplayTail();
    for (const chunk of this.preRollChunks) {
      this.sendAudioJson(chunk);
    }
  }

  private handleVadSpeechEnd(): void {
    if (!this.isSpeaking) return;
    this.isSpeaking = false;
    if (this.isReady) this.vadHasEndedSpeech = true;
    this.clearBackstopTimer();
    logDebug(`${P} VAD speech-end — committing segment`);
    this.maybeCommitSegment(VAD_PAUSE_COMMIT);
  }

  private startBackstopTimer(reason: string, { once = false } = {}): void {
    this.clearBackstopTimer();
    this.maxSegmentTimer = setInterval(() => {
      if (once) this.clearBackstopTimer();
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
    // Before the socket is ready the audio is still held, so the boundary is
    // kept with it and committed when it's flushed.
    if (!this.isReady && !this.isDraining && this.holdsConnectAudio()) {
      this.holdCommit(reason);
      return;
    }
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
      const bytes = this.bytesSinceCommit;
      this.sendCommit(reason === VAD_PAUSE_COMMIT);
      logDebug(`${P} → input_audio_buffer.commit`, {
        reason,
        bytes,
        chunksStreamed: this.audioChunkCount,
        pendingCommits: this.pendingCommits,
      });
    } catch (err) {
      logWarn(`${P} Failed to commit audio segment`, {
        reason,
        ...voiceErrorLogFields(err),
      });
    }
  }

  private holdCommit(reason: string): void {
    const at = this.preConnectBuffer.length;
    const atPause = reason === VAD_PAUSE_COMMIT;
    // With nothing held yet, a boundary still closes a dropped connection's
    // unacknowledged tail, which is replayed ahead of the held audio.
    if (at === 0 && this.replayTailBytes === 0) return;
    const last = this.heldCommits.at(-1);
    if (last?.at === at) {
      last.atPause ||= atPause;
      return;
    }
    this.heldCommits.push({ at, atPause });
    logDebug(`${P} Commit held until the socket is ready`, { reason, bufferedChunks: at });
  }

  /** A held commit, sent once the flush reaches it. Too little audio waits for the next. */
  private commitHeldSegment(atPause: boolean): void {
    if (this.bytesSinceCommit < MIN_COMMIT_BYTES) return;
    try {
      this.sendCommit(atPause);
      logDebug(`${P} → input_audio_buffer.commit (held)`, {
        pendingCommits: this.pendingCommits,
      });
    } catch (err) {
      logWarn(`${P} Failed to send a held commit`, { ...voiceErrorLogFields(err) });
    }
  }

  private settleDrain(reason: string): void {
    this.releaseHeldCompletions(true);
    this.clearDrainTimeout();
    this.isDraining = false;
    this.stopPendingReady = false;
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

  getSessionStats(): ProviderSessionStats {
    return {
      delayTier: OPENAI_TRANSCRIPTION_DELAY,
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

    // Audio captured while (re)connecting sits in the pre-connect buffer until
    // `session.updated`. If a live connection attempt — or an already scheduled
    // reconnect — could still deliver it, wait for it rather than discarding.
    const canFlushBufferedAudio =
      !this.isReady &&
      this.preConnectBufferBytes + this.replayBytes >= MIN_COMMIT_BYTES &&
      (this.connection !== null || this.reconnectTimer !== null);

    // A graceful stop is an expected close — stop the close handler from
    // retrying, and cancel any pending reconnect we aren't waiting on.
    this.isExpectedClose = true;
    if (canFlushBufferedAudio) {
      return this.stopAfterConnect();
    }
    this.isReconnecting = false;
    this.clearReconnectTimer();

    if (!this.connection || !this.isReady) {
      this.releaseHeldCompletions(true);
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
      return;
    }

    this.isDraining = true;
    this.stopVadWorker("stop");
    this.emit({ type: "status", status: "finishing" });

    // Flush whatever audio accumulated since the last interval commit so its
    // transcript is included. If too little remains, OpenAI would reject the
    // commit as undersized — skip it; an interval commit's transcript may still
    // be in flight, and `pendingCommits` already accounts for it.
    if (this.bytesSinceCommit >= MIN_COMMIT_BYTES) {
      try {
        const bytes = this.bytesSinceCommit;
        this.sendCommit();
        logInfo(`${P} → input_audio_buffer.commit (final)`, {
          bytes,
          chunksStreamed: this.audioChunkCount,
          pendingCommits: this.pendingCommits,
        });
      } catch {
        logWarn(`${P} Failed to send final commit, closing immediately`);
        this.releaseHeldCompletions(true);
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
      this.releaseHeldCompletions(true);
      this.isDraining = false;
    }

    // If start() was called during drain it already ran cleanupPreviousSession()
    // and incremented sessionId — don't tear down the new session.
    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Graceful stop before the session is ready. The drain promise first waits
   * (bounded by STOP_CONNECT_TIMEOUT_MS) for `session.updated`, which flushes
   * the buffer and calls `commitAfterLateReady()`; from there it's the normal
   * commit-and-drain. Connect failures settle the drain via the close/fatal
   * paths. Audio arriving meanwhile is dropped by `sendAudioChunk`.
   */
  private async stopAfterConnect(): Promise<void> {
    logInfo(`${P} Stop before session ready — waiting to flush buffered audio`, {
      bufferedChunks: this.preConnectBuffer.length,
      bufferedBytes: this.preConnectBufferBytes,
      hasConnection: !!this.connection,
      isReconnecting: this.isReconnecting,
    });
    this.isDraining = true;
    this.stopPendingReady = true;
    // The mic is released: nothing more for the VAD to hear, and the held
    // audio and its commits stay as they are for the flush.
    this.stopVadWorker("stop");
    this.emit({ type: "status", status: "finishing" });

    const sessionIdBeforeDrain = this.sessionId;
    this.drainPromise = new Promise<void>((resolve) => {
      this.drainResolve = resolve;
      this.drainTimeout = setTimeout(() => {
        logWarn(
          `${P} Session not ready ${STOP_CONNECT_TIMEOUT_MS}ms after stop — discarding buffered audio`,
          { bufferedBytes: this.preConnectBufferBytes }
        );
        this.settleDrain("connect-timeout");
      }, STOP_CONNECT_TIMEOUT_MS);
    });
    await this.drainPromise;

    if (this.sessionId === sessionIdBeforeDrain) {
      this.cleanupPreviousSession();
      this.emit({ type: "status", status: "idle" });
    }
  }

  /**
   * Second half of `stopAfterConnect()`, run from `session.updated` once the
   * buffered audio has been flushed: send the final commit and re-arm the drain
   * backstop for its transcript, or settle now if too little audio made it.
   */
  private commitAfterLateReady(): void {
    this.stopPendingReady = false;
    this.clearDrainTimeout();
    if (!this.connection || this.bytesSinceCommit < MIN_COMMIT_BYTES) {
      logInfo(`${P} Late-ready stop with sub-threshold buffer — no final commit`, {
        bytesSinceCommit: this.bytesSinceCommit,
        pendingCommits: this.pendingCommits,
      });
      // Segments replayed from a dropped connection may still be transcribing.
      if (!this.connection || this.pendingCommits === 0) {
        this.settleDrain("nothing-to-commit");
        return;
      }
    } else {
      const bytes = this.bytesSinceCommit;
      try {
        this.sendCommit();
      } catch {
        logWarn(`${P} Failed to send final commit after late ready`);
        this.settleDrain("final-commit-failed");
        return;
      }
      logInfo(`${P} → input_audio_buffer.commit (final, after late ready)`, {
        bytes,
        pendingCommits: this.pendingCommits,
      });
    }
    this.drainTimeout = setTimeout(() => {
      logWarn(`${P} Drain timed out after ${DRAIN_TIMEOUT_MS}ms, force closing`, {
        pendingCommits: this.pendingCommits,
      });
      this.settleDrain("timeout");
    }, DRAIN_TIMEOUT_MS);
  }

  stop(): void {
    logInfo(`${P} stop() called`, {
      sessionId: this.sessionId,
      voiceSessionId: this.voiceSessionId,
      hasConnection: !!this.connection,
    });
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
