/**
 * Canonical voice session phase types shared across main process, preload, and renderer.
 *
 * All layers must import from here — never re-declare inline. This ensures TypeScript
 * catches phase mismatches at compile time across the IPC boundary.
 */

/**
 * The phase of the voice recording session.
 *
 * - idle: No active session.
 * - arming: Renderer-only pre-recording state. Fires synchronously on hotkey
 *   press so the target panel and toolbar can show a visual cue (~<50ms)
 *   before audio init begins (~200ms). The backend never emits this status
 *   over IPC; it lives only in the renderer voice store and is overwritten
 *   by `beginSession()` once `connecting` arrives.
 * - connecting: WebSocket to OpenAI Realtime is being established.
 * - recording: The transcription backend is ready; live transcription in
 *   progress. Says nothing about whether the mic is delivering real audio —
 *   that is the renderer-only `micSignal` in the voice store (#13105).
 * - paused: Session alive (WebSocket open) but audio capture suspended;
 *   the PCM worklet stops forwarding chunks until the user resumes. An
 *   auto-stop timer terminates the session if pause exceeds 60s.
 * - reconnecting: Connection dropped mid-session; retrying with backoff while
 *   buffering captured audio. The session is still active from the user's view.
 * - finishing: Session stop requested; draining final transcription from OpenAI.
 * - error: Session terminated due to a connection or transcription error.
 */
export type VoiceInputStatus =
  | "idle"
  | "arming"
  | "connecting"
  | "recording"
  | "paused"
  | "reconnecting"
  | "finishing"
  | "error";

/**
 * Why main ended a dictation session. Sent once per session on
 * `voice-input:session-ended`, keyed by the renderer-minted session id.
 *
 * - stopped: the owner stopped a running session and its transcription drained.
 * - cancelled: it ended before anything was committed: stopped before the
 *   provider came up, or its owning view went away.
 * - superseded: a newer start replaced it.
 * - failed: the provider failed to start or died mid-session.
 */
export type VoiceSessionEndReason = "stopped" | "cancelled" | "superseded" | "failed";

/** Where a recognition hint came from. */
export type VoiceKeytermSource =
  "dictionary" | "projectDictionary" | "project" | "repository" | "names" | "branch" | "terminal";

export interface VoiceSentTerm {
  term: string;
  source: VoiceKeytermSource;
}

/**
 * What the most recent dictation handed its transcription provider, kept in
 * main's memory for that one session. `sent` is null until the provider has
 * reported its request, and empty when it went out with no terms.
 * `keytermAttempt` is Deepgram's retry step: after an HTTP 400 it re-sends a
 * trimmed list, then none. `endedBeforeSending` marks a session that ended
 * before the provider reported a request (rejected, stopped while connecting,
 * or the request failed to send), so its empty `sent` is not a provider limit.
 */
export interface LastDictationTerms {
  sessionId: string;
  provider: "openai" | "deepgram";
  /**
   * How many terms assembly gathered, before the provider's own limits. Zero
   * until assembly lands, which for OpenAI can be after its provider starts.
   */
  assembledCount: number;
  sent: VoiceSentTerm[] | null;
  keytermAttempt?: "full" | "trimmed" | "none";
  endedBeforeSending?: true;
  startedAt: number;
}

/**
 * A dictation session another view owns. Main tells every view about the live
 * session on `voice-input:live-session`, except the one that owns it, so the
 * dictation key can stop it from anywhere and the view can say where it runs.
 */
export interface VoiceSessionElsewhere {
  sessionId: string;
  projectId: string | null;
  projectName: string | null;
}

/**
 * The live session as one view sees it: `session` is null when none is live or
 * that view owns it. `revision` grows with every change, so a pulled snapshot
 * can't overwrite a newer push.
 */
export interface VoiceLiveSessionUpdate {
  revision: number;
  session: VoiceSessionElsewhere | null;
}

/**
 * How a `voice-input:start` call came out. A provider that couldn't start
 * reports why in `error`, for the user; it is never logged.
 */
export type VoiceStartOutcome =
  { status: "started" } | { status: "superseded" } | { status: "failed"; error: string };

/**
 * How a `voice-input:rewrite` call came out. Only `replace` carries text.
 *
 * - replace: the model's rewrite, which kept every protected span.
 * - no_change: the model left the selection as it was.
 * - rejected: the rewrite dropped or changed a reference, backticked span,
 *   URL, flag or path, so it was discarded.
 * - unavailable: no OpenAI API key to send it with.
 * - failed: the request failed, timed out or came back unusable.
 */
export type VoiceRewriteOutcome =
  | { status: "replace"; text: string }
  | { status: "no_change" }
  | { status: "rejected" }
  | { status: "unavailable" }
  | { status: "failed" };

/**
 * The lifecycle phase of the transcript within a single voice panel buffer.
 * This is a renderer-level concept — it is derived from store state and is never
 * sent over IPC directly.
 *
 * - idle: No active transcription in this panel buffer.
 * - interim: A live segment is in flight; liveText is non-empty.
 * - utterance_final: A final transcript segment was accepted; liveText cleared.
 * - stable: Ready for the next utterance.
 */
export type VoiceTranscriptPhase = "idle" | "interim" | "utterance_final" | "stable";

/**
 * Returns true when the voice session is in an active phase (i.e. not idle,
 * arming, or error). `arming` is excluded deliberately: it is the pre-audio
 * confirmation window, and including it would cause the toggle guard to treat
 * a second hotkey press during arming as a stop instead of letting the
 * in-flight start complete.
 */
export function isActiveVoiceSession(status: VoiceInputStatus): boolean {
  return (
    status === "connecting" ||
    status === "recording" ||
    status === "paused" ||
    status === "reconnecting" ||
    status === "finishing"
  );
}

/**
 * Severity classification for a voice-input error. Drives the renderer's
 * recovery behavior: transient errors keep the session alive while the main
 * process reconnects; fatal errors tear down the session and surface a toast.
 *
 * - transient: a recoverable transport or rate-limit fault — the main process
 *   is already reconnecting (or will, on the next close). The user sees the
 *   "reconnecting" status but the session intent is preserved.
 * - fatal: requires user action (auth/quota/permission/config) or is
 *   unrecoverable. The session ends.
 */
export type VoiceInputErrorSeverity = "transient" | "fatal";

/**
 * Structured error payload emitted by the voice input pipeline. Plain
 * serializable shape so it crosses Electron's contextBridge (no class
 * instances, no Error subclasses).
 *
 * `code` is a stable identifier — UI mapping, telemetry, and tests should
 * branch on `code`, not on `message`. `message` carries the user-facing
 * fallback string for surfaces that lack a code mapping.
 */
export interface VoiceInputError {
  severity: VoiceInputErrorSeverity;
  /**
   * Stable error code. For server-emitted errors this mirrors the OpenAI
   * Realtime `error.code` (e.g. `"rate_limit_exceeded"`,
   * `"session_expired"`); for transport errors it's a synthetic code like
   * `"ws_close_1006"` or `"connection_timeout"`; for renderer-side
   * pre-connect failures it's a descriptive slug like `"mic_permission_denied"`.
   */
  code: string;
  /** Human-readable fallback message — shown when no `code` mapping exists. */
  message: string;
  /** OpenAI error payload `param` field, when present. */
  param?: string | null;
}
